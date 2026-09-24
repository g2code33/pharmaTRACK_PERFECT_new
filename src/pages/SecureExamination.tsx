import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  LockKeyhole,
  Save,
  Send,
  WifiOff,
} from 'lucide-react';
import { ExaminationRepository } from '../examination/service';
import { LanExamClient, LocalExamAuthority } from '../examination/network';
import { ExaminationSyncEngine } from '../examination/sync';
import { remainingMilliseconds } from '../examination/timer';
import { createPlatformKioskAdapter } from '../examination/androidAdapter';
import type { KioskAdapter } from '../examination/kioskAdapter';
import type { ExamQuestionSnapshot, StudentAttempt } from '../examination/types';

const SecureExamination: React.FC = () => {
  const { attemptId } = useParams<{ attemptId: string }>();
  const navigate = useNavigate();
  const [repository, setRepository] = useState<ExaminationRepository | null>(null);
  const [attempt, setAttempt] = useState<StudentAttempt | null>(null);
  const [questions, setQuestions] = useState<Record<string, ExamQuestionSnapshot>>({});
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [savedQuestions, setSavedQuestions] = useState<Set<string>>(new Set());
  const [seconds, setSeconds] = useState(0);
  const [message, setMessage] = useState('Loading encrypted attempt…');
  const [submitted, setSubmitted] = useState(false);
  const [saveState, setSaveState] = useState<'SAVED' | 'SAVING…' | 'Save problem — retrying'>(
    'SAVED',
  );
  const [syncState, setSyncState] = useState<'SYNCHRONIZED' | 'DEGRADED' | 'RECOVERY_PENDING'>(
    'SYNCHRONIZED',
  );
  const [navigationBusy, setNavigationBusy] = useState(false);
  const adapterRef = useRef<KioskAdapter | null>(null);
  const cleanupKioskRef = useRef<(() => void) | null>(null);
  const syncRef = useRef<ExaminationSyncEngine | null>(null);
  const autosaveRef = useRef(false);
  const saveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const authorityClockRef = useRef<{
    serverMilliseconds: number;
    performanceMilliseconds: number;
  } | null>(null);
  const setAuthorityClock = (serverAt: string) => {
    authorityClockRef.current = {
      serverMilliseconds: new Date(serverAt).getTime(),
      performanceMilliseconds: typeof performance === 'undefined' ? Date.now() : performance.now(),
    };
  };
  const authorityNow = () => {
    const clock = authorityClockRef.current;
    const elapsed = clock
      ? (typeof performance === 'undefined' ? Date.now() : performance.now()) -
        clock.performanceMilliseconds
      : 0;
    return clock ? clock.serverMilliseconds + elapsed : Date.now();
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const opened = await ExaminationRepository.open();
      const saved = opened.snapshot.attempts.find((item) => item.id === attemptId);
      if (!saved) {
        setMessage('This attempt could not be recovered safely.');
        return;
      }
      const version = opened.snapshot.versions.find((item) => item.id === saved.examVersionId);
      if (!version) {
        setMessage('The immutable examination version is unavailable.');
        return;
      }
      if (saved.status === 'LOCKED') {
        setMessage('This attempt is locked. An authorized administrator must unlock it.');
        return;
      }
      if (cancelled) return;
      setRepository(opened);
      setAttempt(saved);
      setAnswers(
        Object.fromEntries(saved.answers.map((answer) => [answer.questionId, answer.answer])),
      );
      setSavedQuestions(new Set(saved.answers.map((answer) => answer.questionId)));
      setQuestions(
        Object.fromEntries(version.questions.map((question) => [question.id, question])),
      );
      setMessage('');
      const session = opened.snapshot.sessions.find((item) => item.id === saved.sessionId);
      let authorityNowAt = new Date().toISOString();
      try {
        const health = session?.authorityEndpoint
          ? await new LanExamClient(session.authorityEndpoint).health()
          : await new LocalExamAuthority(opened).health();
        authorityNowAt = health.serverNowAt || health.checkedAt;
      } catch {
        /* encrypted local timer remains available while LAN reconnects */
      }
      setAuthorityClock(authorityNowAt);
      const timer = await opened.getAttemptTimer(saved.id, authorityNowAt);
      setAttempt({ ...saved, timerState: timer.timer });
      setSeconds(Math.ceil(timer.remainingMilliseconds / 1000));
      const authority = new LocalExamAuthority(opened);
      syncRef.current = new ExaminationSyncEngine(opened, authority, saved.sessionId);
      const adapter = await createPlatformKioskAdapter((violation) => {
        void opened
          .recordSecurityViolation(saved.id, violation.violation, violation.detail)
          .then((result) => {
            if (
              result.policy === 'LOCK_TEMPORARILY' ||
              result.policy === 'REQUIRE_ADMIN_UNLOCK' ||
              result.policy === 'TERMINATE_ATTEMPT' ||
              result.policy === 'FORCE_SUBMIT'
            )
              setAttempt(result.attempt);
          });
      }, version.security.requiredCapabilities || []);
      adapterRef.current = adapter;
      cleanupKioskRef.current = adapter.install();
      void adapter.requestFullscreen();
    })();
    return () => {
      cancelled = true;
      cleanupKioskRef.current?.();
      cleanupKioskRef.current = null;
    };
  }, [attemptId]);

  useEffect(() => {
    if (!repository || !attempt || submitted) return;
    const timer = window.setInterval(() => {
      const deadline = attempt.timerState?.authoritativeDeadlineAt || attempt.deadlineAt;
      const remaining = attempt.timerState
        ? remainingMilliseconds(attempt.timerState, new Date(authorityNow()).toISOString())
        : Math.max(0, new Date(deadline).getTime() - authorityNow());
      setSeconds(Math.ceil(remaining / 1000));
      if (remaining <= 0 && attempt.status === 'ACTIVE') {
        void repository.submitAttempt(attempt.id, true).then((closed) => {
          setAttempt(closed);
          setSubmitted(true);
        });
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [repository, attempt, submitted]);

  useEffect(() => {
    if (!repository || !attempt || submitted) return;
    const refreshAuthorityClock = async () => {
      const session = repository.snapshot.sessions.find((item) => item.id === attempt.sessionId);
      try {
        const health = session?.authorityEndpoint
          ? await new LanExamClient(session.authorityEndpoint).health()
          : await new LocalExamAuthority(repository).health();
        setAuthorityClock(health.serverNowAt || health.checkedAt);
        const latest = repository.snapshot.attempts.find((item) => item.id === attempt.id);
        if (latest) setAttempt(latest);
      } catch {
        void repository.markSynchronizationUnavailable(
          attempt.sessionId,
          'Authority clock unavailable; local encrypted state remains active.',
        );
      }
    };
    const timer = window.setInterval(() => void refreshAuthorityClock(), 5000);
    return () => window.clearInterval(timer);
  }, [repository, attempt, submitted]);

  useEffect(() => {
    if (!syncRef.current || submitted) return;
    const timer = window.setInterval(() => {
      void syncRef.current?.flush().then((result) => {
        setSyncState(result.state);
      });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [submitted]);

  useEffect(() => {
    if (!repository || !attempt || submitted || autosaveRef.current) return;
    const timer = window.setInterval(() => {
      if (
        !autosaveRef.current &&
        currentQuestionRef.current &&
        answersRef.current[currentQuestionRef.current.id] !== undefined
      ) {
        void persistAnswer(
          currentQuestionRef.current.id,
          answersRef.current[currentQuestionRef.current.id],
        );
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [repository, attempt, submitted]);

  const ordered = useMemo(
    () => attempt?.questionOrder.map((id) => questions[id]).filter(Boolean) || [],
    [attempt, questions],
  );
  const current = ordered[index];
  const currentQuestionRef = useRef<ExamQuestionSnapshot | undefined>(undefined);
  const answersRef = useRef<Record<string, string>>({});
  currentQuestionRef.current = current;
  answersRef.current = answers;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = String(seconds % 60).padStart(2, '0');

  const persistAnswer = (questionId: string, value: string): Promise<boolean> => {
    const operation = saveQueueRef.current.then(async () => {
      if (!repository || !attempt) return false;
      setSaveState('SAVING…');
      try {
        await repository.recordAnswer(attempt.id, {
          questionId,
          answer: value,
          selectedOption: questions[questionId]?.questionType === 'mcq' ? Number(value) : undefined,
          deviceSessionId: attempt.deviceSessionId,
          isFinal: false,
        });
        setSavedQuestions((existing) => new Set(existing).add(questionId));
        setSaveState('SAVED');
        setAttempt(repository.snapshot.attempts.find((item) => item.id === attempt.id) || attempt);
        void syncRef.current?.flush();
        return true;
      } catch (error) {
        setSaveState('Save problem — retrying');
        void repository.recordSecurityViolation(
          attempt.id,
          'SUSPICIOUS_STATE_TRANSITION',
          error instanceof Error ? error.message : 'Local answer persistence failed.',
        );
        return false;
      }
    });
    saveQueueRef.current = operation.catch(() => false);
    return operation;
  };

  const saveCurrentBeforeNavigation = async (): Promise<boolean> => {
    if (!current) return true;
    return persistAnswer(current.id, answers[current.id] || '');
  };

  const goTo = async (nextIndex: number) => {
    if (!attempt || !current || navigationBusy || nextIndex < 0 || nextIndex >= ordered.length)
      return;
    setNavigationBusy(true);
    const persisted = await saveCurrentBeforeNavigation();
    if (persisted && repository) {
      try {
        await repository.updateCurrentQuestion(attempt.id, ordered[nextIndex].id);
        setIndex(nextIndex);
      } catch {
        setSaveState('Save problem — retrying');
      }
    }
    setNavigationBusy(false);
  };

  const submit = async () => {
    if (!repository || !attempt || navigationBusy) return;
    setNavigationBusy(true);
    const persisted = await saveCurrentBeforeNavigation();
    if (!persisted) {
      setNavigationBusy(false);
      return;
    }
    await syncRef.current?.flush();
    const closed = await repository.submitAttempt(attempt.id, false, attempt.deviceSessionId);
    await repository.logSecurityEvent({
      attemptId: closed.id,
      sessionId: closed.sessionId,
      studentId: closed.studentId,
      deviceSessionId: closed.deviceSessionId,
      type: 'SUBMITTED',
      severity: 'info',
      details: 'Student submitted after local save confirmation.',
    });
    setAttempt(closed);
    setSubmitted(true);
    setNavigationBusy(false);
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
            KIOSK EXAMINATION · {adapterRef.current?.matrix.platform || 'SECURE MODE'}
          </p>
          <h1 className="text-xl sm:text-2xl font-black">Secure Examination</h1>
          <p className="text-xs text-white/50">
            Timer is authoritative to the examination authority, not this device.
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
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500 mb-6">
            <span>
              Question {index + 1} of {ordered.length}
            </span>
            <span className="inline-flex items-center gap-1">
              <Save className="w-4 h-4" />
              {saveState}
            </span>
            <span>
              {syncState === 'SYNCHRONIZED' ? (
                'Synchronized'
              ) : (
                <>
                  <WifiOff className="w-4 h-4 inline" /> {syncState}
                </>
              )}
            </span>
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
                    onChange={() => {
                      setAnswers((existing) => ({
                        ...existing,
                        [current.id]: String(optionIndex),
                      }));
                      void persistAnswer(current.id, String(optionIndex));
                    }}
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
              onChange={(event) => {
                setAnswers((existing) => ({ ...existing, [current.id]: event.target.value }));
                void persistAnswer(current.id, event.target.value);
              }}
              className="mt-6 w-full min-h-48 rounded-xl border border-slate-300 p-4"
              placeholder="Enter your answer…"
            />
          )}
          <div className="flex flex-wrap justify-between gap-3 mt-8">
            <button
              type="button"
              disabled={
                index === 0 ||
                navigationBusy ||
                attempt.settingsSnapshot.navigation.allowPrevious === false
              }
              onClick={() => void goTo(index - 1)}
              className="rounded-lg border px-4 py-2 font-bold disabled:opacity-30"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={index === ordered.length - 1 || navigationBusy}
              onClick={() => void goTo(index + 1)}
              className="rounded-lg bg-slate-900 text-white px-4 py-2 font-bold disabled:opacity-30"
            >
              {navigationBusy ? 'Saving…' : 'Next'}
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
                onClick={() => void goTo(questionIndex)}
                disabled={navigationBusy}
                className={`rounded-lg p-2 text-sm font-black disabled:opacity-50 ${questionIndex === index ? 'bg-emerald-400 text-slate-950' : answers[question.id] ? 'bg-emerald-900 text-emerald-200' : 'bg-white/10 text-white'}`}
              >
                {questionIndex + 1}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={navigationBusy}
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
            Focus, copy/paste, print, external-link, and exit policy events are audited. A network
            loss is not automatically cheating.
          </p>
        </aside>
      </main>
    </div>
  );
};

export default SecureExamination;
