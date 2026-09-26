/**
 * Material Library.
 *
 * One list of everything uploaded this semester: title, course, topic,
 * semester, type, date, size, page/slide count, OCR, last opened, last
 * position, favorite, and tags. Search, filter, sort, favorites, and recently
 * opened. Large lists paint a window of rows. The list does not read file
 * bytes. Size and kind come from the record, or from the reader once opened.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format, isValid, parseISO } from 'date-fns';
import {
  Clock,
  FileText,
  Image as ImageIcon,
  Library,
  Presentation,
  Search,
  Star,
  Tag,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import type { Slide } from '../types';
import { formatMaterialSize, ocrLabel } from '../utils/materialKind';
import {
  buildLibrary,
  filterLibrary,
  recentLibrary,
  visibleRange,
  type LibraryItem,
  type LibraryQuery,
  type LibrarySort,
} from '../utils/materialLibrary';

const ROW = 168;
const WINDOW_AT = 40;

function formatWhen(iso?: string): string {
  if (!iso) return '—';
  const d = parseISO(iso);
  return isValid(d) ? format(d, 'd MMM yyyy') : '—';
}

function countLabel(item: LibraryItem): string {
  if (!item.pageCount) return '—';
  const unit = item.positionUnit === 'Slide' ? 'slide' : 'page';
  return `${item.pageCount} ${unit}${item.pageCount === 1 ? '' : 's'}`;
}

async function asBytes(file: Blob | Uint8Array | string): Promise<Uint8Array | null> {
  if (file instanceof Uint8Array) return file;
  if (typeof Blob !== 'undefined' && file instanceof Blob) return new Uint8Array(await file.arrayBuffer());
  return null;
}

const MaterialLibrary: React.FC = () => {
  const { state, dispatch } = useApp();
  const navigate = useNavigate();
  const items = useMemo(() => buildLibrary(state), [state]);
  const [query, setQuery] = useState<LibraryQuery>({
    query: '',
    kind: 'all',
    courseId: '',
    semester: '',
    favoritesOnly: false,
    recentOnly: false,
    sort: 'uploaded',
  });
  const [tagFor, setTagFor] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(640);
  const scroller = useRef<HTMLDivElement>(null);

  const courses = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of items) {
      if (item.courseId && !seen.has(item.courseId)) {
        seen.set(item.courseId, item.courseCode ? `${item.courseCode} — ${item.courseName}` : item.courseName);
      }
    }
    return [...seen.entries()];
  }, [items]);
  const semesters = useMemo(
    () => [...new Set(items.map((item) => item.semester).filter((s) => s && s !== '—'))],
    [items],
  );
  const shown = useMemo(() => filterLibrary(items, query), [items, query]);
  const recent = useMemo(() => recentLibrary(items), [items]);
  const windowed = shown.length > WINDOW_AT;
  const range = windowed ? visibleRange(shown.length, scrollTop, viewport, ROW) : { start: 0, end: shown.length };
  const slice = shown.slice(range.start, range.end);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || 640);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [windowed, shown.length]);

  const patch = (id: string, updates: Partial<Slide>) => {
    dispatch({ type: 'UPDATE_SLIDE', payload: { id, updates } });
  };

  const toggleFavorite = (item: LibraryItem) => {
    patch(item.id, { favorite: !item.favorite });
  };

  const addTag = (item: LibraryItem) => {
    const tag = tagDraft.trim().replace(/\s+/g, ' ');
    if (!tag) return;
    const tags = item.tags.some((t) => t.toLowerCase() === tag.toLowerCase()) ? item.tags : [...item.tags, tag];
    patch(item.id, { tags });
    setTagDraft('');
    setTagFor(null);
  };

  const removeTag = (item: LibraryItem, tag: string) => {
    patch(item.id, { tags: item.tags.filter((t) => t !== tag) });
  };

  const setSort = (sort: LibrarySort) => setQuery((q) => ({ ...q, sort }));

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-[#1B4332] to-[#2D6A4F] p-6 text-white shadow-lg">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/15">
            <Library className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Material Library</h1>
            <p className="text-sm text-white/80">
              Every file in this semester, on this device. Opening a result goes to the last page or slide.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <label className="relative flex-1">
            <span className="sr-only">Search materials</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={query.query}
              onChange={(e) => setQuery((q) => ({ ...q, query: e.target.value }))}
              placeholder="Search title, course, topic, tag…"
              aria-label="Search materials"
              className="w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-[#2D6A4F]/20"
            />
          </label>
          <label className="text-sm text-gray-600">
            <span className="sr-only">Sort materials</span>
            <select
              aria-label="Sort materials"
              value={query.sort}
              onChange={(e) => setSort(e.target.value as LibrarySort)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold"
            >
              <option value="uploaded">Upload date</option>
              <option value="recent">Recently opened</option>
              <option value="title">Title</option>
              <option value="size">File size</option>
              <option value="course">Course</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          {([
            ['all', 'All'],
            ['presentation', 'PowerPoint'],
            ['pdf', 'PDF'],
            ['docx', 'Word'],
            ['image', 'Images'],
            ['text', 'Text'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setQuery((q) => ({ ...q, kind: id }))}
              className={`rounded-full px-3 py-1 text-xs font-bold ${
                query.kind === id ? 'bg-[#2D6A4F] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setQuery((q) => ({ ...q, favoritesOnly: !q.favoritesOnly }))}
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              query.favoritesOnly ? 'bg-amber-400 text-[#1B4332]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            Favorites
          </button>
          <button
            type="button"
            onClick={() => setQuery((q) => ({ ...q, recentOnly: !q.recentOnly }))}
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              query.recentOnly ? 'bg-[#2D6A4F] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            Recently opened
          </button>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <select
            aria-label="Filter by course"
            value={query.courseId}
            onChange={(e) => setQuery((q) => ({ ...q, courseId: e.target.value }))}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">All courses</option>
            {courses.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
          <select
            aria-label="Filter by semester"
            value={query.semester}
            onChange={(e) => setQuery((q) => ({ ...q, semester: e.target.value }))}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">All semesters</option>
            {semesters.map((semester) => (
              <option key={semester} value={semester}>{semester}</option>
            ))}
          </select>
          <p className="sm:ml-auto self-center text-xs font-bold text-gray-400">
            {shown.length} of {items.length}
          </p>
        </div>
      </div>

      {recent.length > 0 && !query.query && !query.favoritesOnly && !query.recentOnly && query.kind === 'all' && !query.courseId && !query.semester && (
        <section aria-label="Recently opened">
          <h2 className="mb-2 flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-gray-500">
            <Clock className="h-3.5 w-3.5" /> Recently opened
          </h2>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {recent.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.openLink)}
                className="min-w-[12rem] rounded-xl border border-gray-100 bg-white px-3 py-2 text-left shadow-sm hover:border-[#2D6A4F]/30"
              >
                <p className="truncate text-sm font-bold text-gray-800">{item.title}</p>
                <p className="truncate text-[11px] text-gray-500">
                  {item.positionUnit} {item.lastPosition ?? '—'} · {formatWhen(item.lastOpenedAt)}
                </p>
              </button>
            ))}
          </div>
        </section>
      )}

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white p-10 text-center">
          <FileText className="mx-auto mb-3 h-10 w-10 text-gray-300" />
          <p className="font-bold text-gray-700">{items.length === 0 ? 'No materials yet' : 'Nothing matches'}</p>
          <p className="mt-1 text-sm text-gray-500">
            {items.length === 0
              ? 'Upload a PDF or PowerPoint from Study Materials. It will show up here.'
              : 'Try another word, or clear a filter.'}
          </p>
        </div>
      ) : (
        <div
          ref={scroller}
          data-testid="library-list"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          className={windowed ? 'max-h-[70vh] overflow-y-auto' : ''}
        >
          <div style={windowed ? { height: shown.length * ROW, position: 'relative' } : undefined}>
            <div style={windowed ? { position: 'absolute', top: range.start * ROW, left: 0, right: 0 } : undefined} className="space-y-2">
              {slice.map((item) => (
                <article
                  key={item.id}
                  data-testid="library-card"
                  className="flex h-40 gap-3 overflow-hidden rounded-xl border border-gray-100 bg-white p-3 shadow-sm"
                >
                  <button
                    type="button"
                    aria-label={item.favorite ? `Remove favorite ${item.title}` : `Favorite ${item.title}`}
                    onClick={() => toggleFavorite(item)}
                    className={`mt-0.5 h-8 w-8 shrink-0 rounded-lg ${item.favorite ? 'text-amber-500' : 'text-gray-300 hover:text-amber-400'}`}
                  >
                    <Star className={`h-5 w-5 ${item.favorite ? 'fill-amber-400' : ''}`} />
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate(item.openLink)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="truncate font-bold text-gray-900">{item.title}</h3>
                      <span className="shrink-0 rounded-full bg-[#2D6A4F]/10 px-2 py-0.5 text-[11px] font-black text-[#2D6A4F]">
                        {item.kind === 'pptx' || item.kind === 'ppt' ? (
                          <Presentation className="mr-1 inline h-3 w-3" />
                        ) : item.kind === 'image' ? (
                          <ImageIcon className="mr-1 inline h-3 w-3" />
                        ) : null}
                        {item.typeLabel}
                      </span>
                    </div>
                    <p className="truncate text-xs text-gray-500">
                      {[item.courseCode, item.courseName].filter(Boolean).join(' ') || 'No course'}
                      {' · '}
                      {item.topicName}
                      {' · '}
                      {item.semester}
                    </p>
                    <p className="mt-1 truncate text-xs text-gray-600">
                      Uploaded {formatWhen(item.uploadDate)}
                      {' · '}
                      {formatMaterialSize(item.fileSize)}
                      {' · '}
                      {countLabel(item)}
                      {' · '}
                      {ocrLabel(item.ocrStatus)}
                    </p>
                    <p className="truncate text-xs text-gray-500">
                      Last opened {formatWhen(item.lastOpenedAt)}
                      {' · '}
                      Last {item.positionUnit.toLowerCase()} {item.lastPosition ?? '—'}
                      {item.visualStatus === 'failed' ? ' · Visual render failed — original kept' : ''}
                    </p>
                  </button>
                  <div className="hidden w-40 shrink-0 sm:block">
                    <div className="flex flex-wrap gap-1">
                      {item.tags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => removeTag(item, tag)}
                          className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-bold text-gray-600 hover:bg-red-50 hover:text-red-600"
                          title="Remove tag"
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                    {tagFor === item.id ? (
                      <input
                        aria-label={`Add tag to ${item.title}`}
                        value={tagDraft}
                        autoFocus
                        onChange={(e) => setTagDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') addTag(item);
                          if (e.key === 'Escape') setTagFor(null);
                        }}
                        onBlur={() => {
                          if (tagDraft.trim()) addTag(item);
                          else setTagFor(null);
                        }}
                        placeholder="Tag"
                        className="mt-1 w-full rounded border border-gray-200 px-2 py-1 text-xs"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setTagFor(item.id);
                          setTagDraft('');
                        }}
                        className="mt-1 flex items-center gap-1 text-[11px] font-bold text-[#2D6A4F]"
                      >
                        <Tag className="h-3 w-3" /> Add tag
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MaterialLibrary;
