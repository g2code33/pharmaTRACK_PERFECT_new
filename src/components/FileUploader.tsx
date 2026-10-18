import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
import * as mammoth from 'mammoth';
import { ocrStatusFor, type MaterialKind, type OcrStatus, type VisualStatus } from '../utils/materialKind';
import { inspectFile } from '../utils/fileGuard';
import { pdfHasTextLayer, ocrPdf, ocrImage, type OcrProgress } from '../utils/ocr';
import { saveFile } from '../utils/storage';
import {
  Upload, FileText, Image as ImageIcon, Presentation, X, CheckCircle2,
  AlertCircle, Loader2, ScanLine, Trash2,
} from 'lucide-react';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * The single upload path for the whole app.
 *
 * Replaces four separate, inconsistent <input type="file"> implementations
 * (StudyMaterials had two, plus CourseDetail and Notes) that each had their own
 * partial handling, no size limit, no progress and no error reporting.
 *
 * Key behaviour change: one file produces ONE material. The previous bulk
 * handler created a separate Slide row per file and the transcript button added
 * yet another, which is what produced the "separate separate" mess. Page
 * navigation belongs to the viewer, not the data model.
 */

export type UploadKind = 'pdf' | 'docx' | 'pptx' | 'image' | 'text';

export interface UploadedMaterial {
  /** Per-page text, stored in the search index so deep keywords are findable. */
  pages?: { page: number; text: string }[];
  id: string;
  title: string;
  kind: UploadKind;
  /** Extension stored on the Slide record. */
  fileType: 'pdf' | 'jpg' | 'png' | 'text';
  /** Extracted text, used for search and AI context. */
  text: string;
  pageCount: number;
  sizeBytes: number;
  usedOcr: boolean;
  materialKind?: MaterialKind;
  originalName?: string;
  ocrStatus?: OcrStatus;
  visualStatus?: VisualStatus;
}

type ItemStatus = 'queued' | 'reading' | 'ocr' | 'saving' | 'done' | 'error' | 'cancelled';

interface QueueItem {
  id: string;
  file: File;
  kind: UploadKind;
  status: ItemStatus;
  progress: number;
  message: string;
  error?: string;
  /** Non-blocking finding from the file guard (e.g. "really a Word document"). */
  warning?: string;
  usedOcr: boolean;
  /** Set when we detect a scanned PDF and OCR wasn't requested. */
  looksScanned: boolean;
  controller: AbortController;
}

interface FileUploaderProps {
  /** Called once per successfully processed file. */
  onComplete: (material: UploadedMaterial) => void;
  /** Restrict accepted types; defaults to everything supported. */
  accept?: string;
  maxSizeMb?: number;
  /** Tighter padding for dialogs. Always multi-file either way. */
  compact?: boolean;
}

const MAX_DEFAULT_MB = 100;

const kindOf = (file: File): UploadKind => {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx' || ext === 'doc') return 'docx';
  if (ext === 'pptx' || ext === 'pptm' || ext === 'ppt') return 'pptx';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext)) return 'image';
  return 'text';
};

const fileTypeFor = (kind: UploadKind, file: File): UploadedMaterial['fileType'] => {
  if (kind === 'pdf') return 'pdf';
  if (kind === 'image') return file.name.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  return 'text';
};

const uploadKindFromDetected = (detected: MaterialKind | 'ole' | 'text', file: File): UploadKind => {
  switch (detected) {
    case 'pdf': return 'pdf';
    case 'docx': return 'docx';
    case 'pptx': return 'pptx';
    case 'image': return 'image';
    default: return kindOf(file);
  }
};

const iconFor = (kind: UploadKind) => {
  if (kind === 'image') return ImageIcon;
  if (kind === 'pptx') return Presentation;
  return FileText;
};

const prettySize = (bytes: number) =>
  bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const FileUploader: React.FC<FileUploaderProps> = ({
  onComplete,
  // Extensions only — no MIME wildcard (`image/*`) mixed in. Combining a
  // MIME wildcard with a bare-extension list in the same `accept` string is
  // a known trigger for native file dialogs (WebKitGTK's GTK file chooser on
  // Linux especially) to mis-resolve the filter and render every folder as
  // completely empty, even though matching files are right there. Every
  // supported extension is still listed explicitly (so nothing gets greyed
  // out the way `.pptm`/`.doc` used to), and `inspectFile()`'s byte-sniffing
  // below is the real gatekeeper regardless of what the OS dialog shows.
  accept = '.pdf,.docx,.doc,.pptx,.pptm,.ppt,.txt,.md,.csv,.jpg,.jpeg,.png,.webp,.gif,.bmp',
  maxSizeMb = MAX_DEFAULT_MB,
  compact = false,
}) => {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [ocrRequested, setOcrRequested] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  // Callers pass an inline arrow for onComplete, so React creates a new
  // function every render. addFiles is memoised and processing is async, so a
  // captured onComplete goes stale: uploads finished against the FIRST render's
  // closure, where selectedTopicId was still '' — every file was silently
  // rejected with "Pick a topic first". Reading through a ref always calls the
  // current handler. Same for ocrRequested, which the user can toggle after
  // dropping files.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  const ocrRequestedRef = useRef(ocrRequested);
  useEffect(() => { ocrRequestedRef.current = ocrRequested; }, [ocrRequested]);

  const update = (id: string, patch: Partial<QueueItem>) =>
    setQueue((q) => q.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  /* ---------------- per-type processing ---------------- */

  const processPdf = async (
    item: QueueItem,
    buffer: ArrayBuffer,
  ): Promise<{ text: string; pages: number; ocr: boolean; pageTexts: { page: number; text: string }[] }> => {
    const bytes = new Uint8Array(buffer);
    const hasText = await pdfHasTextLayer(bytes);

    // OCR only when the user asked for it, or when the file plainly has no
    // text layer and they ticked the scanned-document box.
    if (!hasText && ocrRequestedRef.current) {
      update(item.id, { status: 'ocr', message: 'Scanned document — reading text…' });
      const pages = await ocrPdf(
        bytes,
        (p: OcrProgress) => update(item.id, { progress: p.progress, message: p.status }),
        item.controller.signal,
      );
      return {
        text: pages.map((p) => `--- Page ${p.page} ---\n${p.text}`).join('\n\n'),
        pages: pages.length,
        ocr: true,
        pageTexts: pages,
      };
    }

    const pdf = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
    let text = '';
    const pageTexts: { page: number; text: string }[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      if (item.controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((it: any) => it.str).join(' ');
      pageTexts.push({ page: i, text: pageText });
      text += `--- Page ${i} ---\n${pageText}\n\n`;
      update(item.id, { progress: i / pdf.numPages, message: `Reading page ${i} of ${pdf.numPages}…` });
    }
    const pages = pdf.numPages;
    pdf.destroy();

    // Flag it so the UI can suggest OCR, rather than silently storing nothing.
    if (!hasText) update(item.id, { looksScanned: true });
    return { text, pages, ocr: false, pageTexts };
  };

  const processFile = async (item: QueueItem) => {
    try {
      update(item.id, { status: 'reading', progress: 0, message: 'Opening file…' });
      const buffer = await item.file.arrayBuffer();

      let text = '';
      let pages = 1;
      let usedOcr = false;
      let visualStatus: VisualStatus = 'unknown';
      let pageTexts: { page: number; text: string }[] = [];
      let bytesToSave: Uint8Array<ArrayBufferLike> = new Uint8Array(buffer);
      let fileType: UploadedMaterial['fileType'] = fileTypeFor(item.kind, item.file);
      let materialKind: MaterialKind = item.kind === 'pptx' ? 'pptx' : item.kind === 'docx' ? 'docx' : item.kind === 'image' ? 'image' : item.kind;
      let sizeBytes = item.file.size;

      if (item.kind === 'pdf') {
        const r = await processPdf(item, buffer);
        text = r.text; pages = r.pages; usedOcr = r.ocr;
        pageTexts = r.pageTexts;
      } else if (item.kind === 'docx') {
        const r = await mammoth.extractRawText({ arrayBuffer: buffer });
        text = r.value;
      } else if (item.kind === 'pptx') {
        // PowerPoint uploads are normalised to PDF immediately. The reader then
        // uses the fast, bounded PDF renderer instead of reparsing a PPTX on
        // every open, which fixes the freezes users saw with large decks and
        // makes all presentations behave like regular handouts.
        const { convertPptxToPdf } = await import('../utils/pptxToPdf');
        const converted = await convertPptxToPdf(item.file, (progress, message) => {
          update(item.id, { status: 'reading', progress, message });
        });
        text = converted.text;
        pages = converted.pageCount;
        pageTexts = converted.pageTexts;
        bytesToSave = converted.pdfBytes;
        fileType = 'pdf';
        materialKind = 'pdf';
        sizeBytes = converted.pdfBytes.byteLength;
        visualStatus = 'ok';
      } else if (item.kind === 'image') {
        if (ocrRequestedRef.current) {
          update(item.id, { status: 'ocr', message: 'Reading text from image…' });
          text = await ocrImage(item.file, (p) => update(item.id, { progress: p.progress, message: p.status }));
          usedOcr = true;
        } else {
          text = `[Image: ${item.file.name}]`;
        }
      } else {
        text = await item.file.text();
      }

      if (item.controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');

      update(item.id, { status: 'saving', progress: 0.95, message: 'Saving…' });

      const materialId = uuidv4();
      // Binary lives in IndexedDB; only metadata + text go into app state.
      const saved = await saveFile(materialId, bytesToSave);
      if (!saved) {
        // Do NOT call onComplete here — that would create a material record
        // that looks fully uploaded but has no bytes behind it, which is
        // exactly what used to produce "No file is stored for this
        // material" later in the reader with no clue as to why. Surfacing
        // the failure right here, before any record exists, means the user
        // sees it immediately and can retry instead of discovering it much
        // later on a page that can no longer do anything about it.
        update(item.id, {
          status: 'error',
          error: "Couldn't save this file to storage on this device. Check available disk space and try again.",
        });
        return;
      }

      update(item.id, {
        status: 'done',
        progress: 1,
        message: item.kind === 'pptx'
          ? `Converted to PDF · ${pages} slide${pages === 1 ? '' : 's'}`
          : usedOcr ? `Read ${pages} page(s) with OCR` : `Ready · ${pages} page(s)`,
        usedOcr,
      });

      if (!pageTexts.length && text.trim()) pageTexts = [{ page: 1, text }];

      onCompleteRef.current({
        pages: pageTexts,
        id: materialId,
        title: item.file.name.replace(/\.[^.]+$/, ''),
        kind: item.kind,
        fileType,
        text,
        pageCount: pages,
        sizeBytes,
        usedOcr,
        materialKind,
        originalName: item.file.name,
        ocrStatus: ocrStatusFor(materialKind, usedOcr, text),
        visualStatus,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        update(item.id, { status: 'cancelled', message: 'Cancelled' });
        return;
      }
      console.error('Upload failed:', err);
      update(item.id, {
        status: 'error',
        error: err?.message?.includes('password')
          ? 'This file is password protected.'
          : 'Could not read this file. It may be corrupted or in an unsupported format.',
      });
    }
  };

  const addFiles = useCallback((files: FileList | File[]) => {
    const incoming: QueueItem[] = [];
    const pending: File[] = [];

    /**
     * Synchronous rejections first (empty / oversized), so those never even
     * enter the queue as processable work.
     */
    for (const file of Array.from(files)) {
      if (file.size > maxSizeMb * 1048576) {
        incoming.push({
          id: uuidv4(), file, kind: kindOf(file), status: 'error', progress: 0, message: '',
          error: `Too large (${prettySize(file.size)}). Maximum is ${maxSizeMb} MB.`,
          usedOcr: false, looksScanned: false, controller: new AbortController(),
        });
        continue;
      }
      pending.push(file);
    }

    setQueue((q) => [...q, ...incoming]);

    /**
     * Content checks read the head of each file, so they run in parallel and
     * before any parsing. A file whose bytes contradict its name (or which is
     * an executable wearing a .pdf badge) never reaches a parser.
     */
    void (async () => {
      const accepted: QueueItem[] = [];
      for (const file of pending) {
        const verdict = await inspectFile(file, { maxBytes: maxSizeMb * 1048576 });
        const warning = verdict.issues.find((i) => i.severity === 'warn')?.message;

        if (!verdict.ok && verdict.blockedBy) {
          setQueue((q) => [...q, {
            id: uuidv4(), file, kind: kindOf(file), status: 'error', progress: 0, message: '',
            error: verdict.blockedBy!.message,
            usedOcr: false, looksScanned: false, controller: new AbortController(),
          }]);
          continue;
        }

        accepted.push({
          id: uuidv4(), file, kind: uploadKindFromDetected(verdict.detected, file), status: 'queued', progress: 0,
          message: 'Waiting…', usedOcr: false, looksScanned: false, warning,
          controller: new AbortController(),
        });
      }

      if (!accepted.length) return;
      setQueue((q) => [...q, ...accepted]);
      // Sequential, not parallel: several large PDFs decoded at once will
      // exhaust memory on a modest laptop.
      for (const item of accepted) {
        if (item.status !== 'error') await processFile(item);
      }
    })();
  }, [maxSizeMb]);

  /* ---------------- drag & drop ---------------- */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  const busy = queue.some((q) => ['queued', 'reading', 'ocr', 'saving'].includes(q.status));

  return (
    <div className="space-y-3">
      <div
        onClick={() => inputRef.current?.click()}
        onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setDragging(true); }}
        onDragLeave={() => { dragDepth.current--; if (dragDepth.current <= 0) setDragging(false); }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className={`border-2 border-dashed rounded-2xl text-center cursor-pointer touch-manipulation transition-all ${compact ? 'p-4 sm:p-6' : 'p-5 sm:p-10'} ${
          dragging ? 'border-[#2D6A4F] bg-[#2D6A4F]/5 scale-[1.01]' : 'border-slate-300 hover:border-[#2D6A4F] hover:bg-slate-50'
        }`}
      >
        <Upload className={`mx-auto mb-3 ${dragging ? 'text-[#2D6A4F]' : 'text-slate-400'} ${compact ? 'w-8 h-8' : 'w-9 h-9 sm:w-12 sm:h-12'}`} />
        <p className="text-base sm:text-lg font-bold leading-snug text-slate-700">
          {dragging ? 'Drop to upload' : 'Tap to browse or drop files here'}
        </p>
        <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-slate-400 sm:max-w-none">
          PDF · Word · PowerPoint (converted to PDF) · Images — up to {maxSizeMb} MB each
        </p>
      </div>

      <label className="flex items-start gap-3 p-3 sm:p-4 bg-amber-50 border border-amber-200 rounded-xl cursor-pointer hover:bg-amber-100/60 transition-colors">
        <input
          type="checkbox"
          checked={ocrRequested}
          onChange={(e) => setOcrRequested(e.target.checked)}
          className="mt-0.5 w-4 h-4 accent-[#2D6A4F]"
        />
        <span className="flex-1">
          <span className="flex items-center gap-1.5 text-sm font-bold text-amber-900">
            <ScanLine className="w-4 h-4" /> This is a scanned handout or photo
          </span>
          <span className="block text-xs text-amber-700 mt-0.5">
            Reads the text out of scans so they become searchable. Works offline, but takes a few
            seconds per page — leave this off for normal PDFs.
          </span>
        </span>
      </label>

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }}
        className="hidden"
      />

      {queue.length > 0 && (
        <div className="space-y-2">
          {queue.map((item) => {
            const Icon = iconFor(item.kind);
            const active = ['reading', 'ocr', 'saving'].includes(item.status);
            return (
              <div key={item.id} className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-xl shadow-sm">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                  item.status === 'error' ? 'bg-red-50 text-red-500'
                  : item.status === 'done' ? 'bg-green-50 text-green-600'
                  : 'bg-slate-100 text-slate-500'
                }`}>
                  {active ? <Loader2 className="w-4 h-4 animate-spin" />
                    : item.status === 'done' ? <CheckCircle2 className="w-4 h-4" />
                    : item.status === 'error' ? <AlertCircle className="w-4 h-4" />
                    : <Icon className="w-4 h-4" />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-bold text-slate-800 truncate">{item.file.name}</p>
                    <span className="text-[10px] font-bold text-slate-400 flex-shrink-0">{prettySize(item.file.size)}</span>
                  </div>

                  {item.status === 'error' ? (
                    <p className="text-xs text-red-600 mt-0.5">{item.error}</p>
                  ) : (
                    <p className="text-xs text-slate-500 mt-0.5">{item.message}</p>
                  )}

                  {item.warning && item.status !== 'error' ? (
                    <p className="flex items-start gap-1 text-[11px] text-amber-700 mt-0.5" data-testid="upload-warning">
                      <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
                      {item.warning}
                    </p>
                  ) : null}

                  {active && (
                    <div className="h-1 bg-slate-100 rounded-full mt-1.5 overflow-hidden">
                      <div className="h-full bg-[#2D6A4F] rounded-full transition-all duration-300" style={{ width: `${Math.round(item.progress * 100)}%` }} />
                    </div>
                  )}

                  {item.looksScanned && item.status === 'done' && !item.usedOcr && (
                    <p className="text-[11px] text-amber-700 mt-1 flex items-center gap-1">
                      <ScanLine className="w-3 h-3" />
                      No text found — this looks scanned. Re-upload with the box above ticked to make it searchable.
                    </p>
                  )}
                </div>

                {active ? (
                  <button onClick={() => item.controller.abort()} title="Cancel" className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X className="w-4 h-4" /></button>
                ) : (
                  <button onClick={() => setQueue((q) => q.filter((i) => i.id !== item.id))} title="Remove" className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><Trash2 className="w-4 h-4" /></button>
                )}
              </div>
            );
          })}

          {!busy && queue.some((q) => q.status === 'done') && (
            <button onClick={() => setQueue([])} className="w-full py-2 text-xs font-bold text-slate-500 hover:text-slate-700">
              Clear finished
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default FileUploader;
