import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock3, LockKeyhole, Send } from 'lucide-react';
import { ExaminationRepository } from '../examination/service';
import type { ExamQuestionSnapshot, StudentAttempt } from '../examination/types';

function answerCorrect(question: ExamQuestionSnapshot, answer: string): boolean {
  if (question.questionType === 'mcq') return Number(answer) === question.correctOption;
  return (
    Boolean(answer.trim()) &&
    (question.correctAnswer
      ? answer.trim().toLowerCase() === question.correctAnswer.trim().toLowerCase()
      : true)
  );
}

const SecureExamination: React.FC = () => {
  const { attemptId } = useParams<{ attemptId: string }>();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState<StudentAttempt | null>(null);
  const [questions, setQuestions] = useState<Record<string, ExamQuestionSnapshot>>({});
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [seconds, setSeconds] = useState(0);
  const [message, setMessage] = useState('Loading encrypted attempt…');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const repository = await ExaminationRepository.open();
      const saved = repository.snapshot.attempts.find((item) => item.id === attemptId);
      if (!saved) {
        setMessage('This attempt could not be recovered safely.');
        return;
      }
      const version = repository.snapshot.versions.find((item) => item.id === saved.examVersionId);
      if (!version) {
        setMessage('The immutable examination version is unavailable.');
        return;
      }
      if (cancelled) return;
      setAttempt(saved);
      setAnswers(
        Object.fromEntries(saved.answers.map((answer) => [answer.questionId, answer.answer])),
      );
      setQuestions(
        Object.fromEntries(version.questions.map((question) => [question.id, question])),
      );
      setMessage('');
      setSeconds(
        Math.max(0, Math.floor((new Date(saved.deadlineAt).getTime() - Date.now()) / 1000)),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [attemptId]);

  useEffect(() => {
    if (!attempt || submitted || attempt.status !== 'ACTIVE') return;
    const timer = window.setInterval(
      () =>
        setSeconds(
          Math.max(0, Math.floor((new Date(attempt.deadlineAt).getTime() - Date.now()) / 1000)),
        ),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [attempt, submitted]);

  useEffect(() => {
    if (!attempt || submitted) return;
    const onBlur = () => {
      void ExaminationRepository.open().then((repository) =>
        repository.logSecurityEvent({
          attemptId: attempt.id,
          sessionId: attempt.sessionId,
          studentId: attempt.studentId,
          deviceSessionId: attempt.deviceSessionId,
          type: 'FOCUS_LOST',
          severity: 'warning',
          details: 'Window focus was lost during the secure examination.',
        }),
      );
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [attempt, submitted]);

  const ordered = useMemo(
    () => attempt?.questionOrder.map((id) => questions[id]).filter(Boolean) || [],
    [attempt, questions],
  );
  const current = ordered[index];
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = String(seconds % 60).padStart(2, '0');

  const saveAnswer = async (value: string) => {
    if (!attempt || !current) return;
    setAnswers((existing) => ({ ...existing, [current.id]: value }));
    const repository = await ExaminationRepository.open();
    await repository.recordAnswer(attempt.id, {
      questionId: current.id,
      answer: value,
      selectedOption: current.questionType === 'mcq' ? Number(value) : undefined,
      deviceSessionId: attempt.deviceSessionId,
      isFinal: false,
    });
  };

  const submit = async () => {
    if (!attempt) return;
    const repository = await ExaminationRepository.open();
    await repository.submitAttempt(attempt.id);
    await repository.logSecurityEvent({
      attemptId: attempt.id,
      sessionId: attempt.sessionId,
      studentId: attempt.studentId,
      deviceSessionId: attempt.deviceSessionId,
      type: 'SUBMITTED',
      severity: 'info',
      details: 'Student submitted the examination.',
    });
    setSubmitted(true);
  };

  if (message)
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <div className="max-w-lg text-center">
          <LockKeyhole className="w-12 h-12 mx-auto mb-4 text-emerald-400" />
          <h1 className="text-2xl font-black">Secure examination</h1>
          <p className="mt-3 text-white/75">{message}</p>
        </div>
      </div>
    );
  if (!attempt || !current) return null;

  if (submitted)
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
        <div className="max-w-lg text-center">
          <CheckCircle2 className="w-16 h-16 mx-auto mb-4 text-emerald-400" />
          <h1 className="text-3xl font-black">Examination submitted</h1>
          <p className="mt-3 text-white/75">
            Your attempt is stored locally and marked submitted. An authorized LAN authority can
            reconcile it when connected.
          </p>
          <button
            type="button"
            onClick={() => navigate('/quiz')}
            className="mt-6 px-5 py-3 bg-emerald-500 text-slate-950 rounded-xl font-black"
          >
            Return to Quiz
          </button>
        </div>
      </div>
    );

  return (
    <div className="min-h-screen bg-slate-950 text-white p-3 sm:p-6">
      <header className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
        <div>
          <p className="text-xs uppercase tracking-widest text-emerald-300 font-black">
            KIOSK EXAMINATION
          </p>
          <h1 className="text-xl sm:text-2xl font-black">
            {current.questionText ? 'Secure Examination' : 'Examination'}
          </h1>
          <p className="text-xs text-white/50">
            Attempt timer belongs to this attempt, not this device.
          </p>
        </div>
        <div
          className={`flex items-center gap-2 rounded-xl px-4 py-2 font-black ${seconds < 300 ? 'bg-red-500/20 text-red-300' : 'bg-white/10'}`}
        >
          <Clock3 className="w-5 h-5" />
          {minutes}:{remainingSeconds}
        </div>
      </header>
      <main className="max-w-6xl mx-auto grid lg:grid-cols-[1fr_240px] gap-5 mt-5">
        <section className="rounded-2xl bg-white text-slate-900 p-5 sm:p-8">
          <div className="flex items-center justify-between gap-3 text-sm text-slate-500 mb-6">
            <span>
              Question {index + 1} of {ordered.length}
            </span>
            <span>{current.marks} mark(s)</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold leading-relaxed">{current.questionText}</h2>
          {current.questionType === 'mcq' && (
            <div className="mt-6 space-y-3">
              {(
                attempt.optionOrders[current.id] ||
                current.options?.map((_, optionIndex) => optionIndex) ||
                []
              ).map((optionIndex) => (
                <label
                  key={optionIndex}
                  className={`flex gap-3 items-start rounded-xl border p-4 cursor-pointer ${answers[current.id] === String(optionIndex) ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 hover:bg-slate-50'}`}
                >
                  <input
                    type="radio"
                    name={current.id}
                    checked={answers[current.id] === String(optionIndex)}
                    onChange={() => void saveAnswer(String(optionIndex))}
                    className="mt-1"
                  />
                  <span>{current.options?.[optionIndex]}</span>
                </label>
              ))}
            </div>
          )}
          {current.questionType !== 'mcq' && (
            <textarea
              value={answers[current.id] || ''}
              onChange={(event) => void saveAnswer(event.target.value)}
              className="mt-6 w-full min-h-48 rounded-xl border border-slate-300 p-4"
              placeholder="Enter your answer…"
            />
          )}
          <div className="flex flex-wrap justify-between gap-3 mt-8">
            <button
              type="button"
              disabled={index === 0 || !attempt.settingsSnapshot.navigation.allowPrevious}
              onClick={() => setIndex((value) => value - 1)}
              className="rounded-lg border px-4 py-2 font-bold disabled:opacity-30"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={index === ordered.length - 1}
              onClick={() => setIndex((value) => value + 1)}
              className="rounded-lg bg-slate-900 text-white px-4 py-2 font-bold disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </section>
        <aside className="rounded-2xl bg-white/10 border border-white/10 p-4 h-fit">
          <h2 className="font-black mb-3">Questions</h2>
          <div className="grid grid-cols-5 sm:grid-cols-8 lg:grid-cols-4 gap-2">
            {ordered.map((question, questionIndex) => (
              <button
                type="button"
                key={question.id}
                onClick={() => setIndex(questionIndex)}
                className={`rounded-lg p-2 text-sm font-black ${questionIndex === index ? 'bg-emerald-400 text-slate-950' : answers[question.id] ? 'bg-emerald-900 text-emerald-200' : 'bg-white/10 text-white'}`}
              >
                {questionIndex + 1}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Submit this attempt? You may not return after submission.'))
                void submit();
            }}
            className="mt-5 w-full rounded-xl bg-amber-400 text-slate-950 py-3 font-black flex items-center justify-center gap-2"
          >
            <Send className="w-4 h-4" /> Submit attempt
          </button>
          <p className="text-xs text-white/50 mt-3 flex gap-1">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            Focus-loss events are recorded for the examination authority.
          </p>
        </aside>
      </main>
    </div>
  );
};

export default SecureExamination;
