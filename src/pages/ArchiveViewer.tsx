/**
 * Read-only explorer for an archived semester — the historical snapshot.
 *
 * Everything renders from the archive's own snapshot and its own IndexedDB
 * records. It never reads from (or writes to) the live app state, so
 * browsing an old semester can never edit or overwrite the current one.
 *
 * Covers: courses, topics, slides/materials, uploaded PDFs / PPTX / DOCX /
 * images, extracted & OCR text, offloaded slide text, notes, learning
 * objectives, exam questions, quiz history, study plans, exam dates,
 * activities, highlights, saved insights, chat history, timetables and the
 * timetable PDF, plus material metadata.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { loadArchive, loadArchivedFile, loadArchivedRecords, loadArchivedSlideText, type ArchiveRecord } from '../utils/semesterArchive';
import { extractWordText } from '../utils/wordProcessor';
import type { AppState, LearningStatus, Slide, TopicLearningRecord } from '../types';
import { STATUS_LABEL } from '../utils/learningEngine';
import PdfViewer from '../components/PdfViewer';
import PptxViewer from '../components/PptxViewer';
import { format } from 'date-fns';
import {
  Archive,
  Lock,
  BookOpen,
  FileText,
  File as FileIcon,
  FileSpreadsheet,
  Image as ImageIcon,
  StickyNote,
  FileQuestion,
  Brain,
  Calendar,
  CalendarCheck,
  Highlighter,
  ChevronLeft,
  X,
  Loader2,
  AlertTriangle,
  ListChecks,
  MessageSquare,
  Lightbulb,
  Activity,
  LayoutDashboard,
  GraduationCap,
  Download,
  Bot,
} from 'lucide-react';

interface PreviewState {
  slide: Slide;
  url: string | null;
  blobType: string;
  /** Inline extracted / OCR text stored with the slide. */
  text: string | null;
  /** Large text offloaded to IndexedDB (verbatim). */
  offloaded: string | null;
  /** DOCX rendered as text (no native DOCX viewer). */
  docxText: string | null;
  error: string | null;
}

const ArchiveViewer: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const focusKey = searchParams.get('focus') || '';
  const focusPage = Number.parseInt(searchParams.get('page') || '', 10) || undefined;
  const [record, setRecord] = useState<ArchiveRecord | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [selected, setSelected] = useState<string>('overview'); // 'overview' | course id
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewPage, setPreviewPage] = useState<number | undefined>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const appliedFocus = useRef('');
  const [aiConversations, setAiConversations] = useState<Array<{ id: string; title?: string; messages?: Array<{ id?: string; role?: string; content?: string }> }>>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rec = await loadArchive(id || '');
      if (cancelled) return;
      if (!rec) {
        setNotFound(true);
        return;
      }
      setRecord(rec);
      const extras = await loadArchivedRecords(rec.meta.id);
      if (cancelled) return;
      const chats = extras
        .filter((row) => row.sourceKey.startsWith('pharmatrack_ai_conversation_'))
        .map((row) => row.value)
        .filter((value): value is { id: string; title?: string; messages?: Array<{ id?: string; role?: string; content?: string }> } =>
          Boolean(value) && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string');
      setAiConversations(chats);
    })();
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    // Release object URLs on close/unmount.
    return () => {
      setPreview((p) => {
        if (p?.url && p.url.startsWith('blob:')) URL.revokeObjectURL(p.url);
        return p;
      });
    };
  }, [preview?.slide.id]);

  const snapshot = record?.snapshot as unknown as AppState | null;

  const topicsFor = useMemo(() => (courseId: string) =>
    (snapshot?.topics || []).filter((t) => t.courseId === courseId).sort((a, b) => a.orderIndex - b.orderIndex),
  [snapshot]);
  const slidesFor = useMemo(() => (topicId: string) =>
    (snapshot?.slides || []).filter((s) => s.topicId === topicId).sort((a, b) => a.slideNumber - b.slideNumber),
  [snapshot]);

  const openPreview = useCallback(async (slide: Slide, page?: number) => {
    if (!id) return;
    setPreviewPage(page);
    setPreviewLoading(true);
    setPreview({ slide, url: null, blobType: '', text: null, offloaded: null, docxText: null, error: null });
    try {
      const raw = (slide.fileUrl || '').replace(/^local:/, '');
      let url: string | null = null;
      let blobType = '';
      let docxText: string | null = null;
      if (raw) {
        const value = await loadArchivedFile(id, raw);
        if (value !== null) {
          if (typeof value === 'string' && value.startsWith('data:')) {
            url = value;
          } else {
            const blob = value instanceof Blob ? value : new Blob([value as BlobPart]);
            blobType = blob.type || '';
            url = URL.createObjectURL(blob);
            if (String(slide.fileType || '') === 'docx' || blobType.includes('wordprocessingml')) {
              try {
                docxText = await extractWordText(new File([blob], 'material.docx', { type: blobType || 'application/octet-stream' }));
              } catch {
                docxText = null;
              }
            }
          }
        } else {
          setPreview((prev) => (prev ? { ...prev, error: 'The file for this material is not in the archive.' } : prev));
        }
      }
      const offloaded = await loadArchivedSlideText(id, slide.id);
      setPreview((prev) => (prev
        ? { ...prev, url, blobType, text: slide.contentText || null, offloaded, docxText, error: prev.error }
        : prev));
    } catch (err) {
      console.error(err);
      setPreview((prev) => (prev ? { ...prev, error: 'Could not load this file.' } : prev));
    } finally {
      setPreviewLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!record || !snapshot || !focusKey) return;
    const token = `${record.meta.id}|${focusKey}|${focusPage ?? ''}`;
    if (appliedFocus.current === token) return;
    appliedFocus.current = token;
    const sep = focusKey.indexOf(':');
    const kind = sep === -1 ? focusKey : focusKey.slice(0, sep);
    const itemId = sep === -1 ? '' : focusKey.slice(sep + 1);
    const scrollTo = (selector: string) => {
      window.setTimeout(() => {
        document.querySelector(selector)?.scrollIntoView({ block: 'center' });
      }, 120);
    };

    if (kind === 'course' && itemId) {
      setSelected(itemId);
      return;
    }
    if (kind === 'topic' && itemId) {
      const topic = (snapshot.topics || []).find((t) => t.id === itemId);
      if (topic) setSelected(topic.courseId);
      scrollTo(`[data-archive-focus="topic:${itemId}"]`);
      return;
    }
    if ((kind === 'slide' || kind === 'highlight') && itemId) {
      const slideId = kind === 'slide'
        ? itemId
        : (snapshot.highlights || []).find((h) => h.id === itemId)?.materialId;
      const slide = slideId ? (snapshot.slides || []).find((s) => s.id === slideId) : undefined;
      if (slide) {
        const topic = (snapshot.topics || []).find((t) => t.id === slide.topicId);
        if (topic) setSelected(topic.courseId);
        const page = focusPage || (kind === 'highlight'
          ? (snapshot.highlights || []).find((h) => h.id === itemId)?.page
          : undefined);
        void openPreview(slide, page);
        return;
      }
    }
    setSelected('overview');
    if (itemId) scrollTo(`[data-archive-focus="${kind}:${itemId}"]`);
  }, [record, snapshot, focusKey, focusPage, openPreview]);

  if (notFound) {
    return (
      <div className="max-w-3xl mx-auto bg-white rounded-xl border border-gray-100 p-10 text-center">
        <AlertTriangle className="w-12 h-12 text-gray-300 mx-auto mb-3" />
        <h1 className="text-lg font-bold text-gray-700">Archive not found</h1>
        <p className="text-gray-500 text-sm mt-1">It may have been deleted from this device.</p>
        <Link to="/archive" className="inline-block mt-4 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg text-sm font-medium">
          Back to Academic Archive
        </Link>
      </div>
    );
  }

  if (!record || !snapshot) {
    return (
      <div className="max-w-3xl mx-auto bg-white rounded-xl border border-gray-100 p-10 text-center text-gray-500">
        <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> Loading archive…
      </div>
    );
  }

  const previewKind = (p: PreviewState): 'pdf' | 'pptx' | 'image' | 'docx' | 'other' => {
    const t = `${p.blobType} ${String(p.slide.fileType || '')}`.toLowerCase();
    if (t.includes('pdf')) return 'pdf';
    if (t.includes('presentationml') || t.includes('pptx')) return 'pptx';
    if (t.includes('wordprocessingml') || t.includes('docx')) return 'docx';
    if (t.startsWith('image') || t.includes('png') || t.includes('jpg') || t.includes('jpeg') || t.includes('gif') || t.includes('webp')) return 'image';
    return 'other';
  };

  const materialIcon = (slide: Slide) => {
    const t = String(slide.fileType || '').toLowerCase();
    if (t === 'pdf') return <FileText className="w-4 h-4 text-red-400 flex-shrink-0" />;
    if (t === 'pptx') return <FileSpreadsheet className="w-4 h-4 text-orange-400 flex-shrink-0" />;
    if (t === 'docx') return <FileIcon className="w-4 h-4 text-blue-400 flex-shrink-0" />;
    if (t === 'jpg' || t === 'png' || t === 'image' || t === 'gif' || t === 'webp') return <ImageIcon className="w-4 h-4 text-[#2D6A4F] flex-shrink-0" />;
    return <FileIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />;
  };

  const course = selected === 'overview' ? null : (snapshot.courses || []).find((c) => c.id === selected) || null;

  const Section: React.FC<{ title: string; icon: React.ElementType; empty?: string; children?: React.ReactNode }> = ({ title, icon: Icon, empty = 'Nothing in this semester.', children }) => (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3 flex items-center gap-2">
        <Icon className="w-4 h-4 text-[#2D6A4F]" /> {title}
      </h3>
      {children || <p className="text-xs text-gray-400">{empty}</p>}
    </div>
  );

  const has = (n: number) => n > 0;

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* ARCHIVED SEMESTER banner */}
      <div className="bg-gradient-to-r from-[#1B4332] to-[#2D6A4F] rounded-2xl p-5 text-white">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 bg-white/15 rounded-xl flex items-center justify-center">
              <Archive className="w-6 h-6 text-[#FFB703]" />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#FFB703]">Archived Semester</p>
              <h1 className="text-xl font-bold leading-tight">{record.meta.title}</h1>
              <p className="text-white/75 text-sm">
                {record.meta.academicYear && <>{record.meta.academicYear} · </>}
                Completed {format(new Date(record.meta.completedAt), 'd MMMM yyyy')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 px-2.5 py-1 bg-white/10 rounded-full text-xs font-bold">
              <Lock className="w-3.5 h-3.5" /> Read-only
            </span>
            <Link to="/archive" className="p-2 hover:bg-white/10 rounded-lg" title="Back to archive list">
              <ChevronLeft className="w-5 h-5" />
            </Link>
          </div>
        </div>
        <p className="text-white/80 text-xs mt-3">
          This semester is preserved as historical academic data. Browsing it never changes your current semester.
        </p>
        {record.meta.counts && (
          <div className="flex flex-wrap gap-2 mt-3 text-[11px] font-semibold text-white/90">
            <span className="bg-white/10 px-2 py-1 rounded-lg">Courses: {record.meta.counts.courses}</span>
            <span className="bg-white/10 px-2 py-1 rounded-lg">Topics: {record.meta.counts.topics}</span>
            <span className="bg-white/10 px-2 py-1 rounded-lg">Materials: {record.meta.counts.slides}</span>
            <span className="bg-white/10 px-2 py-1 rounded-lg">Files: {record.meta.fileCount}</span>
            <span className="bg-white/10 px-2 py-1 rounded-lg">Notes: {record.meta.counts.notes}</span>
            <span className="bg-white/10 px-2 py-1 rounded-lg">Questions: {record.meta.counts.questions}</span>
          </div>
        )}
      </div>

      <div className="lg:flex lg:gap-5 lg:items-start">
        {/* Left nav */}
        <nav className="lg:w-56 flex lg:flex-col gap-1.5 overflow-x-auto hide-scrollbar pb-1 lg:pb-0 lg:sticky lg:top-4">
          <button
            onClick={() => setSelected('overview')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-bold whitespace-nowrap transition-colors ${selected === 'overview' ? 'bg-[#2D6A4F] text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}
          >
            <LayoutDashboard className="w-4 h-4" /> Overview
          </button>
          {(snapshot.courses || []).map((c) => (
            <button
              key={c.id}
              onClick={() => setSelected(c.id)}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-bold whitespace-nowrap transition-colors text-left ${selected === c.id ? 'bg-[#2D6A4F] text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}
            >
              <GraduationCap className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{c.courseCode}</span>
              <span className={`ml-auto text-[10px] font-semibold ${selected === c.id ? 'text-white/70' : 'text-gray-400'}`}>
                {topicsFor(c.id).length} topics
              </span>
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-4">
          {selected === 'overview' && (
            <>
              {has((snapshot.courses || []).length) ? (
                <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                  <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3 flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-[#2D6A4F]" /> Courses this semester
                  </h3>
                  <div className="grid sm:grid-cols-2 gap-2">
                    {(snapshot.courses || []).map((c) => (
                      <button
                        key={c.id}
                        onClick={() => setSelected(c.id)}
                        className="text-left p-3 rounded-xl border border-gray-100 hover:border-[#2D6A4F] hover:bg-[#2D6A4F]/5"
                      >
                        <p className="font-bold text-gray-800 text-sm">{c.courseCode} <span className="font-normal text-gray-500">· {c.courseName}</span></p>
                        <p className="text-xs text-gray-500 mt-1">
                          {topicsFor(c.id).length} topics · {topicsFor(c.id).reduce((n, t) => n + slidesFor(t.id).length, 0)} materials · {c.creditHours} credits
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <Section title="Timetable" icon={Calendar} empty="No timetable entries.">
                <div className="space-y-3">
                  {(['class', 'quiz', 'exam'] as const).map((cat) => {
                    const items = snapshot.timetables?.[cat] || [];
                    return (
                      <div key={cat}>
                        <h4 className="text-xs font-bold text-gray-500 uppercase mb-1.5">{cat === 'class' ? 'Classes' : cat === 'quiz' ? 'Quizzes' : 'Exams'}</h4>
                        {items.length === 0 ? (
                          <p className="text-xs text-gray-400">Nothing scheduled</p>
                        ) : (
                          <div className="space-y-1.5">
                            {items.map((item) => (
                              <div key={item.id} className="flex items-center gap-3 text-sm bg-gray-50 rounded-lg px-3 py-2">
                                <span className="font-semibold text-gray-700">{item.subject}</span>
                                <span className="text-gray-500 text-xs">{item.date} {item.time}</span>
                                {item.location && <span className="text-gray-400 text-xs ml-auto">{item.location}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {snapshot.timetablePdf ? (
                    <a href={snapshot.timetablePdf} download="timetable.pdf" className="inline-flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg text-sm font-medium hover:bg-[#1B4332]">
                      <Download className="w-4 h-4" /> Download Timetable PDF
                    </a>
                  ) : null}
                </div>
              </Section>

              {has(((snapshot.learningRecords as TopicLearningRecord[] | undefined) || []).length) && (
                <Section title="Learning status" icon={GraduationCap}>
                  <div className="space-y-1.5">
                    {((snapshot.learningRecords as TopicLearningRecord[]) || []).map((row) => {
                      const topic = (snapshot.topics || []).find((t) => t.id === row.topicId);
                      const status = row.status as LearningStatus;
                      return (
                        <div key={row.topicId} data-archive-focus={`learn:${row.topicId}`} className="flex items-center gap-2 text-sm bg-gray-50 rounded-lg px-3 py-2">
                          <span className="font-semibold text-gray-700 truncate">{topic?.topicName || row.topicId}</span>
                          <span className="text-[10px] font-black uppercase text-gray-500">{STATUS_LABEL[status] || row.status}</span>
                          {row.nextReviewAt && <span className="text-xs text-gray-400 ml-auto">next {row.nextReviewAt.slice(0, 10)}</span>}
                        </div>
                      );
                    })}
                  </div>
                </Section>
              )}

              {has((snapshot.learningObjectives || []).length) && (
                <Section title="Learning Objectives" icon={ListChecks}>
                  <div className="space-y-1.5">
                    {(snapshot.learningObjectives || []).map((o) => (
                        <div key={o.id} data-archive-focus={`objective:${o.id}`} className={`flex items-center gap-2 text-sm rounded-lg px-3 py-2 ${focusKey === `objective:${o.id}` ? 'bg-[#2D6A4F]/10 ring-2 ring-[#2D6A4F]/40' : 'bg-gray-50'}`}>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${o.status === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>{o.status}</span>
                        <span className="text-gray-700">{o.objectiveText}</span>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {has((snapshot.notes || []).length) && (
                <Section title="Notes" icon={StickyNote}>
                  <div className="space-y-3">
                    {(snapshot.notes || []).map((note) => {
                      const topic = (snapshot.topics || []).find((t) => t.id === note.topicId);
                      return (
                        <div key={note.id} data-archive-focus={`note:${note.id}`} className={`border rounded-xl p-4 ${focusKey === `note:${note.id}` ? 'border-[#2D6A4F] ring-2 ring-[#2D6A4F]/30' : 'border-gray-100'}`}>
                          <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                            <StickyNote className="w-3.5 h-3.5" />
                            {topic?.topicName || 'Note'} · {format(new Date(note.createdAt), 'd MMM yyyy')}
                            {note.isAiGenerated && <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-[10px] font-bold flex items-center gap-0.5"><Bot className="w-3 h-3" /> AI</span>}
                          </div>
                          <p className="text-sm text-gray-700 whitespace-pre-wrap">{note.noteText}</p>
                          {note.attachedFiles?.length ? (
                            <div className="flex flex-wrap gap-2 mt-3">
                              {note.attachedFiles.map((f) => (
                                <a key={f.id} href={f.data} download={f.name} className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded-lg text-xs font-semibold text-slate-700">
                                  {f.name}
                                </a>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </Section>
              )}

              {has((snapshot.examQuestions || []).length) && (
                <Section title="Exam Questions" icon={FileQuestion}>
                  <div className="space-y-3">
                    {(snapshot.examQuestions || []).map((q) => {
                      const c = (snapshot.courses || []).find((x) => x.id === q.courseId);
                      return (
                        <details key={q.id} data-archive-focus={`question:${q.id}`} open={focusKey === `question:${q.id}`} className={`border rounded-xl p-4 ${focusKey === `question:${q.id}` ? 'border-[#2D6A4F] ring-2 ring-[#2D6A4F]/30' : 'border-gray-100'}`}>
                          <summary className="cursor-pointer text-sm text-gray-700 flex items-center gap-2 list-none">
                            <FileQuestion className="w-4 h-4 text-[#2D6A4F] flex-shrink-0" />
                            <span className="font-semibold">{c?.courseCode || '—'}</span>
                            <span className="text-gray-400 text-xs uppercase">{q.questionType}</span>
                            <span className="text-gray-400 text-xs">{q.marksAllocation} marks · {q.difficulty}</span>
                            <span className="truncate">{q.questionText}</span>
                          </summary>
                          <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
                            <p className="text-sm text-gray-700 whitespace-pre-wrap">{q.questionText}</p>
                            {q.options?.length ? (
                              <ol className="list-decimal list-inside text-sm text-gray-600 space-y-0.5">
                                {q.options.map((opt, i) => (
                                  <li key={i} className={q.correctOption === i ? 'font-bold text-green-700' : ''}>{opt}</li>
                                ))}
                              </ol>
                            ) : null}
                            {q.modelAnswer && (
                              <div className="bg-green-50 border border-green-100 rounded-lg p-3">
                                <p className="text-[10px] font-black uppercase tracking-widest text-green-700 mb-1">Model answer</p>
                                <p className="text-sm text-gray-700 whitespace-pre-wrap">{q.modelAnswer}</p>
                              </div>
                            )}
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </Section>
              )}

              {has((snapshot.quizHistory || []).length) && (
                <Section title="Quiz History" icon={Brain}>
                  <div className="space-y-3">
                    {[...(snapshot.quizHistory || [])].sort((a, b) => b.completedAt.localeCompare(a.completedAt)).map((q) => {
                      const c = (snapshot.courses || []).find((x) => x.id === q.courseId);
                      return (
                        <div key={q.id} data-archive-focus={`quiz:${q.id}`} className={`border rounded-xl p-4 flex items-center gap-4 ${focusKey === `quiz:${q.id}` ? 'border-[#2D6A4F] ring-2 ring-[#2D6A4F]/30' : 'border-gray-100'}`}>
                          <div className={`w-12 h-12 rounded-full flex items-center justify-center font-black text-sm ${q.scorePercentage >= 70 ? 'bg-green-100 text-green-700' : q.scorePercentage >= 50 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                            {q.scorePercentage}%
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-gray-800 text-sm">{c?.courseCode || 'Course'} quiz</p>
                            <p className="text-xs text-gray-500">
                              {format(new Date(q.completedAt), 'd MMM yyyy · HH:mm')} · {q.questionsUsed.length} questions
                              {q.weakTopics.length > 0 && <> · weak: {q.weakTopics.join(', ')}</>}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Section>
              )}

              {has((snapshot.studyPlans || []).length) && (
                <Section title="Study Plans" icon={CalendarCheck}>
                  <div className="space-y-1.5">
                    {(snapshot.studyPlans || []).sort((a, b) => a.date.localeCompare(b.date)).map((p) => {
                      const c = (snapshot.courses || []).find((x) => x.id === p.courseId);
                      return (
                        <div key={p.id} className="flex items-center gap-3 text-sm bg-gray-50 rounded-lg px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${p.isCompleted ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{p.isCompleted ? 'done' : 'planned'}</span>
                          <span className="font-semibold text-gray-700">{p.date} {p.timeSlot}</span>
                          <span className="text-gray-500 text-xs truncate">{c?.courseCode || ''} {p.activityType}{p.notes ? ` · ${p.notes}` : ''}</span>
                        </div>
                      );
                    })}
                  </div>
                </Section>
              )}

              {has((snapshot.examDates || []).length) && (
                <Section title="Exam Dates" icon={CalendarCheck}>
                  <div className="space-y-1.5">
                    {(snapshot.examDates || []).sort((a, b) => a.examDate.localeCompare(b.examDate)).map((d) => {
                      const c = (snapshot.courses || []).find((x) => x.id === d.courseId);
                      return (
                        <div key={d.id} className="flex items-center gap-3 text-sm bg-gray-50 rounded-lg px-3 py-2">
                          <Calendar className="w-4 h-4 text-[#2D6A4F]" />
                          <span className="font-semibold text-gray-700">{d.examDate}</span>
                          <span className="text-gray-500 text-xs">{c?.courseCode || 'Course'} · {d.examType}</span>
                          {d.isReminderSet && <span className="ml-auto text-[10px] font-bold text-amber-600">reminder on</span>}
                        </div>
                      );
                    })}
                  </div>
                </Section>
              )}

              {has((snapshot.activities || []).length) && (
                <Section title="Activity Log" icon={Activity}>
                  <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                    {[...(snapshot.activities || [])].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map((a) => (
                      <div key={a.id} className="flex items-center gap-2 text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2">
                        <Activity className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                        <span className="truncate">{a.description}</span>
                        <span className="text-gray-400 ml-auto whitespace-nowrap">{format(new Date(a.timestamp), 'd MMM yyyy · HH:mm')}</span>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {has((snapshot.highlights || []).length) && (
                <Section title="Highlights" icon={Highlighter}>
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {[...(snapshot.highlights || [])].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map((h) => {
                      const slide = (snapshot.slides || []).find((s) => s.id === h.materialId);
                      return (
                        <div key={h.id} data-archive-focus={`highlight:${h.id}`} className={`border-l-4 rounded-r-lg px-4 py-3 ${focusKey === `highlight:${h.id}` ? 'bg-[#2D6A4F]/10 ring-2 ring-[#2D6A4F]/30' : 'bg-gray-50'}`} style={{ borderColor: h.color || '#FFB703' }}>
                          <p className="text-sm text-gray-700">{h.text}</p>
                          {h.note && <p className="text-xs text-gray-500 mt-1 italic">Note: {h.note}</p>}
                          <p className="text-[11px] text-gray-400 mt-1">
                            {slide?.title || 'Material'}{h.page ? ` · page ${h.page}` : ''} · {format(new Date(h.timestamp), 'd MMM yyyy')}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </Section>
              )}

              {has((snapshot.savedInsights || []).length) && (
                <Section title="Saved Insights" icon={Lightbulb}>
                  <div className="space-y-2">
                    {(snapshot.savedInsights || []).map((s) => (
                      <div key={s.id} data-archive-focus={`insight:${s.id}`} className={`rounded-xl px-4 py-3 ${focusKey === `insight:${s.id}` ? 'bg-[#2D6A4F]/10 border border-[#2D6A4F] ring-2 ring-[#2D6A4F]/30' : 'bg-amber-50/60 border border-amber-100'}`}>
                        <p className="text-sm text-gray-700 whitespace-pre-wrap">{s.content}</p>
                        <p className="text-[11px] text-gray-400 mt-1 flex items-center gap-1">
                          <Bot className="w-3 h-3" /> {s.type} · {format(new Date(s.timestamp), 'd MMM yyyy')}
                        </p>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {has((snapshot.chatHistory || []).length) && (
                <Section title="Chat History" icon={MessageSquare}>
                  <div className="space-y-4 max-h-96 overflow-y-auto pr-1">
                    {(() => {
                      const byTopic = new Map<string, typeof snapshot.chatHistory>();
                      for (const m of snapshot.chatHistory || []) {
                        const list = byTopic.get(m.topicId) || [];
                        list.push(m);
                        byTopic.set(m.topicId, list);
                      }
                      return [...byTopic.entries()].map(([topicId, msgs]) => {
                        const topic = (snapshot.topics || []).find((t) => t.id === topicId);
                        return (
                          <div key={topicId}>
                            <p className="text-xs font-bold text-gray-500 uppercase mb-2">{topic?.topicName || 'Conversation'}</p>
                            <div className="space-y-1.5">
                              {msgs.slice(-60).map((m) => (
                                <div key={m.id} data-archive-focus={`chat:${m.id}`} className={`text-sm rounded-xl px-3 py-2 max-w-[85%] ${focusKey === `chat:${m.id}` ? 'ring-2 ring-[#FFB703]' : ''} ${m.role === 'user' ? 'bg-[#2D6A4F]/10 ml-auto text-gray-800' : 'bg-gray-100 text-gray-700'}`}>
                                  {m.content}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </Section>
              )}
              {aiConversations.length > 0 && (
                <Section title="AI conversations" icon={MessageSquare}>
                  <div className="space-y-4 max-h-96 overflow-y-auto pr-1" data-testid="archive-ai-conversations">
                    {aiConversations.map((conv) => (
                      <div key={conv.id} data-archive-focus={`aichat:${conv.id}`} className={focusKey === `aichat:${conv.id}` ? 'ring-2 ring-[#FFB703] rounded-xl p-2' : undefined}>
                        <p className="text-xs font-bold text-gray-500 uppercase mb-2">{conv.title || 'Conversation'}</p>
                        <div className="space-y-1.5">
                          {(conv.messages || []).slice(-40).map((m, i) => (
                            <div key={m.id || i} className={`text-sm rounded-xl px-3 py-2 max-w-[85%] ${m.role === 'user' ? 'bg-[#2D6A4F]/10 ml-auto text-gray-800' : 'bg-gray-100 text-gray-700'}`}>
                              {m.content}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

            </>
          )}

          {course && (
            <>
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-[#2D6A4F]/10 flex items-center justify-center">
                    <GraduationCap className="w-6 h-6 text-[#2D6A4F]" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="font-bold text-gray-800">{course.courseCode} · {course.courseName}</h2>
                    <p className="text-xs text-gray-500">
                      {course.lecturerName ? `${course.lecturerName} · ` : ''}{course.creditHours} credits · {topicsFor(course.id).length} topics
                    </p>
                  </div>
                </div>
              </div>

              {topicsFor(course.id).map((topic) => (
                <div key={topic.id} data-archive-focus={`topic:${topic.id}`} className={`bg-white rounded-xl border shadow-sm overflow-hidden ${focusKey === `topic:${topic.id}` ? 'border-[#2D6A4F] ring-2 ring-[#2D6A4F]/30' : 'border-gray-100'}`}>
                  <div className="px-4 py-3 bg-gray-50">
                    <p className="font-semibold text-gray-700 text-sm">{topic.topicName}</p>
                  </div>
                  <div className="p-4 space-y-1">
                    {slidesFor(topic.id).map((slide, idx) => (
                      <button
                        key={slide.id}
                        onClick={() => void openPreview(slide)}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[#2D6A4F]/5 text-left"
                      >
                        {materialIcon(slide)}
                        <span className="text-sm text-gray-700 truncate">{idx + 1}. {slide.title}</span>
                        {slide.status === 'completed' && <span className="ml-auto text-[10px] font-bold text-green-600 uppercase">done</span>}
                      </button>
                    ))}
                    {slidesFor(topic.id).length === 0 && <p className="text-xs text-gray-400 px-3 py-1">No materials</p>}
                  </div>
                </div>
              ))}
              {topicsFor(course.id).length === 0 && (
                <div className="bg-white rounded-xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-400">
                  No topics were recorded for this course.
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Material preview (read-only) */}
      {preview && (
        <div className="fixed inset-0 bg-black/70 z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
              <div className="flex items-center gap-2 min-w-0">
                <span className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-gray-400 bg-gray-200 px-2 py-0.5 rounded">
                  <Lock className="w-3 h-3" /> Read-only
                </span>
                <p className="font-semibold text-gray-800 truncate">{preview.slide.title}</p>
              </div>
              <button onClick={() => setPreview(null)} className="p-1 hover:bg-gray-200 rounded"><X className="w-5 h-5 text-gray-500" /></button>
            </div>
            <div className="flex-1 overflow-auto bg-gray-100">
              {previewLoading ? (
                <div className="h-64 flex items-center justify-center text-gray-500"><Loader2 className="w-6 h-6 animate-spin" /></div>
              ) : (() => {
                const kind = previewKind(preview);
                return (
                  <>
                    {preview.url && kind === 'pdf' && <div className="h-[70vh]"><PdfViewer fileUrl={preview.url} title={preview.slide.title} jumpToPage={previewPage} /></div>}
                    {preview.url && kind === 'pptx' && <div className="h-[70vh]"><PptxViewer fileUrl={preview.url} title={preview.slide.title} jumpToPage={previewPage} /></div>}
                    {preview.url && kind === 'image' && <img src={preview.url} alt={preview.slide.title} className="max-h-[70vh] mx-auto" />}
                    {kind === 'docx' && (
                      <div className="p-4">
                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Document text</p>
                        {preview.docxText ? (
                          <pre className="whitespace-pre-wrap text-sm text-gray-700 bg-white border border-gray-200 rounded-xl p-4 max-h-[50vh] overflow-auto">{preview.docxText}</pre>
                        ) : (
                          <p className="text-sm text-gray-500">Text could not be extracted from this document.</p>
                        )}
                      </div>
                    )}
                    {!preview.url && (
                      <div className="h-40 flex flex-col items-center justify-center text-gray-500 text-sm gap-2 px-6 text-center">
                        {preview.error || 'No file for this material.'}
                      </div>
                    )}
                    {preview.url && kind === 'other' && (
                      <div className="h-40 flex flex-col items-center justify-center gap-2 text-gray-600">
                        <FileIcon className="w-8 h-8 text-gray-400" />
                        <p className="text-sm">No built-in preview for this file type.</p>
                        <a href={preview.url} download className="px-3 py-1.5 bg-[#2D6A4F] text-white rounded-lg text-xs font-bold">Download</a>
                      </div>
                    )}
                    {preview.url && kind !== 'other' && (
                      <div className="px-4 pb-2">
                        <a href={preview.url} download className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-300 text-gray-700 rounded-lg text-xs font-bold hover:bg-gray-50">
                          <Download className="w-3.5 h-3.5" /> Download original
                        </a>
                      </div>
                    )}
                    {preview.text && (
                      <div className="p-4">
                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Extracted / OCR text</p>
                        <pre className="whitespace-pre-wrap text-sm text-gray-700 bg-white border border-gray-200 rounded-xl p-4 max-h-[40vh] overflow-auto">{preview.text}</pre>
                      </div>
                    )}
                    {preview.offloaded && (
                      <div className="p-4 pt-0">
                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Full slide text (stored outside JSON)</p>
                        <pre className="whitespace-pre-wrap text-sm text-gray-700 bg-white border border-gray-200 rounded-xl p-4 max-h-[40vh] overflow-auto">{preview.offloaded}</pre>
                      </div>
                    )}
                    {/* Material metadata */}
                    <div className="p-4 pt-0">
                      <details className="bg-white border border-gray-200 rounded-xl p-3">
                        <summary className="cursor-pointer text-xs font-bold text-gray-500 uppercase">Material metadata</summary>
                        <pre className="text-[11px] text-gray-600 mt-2 overflow-x-auto">{JSON.stringify({
                          id: preview.slide.id,
                          topicId: preview.slide.topicId,
                          slideNumber: preview.slide.slideNumber,
                          fileUrl: preview.slide.fileUrl,
                          fileType: preview.slide.fileType || null,
                          blobType: preview.blobType || null,
                          status: preview.slide.status,
                          createdAt: preview.slide.createdAt,
                        }, null, 2)}</pre>
                      </details>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ArchiveViewer;
