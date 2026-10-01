// PharmTrack - Quiz Mode Page

import React, { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useApp } from '../context/AppContext';
import { ExamQuestion, QuizHistory, QuizMode } from '../types';
import { Link, useSearchParams } from 'react-router-dom';
import {
  gradeAnswer,
  isQuizMode,
  questionsForQuiz,
  quizReview,
  QUIZ_MODES,
} from '../utils/questionBank';
import { buildQuickQuizPack, shareQuickQuizPack } from '../utils/quickQuizShare';
import {
  Brain,
  Play,
  Clock,
  ChevronLeft,
  ChevronRight,
  Check,
  X,
  Flag,
  Trophy,
  Target,
  AlertTriangle,
  RotateCcw,
  BookOpen,
  FileQuestion,
  Share2,
} from 'lucide-react';

const QUIZ_SET_SIZE = 3;

interface QuizSettings {
  mode: QuizMode;
  courseId: string;
  topicId: string;
  questionTypes: string[];
  numQuestions: number;
  difficulty: string;
  timed: boolean;
  timeLimit: number;
}

const Quiz: React.FC = () => {
  const { state, dispatch, getTopicsForCourse, addActivity } = useApp();
  const [params] = useSearchParams();
  const quizId = params.get('quiz');
  const requestedMode = params.get('mode');
  const requestedCount = parseInt(params.get('count') || '', 10);
  const reviewedQuiz = useRef('');
  const activeSetRef = useRef<HTMLDivElement | null>(null);

  // Quiz setup state
  const [settings, setSettings] = useState<QuizSettings>({
    mode: requestedMode && isQuizMode(requestedMode) ? requestedMode : 'mixed',
    courseId: params.get('course') || '',
    topicId: params.get('topic') || '',
    questionTypes: params.get('type') === 'mcq' ? ['mcq'] : [],
    numQuestions: Number.isFinite(requestedCount) && requestedCount > 0 ? requestedCount : 10,
    difficulty: 'mixed',
    timed: requestedMode === 'timed',
    timeLimit: 30,
  });

  // Quiz state
  const [quizStarted, setQuizStarted] = useState(false);
  const [isReviewMode, setIsReviewMode] = useState(false);
  const [quizQuestions, setQuizQuestions] = useState<ExamQuestion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Map<string, { answer: string; flagged: boolean }>>(
    new Map(),
  );

  const [timeRemaining, setTimeRemaining] = useState(0);
  const [quizFinished, setQuizFinished] = useState(false);
  const [results, setResults] = useState<QuizHistory | null>(null);

  const topics = settings.courseId ? getTopicsForCourse(settings.courseId) : [];

  const availableQuestions = questionsForQuiz(state, {
    mode: settings.mode,
    courseId: settings.courseId || undefined,
    topicId: settings.topicId || undefined,
    questionTypes: settings.questionTypes,
    difficulty: settings.difficulty,
  });
  const modeReady =
    (settings.mode !== 'topic' || Boolean(settings.topicId)) &&
    (settings.mode !== 'course' || Boolean(settings.courseId));
  const modeHelp = QUIZ_MODES.find((mode) => mode.id === settings.mode);

  // Timer effect
  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    if (quizStarted && settings.timed && timeRemaining > 0 && !quizFinished) {
      timer = setInterval(() => {
        setTimeRemaining((prev) => {
          if (prev <= 1) {
            finishQuiz();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [quizStarted, settings.timed, timeRemaining, quizFinished]);

  const reviewQuiz = (history: QuizHistory) => {
    const qs = state.examQuestions.filter((q) => history.questionsUsed.includes(q.id));
    setQuizQuestions(qs);

    // We recreate the answers map exactly as it was during the quiz so the Results screen can read it
    const prevAnswers = new Map();
    history.answersGiven.forEach((a) => {
      prevAnswers.set(a.questionId, { answer: a.answer, flagged: false });
    });
    setAnswers(prevAnswers);

    // Bypass the active quiz mode and jump straight to the Results screen
    setResults(history);
    setQuizStarted(true);
    setQuizFinished(true);
  };

  useEffect(() => {
    if (!quizId || reviewedQuiz.current === quizId) return;
    const history = state.quizHistory.find((quiz) => quiz.id === quizId);
    if (!history) return;
    reviewedQuiz.current = quizId;
    reviewQuiz(history);
  }, [quizId, state.quizHistory]);

  const selectQuizQuestions = () => {
    const shuffled = [...availableQuestions].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(settings.numQuestions, shuffled.length));
  };

  const startQuiz = () => {
    const selected = selectQuizQuestions();

    setQuizQuestions(selected);
    setCurrentIndex(0);
    setAnswers(new Map());
    setTimeRemaining(settings.timeLimit * 60);
    setQuizStarted(true);
    setQuizFinished(false);
    setResults(null);
  };

  const shareCurrentQuiz = async () => {
    const selected = selectQuizQuestions();
    const course = state.courses.find((c) => c.id === settings.courseId);
    const topic = state.topics.find((t) => t.id === settings.topicId);
    const title = `${modeHelp?.label || 'PharmaTRACK'} · ${topic?.topicName || course?.courseCode || 'Mixed'} (${selected.length})`;
    const pack = buildQuickQuizPack(selected, {
      title,
      course: course ? { code: course.courseCode, name: course.courseName } : undefined,
      topic: topic ? { name: topic.topicName } : undefined,
      timeLimitMinutes: settings.timed ? settings.timeLimit : undefined,
    });
    if (!pack) return;
    try {
      const result = await shareQuickQuizPack(pack);
      if (result === 'copied') alert('Quick quiz link copied. Share it with anyone — it opens directly into the quiz.');
    } catch (err: any) {
      if (err?.name !== 'AbortError') alert(err?.message || 'Could not share this quick quiz link.');
    }
  };

  const saveAnswer = (questionId: string, answer: string) => {
    const newAnswers = new Map(answers);
    const existing = newAnswers.get(questionId) || { answer: '', flagged: false };
    newAnswers.set(questionId, { ...existing, answer });
    setAnswers(newAnswers);
  };

  const toggleFlag = (questionId: string) => {
    const newAnswers = new Map(answers);
    const existing = newAnswers.get(questionId) || { answer: '', flagged: false };
    newAnswers.set(questionId, { ...existing, flagged: !existing.flagged });
    setAnswers(newAnswers);
  };

  const finishQuiz = () => {
    // Calculate results
    let correctCount = 0;
    const answersArray: QuizHistory['answersGiven'] = [];
    const weakTopicsSet = new Set<string>();

    quizQuestions.forEach((q) => {
      const userAnswer = answers.get(q.id);
      let isCorrect = false;

      isCorrect = gradeAnswer(q, userAnswer?.answer || '');

      if (isCorrect) {
        correctCount++;
      } else {
        weakTopicsSet.add(q.topicId);
      }

      answersArray.push({
        questionId: q.id,
        answer: userAnswer?.answer || '',
        isCorrect,
      });
    });

    const scorePercentage = Math.round((correctCount / quizQuestions.length) * 100);

    const history: QuizHistory = {
      id: uuidv4(),
      studentId: state.student?.id || '',
      courseId: settings.courseId || quizQuestions[0]?.courseId || '',
      topicId: settings.topicId || undefined,
      questionsUsed: quizQuestions.map((q) => q.id),
      answersGiven: answersArray,
      scorePercentage,
      weakTopics: Array.from(weakTopicsSet).filter(Boolean),
      timeTaken: settings.timed ? settings.timeLimit * 60 - timeRemaining : 0,
      completedAt: new Date().toISOString(),
      mode: settings.mode,
    };

    dispatch({ type: 'ADD_QUIZ_HISTORY', payload: history });
    addActivity('quiz_taken', `Completed quiz with ${scorePercentage}% score`);
    setResults(history);
    setQuizFinished(true);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const setStart = Math.floor(currentIndex / QUIZ_SET_SIZE) * QUIZ_SET_SIZE;
  const visibleQuestions = quizQuestions.slice(setStart, setStart + QUIZ_SET_SIZE);
  const setEnd = Math.min(setStart + visibleQuestions.length, quizQuestions.length);
  const canGoPreviousSet = setStart > 0;
  const canGoNextSet = setStart + QUIZ_SET_SIZE < quizQuestions.length;

  const scrollActiveSetIntoView = () => {
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      activeSetRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  };

  const goToQuestion = (index: number) => {
    setCurrentIndex(Math.min(Math.max(0, index), Math.max(0, quizQuestions.length - 1)));
    scrollActiveSetIntoView();
  };

  // Setup screen
  if (!quizStarted) {
    return (
      <div className="max-w-2xl mx-auto space-y-4 sm:space-y-6">
        {/* Secure Examination Client Banner */}
        <div className="bg-gradient-to-r from-slate-900 to-[#1B4332] text-white rounded-2xl p-5 sm:p-6 shadow-md border border-emerald-900/40 text-left">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <span className="inline-block px-2.5 py-0.5 bg-emerald-500/20 text-emerald-300 text-xs font-bold rounded-full mb-2 uppercase tracking-wider">
                Official Examination Mode · Web / PWA
              </span>
              <h2 className="text-xl font-bold">PharmaTRACK Secure Examination</h2>
              <p className="text-sm text-slate-300 mt-1">
                Take supervised course examinations directly in the browser with local encrypted caching,
                authoritative timer, and LAN synchronization.
              </p>
            </div>
            <Link
              to="/examinations/kiosk"
              className="inline-flex items-center justify-center gap-2 px-5 py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl font-black shrink-0 transition-colors shadow-sm text-sm"
            >
              Enter Kiosk Examination
            </Link>
          </div>
        </div>

        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl mb-4">
            <Brain className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-800">Quiz Mode</h1>
          <p className="text-gray-500">Test your knowledge with practice questions</p>
          <div className="flex flex-col sm:flex-row sm:flex-wrap items-center justify-center gap-2 mt-4">
            <Link
              to="/examinations/kiosk"
              className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-700 text-white rounded-lg font-bold"
            >
              Enter Kiosk Examination
            </Link>
            <Link
              to="/examinations/builder"
              className="inline-flex items-center gap-2 px-4 py-2 border border-emerald-700 text-emerald-800 rounded-lg font-bold"
            >
              Examination Builder
            </Link>
          </div>
        </div>

        {state.examQuestions.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-xl border border-gray-100">
            <FileQuestion className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-gray-700 mb-2">No questions available</h2>
            <p className="text-gray-500 mb-4">Add or import questions in the Question Bank first</p>
            <Link
              to="/questions"
              className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg"
            >
              Go to Question Bank
            </Link>
          </div>
        ) : (
          <div className="bg-white rounded-xl p-6 border border-gray-100 shadow-sm space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Quiz mode</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {QUIZ_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() =>
                      setSettings({
                        ...settings,
                        mode: mode.id,
                        timed: mode.id === 'timed' ? true : settings.timed,
                        topicId:
                          mode.id === 'course' || mode.id === 'mixed' || mode.id === 'timed'
                            ? ''
                            : settings.topicId,
                      })
                    }
                    className={`px-3 py-2 rounded-lg text-sm font-semibold text-left ${
                      settings.mode === mode.id
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              {modeHelp && <p className="text-xs text-gray-500 mt-2">{modeHelp.hint}</p>}
            </div>

            {/* Course filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Course{settings.mode === 'topic' || settings.mode === 'course' ? ' (required)' : ''}
              </label>
              <select
                value={settings.courseId}
                onChange={(e) =>
                  setSettings({ ...settings, courseId: e.target.value, topicId: '' })
                }
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              >
                <option value="">
                  {settings.mode === 'topic' || settings.mode === 'course'
                    ? 'Choose a course'
                    : 'All Courses'}
                </option>
                {state.courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.courseCode} - {course.courseName}
                  </option>
                ))}
              </select>
            </div>

            {/* Topic filter */}
            {settings.courseId && settings.mode !== 'course' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Topic{settings.mode === 'topic' ? ' (required)' : ''}
                </label>
                <select
                  value={settings.topicId}
                  onChange={(e) => setSettings({ ...settings, topicId: e.target.value })}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                >
                  <option value="">All Topics</option>
                  {topics.map((topic) => (
                    <option key={topic.id} value={topic.id}>
                      {topic.topicName}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Question types */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Question Types</label>
              <div className="flex flex-wrap gap-2">
                {['mcq', 'short_answer', 'structured', 'essay', 'case_study'].map((type) => (
                  <button
                    key={type}
                    onClick={() => {
                      const types = settings.questionTypes.includes(type)
                        ? settings.questionTypes.filter((t) => t !== type)
                        : [...settings.questionTypes, type];
                      setSettings({ ...settings, questionTypes: types });
                    }}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      settings.questionTypes.includes(type) || settings.questionTypes.length === 0
                        ? 'bg-blue-100 text-blue-700 border-2 border-blue-300'
                        : 'bg-gray-100 text-gray-600 border-2 border-transparent'
                    }`}
                  >
                    {type === 'mcq'
                      ? 'MCQ'
                      : type
                          .split('_')
                          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                          .join(' ')}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-1">Leave empty for all types</p>
            </div>

            {/* Number of questions */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Number of Questions
              </label>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-3">
                {[5, 10, 25, 50, 100].map((num) => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => setSettings({ ...settings, numQuestions: num })}
                    className={`py-2 rounded-lg text-xs font-bold transition-all ${
                      settings.numQuestions === num
                        ? 'bg-blue-600 text-white shadow-lg'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {num}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3 bg-gray-50 p-3 rounded-xl border border-gray-100">
                <span className="text-xs font-black text-gray-400 uppercase tracking-widest whitespace-nowrap">
                  Custom Count:
                </span>
                <input
                  type="number"
                  min="1"
                  max={Math.max(1, availableQuestions.length)}
                  value={settings.numQuestions}
                  onChange={(e) =>
                    setSettings({ ...settings, numQuestions: parseInt(e.target.value) || 1 })
                  }
                  className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-bold focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <p className="text-[10px] font-bold text-[#2D6A4F] uppercase tracking-widest mt-2">
                Available Pharmacy Pool: {availableQuestions.length} Questions
              </p>
            </div>

            {/* Difficulty */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Difficulty</label>
              <div className="flex gap-2">
                {['easy', 'medium', 'hard', 'mixed'].map((diff) => (
                  <button
                    key={diff}
                    onClick={() => setSettings({ ...settings, difficulty: diff })}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium capitalize transition-colors ${
                      settings.difficulty === diff
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {diff}
                  </button>
                ))}
              </div>
            </div>

            {/* Timer */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.timed || settings.mode === 'timed'}
                    disabled={settings.mode === 'timed'}
                    onChange={(e) => setSettings({ ...settings, timed: e.target.checked })}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                  />
                  <span className="text-sm font-medium text-gray-700">Timed Mode</span>
                </label>
              </div>
              {settings.timed && (
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-gray-400" />
                  <select
                    value={settings.timeLimit}
                    onChange={(e) =>
                      setSettings({ ...settings, timeLimit: parseInt(e.target.value) })
                    }
                    className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                  >
                    <option value="10">10 minutes</option>
                    <option value="15">15 minutes</option>
                    <option value="20">20 minutes</option>
                    <option value="30">30 minutes</option>
                    <option value="45">45 minutes</option>
                    <option value="60">60 minutes</option>
                  </select>
                </div>
              )}
            </div>

            {/* Start / share buttons */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                onClick={startQuiz}
                disabled={!modeReady || availableQuestions.length === 0}
                className="w-full py-3 bg-gradient-to-r from-blue-500 to-purple-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Play className="w-5 h-5" />
                {modeHelp ? `Start ${modeHelp.label}` : 'Start Quiz'}
              </button>
              <button
                onClick={() => void shareCurrentQuiz()}
                disabled={!modeReady || availableQuestions.length === 0}
                className="w-full py-3 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Share2 className="w-5 h-5" />
                Share Quick Start
              </button>
            </div>
            {!modeReady && (
              <p className="text-xs text-amber-700">Choose the course or topic this mode needs.</p>
            )}
            {modeReady && availableQuestions.length === 0 && (
              <p className="text-xs text-amber-700">No questions match this mode yet.</p>
            )}
          </div>
        )}

        {/* Recent quiz history */}
        {state.quizHistory.length > 0 && (
          <div className="bg-white rounded-xl p-6 border border-gray-100 shadow-sm">
            <h2 className="font-semibold text-gray-800 mb-4">Recent Quizzes</h2>
            <div className="space-y-3">
              {state.quizHistory.slice(0, 5).map((quiz) => {
                const course = state.courses.find((c) => c.id === quiz.courseId);
                return (
                  <div
                    key={quiz.id}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                  >
                    <div>
                      <p className="font-medium text-gray-800">
                        {course?.courseCode || 'Mixed'} - {quiz.questionsUsed.length} questions
                        {quiz.mode
                          ? ` · ${QUIZ_MODES.find((mode) => mode.id === quiz.mode)?.label || quiz.mode}`
                          : ''}
                      </p>
                      <p className="text-sm text-gray-500">
                        {new Date(quiz.completedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div
                        className={`text-lg font-bold ${
                          quiz.scorePercentage >= 70
                            ? 'text-green-600'
                            : quiz.scorePercentage >= 50
                              ? 'text-yellow-600'
                              : 'text-red-600'
                        }`}
                      >
                        {quiz.scorePercentage}%
                      </div>
                      <button
                        onClick={() => reviewQuiz(quiz)}
                        className="text-sm font-bold text-[#2D6A4F] bg-[#2D6A4F]/10 px-3 py-1.5 rounded-lg hover:bg-[#2D6A4F]/20 transition-colors"
                      >
                        Review
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Results screen
  if (quizFinished && results) {
    const review = quizReview(state, results, quizQuestions);
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="text-center">
          <div
            className={`inline-flex items-center justify-center w-20 h-20 rounded-full mb-4 ${
              results.scorePercentage >= 70
                ? 'bg-green-100'
                : results.scorePercentage >= 50
                  ? 'bg-yellow-100'
                  : 'bg-red-100'
            }`}
          >
            {results.scorePercentage >= 70 ? (
              <Trophy className="w-10 h-10 text-green-600" />
            ) : results.scorePercentage >= 50 ? (
              <Target className="w-10 h-10 text-yellow-600" />
            ) : (
              <AlertTriangle className="w-10 h-10 text-red-600" />
            )}
          </div>
          <h1 className="text-3xl font-bold text-gray-800">Quiz Complete!</h1>
          <p className="text-gray-500 mt-2">Here's how you did</p>
        </div>

        {/* Score card */}
        <div className="bg-white rounded-xl p-6 border border-gray-100 shadow-sm">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-6 text-center">
            <div>
              <p
                className={`text-4xl font-bold ${
                  results.scorePercentage >= 70
                    ? 'text-green-600'
                    : results.scorePercentage >= 50
                      ? 'text-yellow-600'
                      : 'text-red-600'
                }`}
              >
                {results.scorePercentage}%
              </p>
              <p className="text-sm text-gray-500">Score</p>
            </div>
            <div>
              <p className="text-4xl font-bold text-gray-800">
                {results.answersGiven.filter((a) => a.isCorrect).length}/
                {results.answersGiven.length}
              </p>
              <p className="text-sm text-gray-500">Correct</p>
            </div>
            <div>
              <p className="text-4xl font-bold text-gray-800">
                {results.timeTaken > 0 ? formatTime(results.timeTaken) : '-'}
              </p>
              <p className="text-sm text-gray-500">Time</p>
            </div>
          </div>
        </div>

        <div
          className={`rounded-xl p-5 border ${review.mistakes.length ? 'bg-yellow-50 border-yellow-200' : 'bg-green-50 border-green-200'}`}
        >
          <h3 className="font-semibold text-gray-800 mb-2 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            {review.mistakes.length ? 'Weak topics' : 'Nothing to revise'}
          </h3>
          <p className="text-sm text-gray-700 mb-3">{review.recommendation}</p>
          {review.weakTopics.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {review.weakTopics.map((topic) => (
                <Link
                  key={topic.id}
                  to={`/learn?topic=${topic.id}`}
                  className="px-3 py-1 bg-white text-yellow-900 rounded-lg text-sm font-semibold border border-yellow-200"
                >
                  Revise {topic.name}
                  {topic.courseCode ? ` · ${topic.courseCode}` : ''}
                </Link>
              ))}
            </div>
          )}
          {review.mistakes.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Link
                to="/quiz?mode=revision"
                className="px-3 py-1.5 bg-[#2D6A4F] text-white rounded-lg text-sm font-semibold"
              >
                Revision quiz
              </Link>
              <Link
                to="/quiz?mode=weak"
                className="px-3 py-1.5 bg-white text-[#2D6A4F] border border-[#2D6A4F] rounded-lg text-sm font-semibold"
              >
                Weak-topic quiz
              </Link>
            </div>
          )}
        </div>

        {review.mistakes.length > 0 && (
          <div className="bg-white rounded-xl border border-red-100 shadow-sm overflow-hidden">
            <div className="p-4 border-b bg-red-50">
              <h3 className="font-semibold text-red-800">Mistakes</h3>
            </div>
            <div className="divide-y">
              {review.mistakes.map((item, idx) => (
                <div key={item.questionId} className="p-4 space-y-2">
                  <p className="font-medium text-gray-800">
                    {idx + 1}. {item.questionText}
                  </p>
                  <p className="text-sm text-red-700">
                    <strong>Your answer:</strong> {item.yourAnswer}
                  </p>
                  <p className="text-sm text-green-800">
                    <strong>Correct answer:</strong> {item.correctAnswer || 'Not recorded'}
                  </p>
                  {item.explanation && (
                    <p className="text-sm text-gray-700 bg-blue-50 rounded-lg p-3">
                      {item.explanation}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="p-4 border-b bg-gray-50">
            <h3 className="font-semibold text-gray-800">Question Review</h3>
          </div>
          <div className="divide-y">
            {review.items.map((item, idx) => {
              const question =
                quizQuestions.find((q) => q.id === item.questionId) ||
                state.examQuestions.find((q) => q.id === item.questionId);
              return (
                <div key={item.questionId} className="p-4">
                  <div className="flex items-start gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${item.correct ? 'bg-green-100' : 'bg-red-100'}`}
                    >
                      {item.correct ? (
                        <Check className="w-4 h-4 text-green-600" />
                      ) : (
                        <X className="w-4 h-4 text-red-600" />
                      )}
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-gray-800">
                        Q{idx + 1}. {item.questionText}
                      </p>
                      {question?.questionType === 'mcq' && question.options && (
                        <div className="mt-2 space-y-1">
                          {question.options.map((opt, optIdx) => (
                            <div
                              key={optIdx}
                              className={`p-2 rounded text-sm ${
                                optIdx === question.correctOption
                                  ? 'bg-green-100 text-green-800 font-medium'
                                  : 'bg-gray-50'
                              }`}
                            >
                              {String.fromCharCode(65 + optIdx)}. {opt}
                              {optIdx === question.correctOption && ' ✓'}
                            </div>
                          ))}
                        </div>
                      )}
                      <p className="mt-2 text-sm text-gray-600">
                        <strong>Your answer:</strong> {item.yourAnswer}
                      </p>
                      {!item.correct && (
                        <p className="mt-1 text-sm text-green-800">
                          <strong>Correct answer:</strong> {item.correctAnswer || 'Not recorded'}
                        </p>
                      )}
                      {item.explanation && (
                        <p className="mt-2 p-3 bg-blue-50 rounded-lg text-sm text-gray-700">
                          {item.explanation}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Actions */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <button
            onClick={() => {
              setQuizStarted(false);
              setQuizFinished(false);
              setResults(null);
            }}
            className="flex-1 py-3 border border-gray-300 text-gray-700 font-semibold rounded-lg hover:bg-gray-50 flex items-center justify-center gap-2"
          >
            <RotateCcw className="w-5 h-5" />
            New Quiz
          </button>
          <Link
            to="/questions"
            className="flex-1 py-3 bg-[#2D6A4F] text-white font-semibold rounded-lg hover:bg-[#1B4332] flex items-center justify-center gap-2"
          >
            <BookOpen className="w-5 h-5" />
            Review Questions
          </Link>
        </div>
      </div>
    );
  }

  // Quiz in progress
  return (
    <div className="mx-auto max-w-7xl space-y-3" ref={activeSetRef}>
      {/* Header */}
      <div className="flex flex-col gap-3 rounded-2xl border border-gray-100 bg-white p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-black uppercase tracking-wider text-gray-500">
            Questions {setStart + 1}-{setEnd} of {quizQuestions.length}
          </p>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-200 sm:max-w-md">
            <div
              className="h-full bg-blue-500 transition-all"
              style={{ width: `${(setEnd / quizQuestions.length) * 100}%` }}
            />
          </div>
        </div>
        {settings.timed && (
          <div
            className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-black ${
              timeRemaining <= 60 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'
            }`}
          >
            <Clock className="h-4 w-4" />
            <span className="font-mono">{formatTime(timeRemaining)}</span>
          </div>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start">
        <section className="min-w-0 space-y-3">
          {/* Question cards: three at a time on phone, PWA, APK, web and desktop */}
          <div className="grid gap-3" data-quiz-question-set="three">
            {visibleQuestions.map((question, offset) => {
              const absoluteIndex = setStart + offset;
              const saved = answers.get(question.id);
              return (
                <article
                  key={question.id}
                  className="rounded-2xl border border-gray-100 bg-white p-3 shadow-sm sm:p-4 lg:p-5"
                >
                  <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-slate-900 px-2.5 py-1 text-[10px] font-black uppercase text-white">
                        Q{absoluteIndex + 1}
                      </span>
                      <span className="rounded-full bg-purple-100 px-2.5 py-1 text-[10px] font-black uppercase text-purple-700">
                        {question.questionType === 'mcq'
                          ? 'MCQ'
                          : question.questionType
                              .split('_')
                              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                              .join(' ')}
                      </span>
                    </div>
                    <span className="text-xs font-bold text-gray-500">{question.marksAllocation} marks</span>
                  </div>

                  <p className="mb-3 text-[15px] font-bold leading-snug text-gray-800 sm:text-base lg:text-lg">
                    {question.questionText}
                  </p>

                  {question.questionType === 'mcq' && question.options ? (
                    <div className="grid gap-2">
                      {question.options.map((opt, idx) => {
                        const isSelected = saved?.answer === String(idx);
                        return (
                          <button
                            key={idx}
                            onClick={() => saveAnswer(question.id, String(idx))}
                            className={`w-full rounded-xl border p-3 text-left text-sm transition-colors ${
                              isSelected
                                ? 'border-blue-500 bg-blue-50'
                                : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <span
                                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-black ${
                                  isSelected ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'
                                }`}
                              >
                                {String.fromCharCode(65 + idx)}
                              </span>
                              <span className="min-w-0 flex-1 leading-snug text-gray-800">{opt}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <textarea
                      value={saved?.answer || ''}
                      onChange={(e) => saveAnswer(question.id, e.target.value)}
                      placeholder="Type your answer here..."
                      readOnly={isReviewMode}
                      rows={4}
                      className="w-full resize-none rounded-xl border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-transparent focus:ring-2 focus:ring-blue-500"
                    />
                  )}

                  <div className="mt-3 flex justify-end">
                    <button
                      onClick={() => toggleFlag(question.id)}
                      className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-black ${
                        saved?.flagged
                          ? 'bg-yellow-100 text-yellow-700'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      <Flag className="h-4 w-4" />
                      Flag
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          {/* Navigation appears after the third question in the current set. */}
          <div className="grid grid-cols-3 gap-2 rounded-2xl border border-gray-100 bg-white p-2 shadow-sm" data-quiz-set-navigation>
            <button
              onClick={() => goToQuestion(setStart - QUIZ_SET_SIZE)}
              disabled={!canGoPreviousSet}
              className="inline-flex items-center justify-center gap-1 rounded-xl bg-gray-100 px-2 py-2 text-xs font-black text-gray-700 disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" /> Back 3
            </button>

            <button
              onClick={finishQuiz}
              className="inline-flex items-center justify-center gap-1 rounded-xl bg-green-600 px-2 py-2 text-xs font-black text-white hover:bg-green-700 sm:text-sm"
            >
              Finish <Check className="h-4 w-4" />
            </button>

            <button
              onClick={() => goToQuestion(setStart + QUIZ_SET_SIZE)}
              disabled={!canGoNextSet}
              className="inline-flex items-center justify-center gap-1 rounded-xl bg-blue-600 px-2 py-2 text-xs font-black text-white hover:bg-blue-700 disabled:opacity-40 sm:text-sm"
            >
              Next 3 <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>

        {/* Question jump selection is fixed/sticky on the right on PC/exe/deb. */}
        <aside className="rounded-2xl border border-gray-100 bg-white p-3 shadow-sm lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto" aria-label="Jump to question">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-black uppercase tracking-wider text-gray-500">Jump to question</h3>
            <span className="rounded-full bg-gray-100 px-2 py-1 text-[10px] font-black text-gray-500">
              {quizQuestions.length} Qs
            </span>
          </div>
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-8 lg:grid-cols-3" data-quiz-jump-grid="right-fixed">
            {quizQuestions.map((q, idx) => {
              const answer = answers.get(q.id);
              return (
                <button
                  key={q.id}
                  onClick={() => goToQuestion(idx)}
                  className={`h-9 rounded-full text-sm font-black transition-colors ${
                    idx >= setStart && idx < setEnd
                      ? 'bg-blue-600 text-white'
                      : answer?.flagged
                        ? 'bg-yellow-400 text-yellow-900'
                        : answer?.answer
                          ? 'border border-green-300 bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                  aria-current={idx === currentIndex ? 'step' : undefined}
                >
                  {idx + 1}
                </button>
              );
            })}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default Quiz;
