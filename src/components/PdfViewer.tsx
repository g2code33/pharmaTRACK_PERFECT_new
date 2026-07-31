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
 * Three things matter for it to feel instant, all handled below:
 *
 *  1. Page boxes are sized from pdf.js viewports before anything renders, so
 *     the scroll height is correct immediately and jumping to page 90 lands in
 *     one go instead of settling as pages appear.
 *  2. Renders are cached per (page, scale, rotation). Scrolling back over a
 *     page reuses the existing canvas instead of re-rasterising it.
 *  3. A window of pages around the viewport is rendered ahead of time and
 *     pages far outside it are evicted, which keeps memory bounded on long
 *     documents without giving up the instant feel.
 *
 * pdf.js 3.x positions text-layer spans with `calc(var(--scale-factor) * ...)`.
 * That variable must be set on the container or every span collapses and
 * selection silently stops working.
 */

type ZoomPreset = 'auto' | 'actual' | 'fit' | 'width';
type ScrollMode = 'vertical' | 'horizontal' | 'wrapped';
type SpreadMode = 'none' | 'odd' | 'even';
type SidebarTab = 'thumbnails' | 'outline' | 'attachments' | 'search' | 'highlights';
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
  /** Scroll to and flash this highlight after opening (Study Bank deep link). */
  focusHighlightId?: string;
  /** Pre-fill the find bar, e.g. from a global-search "In document" hit. */
  initialQuery?: string;
}

interface SearchHit {
  page: number;
  /** Index of this hit within its page, used to target the right <mark>. */
  indexOnPage: number;
  before: string;
  match: string;
  after: string;
}

interface OutlineNode { title: string; dest: unknown; items: OutlineNode[] }

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * Pages rendered around the viewport. Wide enough that normal scrolling always
 * lands on an already-painted page.
 */
const RENDER_WINDOW = 6;
/**
 * Beyond this, canvases are released. One page at 2x DPR is roughly 20 MB, so
 * an unbounded cache would exhaust memory on a 100+ page deck.
 */
const KEEP_WINDOW = 14;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PdfViewer: React.FC<PdfViewerProps> = ({
  fileUrl, title, onPageChange, onTextExtracted,
  highlights = [], onCreateHighlight, onDeleteHighlight, onAskAi, jumpToPage,
  focusHighlightId, initialQuery,
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

  /** Unscaled page dimensions, read once so boxes can be sized before render. */
  const [baseSizes, setBaseSizes] = useState<{ w: number; h: number }[]>([]);

  const [scrollMode, setScrollMode] = useState<ScrollMode>('vertical');
  const [spreadMode, setSpreadMode] = useState<SpreadMode>('none');
  const [tool, setTool] = useState<Tool>('select');

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('thumbnails');
  const [outline, setOutline] = useState<OutlineNode[]>([]);
  const [attachments, setAttachments] = useState<{ filename: string; content: Uint8Array }[]>([]);
  const [docInfo, setDocInfo] = useState<Record<string, unknown> | null>(null);
  /**
   * Publisher page labels, when the PDF declares them. Many lecture decks are
   * numbered i, ii, 1, 2 or start at an offset, so the sheet index is not what
   * the student sees printed on the page. Falls back to the index.
   */
  const [pageLabels, setPageLabels] = useState<string[] | null>(null);
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
  const [textReady, setTextReady] = useState(false);

  const [selection, setSelection] = useState<{ anchor: { x: number; y: number }; text: string; page: number; rects: HighlightRect[] } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const textLayerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const renderTasks = useRef<Map<number, pdfjs.RenderTask>>(new Map());
  const textTasks = useRef<Map<number, { cancel: () => void }>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panState = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  /** page -> "scale|rotation" already painted. Lets us skip redundant renders. */
  const renderedKey = useRef<Map<number, string>>(new Map());
  const inFlight = useRef<Set<number>>(new Set());

  /** Search state read from inside async render callbacks. */
  const searchRef = useRef({ query: '', matchCase: false, wholeWords: false, all: true });
  useEffect(() => {
    searchRef.current = { query, matchCase, wholeWords, all: highlightAllMatches };
  }, [query, matchCase, wholeWords, highlightAllMatches]);

  const scaledSize = useCallback((pageNum: number) => {
    const base = baseSizes[pageNum - 1];
    if (!base) return null;
    const swap = rotation % 180 !== 0;
    const w = (swap ? base.h : base.w) * scale;
    const h = (swap ? base.w : base.h) * scale;
    return { w: Math.floor(w), h: Math.floor(h) };
  }, [baseSizes, scale, rotation]);

  /* ---------------- load ---------------- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setDoc(null);
    setBaseSizes([]); setOutline([]); setAttachments([]); setDocInfo(null);
    setTextReady(false); setPageTexts([]);
    renderedKey.current.clear();

    const task = pdfjs.getDocument(fileUrl);
    task.promise.then(
      async (pdf) => {
        if (cancelled) { pdf.destroy(); return; }
        setDoc(pdf); setNumPages(pdf.numPages); setCurrentPage(1); setLoading(false);

        // Measure every page up front. getPage is cheap (no rasterising) and
        // this is what lets the scrollbar be correct from the first frame.
        const sizes: { w: number; h: number }[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) return;
          try {
            const page = await pdf.getPage(i);
            const vp = page.getViewport({ scale: 1, rotation: 0 });
            sizes[i - 1] = { w: vp.width, h: vp.height };
          } catch {
            sizes[i - 1] = sizes[i - 2] ?? { w: 612, h: 792 };
          }
          // Publish early so the first screenful sizes immediately.
          if (i === Math.min(4, pdf.numPages) || i === pdf.numPages) {
            if (!cancelled) setBaseSizes([...sizes]);
          }
        }

        pdf.getOutline().then((o) => !cancelled && o && setOutline(o as OutlineNode[])).catch(() => {});
        pdf.getAttachments().then((a: any) => {
          if (cancelled || !a) return;
          setAttachments(Object.values(a) as { filename: string; content: Uint8Array }[]);
        }).catch(() => {});
        pdf.getMetadata().then(({ info }) => !cancelled && setDocInfo(info as Record<string, unknown>)).catch(() => {});
        pdf.getPageLabels().then((labels) => {
          if (cancelled || !labels) return;
          // Ignore label sets that are just "1","2","3" - they add nothing.
          const meaningful = labels.some((l, i) => l !== String(i + 1));
          if (meaningful) setPageLabels(labels);
        }).catch(() => {});
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
      setTextReady(true);
      onTextExtracted?.(texts.map((text, i) => ({ page: i + 1, text })));
    })();
    return () => { cancelled = true; };
  }, [doc]);

  /* ---------------- search mark painting ---------------- */

  /**
   * Paints <mark> elements onto one page's already-rendered text spans.
   *
   * Called both when the query changes and immediately after a page's text
   * layer is (re)built. That second call is what keeps marks visible while
   * scrolling: renderTextLayer replaces the layer's children, which would
   * otherwise wipe the marks on every revisit.
   */
  const paintMarks = useCallback((pageNum: number) => {
    const layer = textLayerRefs.current[pageNum - 1];
    if (!layer) return;

    // Clear existing marks on this page only.
    layer.querySelectorAll('mark[data-find]').forEach((el) => {
      const parent = el.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(el.textContent ?? ''), el);
      parent.normalize();
    });

    const { query: q, matchCase: mc, wholeWords: ww } = searchRef.current;
    const raw = q.trim();
    if (raw.length < 2) return;

    const pattern = ww ? `\\b${escapeRe(raw)}\\b` : escapeRe(raw);
    let re: RegExp;
    try { re = new RegExp(pattern, mc ? 'g' : 'gi'); } catch { return; }

    let counter = 0;
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
        mark.dataset.hitIndex = String(counter++);
        mark.textContent = m[0];
        frag.appendChild(mark);
        last = m.index + m[0].length;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      span.replaceChildren(frag);
    });
  }, []);

  /** Marks the active hit distinctly, so stepping through is obvious. */
  const markActive = useCallback(() => {
    document.querySelectorAll('mark[data-find][data-active]').forEach((el) => {
      (el as HTMLElement).removeAttribute('data-active');
    });
    const hit = hits[activeHit];
    if (!hit) return;
    const layer = textLayerRefs.current[hit.page - 1];
    const target = layer?.querySelector(`mark[data-find][data-hit-index="${hit.indexOnPage}"]`);
    target?.setAttribute('data-active', 'true');
  }, [hits, activeHit]);

  /* ---------------- render a page ---------------- */
  const renderPage = useCallback(async (pageNum: number, force = false) => {
    if (!doc) return;
    const canvas = canvasRefs.current[pageNum - 1];
    const textLayer = textLayerRefs.current[pageNum - 1];
    if (!canvas) return;

    const key = `${scale.toFixed(3)}|${rotation}`;
    // The cache is the whole point: revisiting a page must not re-rasterise it.
    if (!force && renderedKey.current.get(pageNum) === key) { paintMarks(pageNum); return; }
    if (inFlight.current.has(pageNum)) return;

    inFlight.current.add(pageNum);
    renderTasks.current.get(pageNum)?.cancel();
    textTasks.current.get(pageNum)?.cancel();

    try {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale, rotation });

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const task = page.render({ canvasContext: ctx, viewport });
      renderTasks.current.set(pageNum, task);
      await task.promise;
      renderTasks.current.delete(pageNum);

      if (textLayer) {
        textLayer.replaceChildren();
        // Required by pdf.js 3.x, or every span collapses and selection breaks.
        textLayer.style.setProperty('--scale-factor', String(viewport.scale));
        textLayer.style.width = `${Math.floor(viewport.width)}px`;
        textLayer.style.height = `${Math.floor(viewport.height)}px`;

        const content = await page.getTextContent();
        const textTask = pdfjs.renderTextLayer({
          textContentSource: content, container: textLayer, viewport,
        });
        textTasks.current.set(pageNum, textTask);
        await textTask.promise;
        textTasks.current.delete(pageNum);

        // Re-apply search marks straight after rebuilding the layer.
        paintMarks(pageNum);
      }

      renderedKey.current.set(pageNum, key);
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException' && !/cancelled/i.test(err?.message ?? '')) {
        console.error(`Failed to render page ${pageNum}:`, err);
      }
    } finally {
      inFlight.current.delete(pageNum);
    }
  }, [doc, scale, rotation, paintMarks]);

  /**
   * Renders a window of pages around `centre` and releases distant canvases.
   *
   * Rendering everything would exhaust memory on a 100+ page document (a single
   * page canvas at 2x DPR is ~20 MB), so pages outside KEEP_WINDOW have their
   * backing store freed and their cache entry dropped.
   */
  const renderWindow = useCallback((centre: number) => {
    if (!doc || !numPages) return;

    for (let d = 0; d <= RENDER_WINDOW; d++) {
      for (const p of d === 0 ? [centre] : [centre - d, centre + d]) {
        if (p >= 1 && p <= numPages) renderPage(p);
      }
    }

    for (const [p] of renderedKey.current) {
      if (Math.abs(p - centre) > KEEP_WINDOW) {
        const c = canvasRefs.current[p - 1];
        if (c) { c.width = 0; c.height = 0; }
        textLayerRefs.current[p - 1]?.replaceChildren();
        renderedKey.current.delete(p);
      }
    }
  }, [doc, numPages, renderPage]);

  /* ---------------- viewport tracking ---------------- */
  useEffect(() => {
    if (!doc || !numPages || !baseSizes.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
            const pageNum = Number((entry.target as HTMLElement).dataset.page);
            setCurrentPage(pageNum);
            setPageInput(String(pageNum));
          }
        }
      },
      { root: containerRef.current, threshold: [0.5] },
    );
    pageRefs.current.slice(0, numPages).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [doc, numPages, baseSizes.length, scrollMode, spreadMode]);

  // Keep the render window centred on wherever the user is.
  useEffect(() => { renderWindow(currentPage); }, [currentPage, renderWindow]);

  // Zoom or rotation invalidates every cached raster.
  useEffect(() => {
    renderedKey.current.clear();
    if (doc) renderWindow(currentPage);
  }, [scale, rotation]);

  useEffect(() => { onPageChange?.(currentPage, numPages); }, [currentPage, numPages]);

  /* ---------------- zoom presets ---------------- */
  // Deliberately keyed off page 1's dimensions and NOT currentPage or scale.
  // Including them created a feedback loop: scrolling changed currentPage,
  // which recomputed the fit, which called setScale, which invalidated every
  // cached raster and re-rendered the visible pages. That constant
  // re-rasterising is what made scrolling feel like it kept refreshing.
  useEffect(() => {
    if (!doc || zoomPreset === 'actual' || !baseSizes.length) return;

    const apply = () => {
      const el = containerRef.current;
      const base = baseSizes[0];
      if (!el || !base) return;
      const swap = rotation % 180 !== 0;
      const bw = swap ? base.h : base.w;
      const bh = swap ? base.w : base.h;
      const availW = el.clientWidth - (spreadMode === 'none' ? 40 : 60);
      const availH = el.clientHeight - 40;

      let next: number;
      if (zoomPreset === 'width') next = availW / bw;
      else if (zoomPreset === 'fit') next = Math.min(availW / bw, availH / bh);
      else next = Math.min(1.5, availW / bw);

      const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
      // Only commit a meaningful change, so a 1px resize can't thrash renders.
      setScale((prev) => (Math.abs(clamped - prev) > 0.01 ? clamped : prev));
    };

    apply();
    const ro = new ResizeObserver(apply);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [doc, zoomPreset, rotation, spreadMode, baseSizes]);

  /* ---------------- navigation ---------------- */
  const goToPage = useCallback((n: number) => {
    const clamped = Math.min(Math.max(1, n), numPages);
    setCurrentPage(clamped);
    setPageInput(String(clamped));
    // Render before scrolling so the destination is already painted on arrival.
    renderWindow(clamped);
    pageRefs.current[clamped - 1]?.scrollIntoView({ behavior: 'auto', block: 'start', inline: 'center' });
  }, [numPages, renderWindow]);

  useEffect(() => {
    if (jumpToPage && numPages && baseSizes.length) {
      const t = setTimeout(() => goToPage(jumpToPage), 120);
      return () => clearTimeout(t);
    }
  }, [jumpToPage, numPages, baseSizes.length, goToPage]);

  // Carry a global-search term into the document's own find bar, so the user
  // arrives with the matches already highlighted.
  useEffect(() => {
    if (!initialQuery || !textReady) return;
    setShowSearch(true);
    setQuery(initialQuery);
  }, [initialQuery, textReady]);

  // Land on the highlight itself, not just its page. Waits for the page to
  // paint, centres the first rect, then flashes it so it is obvious which one
  // was opened.
  const [flashHighlight, setFlashHighlight] = useState<string | null>(null);
  useEffect(() => {
    if (!focusHighlightId || !numPages || !baseSizes.length) return;
    const target = highlights.find((h) => h.id === focusHighlightId);
    if (!target?.page || !target.rects?.length) return;

    const t = setTimeout(() => {
      const el = document.querySelector(`[data-highlight-id="${focusHighlightId}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'auto' });
      setFlashHighlight(focusHighlightId);
      setTimeout(() => setFlashHighlight(null), 2200);
    }, 420);
    return () => clearTimeout(t);
  }, [focusHighlightId, numPages, baseSizes.length, highlights]);

  const goToDestination = async (dest: unknown) => {
    if (!doc || !dest) return;
    try {
      const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return;
      const index = await doc.getPageIndex(explicit[0] as any);
      goToPage(index + 1);
    } catch { /* broken outline entries are common */ }
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

  /* ---------------- hand tool ---------------- */
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

    const pattern = wholeWords ? `\\b${escapeRe(raw)}\\b` : escapeRe(raw);
    let re: RegExp;
    try { re = new RegExp(pattern, matchCase ? 'g' : 'gi'); } catch { setHits([]); return; }

    const found: SearchHit[] = [];
    pageTexts.forEach((text, i) => {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let onPage = 0;
      while ((m = re.exec(text)) && found.length < 2000) {
        found.push({
          page: i + 1,
          indexOnPage: onPage++,
          before: text.slice(Math.max(0, m.index - 45), m.index),
          match: m[0],
          after: text.slice(m.index + m[0].length, m.index + m[0].length + 55),
        });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    });

    setHits(found);
    setActiveHit(0);
    if (found.length) {
      setSidebarOpen(true);
      setSidebarTab('search');
      goToPage(found[0].page);
    }
  }, [query, pageTexts, matchCase, wholeWords]);

  // Repaint marks across loaded pages whenever the query or options change.
  useEffect(() => {
    for (let p = 1; p <= numPages; p++) {
      if (renderedKey.current.has(p)) paintMarks(p);
    }
    markActive();
  }, [query, matchCase, wholeWords, highlightAllMatches, hits, numPages, paintMarks, markActive]);

  useEffect(() => { markActive(); }, [activeHit, currentPage, markActive]);

  const goToHit = useCallback((index: number) => {
    const hit = hits[index];
    if (!hit) return;
    setActiveHit(index);
    goToPage(hit.page);
    // Scroll the exact match into view once its page has painted.
    setTimeout(() => {
      const layer = textLayerRefs.current[hit.page - 1];
      layer?.querySelector(`mark[data-find][data-hit-index="${hit.indexOnPage}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'auto' });
      markActive();
    }, 90);
  }, [hits, goToPage, markActive]);

  const stepHit = (dir: 1 | -1) => {
    if (!hits.length) return;
    goToHit((activeHit + dir + hits.length) % hits.length);
  };

  /* ---------------- print ---------------- */
  const handlePrint = () => {
    const w = window.open(fileUrl, '_blank');
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
  /** What the student sees printed on the page, or the sheet number. */
  const labelFor = useCallback(
    (n: number) => pageLabels?.[n - 1] ?? String(n),
    [pageLabels],
  );
  const highlightsByPage = useMemo(() => {
    const map = new Map<number, Highlight[]>();
    for (const h of highlights) {
      if (!h.page || !h.rects?.length) continue;
      map.set(h.page, [...(map.get(h.page) ?? []), h]);
    }
    return map;
  }, [highlights]);

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
      {/* toolbar */}
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
        <span className="text-xs font-bold text-slate-500 px-1">
          of {numPages || '–'}
          {pageLabels && labelFor(currentPage) !== String(currentPage) && (
            <span className="ml-1 text-slate-400">({labelFor(currentPage)})</span>
          )}
        </span>

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
                <button key={z} onClick={() => setZoom(z)} className="w-full text-left px-4 py-1.5 text-sm hover:bg-white/10">{Math.round(z * 100)}%</button>
              ))}
            </div>
          )}
        </div>

        <span className="w-px h-5 bg-slate-300 mx-1" />

        <button onClick={() => setTool('select')} title="Text selection tool" className={`${iconBtn} ${tool === 'select' ? activeBtn : ''}`}><MousePointer2 className="w-4 h-4" /></button>
        <button onClick={() => setTool('hand')} title="Hand tool (drag to pan)" className={`${iconBtn} ${tool === 'hand' ? activeBtn : ''}`}><Hand className="w-4 h-4" /></button>

        <div className="flex-1 min-w-[1rem]" />

        {highlights.length > 0 && (
          <button
            onClick={() => { setSidebarOpen(true); setSidebarTab('highlights'); }}
            title="Show all highlights in this document"
            className="flex items-center gap-1 text-[11px] font-black text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-md mr-1 hover:bg-amber-100 transition-colors"
          >
            <Highlighter className="w-3 h-3" /> {highlights.length}
          </button>
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

      {/* find bar */}
      {showSearch && (
        <div className="flex items-center gap-2 px-3 py-2 bg-white border-b border-slate-200 flex-shrink-0 flex-wrap z-20">
          <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={textReady ? 'Find in document…' : 'Reading document…'}
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
              {hits.length ? `${activeHit + 1} of ${hits.length}` : textReady ? 'Not found' : 'Reading…'}
            </span>
          )}
          <button onClick={() => stepHit(-1)} disabled={!hits.length} className={iconBtn}><ChevronUp className="w-4 h-4" /></button>
          <button onClick={() => stepHit(1)} disabled={!hits.length} className={iconBtn}><ChevronDown className="w-4 h-4" /></button>
          <button onClick={() => { setShowSearch(false); setQuery(''); }} className={iconBtn}><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* sidebar */}
        {sidebarOpen && (
          <div className="w-60 flex-shrink-0 bg-slate-100 border-r border-slate-300 flex flex-col min-h-0">
            <div className="flex border-b border-slate-300 flex-shrink-0">
              {([['thumbnails', LayoutGrid], ['outline', List], ['search', Search], ['highlights', Highlighter], ['attachments', Paperclip]] as [SidebarTab, typeof List][]).map(([k, Icon]) => (
                <button key={k} onClick={() => setSidebarTab(k)} title={k} className={`flex-1 py-2 flex items-center justify-center relative ${sidebarTab === k ? 'bg-white text-[#2D6A4F] border-b-2 border-[#2D6A4F]' : 'text-slate-500 hover:bg-slate-200/60'}`}>
                  <Icon className="w-4 h-4" />
                  {k === 'search' && hits.length > 0 && (
                    <span className="absolute top-1 right-2 bg-[#FFB703] text-[#1B4332] text-[9px] font-black px-1 rounded-full leading-tight">
                      {hits.length > 99 ? '99+' : hits.length}
                    </span>
                  )}
                  {k === 'highlights' && highlights.length > 0 && (
                    <span className="absolute top-1 right-1.5 bg-amber-400 text-[#1B4332] text-[9px] font-black px-1 rounded-full leading-tight">
                      {highlights.length > 99 ? '99+' : highlights.length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {sidebarTab === 'thumbnails' && pageNumbers.map((n) => (
                <button key={n} onClick={() => goToPage(n)} className={`w-full mb-2 rounded-md overflow-hidden border-2 transition-all ${currentPage === n ? 'border-[#2D6A4F] shadow-md' : 'border-transparent hover:border-slate-400'}`}>
                  <Thumbnail doc={doc} pageNumber={n} />
                  <span className={`block text-[10px] font-bold py-0.5 ${currentPage === n ? 'text-[#2D6A4F]' : 'text-slate-500'}`}>{labelFor(n)}</span>
                </button>
              ))}

              {sidebarTab === 'outline' && (
                outline.length ? <OutlineTree nodes={outline} onSelect={goToDestination} />
                  : <p className="text-xs text-slate-400 text-center py-6 px-2">This document has no outline.</p>
              )}

              {sidebarTab === 'search' && (
                <SearchResultsPanel
                  hits={hits}
                  activeHit={activeHit}
                  query={query}
                  textReady={textReady}
                  onSelect={goToHit}
                  onFocusInput={() => { setShowSearch(true); setTimeout(() => searchInputRef.current?.focus(), 0); }}
                />
              )}

              {sidebarTab === 'highlights' && (
                highlights.length ? (
                  <div className="space-y-1">
                    {[...highlights]
                      .sort((a, b) => (a.page ?? 0) - (b.page ?? 0))
                      .map((h) => (
                        <button
                          key={h.id}
                          onClick={() => {
                            if (h.page) goToPage(h.page);
                            setTimeout(() => {
                              document
                                .querySelector(`[data-highlight-id="${h.id}"]`)
                                ?.scrollIntoView({ block: 'center', behavior: 'auto' });
                              setFlashHighlight(h.id);
                              setTimeout(() => setFlashHighlight(null), 2000);
                            }, 140);
                          }}
                          className="w-full text-left p-2 rounded-md hover:bg-slate-200/70 transition-colors group/hl"
                        >
                          <span className="flex items-start gap-2">
                            <span
                              className="w-1.5 self-stretch rounded-full flex-shrink-0 mt-0.5"
                              style={{ background: overlayFor(h.color) }}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block text-[11px] text-slate-700 leading-snug line-clamp-3">{h.text}</span>
                              {h.page && (
                                <span className="block text-[9px] font-black uppercase tracking-widest text-slate-400 mt-0.5">
                                  Page {labelFor(h.page)}
                                </span>
                              )}
                            </span>
                          </span>
                        </button>
                      ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 text-center py-6 px-2">
                    No highlights yet. Select text in the document to add one.
                  </p>
                )
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

        {/* pages */}
        <div
          ref={containerRef}
          onMouseDown={onPanStart}
          className={`flex-1 min-h-0 py-4 px-2 ${
            scrollMode === 'horizontal' ? 'overflow-x-auto overflow-y-hidden flex items-start gap-4'
              : scrollMode === 'wrapped' ? 'overflow-auto flex flex-wrap justify-center items-start gap-4 content-start'
              : 'overflow-y-scroll overflow-x-auto'
          } ${tool === 'hand' ? 'cursor-grab active:cursor-grabbing' : ''}`}
          style={spreadMode !== 'none' && scrollMode === 'vertical' ? { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '1rem', alignContent: 'flex-start' } : undefined}
        >
          {loading && (
            <div className="flex flex-col items-center justify-center py-32 w-full">
              <Loader2 className="w-10 h-10 text-[#FFB703] animate-spin mb-3" />
              <p className="text-sm font-black text-slate-400 uppercase tracking-widest">Opening document…</p>
            </div>
          )}

          {/* Pages live in a fixed-width centred track. Without it each page
              box was centred independently with mx-auto, so any width change
              (zoom, fit recalculation, scrollbar appearing) shifted every page
              horizontally and the document appeared to slide around. */}
          {pageNumbers.map((n) => {
            const size = scaledSize(n);
            const pageHighlights = highlightsByPage.get(n) ?? [];
            const inline = scrollMode !== 'vertical' || spreadMode !== 'none';
            return (
              <div
                key={n}
                data-page={n}
                ref={(el) => { pageRefs.current[n - 1] = el; }}
                className={`bg-white shadow-lg rounded-sm relative ${inline ? '' : 'mb-4'}`}
                // Sized from the measured viewport before any pixels are drawn,
                // so the scrollbar is correct and jumps land precisely.
                // marginInline:auto rather than mx-auto so the value is stable
                // even while the track width settles.
                style={{
                  width: size?.w ?? 'min(100%, 620px)',
                  height: size?.h,
                  flex: '0 0 auto',
                  marginInline: inline ? undefined : 'auto',
                }}
              >
                <canvas ref={(el) => { canvasRefs.current[n - 1] = el; }} className="block rounded-sm" />

                {pageHighlights.map((h) =>
                  h.rects!.map((r, i) => (
                    <div
                      key={`${h.id}-${i}`}
                      data-highlight-id={i === 0 ? h.id : undefined}
                      className={flashHighlight === h.id ? 'highlight-flash' : undefined}
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
                  className={`pdf-text-layer ${highlightAllMatches ? '' : 'find-active-only'}`}
                  style={{ position: 'absolute', left: 0, top: 0, zIndex: 2, pointerEvents: tool === 'hand' ? 'none' : 'auto' }}
                />

                <span className="absolute bottom-2 right-2 text-[10px] font-black text-slate-400 bg-white/80 px-1.5 py-0.5 rounded pointer-events-none z-10">{labelFor(n)}</span>
              </div>
            );
          })}
        </div>
      </div>

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

/** Search results list, grouped by page. */
const SearchResultsPanel: React.FC<{
  hits: SearchHit[];
  activeHit: number;
  query: string;
  textReady: boolean;
  onSelect: (index: number) => void;
  onFocusInput: () => void;
}> = ({ hits, activeHit, query, textReady, onSelect, onFocusInput }) => {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeHit]);

  if (!query.trim()) {
    return (
      <div className="text-center py-6 px-2">
        <Search className="w-8 h-8 text-slate-300 mx-auto mb-2" />
        <p className="text-xs text-slate-400 mb-3">Search the document to see every match here.</p>
        <button onClick={onFocusInput} className="text-[11px] font-black uppercase tracking-widest text-[#2D6A4F] hover:underline">Open find bar</button>
      </div>
    );
  }
  if (!textReady) return <p className="text-xs text-slate-400 text-center py-6 px-2">Reading document…</p>;
  if (!hits.length) return <p className="text-xs text-slate-400 text-center py-6 px-2">No matches for “{query}”.</p>;

  const groups = hits.reduce<Record<number, { hit: SearchHit; index: number }[]>>((acc, hit, index) => {
    (acc[hit.page] ??= []).push({ hit, index });
    return acc;
  }, {});

  return (
    <div className="space-y-3">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 px-1">
        {hits.length} match{hits.length === 1 ? '' : 'es'} on {Object.keys(groups).length} page{Object.keys(groups).length === 1 ? '' : 's'}
      </p>
      {Object.entries(groups).map(([page, entries]) => (
        <div key={page}>
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 bg-slate-200/70 px-2 py-1 rounded-md sticky top-0">
            Page {page} · {entries.length}
          </p>
          {entries.map(({ hit, index }) => (
            <button
              key={index}
              ref={index === activeHit ? activeRef : undefined}
              onClick={() => onSelect(index)}
              className={`w-full text-left px-2 py-2 text-[11px] leading-snug rounded-md mt-1 transition-colors ${
                index === activeHit ? 'bg-[#2D6A4F] text-white' : 'text-slate-600 hover:bg-slate-200/70'
              }`}
            >
              <span className="opacity-70">…{hit.before}</span>
              <span className={`font-black ${index === activeHit ? 'text-[#FFB703]' : 'bg-[#FFB703]/40 rounded px-0.5'}`}>{hit.match}</span>
              <span className="opacity-70">{hit.after}…</span>
            </button>
          ))}
        </div>
      ))}
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
    }, { rootMargin: '300px' });

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
