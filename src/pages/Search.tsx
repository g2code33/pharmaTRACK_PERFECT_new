/**
 * Academic Search.
 *
 * One offline search across the current semester and archived semesters.
 * It reads local indexes only — no AI provider, and no document is loaded
 * just because the user typed.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Archive, Search, SlidersHorizontal, WifiOff } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { searchAcademic, type AcademicSearchFilters, type SearchScopeFilter } from '../utils/academicSearch';
import { archiveCatalogStatus, archiveFacets, ensureArchiveCatalog, rebuildArchiveCatalog } from '../utils/archiveCatalog';
import { ensureConversationIndex } from '../utils/conversationSearch';
import { onSearchIndex } from '../utils/searchNotify';
import type { SearchResult } from '../utils/search';

const TYPES: { id: string; label: string }[] = [
  { id: '', label: 'All types' },
  { id: 'pdf', label: 'PDF' },
  { id: 'pptx', label: 'PowerPoint' },
  { id: 'docx', label: 'Word' },
  { id: 'image', label: 'Image' },
  { id: 'ocr', label: 'OCR text' },
  { id: 'text', label: 'Text' },
  { id: 'note', label: 'Notes' },
  { id: 'question', label: 'Questions' },
  { id: 'quiz', label: 'Quiz history' },
  { id: 'insight', label: 'Saved insights' },
  { id: 'chat', label: 'Chat history' },
  { id: 'objective', label: 'Objectives' },
  { id: 'highlight', label: 'Highlights' },
  { id: 'topic', label: 'Topics' },
  { id: 'course', label: 'Courses' },
];

const AcademicSearch: React.FC = () => {
  const { state } = useApp();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [scope, setScope] = useState<SearchScopeFilter>((params.get('scope') as SearchScopeFilter) || 'all');
  const [semesterKey, setSemesterKey] = useState(params.get('semester') ?? '');
  const [courseId, setCourseId] = useState(params.get('course') ?? '');
  const [topicId, setTopicId] = useState(params.get('topic') ?? '');
  const [materialType, setMaterialType] = useState(params.get('type') ?? '');
  const [dateFrom, setDateFrom] = useState(params.get('from') ?? '');
  const [dateTo, setDateTo] = useState(params.get('to') ?? '');
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => onSearchIndex(() => setTick((n) => n + 1)), []);
  useEffect(() => {
    void ensureArchiveCatalog();
    void ensureConversationIndex();
  }, []);

  useEffect(() => {
    const next = new URLSearchParams();
    if (query.trim()) next.set('q', query.trim());
    if (scope !== 'all') next.set('scope', scope);
    if (semesterKey) next.set('semester', semesterKey);
    if (courseId) next.set('course', courseId);
    if (topicId) next.set('topic', topicId);
    if (materialType) next.set('type', materialType);
    if (dateFrom) next.set('from', dateFrom);
    if (dateTo) next.set('to', dateTo);
    setParams(next, { replace: true });
  }, [query, scope, semesterKey, courseId, topicId, materialType, dateFrom, dateTo, setParams]);

  const filters: AcademicSearchFilters = {
    scope,
    semesterKey: semesterKey || undefined,
    courseId: courseId || undefined,
    topicId: topicId || undefined,
    materialType: materialType || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };

  const results = useMemo(
    () => searchAcademic(state, query, filters, 40),
    // filters is rebuilt each render; the fields above are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, query, scope, semesterKey, courseId, topicId, materialType, dateFrom, dateTo, tick],
  );

  const facets = useMemo(() => archiveFacets(), [tick]);
  const status = archiveCatalogStatus();
  const semesterLabel = [state.student?.level, state.student?.semester].filter(Boolean).join(' · ') || 'Current semester';

  const courses = useMemo(() => {
    const live = state.courses.map((c) => ({
      id: c.id,
      label: `${c.courseCode} — ${c.courseName}`,
      semester: 'current',
    }));
    const archived = facets.courses
      .filter((c) => !semesterKey || c.archiveId === semesterKey)
      .map((c) => ({
        id: c.id,
        label: `${c.code} — ${c.name}`,
        semester: c.archiveId,
      }));
    const seen = new Set<string>();
    return [...live, ...archived].filter((c) => {
      if (scope === 'current' && c.semester !== 'current') return false;
      if (scope === 'archive' && c.semester === 'current') return false;
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  }, [state.courses, facets.courses, scope, semesterKey]);

  const topics = useMemo(() => {
    const live = state.topics
      .filter((t) => !courseId || t.courseId === courseId)
      .map((t) => ({ id: t.id, label: t.topicName, courseId: t.courseId }));
    const archived = facets.topics
      .filter((t) => !courseId || t.courseId === courseId)
      .filter((t) => !semesterKey || t.archiveId === semesterKey)
      .map((t) => ({ id: t.id, label: t.name, courseId: t.courseId }));
    const seen = new Set<string>();
    return [...live, ...archived].filter((t) => {
      if (scope === 'archive' && state.topics.some((liveTopic) => liveTopic.id === t.id) && !facets.topics.some((a) => a.id === t.id)) {
        return false;
      }
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }, [state.topics, facets.topics, courseId, semesterKey, scope]);

  const clearFilters = () => {
    setScope('all');
    setSemesterKey('');
    setCourseId('');
    setTopicId('');
    setMaterialType('');
    setDateFrom('');
    setDateTo('');
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await rebuildArchiveCatalog();
      await ensureConversationIndex(true);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="bg-gradient-to-r from-[#1B4332] to-[#2D6A4F] rounded-2xl p-6 text-white">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#FFB703]">Offline · on this device</p>
            <h1 className="text-2xl font-bold mt-1 flex items-center gap-2">
              <Search className="w-6 h-6 text-[#FFB703]" /> Academic Search
            </h1>
            <p className="text-white/80 text-sm mt-1 max-w-xl">
              Courses, topics, notes, PDFs, PowerPoint, Word, OCR text, slides, objectives, questions, quizzes, insights and chats — current semester and archives. No AI provider is used.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white/10 rounded-full text-xs font-bold">
            <WifiOff className="w-3.5 h-3.5" /> Works offline
          </span>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-4">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Try a drug, a slide phrase, a note, a question…"
            className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-medium outline-none focus:ring-4 focus:ring-[#2D6A4F]/10 focus:bg-white"
          />
        </div>

        <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-gray-400">
          <SlidersHorizontal className="w-3.5 h-3.5" /> Filters
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Select label="Current / archive" value={scope} onChange={(v) => { setScope(v as SearchScopeFilter); setSemesterKey(''); }}>
            <option value="all">All semesters</option>
            <option value="current">Current semester</option>
            <option value="archive">Archives only</option>
          </Select>
          <Select label="Semester" value={semesterKey} onChange={(v) => { setSemesterKey(v); setScope(v === 'current' ? 'current' : v ? 'archive' : scope); }}>
            <option value="">Any semester</option>
            <option value="current">{semesterLabel}</option>
            {facets.archives.map((a) => (
              <option key={a.id} value={a.id}>{a.title}</option>
            ))}
          </Select>
          <Select label="Course" value={courseId} onChange={(v) => { setCourseId(v); setTopicId(''); }}>
            <option value="">Any course</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
          <Select label="Topic" value={topicId} onChange={setTopicId}>
            <option value="">Any topic</option>
            {topics.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
          <Select label="Material type" value={materialType} onChange={setMaterialType}>
            {TYPES.map((t) => <option key={t.id || 'all'} value={t.id}>{t.label}</option>)}
          </Select>
          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">From</span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 outline-none focus:ring-2 focus:ring-[#2D6A4F]" />
          </label>
          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">To</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 outline-none focus:ring-2 focus:ring-[#2D6A4F]" />
          </label>
          <div className="flex items-end gap-2">
            <button type="button" onClick={clearFilters} className="px-3 py-2 text-xs font-bold text-gray-500 hover:text-gray-800">Clear</button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip active={materialType === 'note'} onClick={() => setMaterialType((t) => t === 'note' ? '' : 'note')}>Notes</Chip>
          <Chip active={materialType === 'question'} onClick={() => setMaterialType((t) => t === 'question' ? '' : 'question')}>Questions</Chip>
          <Chip active={materialType === 'ocr'} onClick={() => setMaterialType((t) => t === 'ocr' ? '' : 'ocr')}>OCR text</Chip>
          <Chip active={scope === 'archive'} onClick={() => setScope((s) => s === 'archive' ? 'all' : 'archive')}>Archives</Chip>
        </div>
        <p className="text-[11px] text-gray-400 flex items-center gap-2">
          <Archive className="w-3.5 h-3.5" />
          {status.ready
            ? `${status.archives} archived semester${status.archives === 1 ? '' : 's'} indexed · ${status.entries} entries`
            : 'Building the archive index…'}
          <button type="button" onClick={() => void refresh()} disabled={refreshing} className="font-bold text-[#2D6A4F] hover:underline disabled:opacity-50">
            {refreshing ? 'Refreshing…' : 'Refresh archive index'}
          </button>
        </p>
      </div>

      {query.trim().length < 2 ? (
        <div className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm text-gray-500">
          Type at least two characters. Search stays on this device.
        </div>
      ) : results.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center">
          <p className="font-bold text-gray-700">No matches for “{query.trim()}”</p>
          <p className="text-sm text-gray-400 mt-1">Try fewer words, or clear a filter.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">{results.length} result{results.length === 1 ? '' : 's'}</p>
          {results.map((result) => (
            <ResultCard key={result.id} result={result} />
          ))}
        </div>
      )}
    </div>
  );
};

const Select: React.FC<{ label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }> = ({ label, value, onChange, children }) => (
  <label className="block">
    <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">{label}</span>
    <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 outline-none focus:ring-2 focus:ring-[#2D6A4F]">
      {children}
    </select>
  </label>
);

const Chip: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={`px-3 py-1.5 rounded-full text-xs font-bold border ${active ? 'bg-[#2D6A4F] text-white border-[#2D6A4F]' : 'bg-white text-gray-600 border-gray-200 hover:border-[#2D6A4F]'}`}
  >
    {children}
  </button>
);

const ResultCard: React.FC<{ result: SearchResult }> = ({ result }) => {
  const where = [
    result.scope === 'archive' ? result.semesterLabel : result.courseCode,
    result.scope === 'archive' ? result.courseCode : result.topicName,
    result.scope === 'archive' ? result.topicName : undefined,
    result.materialTitle && result.materialTitle !== result.title ? result.materialTitle : undefined,
    result.location,
    result.ocr ? 'OCR' : undefined,
  ].filter(Boolean);

  return (
    <article className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 hover:border-[#2D6A4F]/40">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded bg-gray-100 text-gray-500">{result.category}</span>
            {result.scope === 'archive' && (
              <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded bg-amber-50 text-amber-700">Archive</span>
            )}
            {result.materialType && result.materialType !== 'page' && (
              <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{result.materialType}</span>
            )}
          </div>
          <h2 className="font-bold text-gray-800 leading-snug">{result.title}</h2>
          {where.length > 0 && (
            <p className="text-xs text-gray-500 mt-1">{where.join(' · ')}</p>
          )}
          {result.snippet && result.snippet !== 'Go to page' && (
            <p className="text-sm text-gray-600 mt-2 line-clamp-3">“{result.snippet.replace(/^…|…$/g, '')}”</p>
          )}
        </div>
      </div>
      <div className="mt-3">
        <Link
          to={result.link}
          className="inline-flex items-center px-3 py-1.5 rounded-lg bg-[#2D6A4F] text-white text-xs font-bold hover:bg-[#1B4332]"
        >
          {result.action || 'Open'}
        </Link>
      </div>
    </article>
  );
};

export default AcademicSearch;
