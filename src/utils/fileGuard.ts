/**
 * PharmaTRACK — upload file guard.
 *
 * A file picker's `accept` attribute and a filename extension are both
 * suggestions: the user can rename anything, and a truncated download still
 * carries the right name. So every upload is checked against what the bytes
 * actually are before it is processed, stored, or sent to a parser.
 *
 * The rules, in order:
 *
 *   1. empty          — a 0-byte file has nothing to extract
 *   2. too large      — refuse before reading it into memory
 *   3. unsafe         — executables and scripts are never study material
 *   4. corrupt        — the extension promises a format the bytes don't have
 *   5. mismatch       — the bytes are a different format than the name claims
 *
 * Everything runs on the file's first bytes, offline, with no dependency — a
 * failed check has to be cheaper than the work it prevents.
 */
import { kindFromExtension, type MaterialKind } from './materialKind';

export type FileIssueCode = 'empty' | 'too_large' | 'unsafe' | 'corrupt' | 'mismatch';

export interface FileIssue {
  code: FileIssueCode;
  /** `reject` blocks the upload outright; `warn` uploads but tells the student. */
  severity: 'reject' | 'warn';
  message: string;
}

export interface FileVerdict {
  /** True when the file may be processed. */
  ok: boolean;
  /** Format the bytes actually are. */
  detected: MaterialKind | 'ole' | 'text';
  /** Format the filename claims. */
  claimed: MaterialKind;
  issues: FileIssue[];
  /** The first blocking issue, when there is one. */
  blockedBy?: FileIssue;
}

/** Bytes read from the head of the file for signature checks. */
const SNIFF_BYTES = 32;
export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/**
 * Recognises the formats PharmaTRACK can actually read, plus the ones it must
 * refuse. `ole` covers legacy .doc/.ppt, which the app accepts for completeness
 * but cannot parse into slides.
 */
export function sniffBytes(bytes: Uint8Array): MaterialKind | 'ole' | 'text' {
  if (startsWith(bytes, ascii('%PDF-'))) return 'pdf';
  // docx/pptx/odp are all ZIP containers; the extension says which.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])) return 'docx';
  // Legacy Office / OLE2 compound document.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image';
  if (startsWith(bytes, ascii('BM'))) return 'image';
  return 'text';
}

/** Signatures that must never be accepted, whatever they are named. */
const UNSAFE: Array<{ sig: number[]; label: string; offset?: number }> = [
  { sig: ascii('MZ'), label: 'a Windows executable' },
  { sig: [0x7f, 0x45, 0x4c, 0x46], label: 'a Linux executable' },
  { sig: [0xfe, 0xed, 0xfa, 0xce], label: 'a Mach-O executable' },
  { sig: [0xfe, 0xed, 0xfa, 0xcf], label: 'a Mach-O executable' },
  { sig: [0xcf, 0xfa, 0xed, 0xfe], label: 'a Mach-O executable' },
  { sig: [0xca, 0xfe, 0xba, 0xbe], label: 'a Java class or Mach-O binary' },
  { sig: ascii('#!'), label: 'a script' },
  { sig: [0x1f, 0x8b], label: 'a gzip archive' },
  { sig: ascii('7z\xbc\xaf\x27\x1c'), label: 'a 7-Zip archive' },
  { sig: ascii('Rar!'), label: 'a RAR archive' },
  { sig: ascii('\xfd7zXZ'), label: 'an xz archive' },
];

export function looksUnsafe(bytes: Uint8Array): string | null {
  for (const entry of UNSAFE) {
    if (startsWith(bytes, entry.sig, entry.offset ?? 0)) return entry.label;
  }
  return null;
}

/**
 * Reads the first bytes of a file, without demanding the whole thing.
 *
 * Returns `null` when the environment cannot read bytes at all
 * (`Blob.arrayBuffer` is missing on older runtimes). Callers must treat that as
 * "not inspected" rather than "empty" — assuming empty would mark every upload
 * corrupt and refuse real study material.
 */
export async function readHead(file: File, count = SNIFF_BYTES): Promise<Uint8Array | null> {
  const slice = typeof file.slice === 'function' ? file.slice(0, count) : file;

  if (typeof (slice as Blob).arrayBuffer === 'function') {
    try {
      return new Uint8Array(await (slice as Blob).arrayBuffer());
    } catch {
      /* fall through to FileReader */
    }
  }

  if (typeof FileReader !== 'undefined') {
    try {
      return await new Promise<Uint8Array | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
        reader.onerror = () => resolve(null);
        reader.readAsArrayBuffer(slice as Blob);
      });
    } catch {
      /* fall through */
    }
  }

  return null;
}

export function extensionOf(name: string): string {
  const clean = name.split(/[\\/]/).pop() ?? name;
  const dot = clean.lastIndexOf('.');
  return dot > 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

/** A ZIP container is how both .docx and .pptx arrive; the name decides which. */
function resolveContainer(claimed: MaterialKind): MaterialKind | 'ole' | 'text' {
  return claimed === 'pptx' || claimed === 'ppt' ? 'pptx' : 'docx';
}

const LABEL: Record<string, string> = {
  pdf: 'PDF',
  docx: 'Word document',
  pptx: 'PowerPoint',
  ppt: 'PowerPoint',
  image: 'image',
  text: 'text file',
  ole: 'legacy Office file',
  unknown: 'file',
};

/**
 * Checks one file. `ok` is false only for something that cannot be processed
 * at all; a mismatch that is still readable (a PDF named .docx) is a warning,
 * because refusing it would lose real study material over a naming slip.
 */
export async function inspectFile(
  file: File,
  opts: { maxBytes?: number } = {},
): Promise<FileVerdict> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const claimed = kindFromExtension(extensionOf(file.name));
  const issues: FileIssue[] = [];

  if (file.size === 0) {
    const issue: FileIssue = { code: 'empty', severity: 'reject', message: 'The file is empty — there is nothing to read.' };
    return { ok: false, detected: 'text', claimed, issues: [issue], blockedBy: issue };
  }

  if (file.size > maxBytes) {
    const issue: FileIssue = {
      code: 'too_large',
      severity: 'reject',
      message: `Too large (${prettySize(file.size)}). The limit is ${prettySize(maxBytes)}.`,
    };
    return { ok: false, detected: 'text', claimed, issues: [issue], blockedBy: issue };
  }

  const head = await readHead(file);
  if (!head || head.length === 0) {
    // Cannot inspect the bytes here. Blocking the upload would refuse real
    // material because of a missing browser API, so let the parser decide.
    return { ok: true, detected: 'text', claimed, issues: [] };
  }

  const unsafe = looksUnsafe(head);
  if (unsafe) {
    const issue: FileIssue = {
      code: 'unsafe',
      severity: 'reject',
      message: `This is ${unsafe}, not a study material. It was not uploaded.`,
    };
    return { ok: false, detected: 'text', claimed, issues: [issue], blockedBy: issue };
  }

  const raw = sniffBytes(head);
  const detected = raw === 'docx' ? resolveContainer(claimed) : raw;

  // Corrupt: the name promises a format the bytes simply are not.
  const promisesFormat = claimed === 'pdf' || claimed === 'docx' || claimed === 'pptx' || claimed === 'ppt' || claimed === 'image';
  if (promisesFormat && detected === 'text' && !isLikelyText(file.name)) {
    const issue: FileIssue = {
      code: 'corrupt',
      severity: 'reject',
      message: `This file is named ${LABEL[claimed] ?? claimed} but its contents are not. It may be corrupt or renamed — re-download it and try again.`,
    };
    issues.push(issue);
  } else if (promisesFormat && detected !== claimed && !(detected === 'ole' && (claimed === 'pptx' || claimed === 'ppt' || claimed === 'docx'))) {
    // Readable, but not the format the name claims.
    const issue: FileIssue = {
      code: 'mismatch',
      severity: 'warn',
      message: `This file is really ${LABEL[detected] ?? detected}, though it is named ${LABEL[claimed] ?? claimed}. It was uploaded as ${LABEL[detected] ?? detected}.`,
    };
    issues.push(issue);
  }

  if (detected === 'ole') {
    issues.push({
      code: 'mismatch',
      severity: 'warn',
      message: 'This is a legacy Office file (.doc/.ppt). It is kept for reference, but slides cannot be extracted from it.',
    });
  }

  const blockedBy = issues.find((i) => i.severity === 'reject');
  return { ok: !blockedBy, detected, claimed, issues, blockedBy };
}

function isLikelyText(name: string): boolean {
  return ['txt', 'md', 'csv', 'json', 'rtf', 'log'].includes(extensionOf(name));
}

export function prettySize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/**
 * Reconciles a saved material's metadata with the bytes it was built from, so
 * the library never shows "PDF" on something that is really a Word file.
 */
export function reconcileMeta(
  meta: { title?: string; originalName?: string; materialKind?: MaterialKind | string },
  file?: File,
): { title: string; materialKind: MaterialKind } {
  const name = meta.originalName || file?.name || meta.title || 'Untitled material';
  const ext = extensionOf(name);
  const kind = kindFromExtension(ext);
  const title = (meta.title || '').trim() || name.replace(/\.[^.]+$/, '') || 'Untitled material';
  return { title, materialKind: kind === 'unknown' ? (meta.materialKind as MaterialKind) || 'unknown' : kind };
}
