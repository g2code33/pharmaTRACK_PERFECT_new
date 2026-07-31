import React, { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
import * as mammoth from 'mammoth';
import { renderPptx } from '../utils/pptxRenderer';
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

const iconFor = (kind: UploadKind) => {
  if (kind === 'image') return ImageIcon;
  if (kind === 'pptx') return Presentation;
  return FileText;
};

const prettySize = (bytes: number) =>
  bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const FileUploader: React.FC<FileUploaderProps> = ({
  onComplete,
  accept = '.pdf,.docx,.doc,.pptx,.pptm,.ppt,.txt,.md,.csv,image/*',
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

  const processPdf = async (item: QueueItem, buffer: ArrayBuffer): Promise<{ text: string; pages: number; ocr: boolean }> => {
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
      };
    }

    const pdf = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      if (item.controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += `--- Page ${i} ---\n${content.items.map((it: any) => it.str).join(' ')}\n\n`;
      update(item.id, { progress: i / pdf.numPages, message: `Reading page ${i} of ${pdf.numPages}…` });
    }
    const pages = pdf.numPages;
    pdf.destroy();

    // Flag it so the UI can suggest OCR, rather than silently storing nothing.
    if (!hasText) update(item.id, { looksScanned: true });
    return { text, pages, ocr: false };
  };

  const processFile = async (item: QueueItem) => {
    try {
      update(item.id, { status: 'reading', progress: 0, message: 'Opening file…' });
      const buffer = await item.file.arrayBuffer();

      let text = '';
      let pages = 1;
      let usedOcr = false;

      if (item.kind === 'pdf') {
        const r = await processPdf(item, buffer);
        text = r.text; pages = r.pages; usedOcr = r.ocr;
      } else if (item.kind === 'docx') {
        const r = await mammoth.extractRawText({ arrayBuffer: buffer });
        text = r.value;
      } else if (item.kind === 'pptx') {
        const deck = await renderPptx(item.file);
        text = deck.fullText;
        pages = deck.slides.length;
        deck.dispose();
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
      await saveFile(materialId, new Uint8Array(buffer));

      update(item.id, { status: 'done', progress: 1, message: usedOcr ? `Read ${pages} page(s) with OCR` : `Ready · ${pages} page(s)`, usedOcr });

      onCompleteRef.current({
        id: materialId,
        title: item.file.name.replace(/\.[^.]+$/, ''),
        kind: item.kind,
        fileType: fileTypeFor(item.kind, item.file),
        text,
        pageCount: pages,
        sizeBytes: item.file.size,
        usedOcr,
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
    for (const file of Array.from(files)) {
      if (file.size > maxSizeMb * 1048576) {
        incoming.push({
          id: uuidv4(), file, kind: kindOf(file), status: 'error', progress: 0, message: '',
          error: `Too large (${prettySize(file.size)}). Maximum is ${maxSizeMb} MB.`,
          usedOcr: false, looksScanned: false, controller: new AbortController(),
        });
        continue;
      }
      incoming.push({
        id: uuidv4(), file, kind: kindOf(file), status: 'queued', progress: 0,
        message: 'Waiting…', usedOcr: false, looksScanned: false, controller: new AbortController(),
      });
    }

    setQueue((q) => [...q, ...incoming]);
    // Sequential, not parallel: several large PDFs decoded at once will
    // exhaust memory on a modest laptop.
    (async () => {
      for (const item of incoming) {
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
        className={`border-2 border-dashed rounded-2xl text-center cursor-pointer transition-all ${compact ? 'p-6' : 'p-10'} ${
          dragging ? 'border-[#2D6A4F] bg-[#2D6A4F]/5 scale-[1.01]' : 'border-slate-300 hover:border-[#2D6A4F] hover:bg-slate-50'
        }`}
      >
        <Upload className={`mx-auto mb-3 ${dragging ? 'text-[#2D6A4F]' : 'text-slate-400'} ${compact ? 'w-8 h-8' : 'w-12 h-12'}`} />
        <p className="font-bold text-slate-700">
          {dragging ? 'Drop to upload' : 'Drag files here, or click to browse'}
        </p>
        <p className="text-xs text-slate-400 mt-1">
          PDF · Word · PowerPoint · Images — up to {maxSizeMb} MB each
        </p>
      </div>

      <label className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl cursor-pointer hover:bg-amber-100/60 transition-colors">
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
              <div key={item.id} className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-xl">
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
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
