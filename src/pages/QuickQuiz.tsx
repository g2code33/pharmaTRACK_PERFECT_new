import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Home,
  Loader2,
  Pause,
  RotateCcw,
  Save,
  Share2,
  Smartphone,
  Trophy,
  UserPlus,
  X,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import type { Course, ExamQuestion, QuizHistory, Student, Topic } from '../types';
import { detectRuntimeCapabilities } from '../platform/runtime';
import {
  decodeQuickQuizPack,
  fetchQuickQuizPackByCode,
  shareQuickQuizPack,
  type QuickQuizPack,
} from '../utils/quickQuizShare';
import {
  APP_STORE_URL,
  getQuickQuizRouteFromHref,
  openCurrentQuickQuizInInstalledApp,
  rememberPendingQuickQuiz,
} from '../utils/appLinks';
import { gradeAnswer } from '../utils/questionBank';
import type { SharedQuestion } from '../utils/questionShare';

const SHARED_QUICK_COURSE_ID = 'shared-quick-quizzes';
const QUIZ_SET_SIZE = 3;
const QUICK_QUIZ_PAUSE_PREFIX = 'pharmatrack.quickQuiz.pause.v1:';

type PausedQuickQuizState = {
  version: 1;
  savedAt: string;
  packKey: string;
  answers: Record<string, string>;
  currentIndex: number;
  timeRemainingSeconds: number | null;
  timeExpired: boolean;
};

const quickQuizPauseKey = (key: string): string => `${QUICK_QUIZ_PAUSE_PREFIX}${key}`;

const loadPausedQuickQuiz = (key: string): PausedQuickQuizState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(quickQuizPauseKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PausedQuickQuizState;
    return parsed?.version === 1 && parsed.packKey === key ? parsed : null;
  } catch {
    return null;
  }
};

const savePausedQuickQuiz = (payload: PausedQuickQuizState) => {
  try { window.localStorage.setItem(quickQuizPauseKey(payload.packKey), JSON.stringify(payload)); } catch { /* ignore */ }
};

const removePausedQuickQuiz = (key?: string) => {
  if (!key) return;
  try { window.localStorage.removeItem(quickQuizPauseKey(key)); } catch { /* ignore */ }
};

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function packKey(pack: QuickQuizPack): string {
  return hashString(
    JSON.stringify({
      title: pack.title,
      questions: pack.questions.map((q) => [
        q.questionText,
        q.questionType,
        q.options,
        q.correctOption,
        q.correctAnswer,
        q.explanation,
      ]),
    }),
  );
}

const sharedTopicId = (key: string) => `shared-quick-topic-${key}`;
const sharedQuestionId = (key: string, index: number) =>
  `shared-quick-question-${key}-${index + 1}`;

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
    if (Number.isInteger(idx) && q.options[idx])
      return `${String.fromCharCode(65 + idx)}. ${q.options[idx]}`;
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
  if (hours > 0)
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
};

type PackState = {
  loading: boolean;
  pack?: QuickQuizPack;
  packKey?: string;
  questions: ExamQuestion[];
  error?: string;
};

const QuickQuiz: React.FC = () => {
  const { state, dispatch, addActivity } = useApp();
  const runtime = detectRuntimeCapabilities();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { code: routeCode } = useParams<{ code?: string }>();
  const paramsKey = `${params.toString()}|${routeCode || ''}`;
  const [packResult, setPackResult] = useState<PackState>({ loading: true, questions: [] });
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [finished, setFinished] = useState(false);
  const [timeRemainingSeconds, setTimeRemainingSeconds] = useState<number | null>(null);
  const [timeExpired, setTimeExpired] = useState(false);
  const [submitReviewOpen, setSubmitReviewOpen] = useState(false);
  const [pausedAttempt, setPausedAttempt] = useState<PausedQuickQuizState | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [appleHandoffOpen, setAppleHandoffOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [localName, setLocalName] = useState('');
  const [savedHistoryId, setSavedHistoryId] = useState<string | null>(null);
  const savedHistoryRef = useRef<string | null>(null);
  const questionScrollRef = useRef<HTMLDivElement | null>(null);
  const autoOpenAttemptRef = useRef('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setPackResult({ loading: true, questions: [] });
      setAnswers({});
      setCurrentIndex(0);
      setFinished(false);
      setTimeRemainingSeconds(null);
      setTimeExpired(false);
      setSubmitReviewOpen(false);
      setPausedAttempt(null);
      setIsPaused(false);
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
        if (!cancelled)
          setPackResult({
            loading: false,
            pack,
            packKey: key,
            questions: pack.questions.map((question, index) => toQuestion(question, index, key)),
          });
      } catch (error) {
        if (!cancelled) {
          setPackResult({
            loading: false,
            questions: [],
            error:
              error instanceof Error ? error.message : 'This quick quiz link could not be opened.',
          });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [paramsKey]);

  const setStart = Math.floor(currentIndex / QUIZ_SET_SIZE) * QUIZ_SET_SIZE;
  const visibleQuestions = packResult.questions.slice(setStart, setStart + QUIZ_SET_SIZE);
  const setEnd = Math.min(setStart + visibleQuestions.length, packResult.questions.length);
  const canGoPreviousSet = setStart > 0;
  const canGoNextSet = setStart + QUIZ_SET_SIZE < packResult.questions.length;
  const isOnLastQuestion = packResult.questions.length > 0 && currentIndex === packResult.questions.length - 1;
  const answeredCount = packResult.questions.filter((question) =>
    (answers[question.id] || '').trim().length > 0,
  ).length;
  const unansweredCount = Math.max(0, packResult.questions.length - answeredCount);
  const timeLimitSeconds = useMemo(() => {
    const minutes = packResult.pack?.timeLimitMinutes;
    return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
      ? Math.round(minutes) * 60
      : null;
  }, [packResult.pack?.timeLimitMinutes]);
  const timerSeconds =
    timeLimitSeconds === null ? null : Math.max(0, timeRemainingSeconds ?? timeLimitSeconds);
  const timerLabel = timerSeconds === null ? 'No time limit' : formatQuizTimer(timerSeconds);
  const timerIsLow = timerSeconds !== null && timerSeconds <= 60;

  useEffect(() => {
    if (packResult.loading || !packResult.pack) return;
    setTimeRemainingSeconds(timeLimitSeconds);
    setTimeExpired(false);
  }, [packResult.loading, packResult.pack, packResult.packKey, timeLimitSeconds]);

  useEffect(() => {
    if (!packResult.packKey || packResult.loading) return;
    const paused = loadPausedQuickQuiz(packResult.packKey);
    setPausedAttempt(paused);
    setIsPaused(Boolean(paused));
  }, [packResult.loading, packResult.packKey]);

  const scrollQuestionToTop = () => {
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      questionScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  const goToQuestion = (index: number) => {
    setCurrentIndex(Math.min(Math.max(0, index), Math.max(0, packResult.questions.length - 1)));
    scrollQuestionToTop();
  };

  const goToQuestionSet = (startIndex: number) => {
    goToQuestion(Math.min(Math.max(0, startIndex), Math.max(0, packResult.questions.length - 1)));
  };

  const saveAnswer = (id: string, answer: string) =>
    setAnswers((prev) => ({ ...prev, [id]: answer }));
  const reset = () => {
    setAnswers({});
    setCurrentIndex(0);
    setFinished(false);
    setTimeExpired(false);
    setSubmitReviewOpen(false);
    setTimeRemainingSeconds(timeLimitSeconds);
    removePausedQuickQuiz(packResult.packKey);
    setPausedAttempt(null);
    setIsPaused(false);
    savedHistoryRef.current = null;
    setSavedHistoryId(null);
    scrollQuestionToTop();
  };

  const score = useMemo(() => {
    const correct = packResult.questions.filter((q) => gradeAnswer(q, answers[q.id] || '')).length;
    return {
      correct,
      total: packResult.questions.length,
      percent: packResult.questions.length
        ? Math.round((correct / packResult.questions.length) * 100)
        : 0,
    };
  }, [answers, packResult.questions]);

  const shareCurrentPack = async () => {
    if (!packResult.pack) return;
    try {
      const result = await shareQuickQuizPack(packResult.pack);
      if (result === 'copied') alert('Quick quiz link copied.');
    } catch (err: any) {
      if (err?.name !== 'AbortError')
        alert(err?.message || 'Could not share this quick quiz link.');
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
    const missingQuestions = packResult.questions.filter(
      (question) => !existingQuestionIds.has(question.id),
    );

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
        orderIndex: state.topics.filter((topic) => topic.courseId === SHARED_QUICK_COURSE_ID)
          .length,
        createdAt: now,
      };
      dispatch({ type: 'ADD_TOPIC', payload: topic });
    }

    if (missingQuestions.length) {
      dispatch({ type: 'ADD_EXAM_QUESTIONS', payload: missingQuestions });
    }

    const correctCount = packResult.questions.filter((question) =>
      gradeAnswer(question, answers[question.id] || ''),
    ).length;
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
      weakTopics: packResult.questions.some(
        (question) => !gradeAnswer(question, answers[question.id] || ''),
      )
        ? [topicId]
        : [],
      timeTaken:
        timeLimitSeconds === null
          ? 0
          : timeLimitSeconds - Math.max(0, timeRemainingSeconds ?? timeLimitSeconds),
      completedAt: now,
      mode: 'mixed',
    };

    dispatch({ type: 'ADD_QUIZ_HISTORY', payload: history });
    addActivity(
      'quiz_taken',
      `Completed shared quick quiz with ${history.scorePercentage}% score`,
      SHARED_QUICK_COURSE_ID,
      topicId,
    );
    savedHistoryRef.current = history.id;
    setSavedHistoryId(history.id);
    return history.id;
  }, [
    addActivity,
    answers,
    dispatch,
    ensureLocalStudent,
    packResult,
    state.courses,
    state.examQuestions,
    state.topics,
    timeLimitSeconds,
    timeRemainingSeconds,
  ]);

  const submitQuiz = () => {
    removePausedQuickQuiz(packResult.packKey);
    setPausedAttempt(null);
    setIsPaused(false);
    setSubmitReviewOpen(false);
    persistSubmittedQuiz();
    setFinished(true);
  };

  const openSubmitReview = () => {
    if (!isOnLastQuestion) return;
    setSubmitReviewOpen(true);
  };

  const pauseQuickQuiz = () => {
    if (!packResult.packKey || !packResult.questions.length) return;
    const payload: PausedQuickQuizState = {
      version: 1,
      savedAt: new Date().toISOString(),
      packKey: packResult.packKey,
      answers,
      currentIndex,
      timeRemainingSeconds: timerSeconds,
      timeExpired,
    };
    savePausedQuickQuiz(payload);
    setPausedAttempt(payload);
    setSubmitReviewOpen(false);
    setIsPaused(true);
  };

  const continuePausedQuickQuiz = () => {
    if (!pausedAttempt) return;
    setAnswers(pausedAttempt.answers || {});
    setCurrentIndex(Math.min(pausedAttempt.currentIndex, Math.max(0, packResult.questions.length - 1)));
    setTimeRemainingSeconds(pausedAttempt.timeRemainingSeconds ?? timeLimitSeconds);
    setTimeExpired(pausedAttempt.timeExpired);
    setSubmitReviewOpen(false);
    setIsPaused(false);
    scrollQuestionToTop();
  };

  // Safety net: closing the tab or leaving the shared quiz keeps the attempt so
  // reopening the same link offers Continue instead of restarting.
  const autoPauseRef = useRef<PausedQuickQuizState | null>(null);
  useEffect(() => {
    const hasProgress = Object.values(answers).some((value) => (value || '').trim().length > 0);
    autoPauseRef.current =
      !finished && packResult.packKey && packResult.questions.length && (hasProgress || currentIndex > 0)
        ? {
            version: 1,
            savedAt: new Date().toISOString(),
            packKey: packResult.packKey,
            answers,
            currentIndex,
            timeRemainingSeconds: timerSeconds,
            timeExpired,
          }
        : null;
  }, [answers, currentIndex, finished, packResult.packKey, packResult.questions.length, timeExpired, timerSeconds]);

  useEffect(
    () => () => {
      if (autoPauseRef.current) savePausedQuickQuiz(autoPauseRef.current);
    },
    [],
  );

  const discardPausedQuickQuiz = () => {
    removePausedQuickQuiz(packResult.packKey);
    setPausedAttempt(null);
    setIsPaused(false);
    setAnswers({});
    setCurrentIndex(0);
    setTimeExpired(false);
    setTimeRemainingSeconds(timeLimitSeconds);
  };

  useEffect(() => {
    if (isPaused || finished || timeLimitSeconds === null || timeRemainingSeconds === null) return undefined;
    if (timeRemainingSeconds <= 0) {
      setTimeExpired(true);
      persistSubmittedQuiz();
      setFinished(true);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setTimeRemainingSeconds((remaining) =>
        remaining === null ? null : Math.max(0, remaining - 1),
      );
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [finished, isPaused, persistSubmittedQuiz, timeLimitSeconds, timeRemainingSeconds]);

  const showWebAppCta = runtime.platform === 'web' && !runtime.isPWA;
  const shouldTryAndroidApkFirst = showWebAppCta && runtime.device === 'android';
  // iOS cannot launch an installed Home Screen app from a link, so Apple
  // devices get a copy-and-paste handoff into the installed PharmaTRACK app.
  const needsAppleHandoff = showWebAppCta && runtime.isIOS;
  const appHomeHref =
    typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}#/`
      : '/#/';
  const quizShareHref = typeof window === 'undefined' ? '' : window.location.href;

  const copyQuizLink = useCallback(async (): Promise<boolean> => {
    if (typeof window === 'undefined') return false;
    const link = window.location.href;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
        return true;
      }
    } catch {
      // Fall through to the manual prompt below.
    }
    try {
      window.prompt('Copy this quick quiz link:', link);
      return true;
    } catch {
      return false;
    }
  }, []);

  const handleOpenInApp = () => {
    if (typeof window !== 'undefined') {
      const route = getQuickQuizRouteFromHref(window.location.href);
      if (route) rememberPendingQuickQuiz(route);
    }
    if (needsAppleHandoff) {
      setAppleHandoffOpen(true);
      void copyQuizLink().then((copied) => setLinkCopied(copied));
      return;
    }
    const opened = openCurrentQuickQuizInInstalledApp(false);
    if (!opened && typeof window !== 'undefined') window.location.href = appHomeHref;
  };
  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) navigate(-1);
    else navigate('/');
  };

  useEffect(() => {
    // Apple devices cannot be auto-handed to the installed app, and firing an
    // unknown scheme only produces a Safari error sheet over the quiz.
    if (!showWebAppCta || needsAppleHandoff || typeof window === 'undefined') return undefined;
    const attemptKey = `${paramsKey}|${window.location.href}`;
    const storageKey = `pharmatrack:auto-open:${hashString(attemptKey)}`;
    try {
      if (autoOpenAttemptRef.current === attemptKey || window.sessionStorage.getItem(storageKey))
        return undefined;
      window.sessionStorage.setItem(storageKey, String(Date.now()));
    } catch {
      if (autoOpenAttemptRef.current === attemptKey) return undefined;
    }
    autoOpenAttemptRef.current = attemptKey;
    const timer = window.setTimeout(
      () => {
        openCurrentQuickQuizInInstalledApp(true);
      },
      shouldTryAndroidApkFirst ? 0 : 250,
    );
    return () => window.clearTimeout(timer);
  }, [needsAppleHandoff, paramsKey, shouldTryAndroidApkFirst, showWebAppCta]);

  const appleHandoffSheet = appleHandoffOpen ? (
    <div
      className="fixed inset-0 z-[300] flex items-end justify-center bg-slate-950/60 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Open this quiz in the installed PharmaTRACK app"
    >
      <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl safe-area-bottom sm:rounded-3xl">
        <div className="mb-3 flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#2D6A4F] text-white">
            <Smartphone className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-black text-slate-900">Open this quiz in your PharmaTRACK app</h2>
            <p className="mt-1 text-sm text-slate-600">
              iPhone and iPad cannot hand a link to an installed app automatically, so PharmaTRACK copied the
              quiz link for you. Paste it in the app search bar and the quiz opens instantly.
            </p>
          </div>
        </div>

        <ol className="mb-4 space-y-2 rounded-2xl bg-slate-50 p-3 text-sm font-semibold text-slate-700">
          <li className="flex gap-2"><span className="font-black text-[#2D6A4F]">1.</span> Link copied{linkCopied ? ' ✓' : ' — tap “Copy quiz link” below'}</li>
          <li className="flex gap-2"><span className="font-black text-[#2D6A4F]">2.</span> Open PharmaTRACK from your Home Screen</li>
          <li className="flex gap-2"><span className="font-black text-[#2D6A4F]">3.</span> Tap the search bar at the top and paste the link</li>
          <li className="flex gap-2"><span className="font-black text-[#2D6A4F]">4.</span> Press Enter or tap “Open Quick Quiz link”</li>
        </ol>

        <p className="mb-4 break-all rounded-2xl border border-slate-200 bg-white p-3 text-[11px] font-bold text-slate-500">
          {quizShareHref}
        </p>

        <div className="grid gap-2">
          <button
            type="button"
            onClick={() => void copyQuizLink().then((copied) => setLinkCopied(copied))}
            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#2D6A4F] px-4 py-3 text-sm font-black text-white hover:bg-[#1B4332]"
          >
            <Copy className="h-4 w-4" /> {linkCopied ? 'Link copied' : 'Copy quiz link'}
          </button>
          <a
            href={APP_STORE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-4 w-4" /> Get the app
          </a>
          <button
            type="button"
            onClick={() => setAppleHandoffOpen(false)}
            className="rounded-2xl px-4 py-3 text-sm font-black text-slate-500 hover:bg-slate-100"
          >
            Continue in this browser
          </button>
        </div>

        <p className="mt-3 text-[11px] font-bold text-slate-400">
          Not installed yet? In Safari tap Share, then “Add to Home Screen”, or use “Get the app”.
        </p>
      </div>
    </div>
  ) : null;

  const webAppCta = showWebAppCta ? (
    <>
    {appleHandoffSheet}
    <div className="safe-area-x shrink-0 bg-emerald-950 px-3 py-1.5 text-white shadow-lg">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-emerald-200">
            Using PharmaTRACK in a browser
          </p>
          <p className="hidden text-xs text-white/85 sm:block">
            Open the full app or install PharmaTRACK so your quiz history stays easy to revisit.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleOpenInApp}
            className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-xs font-black uppercase tracking-wider text-emerald-900"
          >
            <ExternalLink className="h-4 w-4" /> Open in app
          </button>
          <a
            href={APP_STORE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-white/30 px-3 py-2 text-xs font-black uppercase tracking-wider text-white hover:bg-white/10"
          >
            <Download className="h-4 w-4" /> Get app
          </a>
        </div>
      </div>
    </div>
    </>
  ) : null;

  if (packResult.loading) {
    return (
      <div className="min-h-[100dvh] bg-slate-950 text-white">
        {webAppCta}
        <div className="safe-area-x pt-safe pb-safe flex min-h-[calc(100dvh-4rem)] items-center justify-center p-4">
          <div className="max-w-md w-full rounded-3xl bg-white/10 p-6 text-center shadow-2xl backdrop-blur">
            <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-emerald-300" />
            <h1 className="text-2xl font-black mb-2">Opening quick quiz…</h1>
            <p className="text-slate-300">
              {shouldTryAndroidApkFirst
                ? 'Trying the installed Android app first. Web continues automatically if the APK is not installed.'
                : 'Loading the shared questions.'}
            </p>
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
            <Link
              to="/"
              className="inline-flex items-center gap-2 rounded-xl bg-[#2D6A4F] px-4 py-3 font-bold text-white"
            >
              <Home className="w-4 h-4" /> Open PharmaTRACK
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (isPaused && pausedAttempt) {
    return (
      <div className="min-h-[100dvh] bg-slate-100">
        {webAppCta}
        <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-2xl items-center safe-area-x pt-safe pb-safe p-4">
          <div className="w-full rounded-[2rem] border border-blue-200 bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-start gap-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white">
                <Pause className="h-6 w-6" />
              </span>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.2em] text-blue-600">Quick quiz paused</p>
                <h1 className="mt-1 text-2xl font-black text-slate-900">Continue when ready</h1>
                <p className="mt-1 text-sm text-slate-600">
                  Saved {new Date(pausedAttempt.savedAt).toLocaleString()} · Q{Math.min(pausedAttempt.currentIndex + 1, packResult.questions.length)} of {packResult.questions.length} · {pausedAttempt.timeRemainingSeconds === null ? 'No time limit' : `${formatQuizTimer(pausedAttempt.timeRemainingSeconds)} left`}
                </p>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <button
                type="button"
                onClick={continuePausedQuickQuiz}
                className="rounded-2xl bg-blue-600 px-4 py-3 font-black text-white hover:bg-blue-700 sm:col-span-2"
              >
                Continue quiz
              </button>
              <button
                type="button"
                onClick={discardPausedQuickQuiz}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 font-black text-slate-700 hover:bg-slate-50"
              >
                Restart
              </button>
            </div>
            <button
              type="button"
              onClick={handleBack}
              className="mt-3 inline-flex items-center gap-2 rounded-2xl px-3 py-2 text-sm font-black text-slate-600 hover:bg-slate-100"
            >
              <ChevronLeft className="h-4 w-4" /> Leave page
            </button>
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
          <button
            type="button"
            onClick={handleBack}
            className="inline-flex items-center gap-2 rounded-2xl bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-sm ring-1 ring-slate-200"
          >
            <ChevronLeft className="h-4 w-4" /> Back
          </button>
          <div className="rounded-[2rem] bg-gradient-to-br from-[#0F172A] to-[#2D6A4F] p-6 text-white shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="h-14 w-14 rounded-2xl bg-white/15 flex items-center justify-center">
                <Trophy className="w-8 h-8 text-yellow-300" />
              </div>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.2em] text-emerald-200">
                  Quick quiz complete
                </p>
                <h1 className="text-2xl sm:text-3xl font-black">{packResult.pack.title}</h1>
                {timeExpired && (
                  <p className="mt-1 text-sm font-bold text-amber-200">
                    Time expired, so the quiz was submitted automatically.
                  </p>
                )}
              </div>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-3 gap-2 text-center">
              <div className="rounded-2xl bg-white/10 p-3">
                <p className="text-3xl font-black">{score.percent}%</p>
                <p className="text-xs text-white/70">Score</p>
              </div>
              <div className="rounded-2xl bg-white/10 p-3">
                <p className="text-3xl font-black">{score.correct}</p>
                <p className="text-xs text-white/70">Correct</p>
              </div>
              <div className="rounded-2xl bg-white/10 p-3">
                <p className="text-3xl font-black">{score.total}</p>
                <p className="text-xs text-white/70">Questions</p>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-950 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-white">
                  <Save className="h-5 w-5" />
                </span>
                <div>
                  <p className="font-black">Saved on this device</p>
                  <p className="text-sm text-emerald-800">
                    This shared quiz is now in your PharmaTRACK quiz history and can be revisited
                    after refresh.
                  </p>
                </div>
              </div>
              {savedHistoryId && (
                <Link
                  to={`/quiz?quiz=${savedHistoryId}`}
                  className="inline-flex items-center justify-center rounded-2xl bg-emerald-700 px-4 py-2 text-sm font-black text-white"
                >
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
                    <span
                      className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${correct ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
                    >
                      {correct ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-slate-900">
                        Q{idx + 1}. {q.questionText}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        <strong>Your answer:</strong> {answerLabel(q, answers[q.id] || '')}
                      </p>
                      {!correct && (
                        <p className="mt-1 text-sm text-green-700">
                          <strong>Correct:</strong> {correctLabel(q)}
                        </p>
                      )}
                      {(q.explanation || q.modelAnswer) && (
                        <p className="mt-2 rounded-xl bg-blue-50 p-3 text-sm text-slate-700">
                          {q.explanation || q.modelAnswer}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <button
              onClick={reset}
              className="rounded-2xl border border-slate-300 bg-white px-4 py-3 font-black text-slate-700 flex items-center justify-center gap-2"
            >
              <RotateCcw className="w-5 h-5" /> Retake
            </button>
            <button
              onClick={() => void shareCurrentPack()}
              className="rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 font-black text-indigo-700 flex items-center justify-center gap-2"
            >
              <Share2 className="w-5 h-5" /> Share
            </button>
            {showWebAppCta ? (
              <button
                type="button"
                onClick={handleOpenInApp}
                className="rounded-2xl bg-[#2D6A4F] px-4 py-3 font-black text-white flex items-center justify-center gap-2"
              >
                <ExternalLink className="w-5 h-5" /> Open app
              </button>
            ) : (
              <Link
                to="/"
                className="rounded-2xl bg-[#2D6A4F] px-4 py-3 font-black text-white flex items-center justify-center gap-2"
              >
                <ExternalLink className="w-5 h-5" /> Open app
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-slate-100">
      {webAppCta}

      <header className="safe-area-x shrink-0 border-b border-slate-200/80 bg-slate-100/95 px-3 pb-1.5 pt-safe shadow-sm backdrop-blur sm:px-6 sm:pb-2 sm:pt-3">
        <div className="mx-auto max-w-7xl rounded-2xl bg-[#0F172A] p-2.5 text-white shadow-lg sm:p-3">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={handleBack}
              className="flex h-9 shrink-0 items-center justify-center gap-1 rounded-xl bg-white/10 px-2 text-[11px] font-black uppercase text-white hover:bg-white/15 sm:h-10 sm:px-3"
              aria-label="Back"
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Back</span>
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-[8px] font-black uppercase tracking-[0.2em] text-emerald-300 sm:text-[10px]">
                PharmaTRACK Quick Quiz
              </p>
              <h1 className="mt-0.5 truncate text-sm font-black sm:text-lg">
                {packResult.pack.title}
              </h1>
              <p className="mt-0.5 truncate text-[10px] font-semibold text-slate-300 sm:text-xs">
                {packResult.pack.course?.code || packResult.pack.course?.name || 'Shared quiz'}
                {packResult.pack.topic?.name ? ` · ${packResult.pack.topic.name}` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={pauseQuickQuiz}
              className="flex h-9 shrink-0 items-center justify-center gap-1 rounded-xl bg-amber-400 px-2 text-[11px] font-black uppercase text-amber-950 hover:bg-amber-300 sm:h-10 sm:px-3"
            >
              <Pause className="h-4 w-4" />
              <span className="hidden sm:inline">Pause</span>
            </button>
            <Link
              to="/"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10 text-white sm:h-10 sm:w-10"
            >
              <Home className="h-4 w-4 sm:h-5 sm:w-5" />
            </Link>
          </div>
          <div className="mt-1.5 flex items-center gap-2 sm:gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-emerald-400"
                style={{ width: `${(setEnd / packResult.questions.length) * 100}%` }}
              />
            </div>
            <div className="flex shrink-0 items-center gap-1.5 text-[10px] font-black text-slate-200 sm:text-xs">
              <span>
                Q{setStart + 1}-{setEnd}/{packResult.questions.length}
              </span>
              <span
                className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 ${timerIsLow ? 'bg-red-500/20 text-red-100 ring-1 ring-red-300/40' : 'bg-white/10 text-emerald-100'}`}
              >
                <Clock className="h-3 w-3 sm:h-3.5 sm:w-3.5" /> {timerLabel}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main
        ref={questionScrollRef}
        className="safe-area-x min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2 sm:px-6 sm:py-4"
      >
        <div className="mx-auto grid max-w-7xl gap-3 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
          <section className="min-w-0 space-y-3">
            {!state.student && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 shadow-sm sm:p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <div className="mb-1.5 flex items-center gap-2 text-amber-900">
                      <UserPlus className="h-4 w-4" />
                      <p className="text-sm font-black sm:text-base">Create a local profile to save this quiz</p>
                    </div>
                    <p className="mb-2 text-xs text-amber-800 sm:text-sm">
                      No sign-in is needed. Your name lets PharmaTRACK keep this quiz on this device after refresh.
                    </p>
                    <input
                      value={localName}
                      onChange={(event) => setLocalName(event.target.value)}
                      placeholder="Your name"
                      className="w-full rounded-xl border border-amber-200 bg-white px-3 py-2.5 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-amber-300/40"
                    />
                  </div>
                  <button
                    onClick={ensureLocalStudent}
                    className="rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-black text-amber-950 shadow-sm hover:bg-amber-400"
                  >
                    Save locally
                  </button>
                </div>
              </div>
            )}

            <div className="grid gap-3" data-quick-quiz-question-set="three">
              {visibleQuestions.map((question, offset) => {
                const absoluteIndex = setStart + offset;
                const answered = answers[question.id];
                return (
                  <article
                    key={question.id}
                    className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4 lg:p-5"
                  >
                    <div className="mb-2.5 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-slate-900 px-2.5 py-1 text-[10px] font-black uppercase text-white">
                        Q{absoluteIndex + 1}
                      </span>
                      <span className="rounded-full bg-purple-100 px-2.5 py-1 text-[10px] font-black uppercase text-purple-700">
                        {question.questionType.replace('_', ' ')}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">
                        {question.difficulty}
                      </span>
                    </div>
                    <h2 className="text-[15px] font-black leading-snug text-slate-900 sm:text-base lg:text-lg">
                      {question.questionText}
                    </h2>

                    {question.questionType === 'mcq' && question.options?.length ? (
                      <div className="mt-3 grid gap-2">
                        {question.options.map((opt, idx) => {
                          const selected = answered === String(idx);
                          return (
                            <button
                              key={idx}
                              onClick={() => { setCurrentIndex(absoluteIndex); saveAnswer(question.id, String(idx)); }}
                              className={`flex w-full items-start gap-2 rounded-xl border p-3 text-left text-sm touch-manipulation transition-colors ${selected ? 'border-[#2D6A4F] bg-emerald-50 text-emerald-950 shadow-sm' : 'border-slate-200 bg-white text-slate-800 active:bg-slate-50'}`}
                            >
                              <span
                                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-black ${selected ? 'bg-[#2D6A4F] text-white' : 'bg-slate-100 text-slate-500'}`}
                              >
                                {String.fromCharCode(65 + idx)}
                              </span>
                              <span className="min-w-0 flex-1 leading-snug">{opt}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <textarea
                        value={answers[question.id] || ''}
                        onFocus={() => setCurrentIndex(absoluteIndex)}
                        onChange={(e) => { setCurrentIndex(absoluteIndex); saveAnswer(question.id, e.target.value); }}
                        placeholder="Type your answer…"
                        className="mt-3 min-h-[7rem] w-full rounded-xl border border-slate-300 p-3 text-sm outline-none focus:ring-4 focus:ring-[#2D6A4F]/15"
                      />
                    )}
                  </article>
                );
              })}
            </div>

            <div className="grid grid-cols-[repeat(3,minmax(0,1fr))] items-center gap-2 rounded-2xl border border-slate-200 bg-white/90 p-2 shadow-sm" data-quick-quiz-set-navigation>
              <button
                onClick={() => goToQuestionSet(setStart - QUIZ_SET_SIZE)}
                disabled={!canGoPreviousSet}
                className="inline-flex items-center justify-self-start gap-1 rounded-xl bg-slate-100 px-2 py-2 text-xs font-black text-slate-700 disabled:opacity-35"
              >
                <ChevronLeft className="h-4 w-4" /> Back 3
              </button>
              <button
                onClick={openSubmitReview}
                disabled={!isOnLastQuestion}
                title={isOnLastQuestion ? 'Review answers before submitting' : `Jump to question ${packResult.questions.length} to unlock Finish`}
                className="inline-flex items-center justify-self-center gap-1 rounded-xl bg-emerald-600 px-2 py-2 text-xs font-black text-white shadow-sm disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 sm:text-sm"
              >
                Finish <Check className="h-4 w-4" />
              </button>
              <button
                onClick={() => goToQuestionSet(setStart + QUIZ_SET_SIZE)}
                disabled={!canGoNextSet}
                className="inline-flex items-center justify-self-end gap-1 rounded-xl bg-blue-600 px-2 py-2 text-xs font-black text-white shadow-sm disabled:opacity-35 sm:text-sm"
              >
                Next 3 <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            {!isOnLastQuestion && packResult.questions.length > 0 && (
              <p className="px-1 text-center text-[11px] font-bold text-slate-500">
                Finish unlocks on question {packResult.questions.length}. Use the jump list to go there when you are ready to submit.
              </p>
            )}
          </section>

          {submitReviewOpen && (
            <div className="fixed inset-0 z-[260] flex items-end justify-center bg-slate-950/55 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Review quick quiz before submission">
              <div className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl">
                <div className="border-b border-slate-100 p-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.2em] text-emerald-700">Final review</p>
                  <h2 className="mt-1 text-xl font-black text-slate-900">Check answered and unanswered questions</h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {answeredCount} answered · {unansweredCount} unanswered. Use Corrections to go back before submitting.
                  </p>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  <div className="grid gap-2">
                    {packResult.questions.map((question, idx) => {
                      const hasAnswer = (answers[question.id] || '').trim().length > 0;
                      return (
                        <button
                          key={question.id}
                          type="button"
                          onClick={() => { setSubmitReviewOpen(false); goToQuestion(idx); }}
                          className={`flex items-start gap-3 rounded-2xl border p-3 text-left ${hasAnswer ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}
                        >
                          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-black ${hasAnswer ? 'bg-emerald-600 text-white' : 'bg-amber-500 text-amber-950'}`}>
                            {idx + 1}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-black text-slate-900 line-clamp-2">{question.questionText}</span>
                            <span className={`mt-1 block text-xs font-bold ${hasAnswer ? 'text-emerald-800' : 'text-amber-800'}`}>
                              {hasAnswer ? `Answered: ${answerLabel(question, answers[question.id] || '')}` : 'Unanswered — tap to correct'}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="sticky bottom-0 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 border-t border-slate-100 bg-white p-3 safe-area-bottom">
                  <button
                    type="button"
                    onClick={() => setSubmitReviewOpen(false)}
                    className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-50"
                  >
                    Corrections
                  </button>
                  <button
                    type="button"
                    onClick={submitQuiz}
                    className="rounded-2xl bg-[#2D6A4F] px-4 py-3 text-sm font-black text-white hover:bg-[#1B4332]"
                  >
                    Submit quiz
                  </button>
                </div>
              </div>
            </div>
          )}

          <aside className="rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm lg:sticky lg:top-3 lg:max-h-[calc(100dvh-1.5rem)] lg:overflow-y-auto" aria-label="Jump to question">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs font-black uppercase tracking-wider text-slate-500">Jump to question</p>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black text-slate-500">
                {score.total} Qs
              </span>
            </div>
            <div className="grid grid-cols-5 gap-2 sm:grid-cols-8 lg:grid-cols-3" data-quick-quiz-jump-grid="right-fixed">
              {packResult.questions.map((q, idx) => (
                <button
                  key={q.id}
                  onClick={() => goToQuestion(idx)}
                  className={`h-9 rounded-full text-sm font-black ${idx >= setStart && idx < setEnd ? 'bg-[#2D6A4F] text-white' : answers[q.id] ? 'bg-emerald-100 text-emerald-700' : 'border border-slate-200 bg-white text-slate-500'}`}
                  aria-current={idx === currentIndex ? 'step' : undefined}
                >
                  {idx + 1}
                </button>
              ))}
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
};

export default QuickQuiz;
