import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { HIGHLIGHT_COLORS } from '../components/SelectionPopup';
import {
  Bookmark, Search, Trash2, ExternalLink, Copy, Check, X, Filter,
} from 'lucide-react';

/**
 * Study Bank.
 *
 * Previously this page could never show anything: nothing in the app dispatched
 * ADD_HIGHLIGHT, so the "Highlight text in Study Materials" hint pointed at a
 * feature that did not exist. Now that the viewers create highlights, this is a
 * working library — searchable, filterable, and each entry links back to the
 * exact page it came from.
 */

const Highlights: React.FC = () => {
  const { state, dispatch } = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  const [courseFilter, setCourseFilter] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const topicById = useMemo(() => new Map(state.topics.map((t) => [t.id, t])), [state.topics]);
  const courseById = useMemo(() => new Map(state.courses.map((c) => [c.id, c])), [state.courses]);
  const slideById = useMemo(() => new Map(state.slides.map((s) => [s.id, s])), [state.slides]);

  const enriched = useMemo(() => {
    return state.highlights
      .map((h) => {
        const topic = topicById.get(h.topicId);
        const course = topic ? courseById.get(topic.courseId) : undefined;
        const material = h.materialId ? slideById.get(h.materialId) : undefined;
        return { h, topic, course, material };
      })
      .sort((a, b) => new Date(b.h.timestamp).getTime() - new Date(a.h.timestamp).getTime());
  }, [state.highlights, topicById, courseById, slideById]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return enriched.filter(({ h, topic, course, material }) => {
      if (colorFilter && h.color !== colorFilter) return false;
      if (courseFilter && course?.id !== courseFilter) return false;
      if (!q) return true;
      return (
        h.text.toLowerCase().includes(q) ||
        (h.note ?? '').toLowerCase().includes(q) ||
        (topic?.topicName ?? '').toLowerCase().includes(q) ||
        (material?.title ?? '').toLowerCase().includes(q) ||
        (course?.courseName ?? '').toLowerCase().includes(q) ||
        (course?.courseCode ?? '').toLowerCase().includes(q)
      );
    });
  }, [enriched, query, colorFilter, courseFilter]);

  const usedCourses = useMemo(() => {
    const ids = new Set(enriched.map(({ course }) => course?.id).filter(Boolean) as string[]);
    return state.courses.filter((c) => ids.has(c.id));
  }, [enriched, state.courses]);

  const openHighlight = (topicId: string, slideIndex: number, page?: number) => {
    const params = new URLSearchParams({ slide: String(slideIndex) });
    if (page) params.set('page', String(page));
    navigate(`/read/${topicId}?${params.toString()}`);
  };

  const copy = (id: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
  };

  const swatch = (color: string) =>
    HIGHLIGHT_COLORS.find((c) => c.key === color)?.overlay ?? HIGHLIGHT_COLORS[0].overlay;

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-[#FFB703] to-[#FFA500] rounded-2xl p-6 text-white shadow-lg">
        <h1 className="text-2xl font-bold mb-1 flex items-center gap-2">⭐ Study Bank</h1>
        <p className="text-white/90 text-sm">
          {state.highlights.length === 0
            ? 'Highlights you save while reading will collect here.'
            : `${state.highlights.length} saved highlight${state.highlights.length === 1 ? '' : 's'}`}
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        {/* Search + filters */}
        <div className="p-4 border-b border-gray-100 space-y-3">
          <div className="flex items-center gap-3">
            <Search className="w-5 h-5 text-gray-400 flex-shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your highlights, topics and courses…"
              className="flex-1 outline-none text-sm font-medium min-w-0"
            />
            {query && (
              <button onClick={() => setQuery('')} className="p-1 rounded hover:bg-gray-100">
                <X className="w-4 h-4 text-gray-400" />
              </button>
            )}
          </div>

          {state.highlights.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <Filter className="w-3.5 h-3.5 text-gray-400" />

              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.key}
                  onClick={() => setColorFilter((f) => (f === c.key ? null : c.key))}
                  title={c.label}
                  className={`w-5 h-5 rounded-md ${c.swatch} transition-all ${
                    colorFilter === c.key ? 'ring-2 ring-offset-1 ring-slate-700 scale-110' : 'opacity-60 hover:opacity-100'
                  }`}
                />
              ))}

              {usedCourses.length > 0 && <span className="w-px h-4 bg-gray-200 mx-1" />}

              {usedCourses.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCourseFilter((f) => (f === c.id ? null : c.id))}
                  className={`text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-md transition-colors ${
                    courseFilter === c.id ? 'bg-[#2D6A4F] text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {c.courseCode}
                </button>
              ))}

              {(colorFilter || courseFilter) && (
                <button
                  onClick={() => { setColorFilter(null); setCourseFilter(null); }}
                  className="text-[10px] font-bold text-slate-400 hover:text-slate-700 underline"
                >
                  clear filters
                </button>
              )}
            </div>
          )}
        </div>

        {/* List */}
        <div className="p-4">
          {state.highlights.length === 0 ? (
            <div className="text-center py-14">
              <Bookmark className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <h2 className="text-xl font-bold text-gray-700 mb-2">No highlights yet</h2>
              <p className="text-gray-500 text-sm max-w-sm mx-auto">
                Open a document in Study Materials, select any text, and pick a colour from the
                toolbar that appears. Your highlights are saved here automatically.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12">
              <Search className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="font-bold text-gray-600">No highlights match your search</p>
              <p className="text-sm text-gray-400 mt-1">Try different words or clear the filters.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map(({ h, topic, course, material }) => (
                <div
                  key={h.id}
                  className="group relative p-4 bg-white rounded-xl border border-gray-200 hover:border-[#2D6A4F]/40 hover:shadow-md transition-all"
                >
                  {/* Colour spine */}
                  <span
                    className="absolute left-0 top-3 bottom-3 w-1.5 rounded-r"
                    style={{ background: swatch(h.color) }}
                  />

                  <div className="pl-3">
                    <p className="text-sm text-gray-800 leading-relaxed">
                      <span style={{ background: swatch(h.color), padding: '1px 2px', borderRadius: 2 }}>
                        {h.text}
                      </span>
                    </p>

                    {h.note && (
                      <p className="text-xs text-slate-500 mt-2 italic border-l-2 border-slate-200 pl-2">{h.note}</p>
                    )}

                    <div className="flex items-center justify-between gap-3 mt-3 flex-wrap">
                      <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-gray-400 flex-wrap">
                        {course && <span className="bg-gray-100 px-2 py-1 rounded-md text-gray-600">{course.courseCode}</span>}
                        {topic && <span className="truncate max-w-[160px]">{topic.topicName}</span>}
                        {material && <span className="truncate max-w-[160px] text-gray-400">· {material.title}</span>}
                        {h.page && <span className="text-gray-400">· p.{h.page}</span>}
                      </div>

                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button
                          onClick={() => copy(h.id, h.text)}
                          title="Copy text"
                          className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
                        >
                          {copiedId === h.id ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                        </button>
                        <button
                          onClick={() => openHighlight(h.topicId, h.slideIndex, h.page)}
                          title="Open where this came from"
                          className="p-1.5 rounded-lg hover:bg-gray-100 text-[#2D6A4F]"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm('Delete this highlight?')) {
                              dispatch({ type: 'DELETE_HIGHLIGHT', payload: h.id });
                            }
                          }}
                          title="Delete"
                          className="p-1.5 rounded-lg hover:bg-red-50 text-red-500"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Highlights;
