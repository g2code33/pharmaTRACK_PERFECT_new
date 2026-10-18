/**
 * The one place the pdf.js worker is initialised — for every viewer, extractor
 * and converter in the app.
 *
 * Why a blob and not a URL like before:
 *
 * The worker used to be imported with `?url`, which makes the bundler emit it
 * as a real file (`assets/pdf.worker.min-<hash>.js`) and hand the code a URL to
 * fetch. That path fails on the Linux desktop app in two stacked ways:
 *
 *  1. `new Worker("tauri://localhost/…")` — WebKitGTK does not load dedicated
 *     workers from the app's custom scheme, so pdf.js silently falls back to
 *     its "fake worker", which runs all PDF parsing on the main thread. That
 *     alone makes the whole app stutter while any PDF is open.
 *  2. The fake worker loads the worker file with a <script> tag — and on
 *     affected machines that response arrives with a PDF's MIME type, so the
 *     engine refuses to execute it ("'application/pdf' is not a valid
 *     JavaScript MIME type") and whatever was rendering crashes to the route
 *     error boundary.
 *
 * Inlining the worker with `?raw` and creating it from a blob URL avoids every
 * step of that chain: no network request, no custom scheme, no MIME sniffing,
 * and a real worker thread on every platform. The ~1 MB source string lives in
 * one shared chunk, exactly like the emitted file did.
 */
import * as pdfjs from 'pdfjs-dist';
import workerSource from 'pdfjs-dist/build/pdf.worker.min.js?raw';

let initialised = false;

/** Idempotent; safe to call from every module that renders or reads a PDF. */
export function ensurePdfWorker(): void {
  if (initialised) return;
  initialised = true;
  try {
    const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    pdfjs.GlobalWorkerOptions.workerSrc = url;
  } catch {
    // Nothing we can do here — pdf.js falls back to its main-thread
    // "fake worker", which is slow but still correct.
  }
}

ensurePdfWorker();
