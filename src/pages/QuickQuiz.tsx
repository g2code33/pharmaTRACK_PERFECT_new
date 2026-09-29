import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, ExternalLink, Home, Loader2, RotateCcw, Share2, Trophy, X } from 'lucide-react';
import type { ExamQuestion } from '../types';
import { decodeQuickQuizPack, fetchQuickQuizPackByCode, shareQuickQuizPack, type QuickQuizPack } from '../utils/quickQuizShare';
import { gradeAnswer } from '../utils/questionBank';
import type { SharedQuestion } from '../utils/questionShare';

const toQuestion = (q: SharedQuestion, index: number): ExamQuestion => ({
  id: `quick-${index}`,
  courseId: 'shared-quick-quiz',
  topicId: 'shared-quick-quiz',
  semester: q.semester,
  questionText: q.questionText,
  questionType: q.questionType,
  marksAllocation: 1,
  difficulty: q.difficulty,
  probability: 'medium',
  modelAnswer: q.explanation || q.correctAnswer || '',
  explanation: q.explanation,
  correctAnswer: q.correctAnswer,
  source: { origin: 'imported', label: 'Quick quiz link' },
  tags: ['shared', 'quick-quiz', ...(q.tags || [])],
  isPracticed: false,
  needsReview: false,
  isSaved: false,
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

type PackState = { loading: boolean; pack?: QuickQuizPack; questions: ExamQuestion[]; error?: string };

const QuickQuiz: React.FC = () => {
  const [params] = useSearchParams();
  const paramsKey = params.toString();
  const [packResult, setPackResult] = useState<PackState>({ loading: true, questions: [] });
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [showAnswer, setShowAnswer] = useState(false);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setPackResult({ loading: true, questions: [] });
      setAnswers({});
      setCurrentIndex(0);
      setShowAnswer(false);
      setFinished(false);
      try {
        const currentParams = new URLSearchParams(paramsKey);
        const code = currentParams.get('c');
        const inline = currentParams.get('p') || currentParams.get('pack');
        let pack: QuickQuizPack;
        if (code) {
          pack = await fetchQuickQuizPackByCode(code);
        } else if (inline) {
          pack = decodeQuickQuizPack(inline);
        } else {
          throw new Error('No quick quiz was found in this link.');
        }
        if (!cancelled) setPackResult({ loading: false, pack, questions: pack.questions.map(toQuestion) });
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

  const saveAnswer = (id: string, answer: string) => setAnswers((prev) => ({ ...prev, [id]: answer }));
  const reset = () => {
    setAnswers({});
    setCurrentIndex(0);
    setShowAnswer(false);
    setFinished(false);
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

  if (packResult.loading) {
    return (
      <div className="min-h-[100dvh] bg-slate-950 text-white safe-area-x pt-safe pb-safe flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-3xl bg-white/10 p-6 text-center shadow-2xl backdrop-blur">
          <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-emerald-300" />
          <h1 className="text-2xl font-black mb-2">Opening quick quiz…</h1>
          <p className="text-slate-300">Loading the shared questions.</p>
        </div>
      </div>
    );
  }

  if (packResult.error || !packResult.pack) {
    return (
      <div className="min-h-[100dvh] bg-slate-950 text-white safe-area-x pt-safe pb-safe flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-3xl bg-white text-slate-900 p-6 shadow-2xl">
          <AlertTriangle className="w-12 h-12 text-amber-500 mb-4" />
          <h1 className="text-2xl font-black mb-2">Quick quiz could not open</h1>
          <p className="text-slate-600 mb-5">{packResult.error}</p>
          <Link to="/" className="inline-flex items-center gap-2 rounded-xl bg-[#2D6A4F] px-4 py-3 font-bold text-white">
            <Home className="w-4 h-4" /> Open PharmaTRACK
          </Link>
        </div>
      </div>
    );
  }

  if (finished) {
    return (
      <div className="min-h-[100dvh] bg-slate-100 safe-area-x pt-safe pb-safe p-4">
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="rounded-[2rem] bg-gradient-to-br from-[#0F172A] to-[#2D6A4F] p-6 text-white shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="h-14 w-14 rounded-2xl bg-white/15 flex items-center justify-center"><Trophy className="w-8 h-8 text-yellow-300" /></div>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.2em] text-emerald-200">Quick quiz complete</p>
                <h1 className="text-2xl sm:text-3xl font-black">{packResult.pack.title}</h1>
              </div>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-3 gap-2 text-center">
              <div className="rounded-2xl bg-white/10 p-3"><p className="text-3xl font-black">{score.percent}%</p><p className="text-xs text-white/70">Score</p></div>
              <div className="rounded-2xl bg-white/10 p-3"><p className="text-3xl font-black">{score.correct}</p><p className="text-xs text-white/70">Correct</p></div>
              <div className="rounded-2xl bg-white/10 p-3"><p className="text-3xl font-black">{score.total}</p><p className="text-xs text-white/70">Questions</p></div>
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
    <div className="min-h-[100dvh] bg-slate-100 safe-area-x pt-safe pb-safe p-3 sm:p-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="rounded-[1.75rem] bg-[#0F172A] p-4 sm:p-5 text-white shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-300">PharmaTRACK Quick Quiz</p>
              <h1 className="text-xl sm:text-2xl font-black mt-1">{packResult.pack.title}</h1>
              <p className="text-xs text-slate-300 mt-1">
                {packResult.pack.course?.code || packResult.pack.course?.name || 'Shared quiz'}{packResult.pack.topic?.name ? ` · ${packResult.pack.topic.name}` : ''}
              </p>
            </div>
            <Link to="/" className="shrink-0 rounded-2xl bg-white/10 p-3 text-white"><Home className="w-5 h-5" /></Link>
          </div>
          <div className="mt-4 h-2 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full rounded-full bg-emerald-400" style={{ width: `${((currentIndex + 1) / packResult.questions.length) * 100}%` }} />
          </div>
          <p className="mt-2 text-xs font-bold text-slate-300">Question {currentIndex + 1} of {packResult.questions.length}</p>
        </div>

        {current && (
          <div className="rounded-[1.75rem] bg-white p-5 sm:p-7 shadow-sm border border-slate-200">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-purple-100 px-3 py-1 text-xs font-black uppercase text-purple-700">{current.questionType.replace('_', ' ')}</span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black uppercase text-slate-600">{current.difficulty}</span>
            </div>
            <h2 className="text-lg sm:text-xl font-black text-slate-900 leading-relaxed">{current.questionText}</h2>

            {current.questionType === 'mcq' && current.options?.length ? (
              <div className="mt-5 space-y-3">
                {current.options.map((opt, idx) => {
                  const selected = answers[current.id] === String(idx);
                  return (
                    <button
                      key={idx}
                      onClick={() => saveAnswer(current.id, String(idx))}
                      className={`w-full rounded-2xl border-2 p-4 text-left touch-manipulation transition-all ${selected ? 'border-[#2D6A4F] bg-emerald-50 text-emerald-950 shadow-sm' : 'border-slate-200 bg-white text-slate-800 active:scale-[0.99]'}`}
                    >
                      <span className={`mr-3 inline-flex h-8 w-8 items-center justify-center rounded-full font-black ${selected ? 'bg-[#2D6A4F] text-white' : 'bg-slate-100 text-slate-500'}`}>{String.fromCharCode(65 + idx)}</span>
                      {opt}
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

        <div className="grid grid-cols-3 sm:grid-cols-3 gap-2">
          <button
            onClick={() => { setCurrentIndex((idx) => Math.max(0, idx - 1)); setShowAnswer(false); }}
            disabled={currentIndex === 0}
            className="rounded-2xl bg-white px-3 py-3 font-black text-slate-700 shadow-sm disabled:opacity-40 flex items-center justify-center gap-1"
          >
            <ChevronLeft className="w-5 h-5" /> Prev
          </button>
          <button onClick={() => setFinished(true)} className="rounded-2xl bg-emerald-600 px-3 py-3 font-black text-white shadow-sm">
            Finish
          </button>
          <button
            onClick={() => { setCurrentIndex((idx) => Math.min(packResult.questions.length - 1, idx + 1)); setShowAnswer(false); }}
            disabled={currentIndex === packResult.questions.length - 1}
            className="rounded-2xl bg-blue-600 px-3 py-3 font-black text-white shadow-sm disabled:opacity-40 flex items-center justify-center gap-1"
          >
            Next <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          {packResult.questions.map((q, idx) => (
            <button
              key={q.id}
              onClick={() => { setCurrentIndex(idx); setShowAnswer(false); }}
              className={`h-9 w-9 rounded-full text-sm font-black ${idx === currentIndex ? 'bg-[#2D6A4F] text-white' : answers[q.id] ? 'bg-emerald-100 text-emerald-700' : 'bg-white text-slate-500 border border-slate-200'}`}
            >
              {idx + 1}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default QuickQuiz;
