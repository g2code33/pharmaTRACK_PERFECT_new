/**
 * Best-effort text extraction — for search indexing and AI context ONLY.
 *
 * Contract (the document-engine rules, enforced here):
 *   1. Nothing in this module is ever allowed to sit on the *opening* path.
 *      Opening a document renders the original file (see components/*Viewer
 *      and documents/registry). These extractors exist so search, deep links
 *      and AI questions have text to work with.
 *   2. Extraction is best-effort: a file that cannot be read for text still
 *      uploads, still opens, and still downloads. Every function catches its
 *      own failures and reports them in the result instead of throwing.
 *   3. Extraction works from the file the user already has — no network, no
 *      OCR unless the caller explicitly ran the OCR path (see utils/ocr).
 *
 * What each format gets:
 *   pdf  — page-by-page text layer via PDF.js (the same worker the viewer
 *          uses). Scanned PDFs without a text layer produce empty pages;
 *          OCR remains an explicit, user-requested step at upload.
 *   pptx — the light <a:t> pass over slide XML only: no shapes, layouts,
 *          themes or media are parsed. A full visual parse of a 150-slide
 *          deck takes seconds; this takes milliseconds and is all search
 *          needs. (pptxRenderer.getSlideTexts does the deeper, ordered pass
 *          with speaker notes when the reader needs it.)
 *   docx — mammoth raw text.
 *   xlsx — SheetJS cell display values, one "page" per worksheet.
 */

import * as pdfjs from 'pdfjs-dist';
import JSZip from 'jszip';
import { readBlobArrayBuffer } from './fileGuard';

// Bundle the worker locally. This previously pointed at a CDN, which meant
// PDF processing failed or silently half-completed whenever the user was
// offline - the usual case for this app.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface ExtractedPage {
  page: number;
  text: string;
}

export interface ExtractionResult {
  /** '--- Page N ---'-style joined text, or '' when nothing could be read. */
  text: string;
  pages: ExtractedPage[];
  /** True when the format was recognised but its text could not be read. */
  failed: boolean;
}

const emptyResult = (failed = false): ExtractionResult => ({ text: '', pages: [], failed });

const joinPages = (pages: ExtractedPage[]): string =>
  pages.map((p) => `--- Page ${p.page} ---\n${p.text}`).join('\n\n');

/* ------------------------------------------------------------------ */
/* PDF                                                                  */
/* ------------------------------------------------------------------ */

export interface PdfTextOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Page-by-page PDF text layer. Yields between pages so a large lecture does
 * not freeze the UI thread, and aborts cleanly via `signal`.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  opts: PdfTextOptions = {},
): Promise<ExtractionResult> {
  let pdf: pdfjs.PDFDocumentProxy | null = null;
  try {
    pdf = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
    const pages: ExtractedPage[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      if (opts.signal?.aborted) break;
      let pageText = '';
      try {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        pageText = content.items.map((it: any) => it.str).join(' ');
        page.cleanup();
      } catch {
        /* one unreadable page must not sink the rest */
      }
      pages.push({ page: i, text: pageText });
      opts.onProgress?.(i, pdf.numPages);
      if (i % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { text: joinPages(pages), pages, failed: false };
  } catch {
    return emptyResult(true);
  } finally {
    try {
      pdf?.destroy();
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------------ */
/* PPTX (light pass — no rendering, no layouts, no media)               */
/* ------------------------------------------------------------------ */

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;

/**
 * Slide XML text only. Milliseconds even for large decks; the reader's
 * visual parse (pptxRenderer) is a separate, on-demand path.
 */
export async function extractPptxSlideTexts(data: ArrayBuffer | Blob): Promise<ExtractionResult> {
  try {
    const bytes = data instanceof Blob ? new Uint8Array(await readBlobArrayBuffer(data)) : null;
    const zip = await JSZip.loadAsync(bytes ?? data);
    const entries = Object.keys(zip.files)
      .map((name) => {
        const m = SLIDE_RE.exec(name);
        return m ? { name, n: parseInt(m[1], 10) } : null;
      })
      .filter((e): e is { name: string; n: number } => !!e)
      .sort((a, b) => a.n - b.n);

    const pages: ExtractedPage[] = [];
    for (const entry of entries) {
      const xml = await zip.file(entry.name)?.async('text');
      if (!xml) continue;
      let text = '';
      try {
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        // Join runs within a paragraph with no separator (PowerPoint splits a
        // single word across runs); join paragraphs with newlines.
        text = Array.from(doc.getElementsByTagName('a:p'))
          .map((p) =>
            Array.from(p.getElementsByTagName('a:t'))
              .map((t) => t.textContent || '')
              .join(''),
          )
          .filter((t) => t.trim())
          .join('\n');
      } catch {
        /* one malformed slide does not sink the deck */
      }
      pages.push({ page: entry.n, text });
    }
    if (!pages.length) return emptyResult(true);
    return { text: joinPages(pages), pages, failed: false };
  } catch {
    return emptyResult(true);
  }
}

/* ------------------------------------------------------------------ */
/* DOCX                                                                 */
/* ------------------------------------------------------------------ */

export async function extractDocxText(data: ArrayBuffer | Blob): Promise<ExtractionResult> {
  try {
    const arrayBuffer = data instanceof Blob ? await readBlobArrayBuffer(data) : data;
    // The browser build calls this `arrayBuffer`; the Node build used by tests
    // calls it `buffer`. Supplying both avoids a browser Buffer polyfill.
    const input = { arrayBuffer, buffer: arrayBuffer as unknown as Buffer };
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText(input);
    const text = result.value ?? '';
    if (!text.trim()) return emptyResult(true);
    return { text, pages: [{ page: 1, text }], failed: false };
  } catch {
    return emptyResult(true);
  }
}

/* ------------------------------------------------------------------ */
/* XLSX / XLS / CSV (SheetJS community edition)                         */
/* ------------------------------------------------------------------ */

export async function extractSpreadsheetText(bytes: Uint8Array): Promise<ExtractionResult> {
  try {
    const XLSX = await import('@e965/xlsx');
    const wb = XLSX.read(bytes, { type: 'array' });
    const pages: ExtractedPage[] = [];
    wb.SheetNames.forEach((name, idx) => {
      const ws = wb.Sheets[name];
      if (!ws) return;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '' });
      const text = rows
        .map((row) => (row as string[]).join('\t'))
        .filter((line) => line.trim())
        .join('\n');
      pages.push({ page: idx + 1, text: text ? `[Sheet: ${name}]\n${text}` : '' });
    });
    if (!pages.length) return emptyResult(true);
    return { text: joinPages(pages), pages, failed: false };
  } catch {
    return emptyResult(true);
  }
}

/* ------------------------------------------------------------------ */
/* Text files                                                           */
/* ------------------------------------------------------------------ */

export async function extractPlainText(file: Blob): Promise<ExtractionResult> {
  try {
    const text = await file.text();
    return { text, pages: [{ page: 1, text }], failed: false };
  } catch {
    return emptyResult(true);
  }
}
