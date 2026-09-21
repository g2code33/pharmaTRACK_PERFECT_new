/**
 * Read-only viewer for an archived semester.
 *
 * Everything is rendered from the archive's own snapshot and its own
 * IndexedDB records — never from (or into) the live app state, so reviewing
 * an old semester can never edit or overwrite the current one.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { loadArchive, loadArchivedFile, type ArchiveRecord } from '../utils/semesterArchive';
import type { AppState, Slide } from '../types';
import PdfViewer from '../components/PdfViewer';
import PptxViewer from '../components/PptxViewer';
import { format } from 'date-fns';
import {
  Archive,
  Lock,
  BookOpen,
  FileText,
  Image as ImageIcon,
  StickyNote,
  FileQuestion,
  Brain,
  Calendar,
  Highlighter,
  ChevronLeft,
  X,
  Loader2,
  AlertTriangle,
} from 'lucide-react';

type Tab = 'courses' | 'notes' | 'questions' | 'quizzes' | 'timetable' | 'highlights';

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'courses', label: 'Courses & Materials', icon: BookOpen },
  { id: 'notes', label: 'Notes', icon: StickyNote },
  { id: 'questions', label: 'Questions', icon: FileQuestion },
  { id: 'quizzes', label: 'Quiz History', icon: Brain },
  { id: 'timetable', label: 'Timetable', icon: Calendar },
  { id: 'highlights', label: 'Highlights', icon: Highlighter },
];

const ArchiveViewer: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [record, setRecord] = useState<ArchiveRecord | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<Tab>('courses');
  const [preview, setPreview] = useState<{ slide: Slide; url: string | null; text: string | null; error: string | null } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rec = await loadArchive(id || '');
      if (cancelled) return;
      if (!rec) setNotFound(true);
      else setRecord(rec);
    })();
    return () => { cancelled = true; };
  }, [id]);

  const snapshot = record?.snapshot as unknown as AppState | null;
  const topicsFor = useMemo(() => (courseId: string) =>
    (snapshot?.topics || []).filter((t) => t.courseId === courseId).sort((a, b) => a.orderIndex - b.orderIndex),
  [snapshot]);
  const slidesFor = useMemo(() => (topicId: string) =>
    (snapshot?.slides || []).filter((s) => s.topicId === topicId).sort((a, b) => a.slideNumber - b.slideNumber),
  [snapshot]);

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

  const openPreview = async (slide: Slide) => {
    if (!id) return;
    setPreviewLoading(true);
    setPreview({ slide, url: null, text: null, error: null });
    try {
      const raw = (slide.fileUrl || '').replace(/^local:/, '');
      if (raw) {
        const value = await loadArchivedFile(id, raw);
        if (value !== null) {
          if (typeof value === 'string' && value.startsWith('data:')) {
            setPreview({ slide, url: value, text: slide.contentText || null, error: null });
          } else {
            const blob = value instanceof Blob ? value : new Blob([value as BlobPart]);
            setPreview({ slide, url: URL.createObjectURL(blob), text: slide.contentText || null, error: null });
          }
        } else {
          setPreview({ slide, url: null, text: slide.contentText || null, error: 'The file for this material is not in the archive.' });
        }
      } else {
        setPreview({ slide, url: null, text: slide.contentText || null, error: null });
      }
    } catch (err) {
      setPreview({ slide, url: null, text: slide.contentText || null, error: 'Could not load this file.' });
      console.error(err);
    } finally {
      setPreviewLoading(false);
    }
  };

  const previewKind = (url: string | null, slide: Slide): 'pdf' | 'pptx' | 'image' | 'text' => {
    const u = (url || '').toLowerCase();
    if (u.includes('.pptx') || slide.fileType === 'text' && u.includes('pptx')) return 'pptx';
    if (u.includes('.pdf') || u.includes('pdf')) return 'pdf';
    if (u.includes('.jpg') || u.includes('.png') || u.includes('image') || slide.fileType === 'jpg' || slide.fileType === 'png') return 'image';
    return 'text';
  };

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#1B4332] to-[#2D6A4F] rounded-2xl p-5 text-white">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 bg-white/15 rounded-xl flex items-center justify-center">
              <Archive className="w-6 h-6 text-[#FFB703]" />
            </div>
            <div>
              <h1 className="text-xl font-bold">{record.meta.title}</h1>
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
        {record.meta.counts && (
          <div className="flex flex-wrap gap-3 mt-4 text-xs font-semibold text-white/85">
            <span className="bg-white/10 px-2.5 py-1 rounded-lg">Courses: {record.meta.counts.courses}</span>
            <span className="bg-white/10 px-2.5 py-1 rounded-lg">Materials: {record.meta.counts.slides}</span>
            <span className="bg-white/10 px-2.5 py-1 rounded-lg">Files: {record.meta.fileCount}</span>
            <span className="bg-white/10 px-2.5 py-1 rounded-lg">Notes: {record.meta.counts.notes}</span>
            <span className="bg-white/10 px-2.5 py-1 rounded-lg">Questions: {record.meta.counts.questions}</span>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 overflow-x-auto hide-scrollbar pb-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-bold whitespace-nowrap transition-colors ${
              tab === t.id ? 'bg-[#2D6A4F] text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        {tab === 'courses' && (
          <div className="space-y-5">
            {(snapshot.courses || []).length === 0 && <p className="text-gray-500 text-sm text-center py-6">No courses in this semester.</p>}
            {(snapshot.courses || []).map((course) => (
              <div key={course.id} className="border border-gray-100 rounded-xl overflow-hidden">
                <div className="px-4 py-3 bg-gray-50 flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-[#2D6A4F]" />
                  <span className="font-bold text-gray-800">{course.courseCode}</span>
                  <span className="text-sm text-gray-500 truncate">{course.courseName}</span>
                  <span className="ml-auto text-xs text-gray-400">{course.creditHours} credits</span>
                </div>
                <div className="divide-y divide-gray-50">
                  {topicsFor(course.id).map((topic) => (
                    <div key={topic.id} className="px-4 py-3">
                      <p className="font-semibold text-gray-700 text-sm mb-2">{topic.topicName}</p>
                      <div className="space-y-1">
                        {slidesFor(topic.id).map((slide, idx) => (
                          <button
                            key={slide.id}
                            onClick={() => void openPreview(slide)}
                            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[#2D6A4F]/5 text-left"
                          >
                            {slide.fileType === 'pdf' ? <FileText className="w-4 h-4 text-red-400 flex-shrink-0" /> :
                             (slide.fileType === 'jpg' || slide.fileType === 'png') ? <ImageIcon className="w-4 h-4 text-blue-400 flex-shrink-0" /> :
                             <FileText className="w-4 h-4 text-gray-400 flex-shrink-0" />}
                            <span className="text-sm text-gray-700 truncate">{idx + 1}. {slide.title}</span>
                            {slide.status === 'completed' && <span className="ml-auto text-[10px] font-bold text-green-600 uppercase">done</span>}
                          </button>
                        ))}
                        {slidesFor(topic.id).length === 0 && (
                          <p className="text-xs text-gray-400 px-3 py-1">No materials</p>
                        )}
                      </div>
                    </div>
                  ))}
                  {topicsFor(course.id).length === 0 && (
                    <p className="px-4 py-3 text-xs text-gray-400">No topics</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'notes' && (
          <div className="space-y-3">
            {(snapshot.notes || []).length === 0 && <p className="text-gray-500 text-sm text-center py-6">No notes in this semester.</p>}
            {(snapshot.notes || []).map((note) => {
              const topic = (snapshot.topics || []).find((t) => t.id === note.topicId);
              return (
                <div key={note.id} className="border border-gray-100 rounded-xl p-4">
                  <div className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                    <StickyNote className="w-3.5 h-3.5" />
                    {topic?.topicName || 'Note'} · {format(new Date(note.createdAt), 'd MMM yyyy')}
                    {note.isAiGenerated && <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-[10px] font-bold">AI</span>}
                  </div>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{note.noteText}</p>
                  {note.attachedFiles?.length ? (
                    <div className="flex flex-wrap gap-2 mt-3">
                      {note.attachedFiles.map((f) => (
                        <a
                          key={f.id}
                          href={f.data}
                          download={f.name}
                          className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded-lg text-xs font-semibold text-slate-700"
                        >
                          {f.name}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {tab === 'questions' && (
          <div className="space-y-3">
            {(snapshot.examQuestions || []).length === 0 && <p className="text-gray-500 text-sm text-center py-6">No questions in this semester.</p>}
            {(snapshot.examQuestions || []).map((q) => {
              const course = (snapshot.courses || []).find((c) => c.id === q.courseId);
              return (
                <details key={q.id} className="border border-gray-100 rounded-xl p-4">
                  <summary className="cursor-pointer text-sm text-gray-700 flex items-center gap-2 list-none">
                    <FileQuestion className="w-4 h-4 text-[#2D6A4F] flex-shrink-0" />
                    <span className="font-semibold">{course?.courseCode || '—'}</span>
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
        )}

        {tab === 'quizzes' && (
          <div className="space-y-3">
            {(snapshot.quizHistory || []).length === 0 && <p className="text-gray-500 text-sm text-center py-6">No quiz history in this semester.</p>}
            {[...(snapshot.quizHistory || [])].sort((a, b) => b.completedAt.localeCompare(a.completedAt)).map((q) => {
              const course = (snapshot.courses || []).find((c) => c.id === q.courseId);
              return (
                <div key={q.id} className="border border-gray-100 rounded-xl p-4 flex items-center gap-4">
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center font-black text-sm ${q.scorePercentage >= 70 ? 'bg-green-100 text-green-700' : q.scorePercentage >= 50 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                    {q.scorePercentage}%
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-800 text-sm">{course?.courseCode || 'Course'} quiz</p>
                    <p className="text-xs text-gray-500">
                      {format(new Date(q.completedAt), 'd MMM yyyy · HH:mm')} · {q.questionsUsed.length} questions
                      {q.weakTopics.length > 0 && <> · weak: {q.weakTopics.join(', ')}</>}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'timetable' && (
          <div className="space-y-4">
            {(['class', 'quiz', 'exam'] as const).map((cat) => {
              const items = snapshot.timetables?.[cat] || [];
              return (
                <div key={cat}>
                  <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-2">{cat === 'class' ? 'Classes' : cat === 'quiz' ? 'Quizzes' : 'Exams'}</h3>
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
              <a
                href={snapshot.timetablePdf}
                download="timetable.pdf"
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg text-sm font-medium hover:bg-[#1B4332]"
              >
                <FileText className="w-4 h-4" /> Download Timetable PDF
              </a>
            ) : null}
          </div>
        )}

        {tab === 'highlights' && (
          <div className="space-y-2">
            {(snapshot.highlights || []).length === 0 && <p className="text-gray-500 text-sm text-center py-6">No highlights in this semester.</p>}
            {[...(snapshot.highlights || [])].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map((h) => {
              const slide = (snapshot.slides || []).find((s) => s.id === h.materialId);
              return (
                <div key={h.id} className="border-l-4 rounded-r-lg bg-gray-50 px-4 py-3" style={{ borderColor: h.color || '#FFB703' }}>
                  <p className="text-sm text-gray-700">{h.text}</p>
                  {h.note && <p className="text-xs text-gray-500 mt-1 italic">Note: {h.note}</p>}
                  <p className="text-[11px] text-gray-400 mt-1">
                    {slide?.title || 'Material'}{h.page ? ` · page ${h.page}` : ''} · {format(new Date(h.timestamp), 'd MMM yyyy')}
                  </p>
                </div>
              );
            })}
          </div>
        )}
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
              ) : preview.error && !preview.url && !preview.text ? (
                <div className="h-64 flex items-center justify-center text-gray-500 text-sm px-6 text-center">{preview.error}</div>
              ) : preview.url ? (
                (() => {
                  const kind = previewKind(preview.url, preview.slide);
                  if (kind === 'pdf') return <div className="h-[70vh]"><PdfViewer fileUrl={preview.url!} title={preview.slide.title} /></div>;
                  if (kind === 'pptx') return <div className="h-[70vh]"><PptxViewer fileUrl={preview.url!} title={preview.slide.title} /></div>;
                  if (kind === 'image') return <img src={preview.url} alt={preview.slide.title} className="max-h-[70vh] mx-auto" />;
                  return null;
                })()
              ) : null}
              {preview.text && (
                <div className="p-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Extracted text</p>
                  <pre className="whitespace-pre-wrap text-sm text-gray-700 bg-white border border-gray-200 rounded-xl p-4 max-h-[40vh] overflow-auto">{preview.text}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ArchiveViewer;
