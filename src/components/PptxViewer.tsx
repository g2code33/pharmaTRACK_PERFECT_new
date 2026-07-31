import React, { useEffect, useMemo, useRef, useState } from 'react';
import { renderPptx, type PptxDocument } from '../utils/pptxRenderer';
import {
  ChevronUp, ChevronDown, Search, X, Loader2, AlertTriangle, Download,
  StickyNote, LayoutGrid, Rows,
} from 'lucide-react';

/**
 * Native .pptx viewer.
 *
 * Previously PowerPoint files showed a dead-end "browsers can't render this,
 * download it instead" screen. A .pptx is a ZIP of XML, so we parse it and lay
 * the slides out ourselves — offline, searchable, with speaker notes and
 * embedded images. See utils/pptxRenderer for why we don't convert to PDF.
 */

interface PptxViewerProps {
  fileUrl: string;
  title?: string;
  onTextExtracted?: (pages: { page: number; text: string }[]) => void;
}

const PptxViewer: React.FC<PptxViewerProps> = ({ fileUrl, title, onTextExtracted }) => {
  const [docData, setDocData] = useState<PptxDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(1);
  const [showNotes, setShowNotes] = useState(false);
  const [layout, setLayout] = useState<'scroll' | 'grid'>('scroll');
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    let created: PptxDocument | null = null;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const blob = await (await fetch(fileUrl)).blob();
        const parsed = await renderPptx(blob);
        if (cancelled) { parsed.dispose(); return; }
        created = parsed;
        setDocData(parsed);
        onTextExtracted?.(parsed.slides.map((s) => ({ page: s.slideNumber, text: s.text })));
      } catch (err) {
        console.error('PPTX parse failed:', err);
        if (!cancelled) setError('This PowerPoint file could not be read. It may be corrupted or in the older .ppt format.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      created?.dispose();
    };
  }, [fileUrl]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || !docData) return [];
    return docData.slides.filter((s) => s.text.toLowerCase().includes(q)).map((s) => s.slideNumber);
  }, [query, docData]);

  const goTo = (n: number) => {
    const total = docData?.slides.length ?? 0;
    const clamped = Math.min(Math.max(1, n), total);
    slideRefs.current[clamped - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setCurrent(clamped);
  };

  useEffect(() => {
    if (matches.length) goTo(matches[0]);
  }, [matches.length]);

  // Track which slide is in view.
  useEffect(() => {
    if (!docData) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio > 0.5) {
            setCurrent(Number((e.target as HTMLElement).dataset.slide));
          }
        }
      },
      { root: containerRef.current, threshold: [0.5] },
    );
    slideRefs.current.forEach((el) => el && obs.observe(el));
    return () => obs.disconnect();
  }, [docData, layout]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault(); setShowSearch(true); setTimeout(() => searchRef.current?.focus(), 0); return;
      }
      if (typing) { if (e.key === 'Escape') { setShowSearch(false); setQuery(''); } return; }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') goTo(current + 1);
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') goTo(current - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, docData]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full bg-slate-100">
        <Loader2 className="w-10 h-10 text-[#FFB703] animate-spin mb-3" />
        <p className="text-sm font-black text-slate-400 uppercase tracking-widest">Reading presentation…</p>
      </div>
    );
  }

  if (error || !docData) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full bg-slate-50 p-10 text-center">
        <AlertTriangle className="w-16 h-16 text-red-400 mb-4" />
        <h3 className="text-lg font-black text-slate-800 mb-1">Can't display this presentation</h3>
        <p className="text-sm text-slate-500 max-w-sm mb-6">{error}</p>
        <a href={fileUrl} download={title} className="bg-[#2D6A4F] text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-[#1B4332]">
          <Download className="w-5 h-5" /> Download instead
        </a>
      </div>
    );
  }

  const total = docData.slides.length;

  return (
    <div className="flex flex-col h-full w-full bg-slate-200/60 min-h-0">
      <div className="flex items-center gap-1 px-3 py-2 bg-white border-b border-slate-200 shadow-sm flex-shrink-0 flex-wrap">
        <button onClick={() => goTo(current - 1)} disabled={current <= 1} className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-30"><ChevronUp className="w-4 h-4" /></button>
        <span className="text-xs font-bold text-slate-600 tabular-nums px-1">{current} / {total}</span>
        <button onClick={() => goTo(current + 1)} disabled={current >= total} className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-30"><ChevronDown className="w-4 h-4" /></button>

        <div className="w-px h-5 bg-slate-200 mx-1.5" />

        <button onClick={() => setLayout((l) => (l === 'scroll' ? 'grid' : 'scroll'))} title={layout === 'scroll' ? 'Grid view' : 'Single column'} className="p-1.5 rounded-lg hover:bg-slate-100">
          {layout === 'scroll' ? <LayoutGrid className="w-4 h-4" /> : <Rows className="w-4 h-4" />}
        </button>
        <button onClick={() => setShowNotes((s) => !s)} title="Speaker notes" className={`p-1.5 rounded-lg hover:bg-slate-100 ${showNotes ? 'text-[#2D6A4F] bg-[#2D6A4F]/10' : ''}`}><StickyNote className="w-4 h-4" /></button>
        <button onClick={() => { setShowSearch((s) => !s); setTimeout(() => searchRef.current?.focus(), 0); }} title="Search (Ctrl+F)" className={`p-1.5 rounded-lg hover:bg-slate-100 ${showSearch ? 'text-[#2D6A4F] bg-[#2D6A4F]/10' : ''}`}><Search className="w-4 h-4" /></button>

        <div className="flex-1" />
        <a href={fileUrl} download={title} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-600"><Download className="w-4 h-4" /></a>
      </div>

      {showSearch && (
        <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200 flex-shrink-0">
          <Search className="w-4 h-4 text-slate-400" />
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find in presentation…" className="flex-1 bg-transparent text-sm font-medium outline-none min-w-0" />
          {query.length >= 2 && <span className="text-xs font-bold text-slate-500">{matches.length ? `${matches.length} slide${matches.length === 1 ? '' : 's'}` : 'No results'}</span>}
          <button onClick={() => { setShowSearch(false); setQuery(''); }} className="p-1 rounded hover:bg-slate-200"><X className="w-4 h-4" /></button>
        </div>
      )}

      <div ref={containerRef} className={`flex-1 overflow-auto min-h-0 p-4 ${layout === 'grid' ? 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start' : ''}`}>
        {docData.slides.map((s) => {
          const isMatch = matches.includes(s.slideNumber);
          return (
            <div
              key={s.slideNumber}
              data-slide={s.slideNumber}
              ref={(el) => { slideRefs.current[s.slideNumber - 1] = el; }}
              className={`bg-white shadow-lg rounded-xl overflow-hidden ${layout === 'scroll' ? 'mx-auto mb-4 max-w-4xl w-full' : ''} ${isMatch ? 'ring-2 ring-[#FFB703]' : ''}`}
            >
              {/* 16:9 keeps the familiar slide shape even though we're laying
                  out text rather than reproducing exact PowerPoint geometry. */}
              <div className="px-6 py-5 min-h-[16rem] flex flex-col" style={{ aspectRatio: layout === 'grid' ? '16 / 9' : undefined }}>
                <h3 className="text-lg font-black text-[#1B4332] mb-3 leading-snug">{s.title}</h3>

                {s.images.length > 0 && (
                  <div className={`grid gap-2 mb-3 ${s.images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                    {s.images.map((src, i) => (
                      <img key={i} src={src} alt="" className="w-full max-h-64 object-contain rounded-lg bg-slate-50" loading="lazy" />
                    ))}
                  </div>
                )}

                <div className="space-y-2 flex-1 overflow-hidden">
                  {s.body.map((para, i) => (
                    <p key={i} className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{para}</p>
                  ))}
                  {!s.body.length && !s.images.length && (
                    <p className="text-sm text-slate-400 italic">No text content on this slide.</p>
                  )}
                </div>
              </div>

              {showNotes && s.notes && (
                <div className="px-6 py-3 bg-amber-50 border-t border-amber-100">
                  <p className="text-[10px] font-black uppercase tracking-widest text-amber-700 mb-1 flex items-center gap-1"><StickyNote className="w-3 h-3" /> Speaker notes</p>
                  <p className="text-xs text-amber-900 whitespace-pre-wrap leading-relaxed">{s.notes}</p>
                </div>
              )}

              <div className="px-6 py-1.5 bg-slate-50 border-t text-[10px] font-black text-slate-400 text-right">{s.slideNumber}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default PptxViewer;
