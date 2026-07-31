import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
import {
  ChevronUp, ChevronDown, ZoomIn, ZoomOut, RotateCw, RotateCcw,
  Search, X, Loader2, Download, AlertTriangle, Highlighter, Printer,
  PanelLeft, LayoutGrid, List, Paperclip, MoreVertical, Info,
  MousePointer2, Hand, ArrowDownToLine, ArrowUpToLine, Check,
} from 'lucide-react';
import SelectionPopup, { overlayFor } from './SelectionPopup';
import type { Highlight, HighlightColor, HighlightRect } from '../types';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Full-featured canvas PDF viewer.
 *
 * Replaced an <iframe> that clipped document bottoms and exposed nothing to the
 * app. Canvas alone loses text selection, so pdf.js's renderTextLayer draws
 * transparent, glyph-aligned spans over each page.
 *
 * Critical detail: pdf.js 3.x positions those spans with
 * `calc(var(--scale-factor) * ...)`. If that CSS variable is not set on the
 * text-layer container it logs "The `--scale-factor` CSS-variable must be set"
 * and every span collapses, which silently makes selection (and therefore
 * highlighting) impossible. It is set in renderPage below.
 */

type ZoomPreset = 'auto' | 'actual' | 'fit' | 'width';
type ScrollMode = 'vertical' | 'horizontal' | 'wrapped';
type SpreadMode = 'none' | 'odd' | 'even';
type SidebarTab = 'thumbnails' | 'outline' | 'attachments';
type Tool = 'select' | 'hand';

interface PdfViewerProps {
  fileUrl: string;
  title?: string;
  onPageChange?: (page: number, total: number) => void;
  onTextExtracted?: (pages: { page: number; text: string }[]) => void;
  highlights?: Highlight[];
  onCreateHighlight?: (h: { page: number; text: string; color: HighlightColor; rects: HighlightRect[] }) => void;
  onDeleteHighlight?: (id: string) => void;
  onAskAi?: (text: string) => void;
  jumpToPage?: number;
}

interface SearchHit {
  page: number;
  /** Character offset of the match within that page's text. */
  start: number;
  length: number;
  snippet: string;
}

interface OutlineNode {
  title: string;
  dest: unknown;
  items: OutlineNode[];
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

const PdfViewer: React.FC<PdfViewerProps> = ({
  fileUrl, title, onPageChange, onTextExtracted,
  highlights = [], onCreateHighlight, onDeleteHighlight, onAskAi, jumpToPage,
}) => {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [scale, setScale] = useState(1.2);
  const [zoomPreset, setZoomPreset] = useState<ZoomPreset>('width');
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageSizes, setPageSizes] = useState<Record<number, { w: number; h: number }>>({});

  const [scrollMode, setScrollMode] = useState<ScrollMode>('vertical');
  const [spreadMode, setSpreadMode] = useState<SpreadMode>('none');
  const [tool, setTool] = useState<Tool>('select');

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('thumbnails');
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [attachments, setAttachments] = useState<{ filename: string; content: Uint8Array }[]>([]);
  const [docInfo, setDocInfo] = useState<Record<string, unknown> | null>(null);
  const [showProperties, setShowProperties] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showZoomMenu, setShowZoomMenu] = useState(false);

  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWords, setWholeWords] = useState(false);
  const [highlightAllMatches, setHighlightAllMatches] = useState(true);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeHit, setActiveHit] = useState(0);
  const [pageTexts, setPageTexts] = useState<string[]>([]);

  const [selection, setSelection] = useState<{ anchor: { x: number; y: number }; text: string; page: number; rects: HighlightRect[] } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const textLayerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const renderTasks = useRef<Map<number, pdfjs.RenderTask>>(new Map());
  const textTasks = useRef<Map<number, { cancel: () => void }>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panState = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  /* ---------------- load ---------------- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setDoc(null); setPageSizes({});
    setOutline([]); setAttachments([]); setDocInfo(null);

    const task = pdfjs.getDocument(fileUrl);
    task.promise.then(
      async (pdf) => {
        if (cancelled) { pdf.destroy(); return; }
        setDoc(pdf); setNumPages(pdf.numPages); setCurrentPage(1); setLoading(false);

        // Sidebar + properties data. Each is optional; a missing outline or
        // attachment list must not break the viewer.
        pdf.getOutline().then((o) => !cancelled && o && setOutline(o as OutlineNode[])).catch(() => {});
        pdf.getAttachments().then((a: any) => {
          if (cancelled || !a) return;
          setAttachments(Object.values(a) as { filename: string; content: Uint8Array }[]);
        }).catch(() => {});
        pdf.getMetadata().then(({ info }) => !cancelled && setDocInfo(info as Record<string, unknown>)).catch(() => {});
      },
      (err) => {
        if (cancelled) return;
        console.error('PDF load failed:', err);
        setError(err?.name === 'PasswordException'
          ? 'This PDF is password protected.'
          : 'This PDF could not be opened. It may be corrupted or still uploading.');
        setLoading(false);
      },
    );
    return () => { cancelled = true; task.destroy().catch(() => {}); };
  }, [fileUrl]);

  /* ---------------- extract text ---------------- */
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
        } catch { texts[i - 1] = ''; }
      }
      if (cancelled) return;
      setPageTexts(texts);
      onTextExtracted?.(texts.map((text, i) => ({ page: i + 1, text })));
    })();
    return () => { cancelled = true; };
  }, [doc]);

  /* ---------------- zoom presets ---------------- */
  useEffect(() => {
    if (!doc || zoomPreset === 'actual') return;
    let cancelled = false;

    const apply = async () => {
      const el = containerRef.current;
      if (!el) return;
      const page = await doc.getPage(currentPage || 1);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1, rotation });
      const availW = el.clientWidth - (spreadMode === 'none' ? 40 : 60);
      const availH = el.clientHeight - 40;

      let next = scale;
      if (zoomPreset === 'width') next = availW / base.width;
      else if (zoomPreset === 'fit') next = Math.min(availW / base.width, availH / base.height);
      else if (zoomPreset === 'auto') next = Math.min(1.5, availW / base.width);

      setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)));
    };

    apply();
    const ro = new ResizeObserver(apply);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => { cancelled = true; ro.disconnect(); };
  }, [doc, zoomPreset, rotation, spreadMode, currentPage]);

  /* ---------------- render a page ---------------- */
  const renderPage = useCallback(async (pageNum: number) => {
    if (!doc) return;
    const canvas = canvasRefs.current[pageNum - 1];
    const textLayer = textLayerRefs.current[pageNum - 1];
    if (!canvas) return;

    renderTasks.current.get(pageNum)?.cancel();
    textTasks.current.get(pageNum)?.cancel();

    try {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale, rotation });

      setPageSizes((prev) =>
        prev[pageNum]?.w === viewport.width && prev[pageNum]?.h === viewport.height
          ? prev
          : { ...prev, [pageNum]: { w: viewport.width, h: viewport.height } });

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

      if (textLayer) {
        textLayer.replaceChildren();
        // REQUIRED by pdf.js 3.x: spans are positioned with
        // calc(var(--scale-factor) * ...). Without this they collapse and
        // nothing can be selected or highlighted.
        textLayer.style.setProperty('--scale-factor', String(viewport.scale));
        textLayer.style.width = `${Math.floor(viewport.width)}px`;
        textLayer.style.height = `${Math.floor(viewport.height)}px`;

        const content = await page.getTextContent();
        const textTask = pdfjs.renderTextLayer({
          textContentSource: content,
          container: textLayer,
          viewport,
        });
        textTasks.current.set(pageNum, textTask);
        await textTask.promise;
        textTasks.current.delete(pageNum);
      }
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException' && !/cancelled/i.test(err?.message ?? '')) {
        console.error(`Failed to render page ${pageNum}:`, err);
      }
    }
  }, [doc, scale, rotation]);

  /* ---------------- lazy rendering ---------------- */
  useEffect(() => {
    if (!doc || !numPages) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNum = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) {
            renderPage(pageNum);
            if (entry.intersectionRatio > 0.5) {
              setCurrentPage(pageNum);
              setPageInput(String(pageNum));
            }
          }
        }
      },
      { root: containerRef.current, rootMargin: '150% 0px', threshold: [0, 0.5] },
    );
    pageRefs.current.slice(0, numPages).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [doc, numPages, renderPage, scrollMode, spreadMode]);

  useEffect(() => {
    if (!doc) return;
    pageRefs.current.slice(0, numPages).forEach((el, i) => {
      if (!el || !containerRef.current) return;
      const r = el.getBoundingClientRect();
      const c = containerRef.current.getBoundingClientRect();
      if (r.bottom > c.top - 500 && r.top < c.bottom + 500) renderPage(i + 1);
    });
  }, [scale, rotation, doc, numPages, renderPage]);

  useEffect(() => { onPageChange?.(currentPage, numPages); }, [currentPage, numPages]);

  /* ---------------- navigation ---------------- */
  const goToPage = useCallback((n: number) => {
    const clamped = Math.min(Math.max(1, n), numPages);
    pageRefs.current[clamped - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'center' });
    setCurrentPage(clamped);
    setPageInput(String(clamped));
  }, [numPages]);

  useEffect(() => {
    if (jumpToPage && numPages) {
      const t = setTimeout(() => goToPage(jumpToPage), 350);
      return () => clearTimeout(t);
    }
  }, [jumpToPage, numPages, goToPage]);

  const goToDestination = async (dest: unknown) => {
    if (!doc || !dest) return;
    try {
      const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return;
      const index = await doc.getPageIndex(explicit[0] as any);
      goToPage(index + 1);
    } catch { /* broken outline entries are common; ignore */ }
  };

  const setZoom = (value: number | ZoomPreset) => {
    if (typeof value === 'number') { setZoomPreset('actual'); setScale(value); }
    else setZoomPreset(value);
    setShowZoomMenu(false);
  };
  const zoomBy = (delta: number) => {
    setZoomPreset('actual');
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, +(s + delta).toFixed(2))));
  };

  /* ---------------- hand tool panning ---------------- */
  const onPanStart = (e: React.MouseEvent) => {
    if (tool !== 'hand' || !containerRef.current) return;
    panState.current = {
      x: e.clientX, y: e.clientY,
      left: containerRef.current.scrollLeft, top: containerRef.current.scrollTop,
    };
  };
  useEffect(() => {
    if (tool !== 'hand') return;
    const move = (e: MouseEvent) => {
      if (!panState.current || !containerRef.current) return;
      containerRef.current.scrollLeft = panState.current.left - (e.clientX - panState.current.x);
      containerRef.current.scrollTop = panState.current.top - (e.clientY - panState.current.y);
    };
    const up = () => { panState.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [tool]);

  /* ---------------- selection ---------------- */
  const captureSelection = useCallback(() => {
    if (tool === 'hand') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { setSelection(null); return; }
    const text = sel.toString().trim();
    if (!text) { setSelection(null); return; }

    let node: Node | null = sel.getRangeAt(0).startContainer;
    let pageEl: HTMLElement | null = null;
    while (node) {
      if (node instanceof HTMLElement && node.dataset.page) { pageEl = node; break; }
      node = node.parentNode;
    }
    if (!pageEl) { setSelection(null); return; }

    const page = Number(pageEl.dataset.page);
    const pageBox = pageEl.getBoundingClientRect();
    const clientRects = Array.from(sel.getRangeAt(0).getClientRects()).filter((r) => r.width > 0 && r.height > 1);
    if (!clientRects.length) { setSelection(null); return; }

    // Fractions of the page, so highlights survive zoom, rotation and resize.
    const rects: HighlightRect[] = clientRects.map((r) => ({
      x: (r.left - pageBox.left) / pageBox.width,
      y: (r.top - pageBox.top) / pageBox.height,
      w: r.width / pageBox.width,
      h: r.height / pageBox.height,
    }));

    const first = clientRects[0];
    setSelection({ anchor: { x: first.left + first.width / 2, y: first.top }, text, page, rects });
  }, [tool]);

  useEffect(() => {
    const onUp = () => setTimeout(captureSelection, 10);
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest?.('[data-selection-popup]')) return;
      setSelection(null);
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('mouseup', onUp); document.removeEventListener('mousedown', onDown); };
  }, [captureSelection]);

  const commitHighlight = (color: HighlightColor) => {
    if (!selection) return;
    onCreateHighlight?.({ page: selection.page, text: selection.text, color, rects: selection.rects });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  /* ---------------- search ---------------- */
  useEffect(() => {
    const raw = query.trim();
    if (raw.length < 2 || !pageTexts.length) { setHits([]); return; }

    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = wholeWords ? `\\b${escaped}\\b` : escaped;
    let re: RegExp;
    try { re = new RegExp(pattern, matchCase ? 'g' : 'gi'); } catch { setHits([]); return; }

    const found: SearchHit[] = [];
    pageTexts.forEach((text, i) => {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) && found.length < 1000) {
        const start = Math.max(0, m.index - 40);
        found.push({
          page: i + 1,
          start: m.index,
          length: m[0].length,
          snippet: `${start > 0 ? '…' : ''}${text.slice(start, m.index + m[0].length + 60).trim()}…`,
        });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    });

    setHits(found);
    setActiveHit(0);
    if (found.length) goToPage(found[0].page);
  }, [query, pageTexts, matchCase, wholeWords, goToPage]);

  const stepHit = (dir: 1 | -1) => {
    if (!hits.length) return;
    const next = (activeHit + dir + hits.length) % hits.length;
    setActiveHit(next);
    goToPage(hits[next].page);
  };

  /**
   * Paints search matches onto the text layer.
   *
   * Done by walking the rendered spans and wrapping matched substrings, rather
   * than re-deriving geometry, so the marks line up exactly with the glyphs at
   * any zoom. Re-runs whenever the layer is re-rendered.
   */
  useEffect(() => {
    // Clear previous marks first.
    for (const layer of textLayerRefs.current) {
      layer?.querySelectorAll('mark[data-find]').forEach((el) => {
        const parent = el.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(el.textContent ?? ''), el);
        parent.normalize();
      });
    }
    const raw = query.trim();
    if (!raw || raw.length < 2 || !hits.length) return;

    const pagesToMark = highlightAllMatches
      ? new Set(hits.map((h) => h.page))
      : new Set([hits[activeHit]?.page].filter(Boolean) as number[]);

    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = wholeWords ? `\\b${escaped}\\b` : escaped;

    for (const page of pagesToMark) {
      const layer = textLayerRefs.current[page - 1];
      if (!layer) continue;
      let re: RegExp;
      try { re = new RegExp(pattern, matchCase ? 'g' : 'gi'); } catch { return; }

      layer.querySelectorAll('span').forEach((span) => {
        const text = span.textContent ?? '';
        if (!text) return;
        re.lastIndex = 0;
        if (!re.test(text)) return;
        re.lastIndex = 0;

        const frag = document.createDocumentFragment();
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          const mark = document.createElement('mark');
          mark.dataset.find = 'true';
          mark.textContent = m[0];
          frag.appendChild(mark);
          last = m.index + m[0].length;
          if (m.index === re.lastIndex) re.lastIndex++;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        span.replaceChildren(frag);
      });
    }
  }, [query, hits, activeHit, highlightAllMatches, matchCase, wholeWords, scale, rotation, currentPage, pageSizes]);

  /* ---------------- print ---------------- */
  const handlePrint = () => {
    const w = window.open(fileUrl, '_blank');
    // Some webviews block programmatic print; opening the file is the fallback.
    w?.addEventListener('load', () => { try { w.print(); } catch { /* ignore */ } });
  };

  /* ---------------- keyboard ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault(); setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return;
      }
      if (typing) {
        if (e.key === 'Escape') { setShowSearch(false); setQuery(''); }
        if (e.key === 'Enter' && hits.length) { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); zoomBy(0.2); }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); zoomBy(-0.2); }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setZoom('width'); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); handlePrint(); }
      if (e.key === 'PageDown' || e.key === 'ArrowRight') goToPage(currentPage + 1);
      if (e.key === 'PageUp' || e.key === 'ArrowLeft') goToPage(currentPage - 1);
      if (e.key === 'Home') goToPage(1);
      if (e.key === 'End') goToPage(numPages);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentPage, numPages, hits, activeHit, goToPage]);

  const pageNumbers = useMemo(() => Array.from({ length: numPages }, (_, i) => i + 1), [numPages]);
  const highlightsByPage = useMemo(() => {
    const map = new Map<number, Highlight[]>();
    for (const h of highlights) {
      if (!h.page || !h.rects?.length) continue;
      map.set(h.page, [...(map.get(h.page) ?? []), h]);
    }
    return map;
  }, [highlights]);

  const activeHitPage = hits[activeHit]?.page;

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

  const iconBtn = 'p-1.5 rounded-lg hover:bg-slate-200/70 text-slate-600 disabled:opacity-30 transition-colors';
  const activeBtn = 'bg-[#2D6A4F]/12 text-[#2D6A4F]';

  return (
    <div className="flex flex-col h-full w-full bg-slate-300/40 min-h-0" onClick={() => { setShowMenu(false); setShowZoomMenu(false); }}>
      {/* ---------------- toolbar ---------------- */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 bg-slate-100 border-b border-slate-300 shadow-sm flex-shrink-0 flex-wrap relative z-30">
        <button onClick={() => setSidebarOpen((s) => !s)} title="Toggle sidebar" className={`${iconBtn} ${sidebarOpen ? activeBtn : ''}`}><PanelLeft className="w-4 h-4" /></button>
        <button onClick={() => { setShowSearch((s) => !s); setTimeout(() => searchInputRef.current?.focus(), 0); }} title="Find (Ctrl+F)" className={`${iconBtn} ${showSearch ? activeBtn : ''}`}><Search className="w-4 h-4" /></button>

        <span className="w-px h-5 bg-slate-300 mx-1" />

        <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} title="Previous page" className={iconBtn}><ChevronUp className="w-4 h-4" /></button>
        <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= numPages} title="Next page" className={iconBtn}><ChevronDown className="w-4 h-4" /></button>
        <input
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value)}
          onBlur={() => goToPage(parseInt(pageInput, 10) || 1)}
          onKeyDown={(e) => { if (e.key === 'Enter') goToPage(parseInt(pageInput, 10) || 1); }}
          className="w-12 px-1 py-1 text-center text-xs font-bold border border-slate-300 rounded-md outline-none focus:ring-2 focus:ring-[#2D6A4F]/20 bg-white"
        />
        <span className="text-xs font-bold text-slate-500 px-1">of {numPages || '–'}</span>

        <span className="w-px h-5 bg-slate-300 mx-1" />

        <button onClick={() => zoomBy(-0.2)} title="Zoom out (Ctrl -)" className={iconBtn}><ZoomOut className="w-4 h-4" /></button>
        <button onClick={() => zoomBy(0.2)} title="Zoom in (Ctrl +)" className={iconBtn}><ZoomIn className="w-4 h-4" /></button>

        <div className="relative">
          <button
            onClick={(e) => { e.stopPropagation(); setShowZoomMenu((s) => !s); setShowMenu(false); }}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 min-w-[7.5rem] justify-between"
          >
            {zoomPreset === 'width' ? 'Page Width' : zoomPreset === 'fit' ? 'Page Fit' : zoomPreset === 'auto' ? 'Automatic Zoom' : `${Math.round(scale * 100)}%`}
            <ChevronDown className="w-3 h-3" />
          </button>
          {showZoomMenu && (
            <div onClick={(e) => e.stopPropagation()} className="absolute top-full left-0 mt-1 w-44 bg-slate-800 text-white rounded-lg shadow-2xl py-1 z-50">
              {([['auto', 'Automatic Zoom'], ['actual', 'Actual Size'], ['fit', 'Page Fit'], ['width', 'Page Width']] as [ZoomPreset, string][]).map(([k, label]) => (
                <button key={k} onClick={() => setZoom(k === 'actual' ? 1 : k)} className="w-full text-left px-4 py-1.5 text-sm hover:bg-white/10 flex items-center justify-between">
                  {label}{zoomPreset === k && <Check className="w-3.5 h-3.5" />}
                </button>
              ))}
              <div className="h-px bg-white/15 my-1" />
              {ZOOM_STEPS.map((z) => (
                <button key={z} onClick={() => setZoom(z)} className="w-full text-left px-4 py-1.5 text-sm hover:bg-white/10">
                  {Math.round(z * 100)}%
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="w-px h-5 bg-slate-300 mx-1" />

        <button onClick={() => setTool('select')} title="Text selection tool" className={`${iconBtn} ${tool === 'select' ? activeBtn : ''}`}><MousePointer2 className="w-4 h-4" /></button>
        <button onClick={() => setTool('hand')} title="Hand tool (drag to pan)" className={`${iconBtn} ${tool === 'hand' ? activeBtn : ''}`}><Hand className="w-4 h-4" /></button>

        <div className="flex-1 min-w-[1rem]" />

        {highlights.length > 0 && (
          <span title={`${highlights.length} highlight(s)`} className="flex items-center gap-1 text-[11px] font-black text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-md mr-1">
            <Highlighter className="w-3 h-3" /> {highlights.length}
          </span>
        )}

        <button onClick={handlePrint} title="Print (Ctrl+P)" className={iconBtn}><Printer className="w-4 h-4" /></button>
        <a href={fileUrl} download={title || 'document.pdf'} title="Save" className={iconBtn}><Download className="w-4 h-4" /></a>

        <div className="relative">
          <button onClick={(e) => { e.stopPropagation(); setShowMenu((s) => !s); setShowZoomMenu(false); }} title="More tools" className={iconBtn}><MoreVertical className="w-4 h-4" /></button>
          {showMenu && (
            <div onClick={(e) => e.stopPropagation()} className="absolute top-full right-0 mt-1 w-60 bg-slate-800 text-white rounded-lg shadow-2xl py-1 z-50">
              <button onClick={() => { goToPage(1); setShowMenu(false); }} className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 flex items-center gap-3"><ArrowUpToLine className="w-4 h-4" /> Go to First Page</button>
              <button onClick={() => { goToPage(numPages); setShowMenu(false); }} className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 flex items-center gap-3"><ArrowDownToLine className="w-4 h-4" /> Go to Last Page</button>
              <div className="h-px bg-white/15 my-1" />
              <button onClick={() => setRotation((r) => (r + 90) % 360)} className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 flex items-center gap-3"><RotateCw className="w-4 h-4" /> Rotate Clockwise</button>
              <button onClick={() => setRotation((r) => (r + 270) % 360)} className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 flex items-center gap-3"><RotateCcw className="w-4 h-4" /> Rotate Counterclockwise</button>
              <div className="h-px bg-white/15 my-1" />
              {([['vertical', 'Vertical Scrolling'], ['horizontal', 'Horizontal Scrolling'], ['wrapped', 'Wrapped Scrolling']] as [ScrollMode, string][]).map(([k, label]) => (
                <button key={k} onClick={() => { setScrollMode(k); setShowMenu(false); }} className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 flex items-center justify-between">
                  <span className="flex items-center gap-3"><List className="w-4 h-4" /> {label}</span>{scrollMode === k && <Check className="w-3.5 h-3.5" />}
                </button>
              ))}
              <div className="h-px bg-white/15 my-1" />
              {([['none', 'No Spreads'], ['odd', 'Odd Spreads'], ['even', 'Even Spreads']] as [SpreadMode, string][]).map(([k, label]) => (
                <button key={k} onClick={() => { setSpreadMode(k); setShowMenu(false); }} className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 flex items-center justify-between">
                  <span className="flex items-center gap-3"><LayoutGrid className="w-4 h-4" /> {label}</span>{spreadMode === k && <Check className="w-3.5 h-3.5" />}
                </button>
              ))}
              <div className="h-px bg-white/15 my-1" />
              <button onClick={() => { setShowProperties(true); setShowMenu(false); }} className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 flex items-center gap-3"><Info className="w-4 h-4" /> Document Properties…</button>
            </div>
          )}
        </div>
      </div>

      {/* ---------------- find bar ---------------- */}
      {showSearch && (
        <div className="flex items-center gap-2 px-3 py-2 bg-white border-b border-slate-200 flex-shrink-0 flex-wrap z-20">
          <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={pageTexts.length ? 'Find in document…' : 'Reading document…'}
            className="flex-1 min-w-[8rem] bg-transparent text-sm font-medium outline-none"
          />
          <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 cursor-pointer">
            <input type="checkbox" checked={highlightAllMatches} onChange={(e) => setHighlightAllMatches(e.target.checked)} className="accent-[#2D6A4F]" /> Highlight all
          </label>
          <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 cursor-pointer">
            <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} className="accent-[#2D6A4F]" /> Match case
          </label>
          <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 cursor-pointer">
            <input type="checkbox" checked={wholeWords} onChange={(e) => setWholeWords(e.target.checked)} className="accent-[#2D6A4F]" /> Whole words
          </label>
          {query.trim().length >= 2 && (
            <span className="text-xs font-bold text-slate-500 tabular-nums">
              {hits.length ? `${activeHit + 1} of ${hits.length}` : 'Not found'}
            </span>
          )}
          <button onClick={() => stepHit(-1)} disabled={!hits.length} className={iconBtn}><ChevronUp className="w-4 h-4" /></button>
          <button onClick={() => stepHit(1)} disabled={!hits.length} className={iconBtn}><ChevronDown className="w-4 h-4" /></button>
          <button onClick={() => { setShowSearch(false); setQuery(''); }} className={iconBtn}><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* ---------------- sidebar ---------------- */}
        {sidebarOpen && (
          <div className="w-52 flex-shrink-0 bg-slate-100 border-r border-slate-300 flex flex-col min-h-0">
            <div className="flex border-b border-slate-300 flex-shrink-0">
              {([['thumbnails', LayoutGrid], ['outline', List], ['attachments', Paperclip]] as [SidebarTab, typeof List][]).map(([k, Icon]) => (
                <button key={k} onClick={() => setSidebarTab(k)} title={k} className={`flex-1 py-2 flex items-center justify-center ${sidebarTab === k ? 'bg-white text-[#2D6A4F] border-b-2 border-[#2D6A4F]' : 'text-slate-500 hover:bg-slate-200/60'}`}>
                  <Icon className="w-4 h-4" />
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {sidebarTab === 'thumbnails' && pageNumbers.map((n) => (
                <button key={n} onClick={() => goToPage(n)} className={`w-full mb-2 rounded-md overflow-hidden border-2 transition-all ${currentPage === n ? 'border-[#2D6A4F] shadow-md' : 'border-transparent hover:border-slate-400'}`}>
                  <Thumbnail doc={doc} pageNumber={n} />
                  <span className={`block text-[10px] font-bold py-0.5 ${currentPage === n ? 'text-[#2D6A4F]' : 'text-slate-500'}`}>{n}</span>
                </button>
              ))}

              {sidebarTab === 'outline' && (
                outline.length ? <OutlineTree nodes={outline} onSelect={goToDestination} />
                  : <p className="text-xs text-slate-400 text-center py-6 px-2">This document has no outline.</p>
              )}

              {sidebarTab === 'attachments' && (
                attachments.length ? attachments.map((a) => (
                  <button
                    key={a.filename}
                    onClick={() => {
                      const url = URL.createObjectURL(new Blob([new Uint8Array(a.content)]));
                      const link = document.createElement('a');
                      link.href = url; link.download = a.filename; link.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="w-full text-left px-2 py-2 text-xs font-medium text-slate-700 hover:bg-slate-200/60 rounded-md flex items-center gap-2"
                  >
                    <Paperclip className="w-3.5 h-3.5 flex-shrink-0" /> <span className="truncate">{a.filename}</span>
                  </button>
                )) : <p className="text-xs text-slate-400 text-center py-6 px-2">No attachments.</p>
              )}
            </div>
          </div>
        )}

        {/* ---------------- pages ---------------- */}
        <div
          ref={containerRef}
          onMouseDown={onPanStart}
          className={`flex-1 min-h-0 py-4 px-2 ${
            scrollMode === 'horizontal' ? 'overflow-x-auto overflow-y-hidden flex items-start gap-4'
              : scrollMode === 'wrapped' ? 'overflow-auto flex flex-wrap justify-center items-start gap-4 content-start'
              : 'overflow-auto'
          } ${tool === 'hand' ? 'cursor-grab active:cursor-grabbing' : ''}`}
          style={spreadMode !== 'none' && scrollMode === 'vertical' ? { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '1rem', alignContent: 'flex-start' } : undefined}
        >
          {loading && (
            <div className="flex flex-col items-center justify-center py-32 w-full">
              <Loader2 className="w-10 h-10 text-[#FFB703] animate-spin mb-3" />
              <p className="text-sm font-black text-slate-400 uppercase tracking-widest">Opening document…</p>
            </div>
          )}

          {pageNumbers.map((n) => {
            const size = pageSizes[n];
            const pageHighlights = highlightsByPage.get(n) ?? [];
            const inline = scrollMode !== 'vertical' || spreadMode !== 'none';
            return (
              <div
                key={n}
                data-page={n}
                ref={(el) => { pageRefs.current[n - 1] = el; }}
                className={`bg-white shadow-lg rounded-sm relative ${inline ? '' : 'mx-auto mb-4'} ${activeHitPage === n && hits.length ? 'ring-2 ring-[#FFB703]' : ''}`}
                style={{ width: size ? size.w : 'fit-content', minHeight: size ? size.h : 140, flex: '0 0 auto' }}
              >
                <canvas ref={(el) => { canvasRefs.current[n - 1] = el; }} className="block rounded-sm" />

                {pageHighlights.map((h) =>
                  h.rects!.map((r, i) => (
                    <div
                      key={`${h.id}-${i}`}
                      onClick={() => onDeleteHighlight && window.confirm('Remove this highlight?') && onDeleteHighlight(h.id)}
                      title={onDeleteHighlight ? 'Click to remove highlight' : h.text}
                      style={{
                        position: 'absolute',
                        left: `${r.x * 100}%`, top: `${r.y * 100}%`,
                        width: `${r.w * 100}%`, height: `${r.h * 100}%`,
                        background: overlayFor(h.color), borderRadius: 2,
                        cursor: onDeleteHighlight ? 'pointer' : 'default', zIndex: 1,
                      }}
                    />
                  )),
                )}

                <div
                  ref={(el) => { textLayerRefs.current[n - 1] = el; }}
                  className="pdf-text-layer"
                  style={{ position: 'absolute', left: 0, top: 0, zIndex: 2, pointerEvents: tool === 'hand' ? 'none' : 'auto' }}
                />

                <span className="absolute bottom-2 right-2 text-[10px] font-black text-slate-400 bg-white/80 px-1.5 py-0.5 rounded pointer-events-none z-10">{n}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------------- document properties ---------------- */}
      {showProperties && (
        <div className="fixed inset-0 bg-black/50 z-[300] flex items-center justify-center p-4" onClick={() => setShowProperties(false)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-bold text-slate-800 flex items-center gap-2"><Info className="w-4 h-4" /> Document Properties</h3>
              <button onClick={() => setShowProperties(false)} className={iconBtn}><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-2 max-h-[60vh] overflow-y-auto text-sm">
              {[
                ['File name', title ?? '—'],
                ['Title', (docInfo?.Title as string) || '—'],
                ['Author', (docInfo?.Author as string) || '—'],
                ['Subject', (docInfo?.Subject as string) || '—'],
                ['Keywords', (docInfo?.Keywords as string) || '—'],
                ['Creator', (docInfo?.Creator as string) || '—'],
                ['Producer', (docInfo?.Producer as string) || '—'],
                ['PDF version', (docInfo?.PDFFormatVersion as string) || '—'],
                ['Page count', String(numPages)],
                ['Highlights saved', String(highlights.length)],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 py-1 border-b border-slate-50 last:border-0">
                  <span className="text-slate-500 font-medium flex-shrink-0">{k}</span>
                  <span className="text-slate-800 font-bold text-right truncate">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div data-selection-popup>
        <SelectionPopup
          anchor={selection?.anchor ?? null}
          onHighlight={commitHighlight}
          onCopy={() => { if (selection) navigator.clipboard?.writeText(selection.text); }}
          onAskAi={onAskAi && selection ? () => { onAskAi(selection.text); setSelection(null); } : undefined}
          onDismiss={() => { window.getSelection()?.removeAllRanges(); setSelection(null); }}
        />
      </div>
    </div>
  );
};

/** Lazily-rendered sidebar thumbnail. */
const Thumbnail: React.FC<{ doc: pdfjs.PDFDocumentProxy | null; pageNumber: number }> = ({ doc, pageNumber }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!doc || done || !ref.current) return;
    let cancelled = false;
    const el = ref.current;

    const io = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting || cancelled) return;
      io.disconnect();
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 0.28 });
        el.width = viewport.width; el.height = viewport.height;
        const ctx = el.getContext('2d');
        if (!ctx) return;
        await page.render({ canvasContext: ctx, viewport }).promise;
        if (!cancelled) setDone(true);
      } catch { /* thumbnail failures are cosmetic */ }
    }, { rootMargin: '200px' });

    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [doc, pageNumber, done]);

  return <canvas ref={ref} className="block w-full bg-white" style={{ minHeight: 60 }} />;
};

/** Recursive bookmark tree. */
const OutlineTree: React.FC<{ nodes: OutlineNode[]; onSelect: (dest: unknown) => void; depth?: number }> = ({ nodes, onSelect, depth = 0 }) => (
  <>
    {nodes.map((node, i) => (
      <div key={`${depth}-${i}`}>
        <button
          onClick={() => onSelect(node.dest)}
          style={{ paddingLeft: 8 + depth * 12 }}
          className="w-full text-left pr-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-200/60 rounded-md truncate"
          title={node.title}
        >
          {node.title}
        </button>
        {node.items?.length > 0 && <OutlineTree nodes={node.items} onSelect={onSelect} depth={depth + 1} />}
      </div>
    ))}
  </>
);

export default PdfViewer;
