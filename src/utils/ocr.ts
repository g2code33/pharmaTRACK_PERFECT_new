import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Optional OCR for scanned handouts.
 *
 * A scanned PDF is a picture of text: pdf.js extracts nothing, so the material
 * is invisible to search and useless as AI context. OCR fixes that.
 *
 * It is opt-in per upload because it is slow (seconds per page) and pulls a
 * large model file. Tesseract.js is used rather than a cloud OCR API so it
 * still works with no internet, which is the point of this app.
 *
 * tesseract.js is imported dynamically so its ~15 MB never lands in the main
 * bundle for the majority of users who never scan anything.
 */

export interface OcrProgress {
  /** 0-1 across the whole job. */
  progress: number;
  page: number;
  totalPages: number;
  status: string;
}

/** Heuristic: does this PDF already have a usable text layer? */
export const pdfHasTextLayer = async (data: Uint8Array): Promise<boolean> => {
  try {
    const pdf = await pdfjs.getDocument({ data: data.slice(0) }).promise;
    const sample = Math.min(pdf.numPages, 3);
    let chars = 0;
    for (let i = 1; i <= sample; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      chars += content.items.map((it: any) => it.str).join('').trim().length;
    }
    pdf.destroy();
    // Fewer than ~100 characters across the first pages means it's almost
    // certainly scanned images rather than real text.
    return chars > 100;
  } catch {
    return true; // on failure, assume text so we don't force slow OCR
  }
};

/** Renders one PDF page to a canvas at a resolution OCR can read reliably. */
const pageToCanvas = async (pdf: pdfjs.PDFDocumentProxy, pageNum: number): Promise<HTMLCanvasElement> => {
  const page = await pdf.getPage(pageNum);
  // 2x gives Tesseract enough pixels for small print without exploding memory.
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
};

export const ocrPdf = async (
  data: Uint8Array,
  onProgress?: (p: OcrProgress) => void,
  signal?: AbortSignal,
): Promise<{ page: number; text: string }[]> => {
  const { createWorker } = await import('tesseract.js');
  const pdf = await pdfjs.getDocument({ data: data.slice(0) }).promise;
  const total = pdf.numPages;
  const worker = await createWorker('eng');
  const results: { page: number; text: string }[] = [];

  try {
    for (let i = 1; i <= total; i++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

      onProgress?.({ progress: (i - 1) / total, page: i, totalPages: total, status: `Reading page ${i} of ${total}…` });

      const canvas = await pageToCanvas(pdf, i);
      const { data: { text } } = await worker.recognize(canvas);
      results.push({ page: i, text: text.trim() });

      // Free the bitmap immediately; a 100-page scan would otherwise hold
      // every page's canvas in memory at once.
      canvas.width = 0;
      canvas.height = 0;
    }
    onProgress?.({ progress: 1, page: total, totalPages: total, status: 'Finishing…' });
    return results;
  } finally {
    await worker.terminate();
    pdf.destroy();
  }
};

export const ocrImage = async (
  file: Blob,
  onProgress?: (p: OcrProgress) => void,
): Promise<string> => {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng');
  try {
    onProgress?.({ progress: 0.3, page: 1, totalPages: 1, status: 'Reading image…' });
    const { data: { text } } = await worker.recognize(file);
    onProgress?.({ progress: 1, page: 1, totalPages: 1, status: 'Done' });
    return text.trim();
  } finally {
    await worker.terminate();
  }
};
