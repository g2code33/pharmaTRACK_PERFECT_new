import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  LockKeyhole,
  Save,
  Send,
  WifiOff,
} from 'lucide-react';
import { ExaminationRepository } from '../examination/service';
import { examinationResultToQuizHistory } from '../examination/results';
import { LanExamClient, LocalExamAuthority } from '../examination/network';
import { ExaminationSyncEngine } from '../examination/sync';
import type { LanExamTransport } from '../examination/network';
import { remainingMilliseconds } from '../examination/timer';
import { createPlatformKioskAdapter } from '../examination/androidAdapter';
import { verifyAdminExitPassword } from '../examination/package';
import { loadStagedPharmaExam } from '../examination/packageCache';
import type { KioskAdapter } from '../examination/kioskAdapter';
import type { ExamQuestionSnapshot, StudentAttempt } from '../examination/types';
import {
  enterSecureKiosk,
  markSecureKioskSubmitting,
  onBlockedKioskNavigation,
  releaseSecureKiosk,
} from '../examination/kioskState';

const SecureExamination: React.FC = () => {
  const { attemptId } = useParams<{ attemptId: string }>();
  const navigate = useNavigate();
  const { state: appState, dispatch } = useApp();
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
  const [fullscreenActive, setFullscreenActive] = useState(true);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const adapterRef = useRef<KioskAdapter | null>(null);
  const cleanupKioskRef = useRef<(() => void) | null>(null);
  const blockedNavigationCleanupRef = useRef<(() => void) | null>(null);
  const syncRef = useRef<ExaminationSyncEngine | null>(null);
  const authorityRef = useRef<LanExamTransport | null>(null);
  const autosaveRef = useRef(false);
  const finalizingRef = useRef(false);
  const finalizeSubmissionRef = useRef<
    ((forced: boolean, trigger: 'MANUAL' | 'EXPIRY') => Promise<void>) | null
  >(null);
  const submittedRef = useRef(false);
  submittedRef.current = submitted;
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
  const appendQuizHistoryResult = (closed: StudentAttempt) => {
    if (!repository) return;
    const result = repository.getExaminationResult(closed.id);
    const version = repository.snapshot.versions.find((item) => item.id === closed.examVersionId);
    if (
      !result ||
      !version ||
      appState.quizHistory.some((item) => item.examinationResultId === result.id)
    )
      return;
    dispatch({
      type: 'ADD_QUIZ_HISTORY',
      payload: examinationResultToQuizHistory(result, version),
    });
  };

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const checkFullscreen = () => {
      setFullscreenActive(Boolean(document.fullscreenElement));
    };
    checkFullscreen();
    document.addEventListener('fullscreenchange', checkFullscreen);
    document.addEventListener('webkitfullscreenchange', checkFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', checkFullscreen);
      document.removeEventListener('webkitfullscreenchange', checkFullscreen);
    };
  }, []);

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
      if (saved.status === 'SUBMITTED' || saved.status === 'KIOSK_RELEASED' || saved.status === 'CLOSED') {
        setSubmitted(true);
        return;
      }
      if (saved.status === 'SUBMITTING') {
        const resumed = await opened.submitAttempt(
          saved.id,
          true,
          saved.deviceSessionId,
          saved.submissionTrigger || 'RECOVERY',
        );
        setAttempt(resumed);
        setSubmitted(true);
        return;
      }
      const session = opened.snapshot.sessions.find((item) => item.id === saved.sessionId);
      const authority = session?.authorityEndpoint
        ? new LanExamClient(session.authorityEndpoint, fetch, {
            token: session.authorityAccessToken,
            deviceSessionId: saved.deviceSessionId,
            studentId: saved.studentId,
          })
        : new LocalExamAuthority(opened);
      let authorityNowAt = new Date().toISOString();
      try {
        const health = await authority.health();
        authorityNowAt = health.serverNowAt || health.checkedAt;
      } catch {
        /* encrypted local timer remains available while LAN reconnects */
      }
      setAuthorityClock(authorityNowAt);
      authorityRef.current = authority;
      const timer = await opened.getAttemptTimer(saved.id, authorityNowAt);
      setAttempt({ ...saved, timerState: timer.timer });
      setSeconds(Math.ceil(timer.remainingMilliseconds / 1000));
      syncRef.current = new ExaminationSyncEngine(opened, authority, saved.sessionId);
      const blockedRoutes = [
        ...(version.security.disableAI ? ['/ai'] : []),
        ...(version.security.disableNotes ? ['/notes'] : []),
        ...(version.security.disableMaterials ? ['/materials', '/library', '/archive', '/read'] : []),
      ];
      enterSecureKiosk(
        saved.id,
        Boolean(version.security.fullLockdown ?? version.security.lockdown),
        blockedRoutes,
      );
      blockedNavigationCleanupRef.current = onBlockedKioskNavigation((path) => {
        void opened.logSecurityEvent({
          attemptId: saved.id,
          sessionId: saved.sessionId,
          studentId: saved.studentId,
          deviceSessionId: saved.deviceSessionId,
          type: 'NAVIGATION_BLOCKED',
          severity: 'warning',
          details: `Central secure-exam route gate blocked navigation to ${path}.`,
        });
      });
      const adapter = await createPlatformKioskAdapter((violation) => {
        if (violation.violation === 'ATTEMPTED_EXIT') {
          void opened.requestManualEarlyExit(saved.id).then(async (policy) => {
            if (policy === 'DISALLOW_EARLY_EXIT') {
              setMessage('Early exit is disabled for this examination. Use SUBMIT EXAM or wait for expiry.');
              return;
            }
            let authorized = policy === 'ALLOW_FREE_EXIT';
            if (policy === 'ADMIN_AUTH_REQUIRED') {
              const supplied = window.prompt('Enter the separate examination administrator exit authorization.');
              const stagedPackage = await loadStagedPharmaExam();
              authorized = Boolean(
                supplied && stagedPackage && (await verifyAdminExitPassword(supplied, stagedPackage.security)),
              );
            }
            if (!authorized) {
              setMessage('Separate examination administrator authorization was rejected. RX30 cannot authorize early exit.');
              return;
            }
            try {
              const closed = await opened.authorizeManualEarlyExit(
                saved.id,
                true,
                'package-admin-password',
                undefined,
                'PACKAGE_ADMIN_PASSWORD',
                false,
              );
              setAttempt(closed);
              await finalizeSubmissionRef.current?.(true, 'MANUAL');
            } catch (error) {
              setMessage(error instanceof Error ? error.message : 'Administrator early-exit authorization failed.');
            }
          });
          return;
        }
        void opened
          .recordSecurityViolation(saved.id, violation.violation, violation.detail)
          .then((result) => {
            if (
              result.policy === 'LOCK_TEMPORARILY' ||
              result.policy === 'REQUIRE_ADMIN_UNLOCK' ||
              result.policy === 'TERMINATE_ATTEMPT' ||
              result.policy === 'FORCE_SUBMIT' ||
              result.policy === 'LOCK' ||
              result.policy === 'ADMIN_INTERVENTION'
            ) {
              setAttempt(result.attempt);
              if (result.policy === 'FORCE_SUBMIT') {
                setSubmitted(true);
              }
            } else if (result.policy === 'WARN' || result.policy === 'WARNING') {
              setAttempt(result.attempt);
            }
          });
      }, version.security.requiredCapabilities || [], {
        navigation: version.security.disableNavigation !== false,
        copyPaste: version.security.disableCopyPaste !== false,
        printing: version.security.disablePrinting !== false,
        externalLinks: version.security.disableExternalLinks !== false,
        developerTools: version.security.disableDeveloperTools !== false,
        exit: version.security.restrictExit !== false,
        focus: version.security.detectFocusLoss !== false,
      });
      adapterRef.current = adapter;
      cleanupKioskRef.current = adapter.install();
      // The browser adapter is deliberately still installed in a native build:
      // native window controls and browser event prevention cover different
      // boundaries. Native entry is capability-based and session-scoped.
      if (adapter.enterSecureMode) {
        const entered = await adapter.enterSecureMode(saved.id);
        if (!entered) {
          await opened.recordSecurityViolation(
            saved.id,
            'SUSPICIOUS_STATE_TRANSITION',
            'Native secure-exam window authorization could not be established.',
          );
        }
      }
      void adapter.requestFullscreen();
      const enteredAttempt = await opened.enterKiosk(saved.id);
      setAttempt(enteredAttempt);
    })();
    return () => {
      cancelled = true;
      // Removing a React component is not a release authorization. Keep the
      // application/native kiosk active until terminal submission is durable.
      cleanupKioskRef.current?.();
      cleanupKioskRef.current = null;
      blockedNavigationCleanupRef.current?.();
      blockedNavigationCleanupRef.current = null;
    };
  }, [attemptId]);

  useEffect(() => {
    if (!submitted) return;
    void (async () => {
      if (repository && attempt) {
        try {
          const released = await repository.releaseKiosk(attempt.id);
          setAttempt(released);
        } catch (error) {
          // Do not release the application/native boundary until the explicit
          // RELEASED record is durable. A reload retries this transition.
          setMessage(error instanceof Error ? error.message : 'Kiosk release could not be persisted safely.');
          return;
        }
      }
      releaseSecureKiosk();
      await adapterRef.current?.exitSecureMode?.();
      cleanupKioskRef.current?.();
      cleanupKioskRef.current = null;
    })();
  }, [submitted, repository, attempt]);

  useEffect(() => {
    if (!repository || !attempt || submitted) return;
    const timer = window.setInterval(() => {
      const deadline = attempt.timerState?.authoritativeDeadlineAt || attempt.deadlineAt;
      const remaining = attempt.timerState
        ? remainingMilliseconds(attempt.timerState, new Date(authorityNow()).toISOString())
        : Math.max(0, new Date(deadline).getTime() - authorityNow());
      setSeconds(Math.ceil(remaining / 1000));
      if (
        remaining <= 0 &&
        ['ACTIVE', 'RECOVERY_PENDING', 'PAUSED'].includes(attempt.status) &&
        !finalizingRef.current
      ) {
        void finalizeSubmission(true, 'EXPIRY');
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [repository, attempt, submitted]);

  useEffect(() => {
    if (!repository || !attempt || submitted) return;
    const refreshAuthorityClock = async () => {
      const session = repository.snapshot.sessions.find((item) => item.id === attempt.sessionId);
      try {
        const authority = session?.authorityEndpoint
          ? new LanExamClient(session.authorityEndpoint, fetch, {
              token: session.authorityAccessToken,
              deviceSessionId: attempt.deviceSessionId,
              studentId: attempt.studentId,
            })
          : new LocalExamAuthority(repository);
        const health = await authority.health();
        setAuthorityClock(health.serverNowAt || health.checkedAt);
        await authority.heartbeat?.(attempt.sessionId, attempt.deviceSessionId);
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

  const finalizeSubmission = async (
    forced: boolean,
    trigger: 'MANUAL' | 'EXPIRY' = forced ? 'EXPIRY' : 'MANUAL',
  ) => {
    if (!repository || !attempt || finalizingRef.current || submittedRef.current) return;
    finalizingRef.current = true;
    markSecureKioskSubmitting();
    setNavigationBusy(true);
    try {
      // Save the currently edited answer first, then flush queued revisions.
      const persisted = await saveCurrentBeforeNavigation();
      if (!persisted) return;
      const syncResult = await syncRef.current?.flush();
      if (syncResult) setSyncState(syncResult.state);
      const session = repository.snapshot.sessions.find((item) => item.id === attempt.sessionId);
      if (session?.authorityEndpoint) {
        try {
          // Submission is idempotent at the LAN authority as well as locally.
          // The local authority shares this repository, so it is finalized once
          // below to preserve EXPIRY versus MANUAL trigger semantics.
          await authorityRef.current?.submitAttempt?.(
            attempt.sessionId,
            attempt.id,
            attempt.deviceSessionId,
          );
        } catch {
          await repository.markSynchronizationUnavailable(
            attempt.sessionId,
            `${trigger} submission queued while the LAN authority was unavailable.`,
          );
          setSyncState('RECOVERY_PENDING');
        }
      }
      const closed = await repository.submitAttempt(
        attempt.id,
        forced,
        attempt.deviceSessionId,
        trigger,
      );
      if (trigger === 'MANUAL') {
        await repository.logSecurityEvent({
          attemptId: closed.id,
          sessionId: closed.sessionId,
          studentId: closed.studentId,
          deviceSessionId: closed.deviceSessionId,
          type: 'SUBMITTED',
          severity: 'info',
          details: 'Student submitted after save and synchronization reconciliation; no password was requested.',
        });
      }
      setAttempt(closed);
      appendQuizHistoryResult(closed);
      setSubmitted(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The examination could not be finalized safely.');
    } finally {
      finalizingRef.current = false;
      setNavigationBusy(false);
    }
  };

  finalizeSubmissionRef.current = finalizeSubmission;

  const submit = async () => finalizeSubmission(false, 'MANUAL');

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
      <header className="max-w-6xl mx-auto border-b border-white/10 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-emerald-300 font-black">
              KIOSK EXAMINATION · {adapterRef.current?.matrix.platform || 'web'}
            </p>
            <h1 className="text-xl sm:text-2xl font-black mt-0.5">Secure Examination</h1>
            <p className="text-xs text-white/50">
              Authoritative LAN / local exam timer · Encrypted device state
            </p>
          </div>
          <div
            className={`flex items-center gap-2 rounded-xl px-4 py-2 font-black font-mono text-base ${
              seconds < 300 ? 'bg-red-500/20 text-red-300 animate-pulse border border-red-500/30' : 'bg-white/10'
            }`}
          >
            <Clock3 className="w-5 h-5 text-emerald-400" />
            <span>
              {minutes}:{remainingSeconds}
            </span>
          </div>
        </div>

        {/* Progress & Save Status Row */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mt-4 pt-3 border-t border-white/5">
          <div className="w-full sm:w-auto">
            <p className="text-xs font-bold text-white/70">
              Question {index + 1} of {ordered.length}
            </p>
            <div className="w-full sm:w-64 h-2 bg-white/10 rounded-full mt-1.5 overflow-hidden">
              <div
                className="h-full bg-emerald-400 transition-all duration-300"
                style={{ width: `${((index + 1) / ordered.length) * 100}%` }}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border ${
                saveState === 'SAVED'
                  ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                  : saveState === 'SAVING…'
                    ? 'bg-blue-500/10 text-blue-300 border-blue-500/30'
                    : 'bg-red-500/10 text-red-300 border-red-500/30'
              }`}
            >
              <Save className="w-3.5 h-3.5" />
              {saveState}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border ${
                syncState === 'SYNCHRONIZED'
                  ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                  : 'bg-amber-500/10 text-amber-300 border-amber-500/30'
              }`}
            >
              {syncState === 'SYNCHRONIZED' ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  Synchronized
                </>
              ) : (
                <>
                  <WifiOff className="w-3.5 h-3.5 text-amber-400" />
                  {syncState}
                </>
              )}
            </span>
          </div>
        </div>
      </header>

      {!fullscreenActive && !submitted && (
        <div className="max-w-6xl mx-auto mt-4 bg-amber-500/15 border border-amber-500/40 rounded-xl p-3 sm:p-4 text-amber-200 text-xs sm:text-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-sm">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>Fullscreen exited:</strong> Fullscreen mode is recommended for this secure examination.
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              void adapterRef.current?.requestFullscreen();
            }}
            className="px-3 py-1.5 bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold rounded-lg text-xs shrink-0 transition-colors"
          >
            Return to Fullscreen
          </button>
        </div>
      )}

      <main className="max-w-6xl mx-auto grid lg:grid-cols-[1fr_280px] gap-6 mt-6">
        {/* Main Question Card Section */}
        <div>
          <section className="rounded-2xl bg-white text-slate-900 p-5 sm:p-8 shadow-md border border-slate-100">
            {/* Question Type and Marks Badge */}
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-100">
              <span className="px-3 py-1 bg-purple-100 text-purple-700 rounded-lg text-xs font-bold uppercase tracking-wider">
                {current.questionType === 'mcq'
                  ? 'Multiple Choice'
                  : current.questionType
                      .split('_')
                      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                      .join(' ')}
              </span>
              <span className="text-sm font-semibold text-slate-500">
                {current.marks || 1} {(current.marks || 1) === 1 ? 'mark' : 'marks'}
              </span>
            </div>

            {/* Question Text */}
            <h2 className="text-lg sm:text-xl font-medium text-slate-900 leading-relaxed mb-6">
              {current.questionText}
            </h2>

            {/* MCQ Options with Letters A, B, C, D */}
            {current.questionType === 'mcq' && (
              <div className="space-y-3">
                {(
                  attempt.optionOrders[current.id] ||
                  current.options?.map((_, optionIndex) => optionIndex) ||
                  []
                ).map((optionIndex, displayIdx) => {
                  const isSelected = answers[current.id] === String(optionIndex);
                  const letter = String.fromCharCode(65 + displayIdx);
                  const optionText = current.options?.[optionIndex];
                  return (
                    <button
                      key={optionIndex}
                      type="button"
                      onClick={() => {
                        setAnswers((existing) => ({
                          ...existing,
                          [current.id]: String(optionIndex),
                        }));
                        void persistAnswer(current.id, String(optionIndex));
                      }}
                      className={`w-full p-4 rounded-xl border-2 text-left transition-all flex items-center gap-3.5 min-h-[52px] ${
                        isSelected
                          ? 'border-emerald-600 bg-emerald-50 text-slate-900 shadow-sm'
                          : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      <span
                        className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm shrink-0 transition-colors ${
                          isSelected
                            ? 'bg-emerald-600 text-white'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {letter}
                      </span>
                      <span className="text-base font-medium leading-relaxed">{optionText}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Text / Short-Answer / Essay */}
            {current.questionType !== 'mcq' && (
              <textarea
                value={answers[current.id] || ''}
                onChange={(event) => {
                  setAnswers((existing) => ({ ...existing, [current.id]: event.target.value }));
                  void persistAnswer(current.id, event.target.value);
                }}
                rows={6}
                className="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none resize-none text-slate-800 text-base"
                placeholder="Type your answer here..."
              />
            )}

            {/* Navigation Previous / Next */}
            <div className="flex items-center justify-between pt-6 border-t border-slate-100 mt-8">
              <button
                type="button"
                disabled={
                  index === 0 ||
                  navigationBusy ||
                  attempt.settingsSnapshot.navigation.allowPrevious === false
                }
                onClick={() => void goTo(index - 1)}
                className="inline-flex items-center gap-2 px-4 sm:px-5 py-2.5 rounded-xl border border-slate-300 text-slate-700 font-bold hover:bg-slate-50 transition-colors disabled:opacity-30 disabled:pointer-events-none text-sm sm:text-base"
              >
                <ChevronLeft className="w-5 h-5" />
                Previous
              </button>

              {index === ordered.length - 1 ? (
                <button
                  type="button"
                  disabled={navigationBusy}
                  onClick={() => {
                    if (window.confirm('Submit this attempt? You may not return after submission.'))
                      void submit();
                  }}
                  className="inline-flex items-center gap-2 px-5 sm:px-6 py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-xl transition-colors shadow-sm disabled:opacity-50 text-sm sm:text-base"
                >
                  <Send className="w-4 h-4" />
                  Submit Exam
                </button>
              ) : (
                <button
                  type="button"
                  disabled={navigationBusy}
                  onClick={() => void goTo(index + 1)}
                  className="inline-flex items-center gap-2 px-5 sm:px-6 py-2.5 bg-emerald-700 hover:bg-emerald-600 text-white font-bold rounded-xl transition-colors shadow-sm disabled:opacity-50 text-sm sm:text-base"
                >
                  {navigationBusy ? 'Saving…' : 'Next'}
                  <ChevronRight className="w-5 h-5" />
                </button>
              )}
            </div>
          </section>

          {/* Responsive Question Navigation for Mobile / Tablet */}
          <div className="lg:hidden mt-6 bg-white/5 border border-white/10 rounded-2xl p-4">
            <h3 className="font-bold text-sm text-white/80 mb-3">Question Navigator</h3>
            <div className="flex flex-wrap gap-2">
              {ordered.map((question, questionIndex) => {
                const isCurrent = questionIndex === index;
                const isAnswered = Boolean(answers[question.id]);
                return (
                  <button
                    type="button"
                    key={question.id}
                    onClick={() => void goTo(questionIndex)}
                    disabled={navigationBusy}
                    className={`w-9 h-9 rounded-xl text-sm font-bold transition-all flex items-center justify-center disabled:opacity-50 ${
                      isCurrent
                        ? 'bg-emerald-400 text-slate-950 shadow-md ring-2 ring-emerald-300'
                        : isAnswered
                          ? 'bg-emerald-800 text-emerald-100 border border-emerald-600'
                          : 'bg-white/10 text-white hover:bg-white/20 border border-white/10'
                    }`}
                  >
                    {questionIndex + 1}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              disabled={navigationBusy}
              onClick={() => {
                if (window.confirm('Submit this attempt? You may not return after submission.'))
                  void submit();
              }}
              className="mt-4 w-full rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 py-3 font-black flex items-center justify-center gap-2 transition-colors"
            >
              <Send className="w-4 h-4" /> SUBMIT EXAM
            </button>
          </div>
        </div>

        {/* Desktop Sidebar Aside */}
        <aside className="rounded-2xl bg-white/10 border border-white/10 p-5 h-fit hidden lg:block">
          <h2 className="font-black text-lg mb-3">Questions</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {ordered.map((question, questionIndex) => {
              const isCurrent = questionIndex === index;
              const isAnswered = Boolean(answers[question.id]);
              return (
                <button
                  type="button"
                  key={question.id}
                  onClick={() => void goTo(questionIndex)}
                  disabled={navigationBusy}
                  className={`rounded-xl p-2.5 text-sm font-black transition-all disabled:opacity-50 ${
                    isCurrent
                      ? 'bg-emerald-400 text-slate-950 shadow-md ring-2 ring-emerald-300'
                      : isAnswered
                        ? 'bg-emerald-800 text-emerald-100 border border-emerald-600'
                        : 'bg-white/10 text-white hover:bg-white/20 border border-white/10'
                  }`}
                >
                  {questionIndex + 1}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            disabled={navigationBusy}
            onClick={() => {
              if (window.confirm('Submit this attempt? You may not return after submission.'))
                void submit();
            }}
            className="mt-6 w-full rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 py-3 font-black flex items-center justify-center gap-2 transition-colors shadow-sm"
          >
            <Send className="w-4 h-4" /> SUBMIT EXAM
          </button>

          <p className="text-xs text-white/50 mt-4 flex gap-1.5 leading-relaxed">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
            <span>
              Navigation, clipboard, printing, and exit events are audited. Offline state is
              continuously protected.
            </span>
          </p>
        </aside>
      </main>
    </div>
  );
};

export default SecureExamination;
