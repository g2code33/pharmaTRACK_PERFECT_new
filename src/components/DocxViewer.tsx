import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Download, FileText, Loader2, ZoomIn, ZoomOut,
} from 'lucide-react';

/**
 * Word document viewer — renders the ORIGINAL .docx file, not text extracted
 * from it. docx-preview (Apache-2.0) lays out document.xml faithfully in the
 * browser: paragraphs with their real fonts and spacing, tables, lists,
 * images, headers/footers and footnotes, page-per-section flow — offline, on
 * every platform the app ships to (it runs in the same WebView as the app).
 *
 * Mammoth remains in the app for what it is good at — plain-text extraction
 * for search and AI context — but it is never the visual document path.
 *
 * Explicitly NOT rendered: tracked-change balloons, macros and embedded
 * OLE objects (docx-preview does not draw them). The original file is always
 * one click away (Download Original).
 */

export interface DocxViewerProps {
  fileUrl: string;
  title?: string;
  /** When the material was added (informational). */
  uploadDate?: string;
  onAskAi?: (text: string) => void;
}

const ZOOM_STEPS = [0.75, 1, 1.25, 1.5];

const DocxViewer: React.FC<DocxViewerProps> = ({ fileUrl, title, onAskAi }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const stylesRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [selectionText, setSelectionText] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectionText('');

    (async () => {
      try {
        const blob = await (await fetch(fileUrl)).blob();
        const { renderAsync } = await import('docx-preview');
        const body = bodyRef.current;
        if (!body || cancelled) return;
        // docx-preview writes its page styles into the second container, so
        // everything it creates is removed with this component — nothing
        // leaks into <head> across documents.
        body.replaceChildren();
        await renderAsync(blob, body, stylesRef.current ?? undefined, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          useBase64URL: true,
        });
        if (!cancelled) setLoading(false);
      } catch (err) {
        console.error('DOCX render failed:', err);
        if (!cancelled) {
          setError('This document could not be rendered. It may be corrupted, password-protected, or in the older .doc format (only .docx is rendered visually).');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      bodyRef.current?.replaceChildren();
    };
  }, [fileUrl]);

  const download = useCallback(() => {
    const base = title?.trim() || 'document';
    const name = /\.docx?$/i.test(base) ? base : `${base}.docx`;
    const a = document.createElement('a');
    a.href = fileUrl;
    a.download = name;
    a.click();
  }, [fileUrl, title]);

  const askAi = useCallback(() => {
    const text = (selectionText || window.getSelection()?.toString() || '').trim();
    if (text && onAskAi) onAskAi(text);
  }, [selectionText, onAskAi]);

  const iconBtn = 'rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800 disabled:opacity-40';

  /* ---------------- error state ---------------- */
  if (!loading && error) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-100 p-4" data-testid="docx-viewer-error">
        <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50">
            <AlertTriangle className="h-7 w-7 text-red-500" />
          </div>
          <h3 className="text-lg font-bold text-gray-900">Unable to render this Word document</h3>
          <p className="mt-2 text-sm text-gray-500">
            Visual rendering failed. Your original document is safe. {error}
          </p>
          <button
            onClick={download}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-[#2D6A4F] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#24523e] transition-colors"
          >
            <Download className="h-4 w-4" /> Download Original
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-slate-200">
      {/* toolbar */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-slate-300 bg-slate-100 px-2 py-1.5 shadow-sm">
        <span className="mr-1 flex items-center gap-1.5 rounded-lg bg-white px-2 py-1 text-[11px] font-black uppercase tracking-wider text-blue-600 shadow-sm">
          <FileText className="h-3.5 w-3.5" /> Word
        </span>
        <div className="ml-1 flex items-center gap-0.5">
          <button
            onClick={() => setZoom((z) => Math.max(ZOOM_STEPS[0], ZOOM_STEPS[Math.max(0, ZOOM_STEPS.indexOf(z) - 1)] ?? ZOOM_STEPS[0]))}
            disabled={zoom <= ZOOM_STEPS[0]}
            title="Zoom out"
            className={iconBtn}
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="w-12 text-center text-xs font-bold tabular-nums text-slate-500">{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => setZoom((z) => Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, ZOOM_STEPS.indexOf(z) + 1)] ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]))}
            disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            title="Zoom in"
            className={iconBtn}
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>
        {onAskAi ? (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={askAi}
            disabled={!selectionText.trim()}
            title={selectionText.trim() ? 'Ask AI about the selected text' : 'Select text in the document first'}
            className={`${iconBtn} disabled:cursor-default`}
          >
            <span className="px-1 text-[10px] font-black uppercase tracking-wide">Ask AI</span>
          </button>
        ) : null}
        <div className="ml-auto" />
        <button onClick={download} title="Download original file" className={iconBtn}>
          <Download className="h-4 w-4" />
        </button>
      </div>

      {/* body */}
      <div className="docx-viewer-scroll relative flex-1 overflow-auto p-4" data-testid="docx-viewer-scroll">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm font-bold text-slate-400" data-testid="docx-viewer-loading">
            <Loader2 className="h-5 w-5 animate-spin" /> Rendering document…
          </div>
        ) : null}
        {/* docx-preview's page styles live here so they unmount with the viewer */}
        <div ref={stylesRef} className="hidden" aria-hidden="true" />
        <div
          className="mx-auto w-fit"
          style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
          onMouseUp={() => setSelectionText(window.getSelection()?.toString() ?? '')}
        >
          <div ref={bodyRef} className="docx-body" data-testid="docx-viewer-body" />
        </div>
      </div>
    </div>
  );
};

export default DocxViewer;
