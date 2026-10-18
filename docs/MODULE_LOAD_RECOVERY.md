# Module load recovery (the "'application/pdf' is not a valid JavaScript MIME type" card)

## What the error means

A page is a JavaScript module. The webview will only execute a module when the
response says it is JavaScript, so this message is a **load** failure — the
page's code never ran. Nothing the student saved is involved: courses, slides,
notes and answers live in local storage, not in the bundle.

## Why the desktop app can produce it at all

The desktop shell serves its own files through Tauri's asset protocol, and that
protocol decides a response's `Content-Type` **from the file's bytes**
(`tauri-utils` `MimeType::parse` runs `infer` over the prologue), not from the
file name. So a `.js` file whose first bytes are `%PDF` is served as
`application/pdf`, and WebKit refuses to import it.

Two situations end there:

1. the bytes are really something else (a damaged installation), or
2. the bytes are the right JavaScript but the response carries the wrong label
   (a webview-level mix-up between concurrent responses).

Tauri's handler also answers a **missing** file with `index.html`, which is the
usual cause of the sibling message "'text/html' is not a valid JavaScript MIME
type" around deployments.

## What the app does about it now

`src/utils/routeLoader.ts` → `lazyWithRetry`:

1. import → retry once (cold cache, dropped connection);
2. re-import the same file under a unique query (a rejected specifier is
   remembered by the engine, so repeating it is useless);
3. **byte-level rescue** (`src/utils/moduleRescue.ts`): `fetch()` the exact
   file (a normal fetch is not subject to the module MIME check), verify the
   bytes really are JavaScript, rewrite its relative imports and
   `import.meta.url` against the original URL, and import it from a `blob:`
   URL created with `type: 'text/javascript'`. The page opens in case 2;
   case 1 throws `DamagedAssetError`, which names the file, says it arrived as
   a PDF/web page, and states the repair;
4. only then, one guarded service-worker refresh + reload;
5. otherwise the route error boundary shows the recovery card with the real
   error text and the failing file.

Because WebKit's refusal names the MIME type but **not** the URL, the file is
resolved deterministically from `chunk-map.json` — written at build time by the
`routeChunkMap` plugin in `vite.config.ts`, mapping each page's source path (the
third argument to `lazyRoute`) to the chunk that build emitted. The resource
timeline is only consulted when that lookup misses.

Inside a packaged shell, background route prefetching is disabled: the bundle
is already local, and warming a dozen chunks at once is both unnecessary and
the situation most likely to produce a mis-labelled response.

## For an installation that is actually damaged

- Linux (deb): `bash scripts/verify-ubuntu.sh` checks every shipped file
  against `dist/integrity.json` straight from disk, no webview involved, and
  prints the size and first bytes of anything that does not match.
- The app also verifies itself at startup and shows a red banner naming the
  first wrong file plus the reinstall command.
- A reinstall over the top keeps user data (it lives outside the install
  directory).
