import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Clock, Download, ExternalLink, Home, Loader2, RotateCcw, Save, Share2, Trophy, UserPlus, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import type { Course, ExamQuestion, QuizHistory, Student, Topic } from '../types';
import { detectRuntimeCapabilities } from '../platform/runtime';
import { decodeQuickQuizPack, fetchQuickQuizPackByCode, shareQuickQuizPack, type QuickQuizPack } from '../utils/quickQuizShare';
import { gradeAnswer } from '../utils/questionBank';
import type { SharedQuestion } from '../utils/questionShare';

const SHARED_QUICK_COURSE_ID = 'shared-quick-quizzes';
const APP_DOWNLOAD_URL = 'https://github.com/g2code33/pharmaTRACK_PERFECT_new/releases/latest';

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function packKey(pack: QuickQuizPack): string {
  return hashString(JSON.stringify({
    title: pack.title,
    questions: pack.questions.map((q) => [
      q.questionText,
      q.questionType,
      q.options,
      q.correctOption,
      q.correctAnswer,
      q.explanation,
    ]),
  }));
}

const sharedTopicId = (key: string) => `shared-quick-topic-${key}`;
const sharedQuestionId = (key: string, index: number) => `shared-quick-question-${key}-${index + 1}`;

const toQuestion = (q: SharedQuestion, index: number, key: string): ExamQuestion => ({
  id: sharedQuestionId(key, index),
  courseId: SHARED_QUICK_COURSE_ID,
  topicId: sharedTopicId(key),
  semester: q.semester,
  questionText: q.questionText,
  questionType: q.questionType,
  marksAllocation: 1,
  difficulty: q.difficulty,
  probability: 'medium',
  modelAnswer: q.explanation || q.correctAnswer || '',
  explanation: q.explanation,
  correctAnswer: q.correctAnswer,
  source: { origin: 'imported', label: 'Shared quick quiz link' },
  tags: ['shared', 'quick-quiz', ...(q.tags || [])],
  isPracticed: false,
  needsReview: false,
  isSaved: true,
  createdAt: new Date().toISOString(),
  options: q.options,
  correctOption: q.correctOption,
});

const answerLabel = (q: ExamQuestion, raw: string): string => {
  if (q.questionType === 'mcq' && q.options?.length) {
    const idx = Number(raw);
    if (Number.isInteger(idx) && q.options[idx]) return `${String.fromCharCode(65 + idx)}. ${q.options[idx]}`;
  }
  return raw.trim() || 'No answer';
};

const correctLabel = (q: ExamQuestion): string => {
  if (q.questionType === 'mcq' && q.options?.length && q.correctOption !== undefined) {
    return `${String.fromCharCode(65 + q.correctOption)}. ${q.options[q.correctOption] || ''}`;
  }
  return q.correctAnswer || q.modelAnswer || 'Not supplied';
};

const formatQuizTimer = (seconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
};

type PackState = { loading: boolean; pack?: QuickQuizPack; packKey?: string; questions: ExamQuestion[]; error?: string };

const QuickQuiz: React.FC = () => {
  const { state, dispatch, addActivity } = useApp();
  const runtime = detectRuntimeCapabilities();
  const [params] = useSearchParams();
  const { code: routeCode } = useParams<{ code?: string }>();
  const paramsKey = `${params.toString()}|${routeCode || ''}`;
  const [packResult, setPackResult] = useState<PackState>({ loading: true, questions: [] });
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [showAnswer, setShowAnswer] = useState(false);
  const [finished, setFinished] = useState(false);
  const [timeRemainingSeconds, setTimeRemainingSeconds] = useState<number | null>(null);
  const [timeExpired, setTimeExpired] = useState(false);
  const [localName, setLocalName] = useState('');
  const [savedHistoryId, setSavedHistoryId] = useState<string | null>(null);
  const savedHistoryRef = useRef<string | null>(null);
  const questionScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setPackResult({ loading: true, questions: [] });
      setAnswers({});
      setCurrentIndex(0);
      setShowAnswer(false);
      setFinished(false);
      setTimeRemainingSeconds(null);
      setTimeExpired(false);
      savedHistoryRef.current = null;
      setSavedHistoryId(null);
      try {
        const [queryString, codeFromRoute = ''] = paramsKey.split('|');
        const currentParams = new URLSearchParams(queryString);
        const code = currentParams.get('c') || codeFromRoute;
        const inline = currentParams.get('p') || currentParams.get('pack');
        let pack: QuickQuizPack;
        if (code) {
          pack = await fetchQuickQuizPackByCode(code);
        } else if (inline) {
          pack = decodeQuickQuizPack(inline);
        } else {
          throw new Error('No quick quiz was found in this link.');
        }
        const key = packKey(pack);
        if (!cancelled) setPackResult({ loading: false, pack, packKey: key, questions: pack.questions.map((question, index) => toQuestion(question, index, key)) });
      } catch (error) {
        if (!cancelled) {
          setPackResult({
            loading: false,
            questions: [],
            error: error instanceof Error ? error.message : 'This quick quiz link could not be opened.',
          });
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [paramsKey]);

  const current = packResult.questions[currentIndex];
  const timeLimitSeconds = useMemo(() => {
    const minutes = packResult.pack?.timeLimitMinutes;
    return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) * 60 : null;
  }, [packResult.pack?.timeLimitMinutes]);
  const timerSeconds = timeLimitSeconds === null ? null : Math.max(0, timeRemainingSeconds ?? timeLimitSeconds);
  const timerLabel = timerSeconds === null ? 'No time limit' : formatQuizTimer(timerSeconds);
  const timerIsLow = timerSeconds !== null && timerSeconds <= 60;

  useEffect(() => {
    if (packResult.loading || !packResult.pack) return;
    setTimeRemainingSeconds(timeLimitSeconds);
    setTimeExpired(false);
  }, [packResult.loading, packResult.pack, packResult.packKey, timeLimitSeconds]);

  const scrollQuestionToTop = () => {
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      questionScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  const goToQuestion = (index: number) => {
    setCurrentIndex(Math.min(Math.max(0, index), Math.max(0, packResult.questions.length - 1)));
    setShowAnswer(false);
    scrollQuestionToTop();
  };

  const saveAnswer = (id: string, answer: string) => setAnswers((prev) => ({ ...prev, [id]: answer }));
  const reset = () => {
    setAnswers({});
    setCurrentIndex(0);
    setShowAnswer(false);
    setFinished(false);
    setTimeExpired(false);
    setTimeRemainingSeconds(timeLimitSeconds);
    savedHistoryRef.current = null;
    setSavedHistoryId(null);
    scrollQuestionToTop();
  };

  const score = useMemo(() => {
    const correct = packResult.questions.filter((q) => gradeAnswer(q, answers[q.id] || '')).length;
    return { correct, total: packResult.questions.length, percent: packResult.questions.length ? Math.round((correct / packResult.questions.length) * 100) : 0 };
  }, [answers, packResult.questions]);

  const shareCurrentPack = async () => {
    if (!packResult.pack) return;
    try {
      const result = await shareQuickQuizPack(packResult.pack);
      if (result === 'copied') alert('Quick quiz link copied.');
    } catch (err: any) {
      if (err?.name !== 'AbortError') alert(err?.message || 'Could not share this quick quiz link.');
    }
  };

  const ensureLocalStudent = useCallback((): Student => {
    if (state.student) return state.student;
    const created: Student = {
      id: uuidv4(),
      name: localName.trim() || 'Quick Quiz Student',
      university: 'PharmaTRACK Web Quiz',
      level: 'Quick Quiz',
      program: 'Pharmacy',
      semester: 'Shared Quiz',
      createdAt: new Date().toISOString(),
    };
    dispatch({ type: 'SET_STUDENT', payload: created });
    return created;
  }, [dispatch, localName, state.student]);

  const persistSubmittedQuiz = useCallback((): string | null => {
    if (!packResult.pack || !packResult.packKey || !packResult.questions.length) return null;
    if (savedHistoryRef.current) return savedHistoryRef.current;

    const student = ensureLocalStudent();
    const now = new Date().toISOString();
    const topicId = sharedTopicId(packResult.packKey);
    const existingQuestionIds = new Set(state.examQuestions.map((question) => question.id));
    const missingQuestions = packResult.questions.filter((question) => !existingQuestionIds.has(question.id));

    if (!state.courses.some((course) => course.id === SHARED_QUICK_COURSE_ID)) {
      const course: Course = {
        id: SHARED_QUICK_COURSE_ID,
        studentId: student.id,
        courseCode: 'QUICK',
        courseName: 'Shared Quick Quizzes',
        lecturerName: 'PharmaTRACK',
        semester: student.semester || 'Shared Quiz',
        creditHours: 0,
        createdAt: now,
      };
      dispatch({ type: 'ADD_COURSE', payload: course });
    }

    if (!state.topics.some((topic) => topic.id === topicId)) {
      const topic: Topic = {
        id: topicId,
        courseId: SHARED_QUICK_COURSE_ID,
        topicName: packResult.pack.title || 'Shared quick quiz',
        orderIndex: state.topics.filter((topic) => topic.courseId === SHARED_QUICK_COURSE_ID).length,
        createdAt: now,
      };
      dispatch({ type: 'ADD_TOPIC', payload: topic });
    }

    if (missingQuestions.length) {
      dispatch({ type: 'ADD_EXAM_QUESTIONS', payload: missingQuestions });
    }

    const correctCount = packResult.questions.filter((question) => gradeAnswer(question, answers[question.id] || '')).length;
    const history: QuizHistory = {
      id: uuidv4(),
      studentId: student.id,
      courseId: SHARED_QUICK_COURSE_ID,
      topicId,
      questionsUsed: packResult.questions.map((question) => question.id),
      answersGiven: packResult.questions.map((question) => ({
        questionId: question.id,
        answer: answers[question.id] || '',
        isCorrect: gradeAnswer(question, answers[question.id] || ''),
      })),
      scorePercentage: Math.round((correctCount / packResult.questions.length) * 100),
      weakTopics: packResult.questions.some((question) => !gradeAnswer(question, answers[question.id] || '')) ? [topicId] : [],
      timeTaken: timeLimitSeconds === null ? 0 : timeLimitSeconds - Math.max(0, timeRemainingSeconds ?? timeLimitSeconds),
      completedAt: now,
      mode: 'mixed',
    };

    dispatch({ type: 'ADD_QUIZ_HISTORY', payload: history });
    addActivity('quiz_taken', `Completed shared quick quiz with ${history.scorePercentage}% score`, SHARED_QUICK_COURSE_ID, topicId);
    savedHistoryRef.current = history.id;
    setSavedHistoryId(history.id);
    return history.id;
  }, [addActivity, answers, dispatch, ensureLocalStudent, packResult, state.courses, state.examQuestions, state.topics, timeLimitSeconds, timeRemainingSeconds]);

  const submitQuiz = () => {
    persistSubmittedQuiz();
    setFinished(true);
  };

  useEffect(() => {
    if (finished || timeLimitSeconds === null || timeRemainingSeconds === null) return undefined;
    if (timeRemainingSeconds <= 0) {
      setTimeExpired(true);
      persistSubmittedQuiz();
      setFinished(true);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setTimeRemainingSeconds((remaining) => (remaining === null ? null : Math.max(0, remaining - 1)));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [finished, persistSubmittedQuiz, timeLimitSeconds, timeRemainingSeconds]);

  const showWebAppCta = runtime.platform === 'web' && !runtime.isPWA;
  const appHomeHref = typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}#/` : '/#/';
  const webAppCta = showWebAppCta ? (
    <div className="safe-area-x shrink-0 bg-emerald-950 px-3 py-1.5 text-white shadow-lg">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-emerald-200">Using PharmaTRACK in a browser</p>
          <p className="hidden text-xs text-white/85 sm:block">Open the full app or install PharmaTRACK so your quiz history stays easy to revisit.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={appHomeHref} className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-xs font-black uppercase tracking-wider text-emerald-900">
            <ExternalLink className="h-4 w-4" /> Open in app
          </a>
          <a href={APP_DOWNLOAD_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/30 px-3 py-2 text-xs font-black uppercase tracking-wider text-white hover:bg-white/10">
            <Download className="h-4 w-4" /> Get app
          </a>
        </div>
      </div>
    </div>
  ) : null;

  if (packResult.loading) {
    return (
      <div className="min-h-[100dvh] bg-slate-950 text-white">
        {webAppCta}
        <div className="safe-area-x pt-safe pb-safe flex min-h-[calc(100dvh-4rem)] items-center justify-center p-4">
          <div className="max-w-md w-full rounded-3xl bg-white/10 p-6 text-center shadow-2xl backdrop-blur">
            <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-emerald-300" />
            <h1 className="text-2xl font-black mb-2">Opening quick quiz…</h1>
            <p className="text-slate-300">Loading the shared questions.</p>
          </div>
        </div>
      </div>
    );
  }

  if (packResult.error || !packResult.pack) {
    return (
      <div className="min-h-[100dvh] bg-slate-950 text-white">
        {webAppCta}
        <div className="safe-area-x pt-safe pb-safe flex min-h-[calc(100dvh-4rem)] items-center justify-center p-4">
          <div className="max-w-md w-full rounded-3xl bg-white text-slate-900 p-6 shadow-2xl">
            <AlertTriangle className="w-12 h-12 text-amber-500 mb-4" />
            <h1 className="text-2xl font-black mb-2">Quick quiz could not open</h1>
            <p className="text-slate-600 mb-5">{packResult.error}</p>
            <Link to="/" className="inline-flex items-center gap-2 rounded-xl bg-[#2D6A4F] px-4 py-3 font-bold text-white">
              <Home className="w-4 h-4" /> Open PharmaTRACK
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (finished) {
    return (
      <div className="min-h-[100dvh] bg-slate-100">
        {webAppCta}
        <div className="mx-auto max-w-3xl space-y-4 safe-area-x pt-safe pb-safe p-4">
          <div className="rounded-[2rem] bg-gradient-to-br from-[#0F172A] to-[#2D6A4F] p-6 text-white shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="h-14 w-14 rounded-2xl bg-white/15 flex items-center justify-center"><Trophy className="w-8 h-8 text-yellow-300" /></div>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.2em] text-emerald-200">Quick quiz complete</p>
                <h1 className="text-2xl sm:text-3xl font-black">{packResult.pack.title}</h1>
                {timeExpired && <p className="mt-1 text-sm font-bold text-amber-200">Time expired, so the quiz was submitted automatically.</p>}
              </div>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-3 gap-2 text-center">
              <div className="rounded-2xl bg-white/10 p-3"><p className="text-3xl font-black">{score.percent}%</p><p className="text-xs text-white/70">Score</p></div>
              <div className="rounded-2xl bg-white/10 p-3"><p className="text-3xl font-black">{score.correct}</p><p className="text-xs text-white/70">Correct</p></div>
              <div className="rounded-2xl bg-white/10 p-3"><p className="text-3xl font-black">{score.total}</p><p className="text-xs text-white/70">Questions</p></div>
            </div>
          </div>

          <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-950 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-white"><Save className="h-5 w-5" /></span>
                <div>
                  <p className="font-black">Saved on this device</p>
                  <p className="text-sm text-emerald-800">This shared quiz is now in your PharmaTRACK quiz history and can be revisited after refresh.</p>
                </div>
              </div>
              {savedHistoryId && (
                <Link to={`/quiz?quiz=${savedHistoryId}`} className="inline-flex items-center justify-center rounded-2xl bg-emerald-700 px-4 py-2 text-sm font-black text-white">
                  Open saved review
                </Link>
              )}
            </div>
          </div>

          <div className="rounded-3xl bg-white shadow-sm border border-slate-200 overflow-hidden">
            {packResult.questions.map((q, idx) => {
              const correct = gradeAnswer(q, answers[q.id] || '');
              return (
                <div key={q.id} className="p-4 border-b last:border-0">
                  <div className="flex items-start gap-3">
                    <span className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${correct ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {correct ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-slate-900">Q{idx + 1}. {q.questionText}</p>
                      <p className="mt-1 text-sm text-slate-600"><strong>Your answer:</strong> {answerLabel(q, answers[q.id] || '')}</p>
                      {!correct && <p className="mt-1 text-sm text-green-700"><strong>Correct:</strong> {correctLabel(q)}</p>}
                      {(q.explanation || q.modelAnswer) && <p className="mt-2 rounded-xl bg-blue-50 p-3 text-sm text-slate-700">{q.explanation || q.modelAnswer}</p>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <button onClick={reset} className="rounded-2xl border border-slate-300 bg-white px-4 py-3 font-black text-slate-700 flex items-center justify-center gap-2">
              <RotateCcw className="w-5 h-5" /> Retake
            </button>
            <button onClick={() => void shareCurrentPack()} className="rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 font-black text-indigo-700 flex items-center justify-center gap-2">
              <Share2 className="w-5 h-5" /> Share
            </button>
            <Link to="/" className="rounded-2xl bg-[#2D6A4F] px-4 py-3 font-black text-white flex items-center justify-center gap-2">
              <ExternalLink className="w-5 h-5" /> Open app
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-slate-100">
      {webAppCta}

      <header className="safe-area-x shrink-0 border-b border-slate-200/80 bg-slate-100/95 px-3 pb-2 pt-safe shadow-sm backdrop-blur sm:px-6 sm:pb-3 sm:pt-4">
        <div className="mx-auto max-w-4xl rounded-2xl bg-[#0F172A] p-3 text-white shadow-lg sm:p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[9px] font-black uppercase tracking-[0.2em] text-emerald-300 sm:text-[10px]">PharmaTRACK Quick Quiz</p>
              <h1 className="mt-0.5 truncate text-base font-black sm:text-lg">{packResult.pack.title}</h1>
              <p className="mt-0.5 truncate text-[11px] font-semibold text-slate-300 sm:text-xs">
                {packResult.pack.course?.code || packResult.pack.course?.name || 'Shared quiz'}{packResult.pack.topic?.name ? ` · ${packResult.pack.topic.name}` : ''}
              </p>
            </div>
            <Link to="/" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/10 text-white sm:h-11 sm:w-11"><Home className="w-5 h-5" /></Link>
          </div>
          <div className="mt-2 flex items-center gap-2 sm:gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-emerald-400" style={{ width: `${((currentIndex + 1) / packResult.questions.length) * 100}%` }} />
            </div>
            <div className="flex shrink-0 items-center gap-2 text-[11px] font-black text-slate-200 sm:text-xs">
              <span>Q{currentIndex + 1}/{packResult.questions.length}</span>
              <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 ${timerIsLow ? 'bg-red-500/20 text-red-100 ring-1 ring-red-300/40' : 'bg-white/10 text-emerald-100'}`}>
                <Clock className="h-3.5 w-3.5" /> Time: {timerLabel}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main ref={questionScrollRef} className="safe-area-x min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-6 sm:py-5">
        <div className="mx-auto max-w-4xl space-y-4">
          {!state.student && (
            <div className="rounded-[1.5rem] border border-amber-200 bg-amber-50 p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <div className="mb-2 flex items-center gap-2 text-amber-900">
                    <UserPlus className="h-5 w-5" />
                    <p className="font-black">Create a local profile to save this quiz</p>
                  </div>
                  <p className="mb-3 text-sm text-amber-800">No sign-in is needed. Your name lets PharmaTRACK keep this quiz on this device after refresh.</p>
                  <input
                    value={localName}
                    onChange={(event) => setLocalName(event.target.value)}
                    placeholder="Your name"
                    className="w-full rounded-2xl border border-amber-200 bg-white px-4 py-3 font-bold text-slate-900 outline-none focus:ring-4 focus:ring-amber-300/40"
                  />
                </div>
                <button onClick={ensureLocalStudent} className="rounded-2xl bg-amber-500 px-5 py-3 font-black text-amber-950 shadow-sm hover:bg-amber-400">
                  Save locally
                </button>
              </div>
            </div>
          )}

          {current && (
            <div className="rounded-[1.5rem] border border-slate-200 bg-white p-4 shadow-sm sm:rounded-[1.75rem] sm:p-7">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-purple-100 px-3 py-1 text-xs font-black uppercase text-purple-700">{current.questionType.replace('_', ' ')}</span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black uppercase text-slate-600">{current.difficulty}</span>
              </div>
              <h2 className="text-lg font-black leading-relaxed text-slate-900 sm:text-xl">{current.questionText}</h2>

              {current.questionType === 'mcq' && current.options?.length ? (
                <div className="mt-5 space-y-3">
                  {current.options.map((opt, idx) => {
                    const selected = answers[current.id] === String(idx);
                    return (
                      <button
                        key={idx}
                        onClick={() => saveAnswer(current.id, String(idx))}
                        className={`flex w-full items-start gap-3 rounded-2xl border-2 p-4 text-left touch-manipulation transition-all ${selected ? 'border-[#2D6A4F] bg-emerald-50 text-emerald-950 shadow-sm' : 'border-slate-200 bg-white text-slate-800 active:scale-[0.99]'}`}
                      >
                        <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-black ${selected ? 'bg-[#2D6A4F] text-white' : 'bg-slate-100 text-slate-500'}`}>{String.fromCharCode(65 + idx)}</span>
                        <span className="min-w-0 flex-1 leading-relaxed">{opt}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <textarea
                  value={answers[current.id] || ''}
                  onChange={(e) => saveAnswer(current.id, e.target.value)}
                  placeholder="Type your answer…"
                  className="mt-5 min-h-[9rem] w-full rounded-2xl border border-slate-300 p-4 outline-none focus:ring-4 focus:ring-[#2D6A4F]/15"
                />
              )}

              <div className="mt-5 border-t border-slate-100 pt-4">
                <button onClick={() => setShowAnswer((show) => !show)} className="text-sm font-black text-blue-700">
                  {showAnswer ? 'Hide answer' : 'Show answer'}
                </button>
                {showAnswer && <div className="mt-3 rounded-2xl bg-blue-50 p-4 text-sm text-slate-700"><strong>Answer:</strong> {correctLabel(current)}{(current.explanation || current.modelAnswer) ? <p className="mt-2">{current.explanation || current.modelAnswer}</p> : null}</div>}
              </div>
            </div>
          )}
        </div>
      </main>

      <footer className="safe-area-x safe-area-bottom shrink-0 border-t border-slate-200/80 bg-slate-100/95 px-3 pb-2 pt-2 shadow-[0_-12px_30px_rgba(15,23,42,0.10)] backdrop-blur sm:px-6 sm:pb-4">
        <div className="mx-auto max-w-4xl space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => goToQuestion(currentIndex - 1)}
              disabled={currentIndex === 0}
              className="flex items-center justify-center gap-1 rounded-2xl bg-white px-3 py-3 font-black text-slate-700 shadow-sm disabled:opacity-40"
            >
              <ChevronLeft className="w-5 h-5" /> Prev
            </button>
            <button onClick={submitQuiz} className="rounded-2xl bg-emerald-600 px-3 py-3 font-black text-white shadow-sm">
              <span className="hidden sm:inline">Finish & save</span><span className="sm:hidden">Finish</span>
            </button>
            <button
              onClick={() => goToQuestion(currentIndex + 1)}
              disabled={currentIndex === packResult.questions.length - 1}
              className="flex items-center justify-center gap-1 rounded-2xl bg-blue-600 px-3 py-3 font-black text-white shadow-sm disabled:opacity-40"
            >
              Next <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          <div className="max-h-24 overflow-y-auto overscroll-contain rounded-2xl bg-white/70 p-2 shadow-inner sm:max-h-28" aria-label="Jump to question">
            <div className="flex flex-wrap justify-center gap-2">
              {packResult.questions.map((q, idx) => (
                <button
                  key={q.id}
                  onClick={() => goToQuestion(idx)}
                  className={`h-9 w-9 rounded-full text-sm font-black ${idx === currentIndex ? 'bg-[#2D6A4F] text-white' : answers[q.id] ? 'bg-emerald-100 text-emerald-700' : 'bg-white text-slate-500 border border-slate-200'}`}
                  aria-current={idx === currentIndex ? 'step' : undefined}
                >
                  {idx + 1}
                </button>
              ))}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default QuickQuiz;
