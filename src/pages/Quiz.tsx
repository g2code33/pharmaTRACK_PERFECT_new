// PharmTrack - Quiz Mode Page

import React, { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useApp } from '../context/AppContext';
import { ExamQuestion, QuizHistory } from '../types';
import { Link } from 'react-router-dom';
import {
  Brain,
  Play,
  Clock,
  ChevronLeft,
  ChevronRight,
  Check,
  X,
  Flag,
  Eye,
  EyeOff,
  Trophy,
  Target,
  AlertTriangle,
  RotateCcw,
  BookOpen,
  FileQuestion,
} from 'lucide-react';

interface QuizSettings {
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

  // Quiz setup state
  const [settings, setSettings] = useState<QuizSettings>({
    courseId: '',
    topicId: '',
    questionTypes: [],
    numQuestions: 10,
    difficulty: 'mixed',
    timed: false,
    timeLimit: 30,
  });

  // Quiz state
  const [quizStarted, setQuizStarted] = useState(false);
    const [quizQuestions, setQuizQuestions] = useState<ExamQuestion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Map<string, { answer: string; flagged: boolean }>>(new Map());
  const [showAnswer, setShowAnswer] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [quizFinished, setQuizFinished] = useState(false);
  const [results, setResults] = useState<QuizHistory | null>(null);

  const topics = settings.courseId ? getTopicsForCourse(settings.courseId) : [];

  // Get available questions based on filters
  const getAvailableQuestions = () => {
    return state.examQuestions.filter((q) => {
      if (settings.courseId && q.courseId !== settings.courseId) return false;
      if (settings.topicId && q.topicId !== settings.topicId) return false;
      if (settings.questionTypes.length > 0 && !settings.questionTypes.includes(q.questionType))
        return false;
      if (settings.difficulty !== 'mixed' && q.difficulty !== settings.difficulty) return false;
      return true;
    });
  };

  const availableQuestions = getAvailableQuestions();

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
    const qs = state.examQuestions.filter(q => history.questionsUsed.includes(q.id));
    setQuizQuestions(qs);
    
    // We recreate the answers map exactly as it was during the quiz so the Results screen can read it
    const prevAnswers = new Map();
    history.answersGiven.forEach(a => { 
       prevAnswers.set(a.questionId, { answer: a.answer, flagged: false }); 
    });
    setAnswers(prevAnswers);
    
    // Bypass the active quiz mode and jump straight to the Results screen
    setResults(history);
    setQuizStarted(true);
    setQuizFinished(true);
  };

  const startQuiz = () => {
    // Shuffle and select questions
    const shuffled = [...availableQuestions].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(settings.numQuestions, shuffled.length));

    setQuizQuestions(selected);
    setCurrentIndex(0);
    setAnswers(new Map());
    setShowAnswer(false);
    setTimeRemaining(settings.timeLimit * 60);
    setQuizStarted(true);
    setQuizFinished(false);
    setResults(null);
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

      // For MCQ, check if correct option selected
      if (q.questionType === 'mcq' && q.correctOption !== undefined) {
        const answerNum = parseInt(userAnswer?.answer || '-1');
        isCorrect = answerNum === q.correctOption;
      } else {
        // For other types, mark as correct if answered (user self-assessment)
        isCorrect = (userAnswer?.answer || '').trim().length > 0;
      }

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
      questionsUsed: quizQuestions.map((q) => q.id),
      answersGiven: answersArray,
      scorePercentage,
      weakTopics: Array.from(weakTopicsSet),
      timeTaken: settings.timed ? settings.timeLimit * 60 - timeRemaining : 0,
      completedAt: new Date().toISOString(),
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

  const currentQuestion = quizQuestions[currentIndex];

  // Setup screen
  if (!quizStarted) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl mb-4">
            <Brain className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-800">Quiz Mode</h1>
          <p className="text-gray-500">Test your knowledge with practice questions</p>
        </div>

        {state.examQuestions.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-xl border border-gray-100">
            <FileQuestion className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-gray-700 mb-2">No questions available</h2>
            <p className="text-gray-500 mb-4">Generate some questions first to take a quiz</p>
            <Link
              to="/questions"
              className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg"
            >
              Go to Question Bank
            </Link>
          </div>
        ) : (
          <div className="bg-white rounded-xl p-6 border border-gray-100 shadow-sm space-y-6">
            {/* Course filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Course</label>
              <select
                value={settings.courseId}
                onChange={(e) =>
                  setSettings({ ...settings, courseId: e.target.value, topicId: '' })
                }
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
              >
                <option value="">All Courses</option>
                {state.courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.courseCode} - {course.courseName}
                  </option>
                ))}
              </select>
            </div>

            {/* Topic filter */}
            {settings.courseId && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Topic</label>
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
              <div className="grid grid-cols-5 gap-2 mb-3">
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
                <span className="text-xs font-black text-gray-400 uppercase tracking-widest whitespace-nowrap">Custom Count:</span>
                <input 
                  type="number"
                  min="1"
                  max={Math.max(1, availableQuestions.length)}
                  value={settings.numQuestions}
                  onChange={(e) => setSettings({ ...settings, numQuestions: parseInt(e.target.value) || 1 })}
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
                    checked={settings.timed}
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

            {/* Start button */}
            <button
              onClick={startQuiz}
              disabled={availableQuestions.length === 0}
              className="w-full py-3 bg-gradient-to-r from-blue-500 to-purple-600 text-white font-semibold rounded-lg hover:from-blue-600 hover:to-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <Play className="w-5 h-5" />
              Start Quiz
            </button>
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
                      <button onClick={() => reviewQuiz(quiz)} className="text-sm font-bold text-[#2D6A4F] bg-[#2D6A4F]/10 px-3 py-1.5 rounded-lg hover:bg-[#2D6A4F]/20 transition-colors">Review</button>
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
          <div className="grid grid-cols-3 gap-6 text-center">
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
                {results.answersGiven.filter((a) => a.isCorrect).length}/{quizQuestions.length}
              </p>
              <p className="text-sm text-gray-500">Correct</p>
            </div>
            <div>
              <p className="text-4xl font-bold text-gray-800">
                {settings.timed ? formatTime(results.timeTaken) : '-'}
              </p>
              <p className="text-sm text-gray-500">Time</p>
            </div>
          </div>
        </div>

        {/* Weak areas */}
        {results.weakTopics.length > 0 && (
          <div className="bg-yellow-50 rounded-xl p-5 border border-yellow-200">
            <h3 className="font-semibold text-yellow-800 mb-3 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5" />
              Areas to Review
            </h3>
            <div className="flex flex-wrap gap-2">
              {results.weakTopics.map((topicId) => {
                const topic = state.topics.find((t) => t.id === topicId);
                return topic ? (
                  <span
                    key={topicId}
                    className="px-3 py-1 bg-yellow-100 text-yellow-800 rounded-lg text-sm"
                  >
                    {topic.topicName}
                  </span>
                ) : null;
              })}
            </div>
          </div>
        )}

        {/* Question review */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="p-4 border-b bg-gray-50">
            <h3 className="font-semibold text-gray-800">Question Review</h3>
          </div>
          <div className="divide-y">
            {quizQuestions.map((q, idx) => {
              const result = results.answersGiven.find((a) => a.questionId === q.id);
              const userAnswer = answers.get(q.id);

              return (
                <div key={q.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                        result?.isCorrect ? 'bg-green-100' : 'bg-red-100'
                      }`}
                    >
                      {result?.isCorrect ? (
                        <Check className="w-4 h-4 text-green-600" />
                      ) : (
                        <X className="w-4 h-4 text-red-600" />
                      )}
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-gray-800">
                        Q{idx + 1}. {q.questionText}
                      </p>

                      {q.questionType === 'mcq' && q.options && (
                        <div className="mt-2 space-y-1">
                          {q.options.map((opt, optIdx) => (
                            <div
                              key={optIdx}
                              className={`p-2 rounded text-sm ${
                                optIdx === q.correctOption
                                  ? 'bg-green-100 text-green-800 font-medium'
                                  : userAnswer?.answer === String(optIdx) && optIdx !== q.correctOption
                                  ? 'bg-red-100 text-red-800'
                                  : 'bg-gray-50'
                              }`}
                            >
                              {String.fromCharCode(65 + optIdx)}. {opt}
                              {optIdx === q.correctOption && ' ✓'}
                            </div>
                          ))}
                        </div>
                      )}

                      {q.questionType !== 'mcq' && userAnswer?.answer && (
                        <div className="mt-2 p-3 bg-gray-50 rounded-lg">
                          <p className="text-sm text-gray-600">
                            <strong>Your answer:</strong> {userAnswer.answer}
                          </p>
                        </div>
                      )}

                      <details className="mt-2">
                        <summary className="text-sm text-blue-600 cursor-pointer hover:underline">
                          View model answer
                        </summary>
                        <p className="mt-2 p-3 bg-blue-50 rounded-lg text-sm text-gray-700">
                          {q.modelAnswer}
                        </p>
                      </details>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-4">
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
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-sm text-gray-500">
            Question {currentIndex + 1} of {quizQuestions.length}
          </p>
          <div className="w-48 h-2 bg-gray-200 rounded-full mt-2 overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all"
              style={{ width: `${((currentIndex + 1) / quizQuestions.length) * 100}%` }}
            />
          </div>
        </div>
        {settings.timed && (
          <div
            className={`flex items-center gap-2 px-4 py-2 rounded-lg ${
              timeRemaining <= 60 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'
            }`}
          >
            <Clock className="w-5 h-5" />
            <span className="font-mono font-bold">{formatTime(timeRemaining)}</span>
          </div>
        )}
      </div>

      {/* Question card */}
      {currentQuestion && (
        <div className="bg-white rounded-xl p-6 border border-gray-100 shadow-sm mb-6">
          {/* Question type badge */}
          <div className="flex items-center justify-between mb-4">
            <span className="px-3 py-1 bg-purple-100 text-purple-700 rounded-lg text-sm font-medium">
              {currentQuestion.questionType === 'mcq'
                ? 'Multiple Choice'
                : currentQuestion.questionType
                    .split('_')
                    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                    .join(' ')}
            </span>
            <span className="text-sm text-gray-500">
              {currentQuestion.marksAllocation} marks
            </span>
          </div>

          {/* Question text */}
          <p className="text-lg text-gray-800 font-medium mb-6">{currentQuestion.questionText}</p>

          {/* MCQ options */}
          {currentQuestion.questionType === 'mcq' && currentQuestion.options ? (
            <div className="space-y-3">
              {currentQuestion.options.map((opt, idx) => {
                const isSelected = answers.get(currentQuestion.id)?.answer === String(idx);
                return (
                  <button
                    key={idx}
                    onClick={() => saveAnswer(currentQuestion.id, String(idx))}
                    className={`w-full p-4 rounded-lg border-2 text-left transition-all ${
                      isSelected
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`w-8 h-8 rounded-full flex items-center justify-center font-medium ${
                          isSelected ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {String.fromCharCode(65 + idx)}
                      </span>
                      <span className="text-gray-800">{opt}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            // Text answer
            <textarea
              value={answers.get(currentQuestion.id)?.answer || ''}
              onChange={(e) => saveAnswer(currentQuestion.id, e.target.value)}
              placeholder="Type your answer here..." readOnly={isReviewMode}
              rows={6}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none resize-none"
            />
          )}

          {/* Show answer toggle */}
                    <div className="mt-6 pt-4 border-t">
            <button
              onClick={() => setShowAnswer(!showAnswer)}
              className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
            >
              {showAnswer ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              {showAnswer ? 'Hide Answer' : 'Show Model Answer'}
            </button>
            {showAnswer && (
              <div className="mt-3 p-4 bg-blue-50 rounded-lg">
                <p className="text-gray-700">{currentQuestion.modelAnswer}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
          disabled={currentIndex === 0}
          className="flex items-center gap-2 px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
        >
          <ChevronLeft className="w-5 h-5" />
          Previous
        </button>

        <div className="flex items-center gap-2">
          <button
            onClick={() => toggleFlag(currentQuestion?.id || '')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg ${
              answers.get(currentQuestion?.id || '')?.flagged
                ? 'bg-yellow-100 text-yellow-700'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            <Flag className="w-5 h-5" />
            Flag
          </button>
        </div>

        {currentIndex === quizQuestions.length - 1 ? (
          <button
            onClick={finishQuiz}
            className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700"
          >
            "Finish Quiz"
            <Check className="w-5 h-5" />
          </button>
        ) : (
          <button
            onClick={() => setCurrentIndex((prev) => Math.min(quizQuestions.length - 1, prev + 1))}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Next
            <ChevronRight className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Question dots */}
      <div className="flex flex-wrap justify-center gap-2 mt-6">
        {quizQuestions.map((q, idx) => {
          const answer = answers.get(q.id);
          return (
            <button
              key={q.id}
              onClick={() => setCurrentIndex(idx)}
              className={`w-8 h-8 rounded-full text-sm font-medium transition-colors ${
                currentIndex === idx
                  ? 'bg-blue-600 text-white'
                  : answer?.flagged
                  ? 'bg-yellow-400 text-white'
                  : answer?.answer
                  ? 'bg-green-100 text-green-700 border border-green-300'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {idx + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default Quiz;
