import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
import {
  ChevronUp, ChevronDown, ZoomIn, ZoomOut, Maximize2, RotateCw,
  Search, X, Loader2, Download, AlertTriangle,
} from 'lucide-react';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Canvas-based PDF viewer.
 *
 * Replaces an <iframe src={blobUrl}#toolbar=0>, which had two fatal problems:
 *  - The bottom of documents was clipped. The wrapper set `minHeight: 85vh`
 *    while the iframe was `absolute inset-0`, so the iframe sized itself to the
 *    parent's computed box rather than the content, and the tail was cut off.
 *  - It was a black box: no access to page count, no text layer, no search, no
 *    way to jump to a page or sync state with the app.
 *
 * Rendering each page to canvas ourselves fixes the clipping (pages are laid
 * out in normal document flow and the container simply scrolls) and unlocks
 * search, zoom, rotation and page navigation.
 */

interface PdfViewerProps {
  /** Blob/object URL of the PDF. */
  fileUrl: string;
  /** Shown in the toolbar and used as the download filename. */
  title?: string;
  /** Fires whenever the visible page changes, so callers can persist progress. */
  onPageChange?: (page: number, total: number) => void;
  /** Text extracted per page, so the parent can index it for global search. */
  onTextExtracted?: (pages: { page: number; text: string }[]) => void;
}

interface PageMatch {
  page: number;
  /** Match index within that page. */
  index: number;
  snippet: string;
}

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;

const PdfViewer: React.FC<PdfViewerProps> = ({ fileUrl, title, onPageChange, onTextExtracted }) => {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fitMode, setFitMode] = useState<'width' | 'free'>('width');

  // Search
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<PageMatch[]>([]);
  const [activeMatch, setActiveMatch] = useState(0);
  const [pageTexts, setPageTexts] = useState<string[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  // Tracks in-flight renders so a scale change mid-render can cancel cleanly;
  // pdf.js throws if two renders target the same canvas concurrently.
  const renderTasks = useRef<Map<number, pdfjs.RenderTask>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);

  /* ---------------- load document ---------------- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDoc(null);

    const task = pdfjs.getDocument(fileUrl);
    task.promise.then(
      (pdf) => {
        if (cancelled) { pdf.destroy(); return; }
        setDoc(pdf);
        setNumPages(pdf.numPages);
        setCurrentPage(1);
        setLoading(false);
      },
      (err) => {
        if (cancelled) return;
        console.error('PDF load failed:', err);
        setError(
          err?.name === 'PasswordException'
            ? 'This PDF is password protected.'
            : 'This PDF could not be opened. It may be corrupted or still uploading.',
        );
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
      task.destroy().catch(() => {});
    };
  }, [fileUrl]);

  /* ---------------- extract text (for search + parent indexing) ---------------- */
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;

    (async () => {
      const texts: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        if (cancelled) return;
        try {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          texts[i - 1] = content.items.map((it: any) => it.str).join(' ');
        } catch {
          texts[i - 1] = '';
        }
      }
      if (cancelled) return;
      setPageTexts(texts);
      onTextExtracted?.(texts.map((text, i) => ({ page: i + 1, text })));
    })();

    return () => { cancelled = true; };
  }, [doc]);

  /* ---------------- responsive fit-to-width ---------------- */
  useEffect(() => {
    if (!doc || fitMode !== 'width') return;
    let cancelled = false;

    const fit = async () => {
      const el = containerRef.current;
      if (!el) return;
      const page = await doc.getPage(1);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1, rotation });
      // 32px accounts for the page's horizontal padding/margin.
      const target = (el.clientWidth - 32) / base.width;
      setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, target)));
    };

    fit();
    const ro = new ResizeObserver(fit);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => { cancelled = true; ro.disconnect(); };
  }, [doc, fitMode, rotation]);

  /* ---------------- render a single page ---------------- */
  const renderPage = useCallback(async (pageNum: number) => {
    if (!doc) return;
    const canvas = canvasRefs.current[pageNum - 1];
    if (!canvas) return;

    // Cancel any render already targeting this canvas.
    renderTasks.current.get(pageNum)?.cancel();

    try {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale, rotation });

      // Render at device pixel ratio so text stays crisp on HiDPI screens,
      // then scale back down with CSS.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const task = page.render({ canvasContext: ctx, viewport });
      renderTasks.current.set(pageNum, task);
      await task.promise;
      renderTasks.current.delete(pageNum);
    } catch (err: any) {
      // RenderingCancelledException is expected when zooming quickly.
      if (err?.name !== 'RenderingCancelledException') {
        console.error(`Failed to render page ${pageNum}:`, err);
      }
    }
  }, [doc, scale, rotation]);

  /* ---------------- lazy render visible pages ---------------- */
  useEffect(() => {
    if (!doc || !numPages) return;

    // Only render pages near the viewport. A 300-page PDF rendered eagerly
    // would exhaust memory and lock the UI.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNum = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) {
            renderPage(pageNum);
            if (entry.intersectionRatio > 0.5) setCurrentPage(pageNum);
          }
        }
      },
      { root: containerRef.current, rootMargin: '200% 0px', threshold: [0, 0.5] },
    );

    pageRefs.current.slice(0, numPages).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [doc, numPages, renderPage]);

  // Re-render everything already on screen when zoom/rotation changes.
  useEffect(() => {
    if (!doc) return;
    const visible = pageRefs.current
      .slice(0, numPages)
      .map((el, i) => ({ el, page: i + 1 }))
      .filter(({ el }) => {
        if (!el || !containerRef.current) return false;
        const r = el.getBoundingClientRect();
        const c = containerRef.current.getBoundingClientRect();
        return r.bottom > c.top - 400 && r.top < c.bottom + 400;
      });
    visible.forEach(({ page }) => renderPage(page));
  }, [scale, rotation, doc, numPages, renderPage]);

  useEffect(() => { onPageChange?.(currentPage, numPages); }, [currentPage, numPages]);

  /* ---------------- navigation ---------------- */
  const goToPage = useCallback((n: number) => {
    const clamped = Math.min(Math.max(1, n), numPages);
    pageRefs.current[clamped - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setCurrentPage(clamped);
  }, [numPages]);

  const zoomBy = (delta: number) => {
    setFitMode('free');
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, +(s + delta).toFixed(2))));
  };

  /* ---------------- search ---------------- */
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || !pageTexts.length) { setMatches([]); return; }

    const found: PageMatch[] = [];
    pageTexts.forEach((text, i) => {
      const hay = text.toLowerCase();
      let from = 0;
      let idx = hay.indexOf(q, from);
      while (idx !== -1 && found.length < 500) {
        const start = Math.max(0, idx - 40);
        found.push({
          page: i + 1,
          index: idx,
          snippet: `${start > 0 ? '…' : ''}${text.slice(start, idx + q.length + 60).trim()}…`,
        });
        from = idx + q.length;
        idx = hay.indexOf(q, from);
      }
    });

    setMatches(found);
    setActiveMatch(0);
    if (found.length) goToPage(found[0].page);
  }, [query, pageTexts, goToPage]);

  const stepMatch = (dir: 1 | -1) => {
    if (!matches.length) return;
    const next = (activeMatch + dir + matches.length) % matches.length;
    setActiveMatch(next);
    goToPage(matches[next].page);
  };

  /* ---------------- keyboard ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT' ||
                     (e.target as HTMLElement)?.tagName === 'TEXTAREA';
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return;
      }
      if (typing) {
        if (e.key === 'Escape') { setShowSearch(false); setQuery(''); }
        if (e.key === 'Enter' && matches.length) { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomBy(0.2); }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); zoomBy(-0.2); }
      if (e.key === 'PageDown' || e.key === 'ArrowRight') goToPage(currentPage + 1);
      if (e.key === 'PageUp' || e.key === 'ArrowLeft') goToPage(currentPage - 1);
      if (e.key === 'Home') goToPage(1);
      if (e.key === 'End') goToPage(numPages);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentPage, numPages, matches, activeMatch, goToPage]);

  const pageNumbers = useMemo(
    () => Array.from({ length: numPages }, (_, i) => i + 1),
    [numPages],
  );

  /* ---------------- render ---------------- */
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full bg-slate-50 p-10 text-center">
        <AlertTriangle className="w-16 h-16 text-red-400 mb-4" />
        <h3 className="text-lg font-black text-slate-800 mb-1">Can't display this PDF</h3>
        <p className="text-sm text-slate-500 max-w-sm mb-6">{error}</p>
        <a href={fileUrl} download={title || 'document.pdf'} className="bg-[#2D6A4F] text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-[#1B4332]">
          <Download className="w-5 h-5" /> Download instead
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-slate-200/60 min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 py-2 bg-white border-b border-slate-200 shadow-sm flex-shrink-0 flex-wrap">
        <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} title="Previous page (←)" className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-30"><ChevronUp className="w-4 h-4" /></button>
        <div className="flex items-center gap-1 text-xs font-bold text-slate-600">
          <input
            type="number"
            value={currentPage}
            min={1}
            max={numPages || 1}
            onChange={(e) => goToPage(parseInt(e.target.value, 10) || 1)}
            className="w-12 px-1.5 py-1 text-center border border-slate-200 rounded-md outline-none focus:ring-2 focus:ring-[#2D6A4F]/20"
          />
          <span className="text-slate-400">/ {numPages || '–'}</span>
        </div>
        <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= numPages} title="Next page (→)" className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-30"><ChevronDown className="w-4 h-4" /></button>

        <div className="w-px h-5 bg-slate-200 mx-1.5" />

        <button onClick={() => zoomBy(-0.2)} title="Zoom out (Ctrl -)" className="p-1.5 rounded-lg hover:bg-slate-100"><ZoomOut className="w-4 h-4" /></button>
        <span className="text-[11px] font-black text-slate-500 w-11 text-center tabular-nums">{Math.round(scale * 100)}%</span>
        <button onClick={() => zoomBy(0.2)} title="Zoom in (Ctrl +)" className="p-1.5 rounded-lg hover:bg-slate-100"><ZoomIn className="w-4 h-4" /></button>
        <button onClick={() => setFitMode((m) => (m === 'width' ? 'free' : 'width'))} title="Fit to width" className={`p-1.5 rounded-lg hover:bg-slate-100 ${fitMode === 'width' ? 'text-[#2D6A4F] bg-[#2D6A4F]/10' : ''}`}><Maximize2 className="w-4 h-4" /></button>
        <button onClick={() => setRotation((r) => (r + 90) % 360)} title="Rotate" className="p-1.5 rounded-lg hover:bg-slate-100"><RotateCw className="w-4 h-4" /></button>

        <div className="w-px h-5 bg-slate-200 mx-1.5" />

        <button onClick={() => { setShowSearch((s) => !s); setTimeout(() => searchInputRef.current?.focus(), 0); }} title="Search in document (Ctrl+F)" className={`p-1.5 rounded-lg hover:bg-slate-100 ${showSearch ? 'text-[#2D6A4F] bg-[#2D6A4F]/10' : ''}`}><Search className="w-4 h-4" /></button>

        <div className="flex-1" />
        <a href={fileUrl} download={title || 'document.pdf'} title="Download" className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-600"><Download className="w-4 h-4" /></a>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200 flex-shrink-0">
          <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={pageTexts.length ? 'Find in document…' : 'Reading document…'}
            className="flex-1 bg-transparent text-sm font-medium outline-none min-w-0"
          />
          {query.length >= 2 && (
            <span className="text-xs font-bold text-slate-500 tabular-nums flex-shrink-0">
              {matches.length ? `${activeMatch + 1} of ${matches.length}` : 'No results'}
            </span>
          )}
          <button onClick={() => stepMatch(-1)} disabled={!matches.length} className="p-1 rounded hover:bg-slate-200 disabled:opacity-30"><ChevronUp className="w-4 h-4" /></button>
          <button onClick={() => stepMatch(1)} disabled={!matches.length} className="p-1 rounded hover:bg-slate-200 disabled:opacity-30"><ChevronDown className="w-4 h-4" /></button>
          <button onClick={() => { setShowSearch(false); setQuery(''); }} className="p-1 rounded hover:bg-slate-200"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Pages. Normal document flow + a single scroll container, so nothing
          can be clipped the way the absolutely-positioned iframe was. */}
      <div ref={containerRef} className="flex-1 overflow-auto min-h-0 py-4 px-2">
        {loading && (
          <div className="flex flex-col items-center justify-center py-32">
            <Loader2 className="w-10 h-10 text-[#FFB703] animate-spin mb-3" />
            <p className="text-sm font-black text-slate-400 uppercase tracking-widest">Opening document…</p>
          </div>
        )}

        {pageNumbers.map((n) => (
          <div
            key={n}
            data-page={n}
            ref={(el) => { pageRefs.current[n - 1] = el; }}
            className="mx-auto mb-4 bg-white shadow-lg rounded-sm relative"
            style={{ width: 'fit-content', minHeight: 120 }}
          >
            <canvas ref={(el) => { canvasRefs.current[n - 1] = el; }} className="block rounded-sm" />
            <span className="absolute bottom-2 right-2 text-[10px] font-black text-slate-400 bg-white/80 px-1.5 py-0.5 rounded pointer-events-none">
              {n}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PdfViewer;
