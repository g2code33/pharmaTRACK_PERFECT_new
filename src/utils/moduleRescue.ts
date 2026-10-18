/**
 * Last-resort loading for a page module the engine refused to run.
 *
 * The failure this exists for is real and has followed this app across several
 * releases on Linux:
 *
 *   TypeError: 'application/pdf' is not a valid JavaScript MIME type.
 *
 * A module script is only executable when the response says it is JavaScript.
 * WebKitGTK (the Tauri webview) enforces that strictly, so a route chunk that
 * comes back as `application/pdf` cannot be imported — the page dies before a
 * single byte of it runs. There are only two ways that response can happen,
 * and the difference matters:
 *
 *  1. The bytes are JavaScript but the *header* is wrong. The desktop shell
 *     decides a response's MIME type from its content (tauri-utils
 *     MimeType::parse sniffs the first bytes with `infer`), so in practice this
 *     is a webview-level mix-up between two concurrent responses. The file is
 *     fine; only the label is wrong.
 *  2. The bytes really are something else — a PDF sitting where a chunk should
 *     be. Nothing in JavaScript can repair that file; the app must say so
 *     instead of pretending the page is broken.
 *
 * `rescueModuleImport` handles both: it fetches the file itself (a plain
 * `fetch()` is not subject to the module MIME check), decides from the bytes
 * which case it is, and in case 1 re-imports the same source from a `blob:`
 * URL created with `type: 'text/javascript'`. Because the browser then has an
 * explicitly-typed script, the refusal cannot repeat.
 *
 * A chunk's own relative imports (`import "./vendor-react-*.js"`) do not
 * resolve against a blob URL, so the source is rewritten first: relative
 * specifiers are made absolute against the original file's URL, and
 * `import.meta.url` is pinned to it. That keeps `?url` assets resolving the
 * way the bundle expects.
 *
 * This runs ONLY after the normal import and a cache-busted re-import have both
 * failed. It is a rescue, never the primary path.
 */

/** What the bytes we were served actually look like. */
export type ServedModuleKind = 'javascript' | 'pdf' | 'html' | 'other';

/** Enough bytes to cover `%PDF-`, a doctype, and a bundle prologue. */
const SNIFF_WINDOW = 512;

/** The file was not JavaScript. `url`, kind and size are for the error card. */
export class DamagedAssetError extends Error {
  readonly url: string;
  readonly served: ServedModuleKind;
  readonly byteLength: number;

  constructor(url: string, served: ServedModuleKind, byteLength: number) {
    super(describeDamagedAsset(url, served, byteLength));
    this.name = 'DamagedAssetError';
    this.url = url;
    this.served = served;
    this.byteLength = byteLength;
  }
}

/** Short, human label for what arrived instead of the app's code. */
export function servedKindLabel(served: ServedModuleKind): string {
  switch (served) {
    case 'pdf':
      return 'a PDF document';
    case 'html':
      return 'a web page (index.html)';
    case 'other':
      return 'binary data';
    default:
      return 'JavaScript';
  }
}

/** The file name alone, for a message that fits on the error card. */
export function assetNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url, 'https://tauri.localhost/');
    const name = parsed.pathname.split('/').filter(Boolean).pop();
    return name || parsed.pathname;
  } catch {
    return url;
  }
}

/**
 * The sentence shown to the user. It has to say three things: which file is
 * wrong, that the app (not their data) is damaged, and what actually repairs
 * it — the previous message named only a MIME type, which is unusable advice.
 */
export function describeDamagedAsset(
  url: string,
  served: ServedModuleKind,
  byteLength: number,
): string {
  const name = assetNameFromUrl(url);
  if (served === 'javascript') {
    return `The app served ${name} with the wrong content type but correct JavaScript contents; the page was reloaded from the bytes instead.`;
  }
  if (served === 'html') {
    // The shell answers a missing file with index.html, so this is the classic
    // "the page is running an older build than the files next to it" skew —
    // the repair is a refresh/update, not a reinstall.
    return (
      `This page asked for ${name}, but the app served its start page instead. ` +
      'That usually means the running app and its files are from different versions, which happens around an update. ' +
      'Press Retry, or close and reopen the app. Your courses, slides and notes are stored separately and are not affected.'
    );
  }
  const size = byteLength > 0 ? ` (${byteLength.toLocaleString()} bytes)` : '';
  return (
    `The app file ${name} arrived as ${servedKindLabel(served)} instead of JavaScript${size}. ` +
    'This installation is serving the wrong contents for its own files, so this page cannot start. ' +
    'Your courses, slides and notes are stored separately and are not affected. ' +
    'Reinstall PharmaTRACK over the top of the current version (it keeps your data), then reopen the app.'
  );
}

function startsWithAscii(bytes: Uint8Array, signature: string): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Classifies the first bytes of a response. Deliberately independent of the
 * declared Content-Type: the header is exactly what we cannot trust here.
 */
export function sniffServedModule(bytes: Uint8Array): ServedModuleKind {
  if (bytes.length === 0) return 'other';
  if (startsWithAscii(bytes, '%PDF')) return 'pdf';

  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, SNIFF_WINDOW))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();

  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  if (head.startsWith('<?xml')) return 'other';

  // A NUL byte in the prologue is the signature of a binary payload (font,
  // image, zip) rather than minified JavaScript, which never contains one.
  for (let i = 0; i < Math.min(bytes.length, SNIFF_WINDOW); i += 1) {
    if (bytes[i] === 0) return 'other';
  }
  return 'javascript';
}

/**
 * Makes a chunk loadable from a blob URL.
 *
 * Vite emits bare relative specifiers (`from"./vendor-*.js"`,
 * `import("./Chunk-*.js")`) and, for `?url` assets, `new URL(..., import.meta.url)`.
 * A blob module has no directory, so both are rewritten against the file's real
 * URL before the source is re-imported.
 */
export function rewriteModuleSpecifiers(code: string, moduleUrl: string): string {
  let directory: string;
  try {
    directory = new URL('.', moduleUrl).href;
  } catch {
    return code;
  }
  return (
    code
      // import.meta.url -> the original file's URL (string literal)
      .replace(/\bimport\.meta\.url\b/g, JSON.stringify(moduleUrl))
      // `from "./x"` (static import, re-export)
      .replace(/(\bfrom\s*)(["'])\.\//g, (_match, prefix: string, quote: string) => {
        return `${prefix}${quote}${directory}`;
      })
      // `import("./x")` (dynamic import)
      .replace(/(\bimport\s*\(\s*)(["'])\.\//g, (_match, prefix: string, quote: string) => {
        return `${prefix}${quote}${directory}`;
      })
      // `import "./x"` and `import"./x"` (side-effect imports; minified output
      // drops the space, so the whitespace here must be optional)
      .replace(/(\bimport\s*)(["'])\.\//g, (_match, prefix: string, quote: string) => {
        return `${prefix}${quote}${directory}`;
      })
  );
}

/** A route module must expose a component as `default`. */
export function isRouteModule(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const component = (value as { default?: unknown }).default;
  if (typeof component === 'function') return true;
  // React.memo / forwardRef components are objects tagged with $$typeof.
  return (
    typeof component === 'object' &&
    component !== null &&
    ('$$typeof' in (component as Record<string, unknown>) ||
      'render' in (component as Record<string, unknown>))
  );
}

/** Strips the query before the file is re-imported from its bytes. */
function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.href : undefined);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/**
 * Fetches a failed module, proves what it is, and imports it from a correctly
 * typed blob URL.
 *
 * Throws `DamagedAssetError` when the bytes are not JavaScript at all (the
 * error card can then name the file and the repair), and a plain Error for
 * network/HTTP failures so the caller keeps its normal retry/reload path.
 */
export async function rescueModuleImport<T = unknown>(
  url: string,
  fetchImpl: typeof fetch | undefined = typeof fetch === 'function' ? fetch : undefined,
): Promise<{ default: T }> {
  if (!fetchImpl) throw new Error('Module rescue is unavailable: fetch is missing.');
  const response = await fetchImpl(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Module rescue fetch failed for ${url}: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const served = sniffServedModule(bytes);
  if (served !== 'javascript') {
    throw new DamagedAssetError(url, served, bytes.byteLength);
  }

  const source = rewriteModuleSpecifiers(
    new TextDecoder('utf-8', { fatal: false }).decode(bytes),
    withoutQuery(url),
  );
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    return (await import(/* @vite-ignore */ blobUrl)) as { default: T };
  } finally {
    // The module graph keeps what it imported; the blob itself is no longer needed.
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {
      /* ignore */
    }
  }
}
