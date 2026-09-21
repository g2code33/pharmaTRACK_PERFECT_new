import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight,
  Download, FileText, Info, Loader2, Maximize, Menu, Minimize,
  PanelLeft, Search, StickyNote, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { renderPptx, ptToPx, type PptxDocument, type PptxParagraph, type PptxShape, type PptxSlide } from '../utils/pptxRenderer';
import SelectionPopup from './SelectionPopup';
import type { HighlightColor } from '../types';

/**
 * Native .pptx viewer — renders the *actual* slide as positioned DOM:
 * shape geometry, fonts, fills, tables, placed images and backgrounds,
 * exactly the way the document was laid out. No conversion services, no
 * network — the file stays on the device (see utils/pptxRenderer).
 *
 * UX mirrors the PDF viewer: single-slide stage with prev/next + "n of N",
 * direct jump, keyboard navigation, lazy thumbnail sidebar (bottom sheet on
 * mobile), zoom presets, find with per-slide matching, speaker notes,
 * fullscreen presentation mode, file info, "Download Original", resume
 * position per material and a text fallback if a file cannot be rendered.
 *
 * Performance: only the current slide is rendered; thumbnails render lazily
 * (IntersectionObserver) and skip images; large decks never materialise
 * more than a few slides' DOM at a time.
 */

export interface PptxViewerProps {
  fileUrl: string;
  title?: string;
  /** Text captured at upload time — used for the "View Extracted Text" fallback. */
  extractedText?: string;
  /** Open directly on this slide (1-based), e.g. from a search deep-link. */
  jumpToPage?: number;
  /** Open the find bar with this query prefilled. */
  initialQuery?: string;
  /** When the material was added (shown in File Info). */
  uploadDate?: string;
  onTextExtracted?: (pages: { page: number; text: string }[]) => void;
  onCreateHighlight?: (h: { page: number; text: string; color: HighlightColor }) => void;
  onAskAi?: (text: string) => void;
}

type ZoomMode = 'fitWidth' | 'fit' | 'custom';

const POS_KEY = 'pharmatrack.pptxPos.v1';
const FONT_STACK = 'Calibri, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const clampZoom = (v: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(v * 100) / 100));

/* ------------------------------------------------------------------ */
/* Resume position (per material, local only)                         */
/* ------------------------------------------------------------------ */

function loadSavedSlide(fileUrl: string): number | null {
  try {
    // Archive previews use ephemeral blob: URLs — no meaningful resume target.
    if (!fileUrl.startsWith('local:')) return null;
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, { slide: number; t: number }>;
    const entry = map[fileUrl];
    return entry && Number.isFinite(entry.slide) ? entry.slide : null;
  } catch {
    return null;
  }
}

function saveSlidePosition(fileUrl: string, slide: number): void {
  try {
    if (!fileUrl.startsWith('local:')) return;
    const raw = localStorage.getItem(POS_KEY);
    const map: Record<string, { slide: number; t: number }> = raw ? JSON.parse(raw) : {};
    const entries = Object.entries(map);
    if (entries.length >= 50 && !map[fileUrl]) {
      const oldest = entries.sort((a, b) => a[1].t - b[1].t)[0];
      if (oldest) delete map[oldest[0]];
    }
    map[fileUrl] = { slide, t: Date.now() };
    localStorage.setItem(POS_KEY, JSON.stringify(map));
  } catch {
    /* quota exceeded — resume is a nicety, never block on it */
  }
}

/* ------------------------------------------------------------------ */
/* In-slide find highlighting                                         */
/* ------------------------------------------------------------------ */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function clearMarks(root: HTMLElement): void {
  root.querySelectorAll('mark[data-pptx-find]').forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent || ''), m);
    parent.normalize();
  });
}

/** Wraps every occurrence of `query` inside the rendered slide; returns count. */
function markText(root: HTMLElement, query: string, opts: { caseSensitive: boolean; wholeWord: boolean }): number {
  const q = query.trim();
  if (!q) return 0;
  const flags = 'g' + (opts.caseSensitive ? '' : 'i');
  let re: RegExp;
  try {
    re = new RegExp(opts.wholeWord ? `\\b${escapeRe(q)}\\b` : escapeRe(q), flags);
  } catch {
    return 0;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentNode;
      if (!p || (p as HTMLElement).tagName === 'MARK') return NodeFilter.FILTER_REJECT;
      re.lastIndex = 0;
      return re.test(n.textContent || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let count = 0;
  for (const node of nodes) {
    const text = node.textContent || '';
    re.lastIndex = 0;
    const hits: { start: number; end: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({ start: m.index, end: m.index + m[0].length });
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
    if (!hits.length) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const h of hits) {
      if (h.start > last) frag.appendChild(document.createTextNode(text.slice(last, h.start)));
      const mark = document.createElement('mark');
      mark.setAttribute('data-pptx-find', '1');
      mark.className = 'bg-amber-300/80 text-inherit';
      mark.textContent = text.slice(h.start, h.end);
      frag.appendChild(mark);
      count += 1;
      last = h.end;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function aspectLabel(w: number, h: number): string {
  if (h > 0) {
    const r = w / h;
    if (Math.abs(r - 16 / 9) < 0.02) return '16:9';
    if (Math.abs(r - 4 / 3) < 0.02) return '4:3';
  }
  return `${Math.round(w)} × ${Math.round(h)}`;
}

/* ------------------------------------------------------------------ */
/* Slide rendering (pure DOM, memoised)                               */
/* ------------------------------------------------------------------ */

const ParagraphView = memo(function ParagraphView({
  p, fontScale, defaultSizePt,
}: { p: PptxParagraph; fontScale: number; defaultSizePt: number }) {
  const baseSize = (p.runs[0]?.sizePt ?? defaultSizePt) * fontScale;
  const style: React.CSSProperties = {
    textAlign: p.align ?? 'left',
    fontSize: ptToPx(baseSize),
    lineHeight: p.lineSpacing ?? 1.15,
    marginTop: p.spaceBeforePt ? ptToPx(p.spaceBeforePt) : 0,
    marginBottom: p.spaceAfterPt ? ptToPx(p.spaceAfterPt) : 0,
  };
  if (!p.runs.length) {
    return <div aria-hidden style={{ ...style, minHeight: ptToPx(baseSize) }} />;
  }
  const bullet = p.bullet === undefined ? null : p.bullet;
  return (
    <div style={style} className={bullet ? 'flex items-start' : ''}>
      {bullet ? (
        <span aria-hidden className="shrink-0 w-[1.4em] text-left whitespace-pre">{bullet}\u00A0</span>
      ) : null}
      <span className="min-w-0 whitespace-pre-wrap break-words">
        {p.runs.map((r, i) => (
          <span
            key={i}
            style={{
              fontSize: r.sizePt ? ptToPx(r.sizePt * fontScale) : undefined,
              fontWeight: r.bold ? 700 : undefined,
              fontStyle: r.italic ? 'italic' : undefined,
              textDecoration: r.underline ? 'underline' : undefined,
              color: r.color,
              fontFamily: r.font,
            }}
          >
            {r.text}
          </span>
        ))}
      </span>
    </div>
  );
});

const TableView = memo(function TableView({ shape, base }: { shape: PptxShape; base: React.CSSProperties }) {
  const table = shape.table;
  if (!table || !table.cells.length) return null;
  return (
    <div aria-hidden className="absolute overflow-hidden" style={base}>
      <table style={{ tableLayout: 'fixed', width: '100%', borderCollapse: 'collapse', fontFamily: FONT_STACK }}>
        {table.colWidths.length ? (
          <colgroup>
            {table.colWidths.map((w, i) => (
              <col key={i} style={{ width: shape.w > 0 ? `${((w / shape.w) * 100).toFixed(2)}%` : undefined }} />
            ))}
          </colgroup>
        ) : null}
        <tbody>
          {table.cells.map((row, ri) => (
            <tr key={ri} style={{ height: table.rowHeights[ri] || undefined }}>
              {row.map((c, ci) => (
                <td
                  key={ci}
                  style={{
                    background: c.fill,
                    border: '1px solid rgba(0, 0, 0, 0.28)',
                    padding: '2px 5px',
                    fontSize: ptToPx((c.sizePt ?? 14) * shape.textScale),
                    fontWeight: c.bold ? 700 : 400,
                    color: c.color,
                    verticalAlign: 'middle',
                    overflow: 'hidden',
                  }}
                >
                  {c.text}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

const ShapeView = memo(function ShapeView({ shape, showImages }: { shape: PptxShape; showImages: boolean }) {
  const base: React.CSSProperties = {
    position: 'absolute',
    left: shape.x,
    top: shape.y,
    width: shape.w,
    height: shape.h,
    transform: shape.rot ? `rotate(${shape.rot}deg)` : undefined,
  };

  if (shape.type === 'image') {
    if (!shape.imageUrl || !showImages || shape.w <= 0 || shape.h <= 0) return null;
    return <img src={shape.imageUrl} alt="" loading="lazy" draggable={false} className="absolute select-none" style={{ ...base, objectFit: 'fill' }} />;
  }

  if (shape.type === 'line') {
    const color = shape.fill || shape.borderColor || '#000000';
    return (
      <div
        aria-hidden
        className="absolute"
        style={{ ...base, background: color, minWidth: Math.max(shape.w, 1), minHeight: Math.max(shape.h, shape.borderWidth || 2), borderRadius: 2 }}
      />
    );
  }

  if (shape.type === 'table') return <TableView shape={shape} base={base} />;

  if (shape.type === 'chart') {
    return (
      <div aria-hidden className="absolute flex items-center justify-center rounded border border-dashed border-gray-300 bg-gray-50/80" style={base}>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Chart</span>
      </div>
    );
  }

  // Text shape (possibly with a fill/border behind it).
  const t = shape.text;
  const radius = shape.geom === 'ellipse' ? '50%' : shape.geom === 'roundRect' ? '10px' : undefined;
  const borderStyle: React.CSSProperties = shape.borderColor
    ? { border: `${Math.max(1, shape.borderWidth || 1)}px solid ${shape.borderColor}` }
    : {};
  return (
    <div
      data-shape={shape.isTitle ? 'title' : 'text'}
      className={shape.fill ? 'absolute overflow-hidden' : 'absolute'}
      style={{ ...base, background: shape.fill, ...borderStyle, borderRadius: radius }}
    >
      {t ? (
        <div
          className={`w-full h-full flex flex-col ${t.anchor === 'ctr' ? 'justify-center' : t.anchor === 'b' ? 'justify-end' : 'justify-start'}`}
          style={{ padding: '5px 9px' }}
        >
          {t.paragraphs.map((p, i) => (
            <ParagraphView key={i} p={p} fontScale={t.fontScale * shape.textScale} defaultSizePt={t.defaultSizePt} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

const SlideCanvas = memo(function SlideCanvas({
  slide, sw, sh, showImages = true,
}: { slide: PptxSlide; sw: number; sh: number; showImages?: boolean }) {
  return (
    <div
      className="relative overflow-hidden"
      style={{ width: sw, height: sh, background: slide.background ?? '#ffffff', fontFamily: FONT_STACK }}
      data-slide-canvas
    >
      {slide.shapes.map((s) => (
        <ShapeView key={s.id} shape={s} showImages={showImages} />
      ))}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Thumbnails (lazy, IntersectionObserver-gated)                      */
/* ------------------------------------------------------------------ */

const THUMB_W = 132;

const Thumb = memo(function Thumb({
  index, active, deck, onGo,
}: { index: number; active: number; deck: PptxDocument; onGo: (n: number) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    // Rooted at the viewport: the strip lives in its own scroll container
    // (sidebar on desktop, bottom sheet on mobile), so a stage-rooted observer
    // would never fire.
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setInView(e.isIntersecting);
      },
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const isActive = active === index;
  // Always render the neighbourhood of the current slide; the rest only when
  // scrolled near. Keeps large decks cheap even with the sidebar open.
  const rendered = inView || Math.abs(index - active) <= 6;
  const k = THUMB_W / deck.slideWidth;

  return (
    <button
      ref={ref}
      onClick={() => onGo(index)}
      data-testid={`pptx-thumb-${index}`}
      className={`w-36 shrink-0 p-2 sm:w-full sm:p-0 transition-colors ${isActive ? 'bg-amber-50' : 'hover:bg-slate-200/70'}`}
      title={`Go to slide ${index}`}
    >
      <div
        className={`relative mx-auto w-full overflow-hidden rounded border-2 bg-white sm:w-[132px] ${isActive ? 'border-[#2D6A4F] shadow-md' : 'border-slate-300'}`}
        style={{ aspectRatio: `${deck.slideWidth} / ${deck.slideHeight}` }}
      >
        {rendered ? (
          <div className="pointer-events-none absolute left-0 top-0 origin-top-left" style={{ transform: `scale(${k})`, width: deck.slideWidth }}>
            <SlideCanvas slide={deck.slides[index - 1]} sw={deck.slideWidth} sh={deck.slideHeight} showImages={false} />
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] font-bold text-slate-400">
            Slide {index}
          </div>
        )}
      </div>
      <div className={`mt-1 text-center text-[11px] font-bold ${isActive ? 'text-[#2D6A4F]' : 'text-slate-500'}`}>{index}</div>
    </button>
  );
});

/* ------------------------------------------------------------------ */
/* Main viewer                                                        */
/* ------------------------------------------------------------------ */

const PptxViewer: React.FC<PptxViewerProps> = ({
  fileUrl, title, extractedText, jumpToPage, initialQuery, uploadDate,
  onTextExtracted, onCreateHighlight, onAskAi,
}) => {
  const [deck, setDeck] = useState<PptxDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'slides' | 'text'>('slides');
  const [slide, setSlide] = useState(1);
  const [zoom, setZoom] = useState<{ mode: ZoomMode; value: number }>({ mode: 'fitWidth', value: 1 });
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 640px)').matches : true,
  );
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [findOpts, setFindOpts] = useState({ caseSensitive: false, wholeWord: false });
  const [matchIdx, setMatchIdx] = useState(0);
  const [markCount, setMarkCount] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const [zoomMenu, setZoomMenu] = useState(false);
  const [menu, setMenu] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [fs, setFs] = useState(false);
  /** In presentation mode the chrome fades out until the pointer moves. */
  const [fsChrome, setFsChrome] = useState(true);
  const [retryTick, setRetryTick] = useState(0);
  const [pageInput, setPageInput] = useState('1');
  const [selection, setSelection] = useState<{ anchor: { x: number; y: number }; text: string } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const deckRef = useRef<PptxDocument | null>(null);
  const jumpAppliedRef = useRef(false);
  const touchRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const total = deck?.slides.length ?? 0;

  /* ---------------- parse (once per file / retry) ---------------- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMode('slides');
    setSlide(1);
    setPageInput('1');
    setQuery('');
    setFindOpen(false);
    jumpAppliedRef.current = false;

    (async () => {
      try {
        const blob = await (await fetch(fileUrl)).blob();
        const parsed = await renderPptx(blob);
        if (cancelled) {
          parsed.dispose();
          return;
        }
        const prev = deckRef.current;
        if (prev && prev !== parsed) prev.dispose();
        deckRef.current = parsed;
        setDeck(parsed);
        onTextExtracted?.(parsed.slides.map((s) => ({ page: s.slideNumber, text: s.text })));
        setLoading(false);
      } catch (err) {
        console.error('PPTX parse failed:', err);
        if (!cancelled) {
          setError('The file could not be read. It may be corrupted, password-protected, or in the older .ppt format.');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl, retryTick]);

  useEffect(() => () => {
    deckRef.current?.dispose();
    deckRef.current = null;
  }, []);

  /* ---------------- deep-link / resume ---------------- */
  useEffect(() => {
    if (!deck || jumpAppliedRef.current) return;
    jumpAppliedRef.current = true;
    let start = 1;
    const saved = loadSavedSlide(fileUrl);
    if (saved && saved >= 1 && saved <= deck.slides.length) start = saved;
    if (jumpToPage && jumpToPage >= 1 && jumpToPage <= deck.slides.length) start = jumpToPage;
    setSlide(start);
    setPageInput(String(start));
    if (initialQuery) {
      setFindOpen(true);
      setQuery(initialQuery);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck]);

  /* ---------------- navigation ---------------- */
  const go = useCallback(
    (n: number) => {
      if (!deck) return;
      const clamped = Math.min(total, Math.max(1, n));
      setSlide(clamped);
      setPageInput(String(clamped));
      saveSlidePosition(fileUrl, clamped);
    },
    [deck, total, fileUrl],
  );

  /* ---------------- zoom ---------------- */
  const scale = useMemo(() => {
    if (!deck) return 1;
    if (zoom.mode === 'custom') return clampZoom(zoom.value);
    const { w, h } = containerSize;
    const sw = deck.slideWidth;
    const sh = deck.slideHeight;
    if (w < 10 || h < 10) return 1;
    if (zoom.mode === 'fitWidth') return clampZoom((w - 16) / sw);
    return clampZoom(Math.min((w - 24) / sw, (h - 24) / sh));
  }, [deck, zoom, containerSize]);

  const currentScaleRef = useRef(1);
  currentScaleRef.current = scale;
  const zoomBy = useCallback((delta: number) => {
    setZoom((z) => ({ mode: 'custom', value: clampZoom((z.mode === 'custom' ? z.value : currentScaleRef.current) + delta) }));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setContainerSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [deck, mode, error, fs]);

  /* Ctrl/⌘ + wheel zooms (trackpad pinch on laptops), like a PDF page. */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 0.1 : -0.1);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [deck, mode, zoomBy]);

  /* Presentation mode: chrome fades away, any pointer movement brings it back. */
  useEffect(() => {
    if (!fs) {
      setFsChrome(true);
      return;
    }
    let timer: number | undefined;
    const reveal = () => {
      setFsChrome(true);
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => setFsChrome(false), 2500);
    };
    reveal();
    window.addEventListener('mousemove', reveal);
    window.addEventListener('touchstart', reveal);
    return () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('mousemove', reveal);
      window.removeEventListener('touchstart', reveal);
    };
  }, [fs]);

  /* Light-dismiss the toolbar dropdowns (Escape is handled separately). */
  useEffect(() => {
    if (!zoomMenu && !menu) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[data-pptx-menu]')) return;
      setZoomMenu(false);
      setMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [zoomMenu, menu]);

  /* ---------------- keyboard ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomBy(0.2);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        zoomBy(-0.2);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        setZoom({ mode: 'fitWidth', value: 1 });
        return;
      }
      if (typing) return;
      if (e.key === 'Escape') {
        if (infoOpen) setInfoOpen(false);
        else if (findOpen) setFindOpen(false);
        else if (zoomMenu || menu) {
          setZoomMenu(false);
          setMenu(false);
        } else if (fs) setFs(false);
        return;
      }
      if (!deck || mode !== 'slides') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        go(slide + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        go(slide - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'End') {
        e.preventDefault();
        go(total);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deck, slide, total, findOpen, zoomMenu, menu, infoOpen, fs, mode, go, zoomBy]);

  /* ---------------- find across slides ---------------- */
  const matches = useMemo(() => {
    if (!deck || !query.trim()) return [] as number[];
    const q = query.trim();
    let re: RegExp | null = null;
    if (findOpts.wholeWord) {
      try {
        re = new RegExp(`\\b${escapeRe(q)}\\b`, findOpts.caseSensitive ? '' : 'i');
      } catch {
        re = null;
      }
    }
    return deck.slides
      .filter((s) => {
        if (re) return re.test(s.text);
        const t = findOpts.caseSensitive ? s.text : s.text.toLowerCase();
        const needle = findOpts.caseSensitive ? q : q.toLowerCase();
        return t.includes(needle);
      })
      .map((s) => s.slideNumber);
  }, [deck, query, findOpts]);

  const goToMatch = useCallback(
    (idx: number) => {
      if (!matches.length) return;
      const n = ((idx % matches.length) + matches.length) % matches.length;
      setMatchIdx(n);
      go(matches[n]);
    },
    [matches, go],
  );

  useEffect(() => {
    if (!query.trim()) {
      setMatchIdx(0);
      setMarkCount(0);
      return;
    }
    if (matches.length) {
      setMatchIdx(0);
      go(matches[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, findOpts, matches.join(','), deck]);

  /* highlight the current slide's matches in the DOM */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    clearMarks(stage);
    if (findOpen && query.trim() && deck && slide === matches[matchIdx]) {
      setMarkCount(markText(stage, query, findOpts));
    } else {
      setMarkCount(0);
    }
  }, [slide, query, findOpts, findOpen, deck, matches, matchIdx]);

  /* ---------------- selection ---------------- */
  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelection(null);
      return;
    }
    const text = sel.toString();
    if (!text.trim() || text.length < 2) {
      setSelection(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelection({ anchor: { x: rect.left + rect.width / 2, y: rect.top }, text });
  }, []);

  const handleHighlight = useCallback(
    (color: HighlightColor) => {
      if (selection && onCreateHighlight) {
        onCreateHighlight({ page: slide, text: selection.text, color });
      }
      window.getSelection()?.removeAllRanges();
      setSelection(null);
    },
    [selection, onCreateHighlight, slide],
  );

  const handleCopy = useCallback(() => {
    if (!selection) return;
    navigator.clipboard?.writeText(selection.text).catch(() => undefined);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, [selection]);

  /* ---------------- swipe ---------------- */
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, []);
  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const s = touchRef.current;
      touchRef.current = null;
      if (!s || !deck) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - s.t < 600) {
        if (dx < 0) go(slide + 1);
        else go(slide - 1);
      }
    },
    [deck, slide, go],
  );

  const download = useCallback(() => {
    // Keep a real .pptx extension on the saved file even when the material
    // title (used as the download name) was stored without one.
    const base = title?.trim() || 'presentation';
    const name = /\.pptx?$/i.test(base) ? base : `${base}.pptx`;
    const a = document.createElement('a');
    a.href = fileUrl;
    a.download = name;
    a.click();
  }, [fileUrl, title]);

  /* ---------------- derived ---------------- */
  const currentSlide = deck && deck.slides.length ? deck.slides[slide - 1] : undefined;
  const zoomLabel =
    zoom.mode === 'fitWidth' ? 'Fit Width' : zoom.mode === 'fit' ? 'Fit to Screen' : `${Math.round(scale * 100)}%`;
  const textSlides = deck ? deck.slides.filter((s) => s.text.trim()).length : 0;
  const hasSlides = Boolean(deck && deck.slides.length);
  /**
   * A readable zip with no slides is just as unrenderable as a broken file,
   * so it gets the same never-a-blank-viewer treatment.
   */
  const failure = error ?? (deck && !hasSlides ? 'No slides were found in this file.' : null);

  /* ================= error state (spec §17) ================= */
  if (!loading && mode === 'slides' && failure) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-100 p-4">
        <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-xl">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-50">
            <AlertTriangle className="h-7 w-7 text-red-500" />
          </div>
          <h3 className="text-lg font-bold text-gray-900">Unable to render this PowerPoint visually</h3>
          <p className="mt-2 text-sm text-gray-500">
            Your original presentation is safe. {failure}
          </p>
          <div className="mt-6 flex flex-col gap-2">
            <button
              onClick={download}
              className="flex items-center justify-center gap-2 rounded-lg bg-[#2D6A4F] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#24523e] transition-colors"
            >
              <Download className="h-4 w-4" /> Download Original
            </button>
            {extractedText ? (
              <button
                onClick={() => {
                  setMode('text');
                  setError(null);
                }}
                className="flex items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-bold text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <FileText className="h-4 w-4" /> View Extracted Text
              </button>
            ) : null}
            <button
              onClick={() => {
                setError(null);
                setRetryTick((t) => t + 1);
              }}
              className="rounded-lg px-4 py-2 text-sm font-bold text-[#2D6A4F] hover:bg-[#2D6A4F]/10 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ================= loading ================= */
  if (loading) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-gray-100">
        <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-[#FFB703]" />
        <p className="text-sm font-bold uppercase tracking-widest text-gray-400">Preparing slides…</p>
      </div>
    );
  }

  /* ================= extracted-text fallback mode ================= */
  if (mode === 'text') {
    return (
      <div className="flex h-full w-full flex-col bg-gray-100">
        <div className="flex items-center gap-0.5 border-b border-slate-300 bg-slate-100 px-2 py-1.5 shadow-sm">
          {hasSlides ? (
            <button
              onClick={() => setMode('slides')}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-bold text-[#2D6A4F] hover:bg-[#2D6A4F]/10 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" /> Back to Slides
            </button>
          ) : null}
          <span className="px-2 text-sm font-black text-slate-700 truncate">{title || 'Presentation'}</span>
          <div className="ml-auto" />
          {!hasSlides ? (
            <button
              onClick={() => {
                setMode('slides');
                setError(null);
                setRetryTick((t) => t + 1);
              }}
              className="mr-1 rounded-lg px-2 py-1.5 text-sm font-bold text-[#2D6A4F] hover:bg-[#2D6A4F]/10 transition-colors"
            >
              Retry
            </button>
          ) : null}
          <button onClick={download} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-200/70 transition-colors">
            <Download className="h-4 w-4" /> <span className="hidden sm:inline">Download Original</span>
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {deck && hasSlides ? (
            <div className="mx-auto max-w-3xl space-y-4">
              {deck.slides.map((s) => (
                <div key={s.slideNumber} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-xs font-black uppercase tracking-wider text-[#2D6A4F]">Slide {s.slideNumber}</span>
                    {s.title ? <span className="text-sm font-bold text-gray-900 truncate">{s.title}</span> : null}
                  </div>
                  {s.body.length ? (
                    <div className="space-y-1">
                      {s.body.map((b, i) => (
                        <p key={i} className="text-sm leading-relaxed text-gray-700">{b}</p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm italic text-gray-400">No text on this slide.</p>
                  )}
                  {s.notes ? (
                    <div className="mt-3 rounded-lg bg-amber-50 p-3">
                      <p className="mb-1 text-[11px] font-black uppercase tracking-wider text-amber-700">Speaker notes</p>
                      <p className="whitespace-pre-wrap text-sm text-amber-900">{s.notes}</p>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <pre className="mx-auto max-w-3xl whitespace-pre-wrap rounded-xl border border-gray-200 bg-white p-5 font-sans text-sm leading-relaxed text-gray-700 shadow-sm">
              {extractedText || 'No extracted text is available for this file.'}
            </pre>
          )}
        </div>
      </div>
    );
  }

  if (!deck) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-100 text-sm font-bold text-gray-400">
        No slides found in this file.
      </div>
    );
  }

  /* ================= main slide view ================= */
  const iconBtn = 'p-1.5 rounded-lg hover:bg-slate-200/70 text-slate-600 disabled:opacity-30 transition-colors';
  const activeBtn = 'bg-[#2D6A4F]/12 text-[#2D6A4F]';

  const chromeCls = fs && !fsChrome ? 'opacity-0 pointer-events-none' : 'opacity-100';

  return (
    <div
      className={`flex flex-col ${fs ? 'fixed inset-0 z-[100] h-full w-full bg-gray-950' : 'relative h-full w-full bg-gray-100'}`}
      data-pptx-viewer
    >
      {/* toolbar (fades out in presentation mode until the pointer moves) */}
      <div className={`relative z-30 flex flex-shrink-0 flex-wrap items-center gap-0.5 border-b border-slate-300 bg-slate-100 px-2 py-1.5 shadow-sm transition-opacity duration-300 ${chromeCls}`}>
        <button
          onClick={() => setSidebarOpen((s) => !s)}
          title="Toggle thumbnails"
          className={`${iconBtn} ${sidebarOpen ? activeBtn : ''}`}
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <button
          onClick={() => {
            setFindOpen((s) => !s);
            setTimeout(() => searchInputRef.current?.focus(), 0);
          }}
          title="Find (Ctrl+F)"
          className={`${iconBtn} ${findOpen ? activeBtn : ''}`}
        >
          <Search className="h-4 w-4" />
        </button>

        <span className="mx-1 h-5 w-px bg-slate-300" />

        <button onClick={() => go(slide - 1)} disabled={slide <= 1} title="Previous slide (←)" className={iconBtn}>
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button onClick={() => go(slide + 1)} disabled={slide >= total} title="Next slide (→)" className={iconBtn}>
          <ChevronRight className="h-4 w-4" />
        </button>
        <input
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value)}
          onBlur={() => go(parseInt(pageInput, 10) || 1)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(parseInt(pageInput, 10) || 1);
            e.stopPropagation();
          }}
          aria-label="Go to slide"
          className="w-12 rounded-md border border-slate-300 bg-white px-1 py-1 text-center text-xs font-bold outline-none focus:ring-2 focus:ring-[#2D6A4F]/20"
        />
        <span className="px-1 text-xs font-bold text-slate-500">of {total}</span>

        <span className="mx-1 h-5 w-px bg-slate-300" />

        <button onClick={() => zoomBy(-0.2)} title="Zoom out (Ctrl -)" className={iconBtn}>
          <ZoomOut className="h-4 w-4" />
        </button>
        <button onClick={() => zoomBy(0.2)} title="Zoom in (Ctrl +)" className={iconBtn}>
          <ZoomIn className="h-4 w-4" />
        </button>
        <div className="relative" data-pptx-menu>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setZoomMenu((s) => !s);
              setMenu(false);
            }}
            className="flex min-w-[7rem] items-center justify-between gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 hover:bg-slate-50"
            title="Zoom"
          >
            {zoomLabel}
            <ChevronDown className="h-3 w-3" />
          </button>
          {zoomMenu && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute left-0 top-full z-50 mt-1 w-44 rounded-lg bg-slate-800 py-1 text-white shadow-2xl"
            >
              {(
                [
                  ['fitWidth', 'Fit Width'],
                  ['fit', 'Fit to Screen'],
                  ['custom', '100%'],
                ] as [ZoomMode, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => {
                    setZoom(k === 'custom' ? { mode: 'custom', value: 1 } : { mode: k, value: 1 });
                    setZoomMenu(false);
                  }}
                  className={`flex w-full items-center justify-between px-4 py-1.5 text-sm hover:bg-white/10 ${zoom.mode === k && k !== 'custom' ? 'text-amber-300' : ''}`}
                >
                  {label}
                  {zoom.mode === k && k !== 'custom' ? <Check className="h-3.5 w-3.5" /> : null}
                </button>
              ))}
              <div className="my-1 h-px bg-white/15" />
              {[0.5, 0.75, 1.25, 1.5, 2, 3].map((z) => (
                <button
                  key={z}
                  onClick={() => {
                    setZoom({ mode: 'custom', value: z });
                    setZoomMenu(false);
                  }}
                  className={`w-full px-4 py-1.5 text-left text-sm hover:bg-white/10 ${zoom.mode === 'custom' && Math.abs(zoom.value - z) < 0.01 ? 'text-amber-300' : ''}`}
                >
                  {Math.round(z * 100)}%
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => setShowNotes((s) => !s)}
          title="Toggle speaker notes"
          className={`${iconBtn} ${showNotes ? activeBtn : ''}`}
        >
          <StickyNote className="h-4 w-4" />
        </button>

        <div className="ml-auto" />

        <button onClick={download} title="Download original file" className={iconBtn}>
          <Download className="h-4 w-4" />
        </button>
        <button
          onClick={() => setFs((s) => !s)}
          title={fs ? 'Exit fullscreen (Esc)' : 'Fullscreen presentation mode'}
          className={iconBtn}
        >
          {fs ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
        </button>
        <div className="relative" data-pptx-menu>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenu((s) => !s);
              setZoomMenu(false);
            }}
            title="More tools"
            className={`${iconBtn} ${menu ? activeBtn : ''}`}
          >
            <Menu className="h-4 w-4" />
          </button>
          {menu && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-full z-50 mt-1 w-52 rounded-lg bg-slate-800 py-1 text-white shadow-2xl"
            >
              <button onClick={() => { go(1); setMenu(false); }} className="flex w-full items-center gap-3 px-4 py-2 text-sm hover:bg-white/10">
                <ChevronLeft className="h-4 w-4" /> First slide
              </button>
              <button onClick={() => { go(total); setMenu(false); }} className="flex w-full items-center gap-3 px-4 py-2 text-sm hover:bg-white/10">
                <ChevronRight className="h-4 w-4" /> Last slide
              </button>
              <div className="my-1 h-px bg-white/15" />
              <button onClick={() => { setMode('text'); setMenu(false); }} className="flex w-full items-center gap-3 px-4 py-2 text-sm hover:bg-white/10">
                <FileText className="h-4 w-4" /> View Extracted Text
              </button>
              <button onClick={() => { setInfoOpen(true); setMenu(false); }} className="flex w-full items-center gap-3 px-4 py-2 text-sm hover:bg-white/10">
                <Info className="h-4 w-4" /> File Info
              </button>
              <button onClick={() => { download(); setMenu(false); }} className="flex w-full items-center gap-3 px-4 py-2 text-sm hover:bg-white/10">
                <Download className="h-4 w-4" /> Download Original
              </button>
            </div>
          )}
        </div>
      </div>

      {/* find bar */}
      {findOpen && (
        <div className="relative z-20 flex flex-wrap items-center gap-2 border-b border-slate-300 bg-white px-3 py-2 shadow-sm">
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') goToMatch(matchIdx + (e.shiftKey ? -1 : 1));
              if (e.key === 'Escape') setFindOpen(false);
            }}
            placeholder="Find in presentation…"
            className="w-56 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[#2D6A4F]/20"
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-bold text-slate-600">
            <input
              type="checkbox"
              checked={findOpts.caseSensitive}
              onChange={(e) => setFindOpts((o) => ({ ...o, caseSensitive: e.target.checked }))}
              className="accent-[#2D6A4F]"
            />
            Match case
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-bold text-slate-600">
            <input
              type="checkbox"
              checked={findOpts.wholeWord}
              onChange={(e) => setFindOpts((o) => ({ ...o, wholeWord: e.target.checked }))}
              className="accent-[#2D6A4F]"
            />
            Whole words
          </label>
          {query.trim().length >= 1 && (
            <span className="text-xs font-bold tabular-nums text-slate-500">
              {matches.length ? `${matchIdx + 1} of ${matches.length}` : 'Not found'}
            </span>
          )}
          <span className="text-[11px] text-slate-400 hidden sm:inline">
            {markCount > 0 ? `${markCount} shown on this slide` : ''}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <button onClick={() => goToMatch(matchIdx - 1)} disabled={!matches.length} title="Previous match" className={iconBtn}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button onClick={() => goToMatch(matchIdx + 1)} disabled={!matches.length} title="Next match" className={iconBtn}>
              <ChevronRight className="h-4 w-4" />
            </button>
            <button onClick={() => { setFindOpen(false); setQuery(''); }} title="Close (Esc)" className={iconBtn}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* body */}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {/* thumbnails: bottom sheet on mobile, left panel on desktop */}
        {sidebarOpen && (
          <div className="flex h-36 flex-shrink-0 flex-col border-t border-slate-300 bg-slate-100 sm:h-auto sm:w-48 sm:border-t-0 sm:border-r sm:overflow-y-auto">
            <div className="flex items-center justify-between px-3 py-1.5 sm:py-2">
              <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">
                Slides ({total})
              </span>
            </div>
            <div className="flex flex-1 gap-1 overflow-x-auto overflow-y-hidden px-2 pb-2 sm:flex-col sm:gap-0 sm:overflow-x-hidden sm:overflow-y-auto sm:p-0">
              {deck.slides.map((s) => (
                <Thumb
                  key={s.slideNumber}
                  index={s.slideNumber}
                  active={slide}
                  deck={deck}
                  onGo={go}
                />
              ))}
            </div>
          </div>
        )}

        {/* stage */}
        <div
          ref={containerRef}
          onMouseUp={handleMouseUp}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          className={`relative flex-1 overflow-auto ${fs ? 'bg-gray-950' : 'bg-gray-200'}`}
          data-testid="pptx-stage"
        >
          <div className="flex min-h-full min-w-full items-center justify-center p-4">
            <div className="flex flex-col items-center">
              <div
                style={{ width: deck.slideWidth * scale, height: deck.slideHeight * scale }}
                className="relative"
              >
                <div
                  ref={stageRef}
                  className="absolute left-0 top-0 origin-top-left shadow-2xl"
                  style={{ transform: `scale(${scale})`, width: deck.slideWidth, height: deck.slideHeight }}
                >
                  {currentSlide ? (
                    <SlideCanvas slide={currentSlide} sw={deck.slideWidth} sh={deck.slideHeight} />
                  ) : null}
                </div>
              </div>
              {showNotes && currentSlide ? (
                <div
                  className="mt-3 w-full rounded-b-lg border border-t-0 border-slate-300 bg-white px-4 py-3 shadow-lg"
                  style={{ width: deck.slideWidth * scale }}
                >
                  <p className="mb-1 text-[11px] font-black uppercase tracking-wider text-slate-400">
                    Speaker notes
                  </p>
                  {currentSlide.notes ? (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{currentSlide.notes}</p>
                  ) : (
                    <p className="text-sm italic text-slate-400">No notes on this slide.</p>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* selection popup */}
      {selection && (
        <SelectionPopup
          anchor={selection.anchor}
          onHighlight={handleHighlight}
          onCopy={handleCopy}
          onAskAi={onAskAi ? () => { onAskAi(selection.text); window.getSelection()?.removeAllRanges(); setSelection(null); } : undefined}
          onDismiss={() => {
            window.getSelection()?.removeAllRanges();
            setSelection(null);
          }}
        />
      )}

      {/* file info dialog */}
      {infoOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4" onClick={() => setInfoOpen(false)}>
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="File info"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-black text-slate-800">File Info</h3>
              <button onClick={() => setInfoOpen(false)} className={iconBtn}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <dl className="space-y-2 text-sm">
              {(
                [
                  ['Name', title || 'Presentation'],
                  ['Type', 'PowerPoint (PPTX)'],
                  ['Size', formatBytes(deck.fileSize)],
                  ['Slides', String(total)],
                  ['Dimensions', `${Math.round(deck.slideWidth)} × ${Math.round(deck.slideHeight)} px (${aspectLabel(deck.slideWidth, deck.slideHeight)})`],
                  ...(uploadDate ? ([['Added', formatDateTime(uploadDate)]] as [string, string][]) : []),
                  ['Created', formatDateTime(deck.dates?.created)],
                  ['Modified', formatDateTime(deck.dates?.modified)],
                  ['Text extraction', textSlides ? `${textSlides} of ${total} slide(s) contain text` : 'No text found'],
                ] as [string, string][]
              ).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 border-b border-slate-100 pb-2">
                  <dt className="shrink-0 font-bold text-slate-500">{k}</dt>
                  <dd className="break-words text-right font-medium text-slate-800">{v}</dd>
                </div>
              ))}
            </dl>
            <button
              onClick={download}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-[#2D6A4F] px-4 py-2 text-sm font-bold text-white hover:bg-[#24523e] transition-colors"
            >
              <Download className="h-4 w-4" /> Download Original
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PptxViewer;
