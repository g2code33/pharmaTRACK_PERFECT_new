import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Flag,
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
import { queryNativeFullscreenActive } from '../examination/nativeKiosk';
import { verifyAdminExitPassword } from '../examination/package';
import { loadStagedPharmaExam } from '../examination/packageCache';
import { verifyPassword } from '../examination/crypto';
import { secureWindowPrompt } from '../platform/securePrompt';
import type { KioskAdapter } from '../examination/kioskAdapter';
import type { ExamQuestionSnapshot, StudentAttempt } from '../examination/types';
import {
  clearFlaggedQuestions,
  loadFlaggedQuestions,
  saveFlaggedQuestions,
} from '../examination/flaggedQuestions';
import {
  enterSecureKiosk,
  markSecureKioskSubmitting,
  onBlockedKioskNavigation,
  releaseSecureKiosk,
} from '../examination/kioskState';
import { detectRuntimePlatform, isIOS, isIOSPWA, isIOSSafari } from '../platform/runtime';
import {
  clearKioskAttemptProgress,
  getStoredKioskJoinCode,
  reportKioskAttemptHeartbeat,
} from '../examination/kioskRoster';
import { submitOrQueueKioskExamResult } from '../examination/kioskResultOutbox';

/** Questions are shown in groups of this size, matching the shared Quick Quiz layout exactly. */
const QUIZ_SET_SIZE = 3;


/**
 * Checks a supplied separate-administrator early-exit password against
 * every source that can legitimately hold it.
 *
 * The verifier is checked against the attempt's own immutable
 * `settingsSnapshot` first — it was copied from the published exam version
 * the moment this specific attempt started, so it is correct regardless of
 * how the student reached the device (a `.pharmaexam` file, a LAN/cloud
 * join code, or a reused kiosk) and is immune to the device's local
 * "currently staged package" cache being overwritten or cleared by later
 * activity (a different exam staged on the same device, a package
 * re-publish, etc.) after this attempt began.
 *
 * Older `.pharmaexam` files published before the exit verifier lived on the
 * exam version only ever embedded it in the package itself, so that is
 * still checked as a fallback for backward compatibility.
 */
async function verifyAdminExitAuthorization(
  supplied: string | null | undefined,
  attempt: StudentAttempt,
): Promise<boolean> {
  if (!supplied) return false;
  const versionVerifier = attempt.settingsSnapshot?.security?.adminExitPasswordVerifier;
  if (versionVerifier && (await verifyPassword(supplied, versionVerifier))) return true;
  const stagedPackage = await loadStagedPharmaExam();
  if (stagedPackage && (await verifyAdminExitPassword(supplied, stagedPackage.security))) return true;
  return false;
}

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
  // True only for notices raised once an attempt is already active (an
  // early-exit rejection, a disabled-exit notice, a submission hiccup) —
  // never for the mount-time failures above, where there is genuinely no
  // quiz state to return to. Lets a student who backed out of (or was
  // rejected from) an exit attempt get back to answering instead of being
  // stuck on a dead-end card, without ever weakening the lock itself.
  const [messageReturnable, setMessageReturnable] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saveState, setSaveState] = useState<'SAVED' | 'SAVING…' | 'Save problem — retrying'>(
    'SAVED',
  );
  const [syncState, setSyncState] = useState<'SYNCHRONIZED' | 'DEGRADED' | 'RECOVERY_PENDING'>(
    'SYNCHRONIZED',
  );
  const [fullscreenActive, setFullscreenActive] = useState(true);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [flaggedQuestions, setFlaggedQuestions] = useState<Set<string>>(new Set());
  const [submitReviewOpen, setSubmitReviewOpen] = useState(false);
  // Post-submission admin unlock gate: once true, the release effect below
  // is allowed to actually tear down the kiosk lock. Starts false on every
  // mount, including a reload while "awaiting admin exit" — only the
  // password check below can set it.
  const [exitAuthorized, setExitAuthorized] = useState(false);
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState('');
  const adapterRef = useRef<KioskAdapter | null>(null);
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
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
    try {
      const studentResult = repository.getStudentVisibleResult(closed.id, closed.studentId);
      if (!studentResult.visible) return; // STRICT RULE: never store hidden results in appState / localStorage!
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
    } catch {
      // If visibility policy prevents result retrieval, do not populate quiz history
    }
  };

  /**
   * Reports the final score straight to the cloud so the administrator
   * receives it reliably, even when this device never shared a LAN with the
   * admin's device during the exam. Best-effort only: it must never block or
   * fail a submission that is already durable in encrypted local storage —
   * the offline result remains authoritative regardless of whether this
   * succeeds.
   *
   * If the device is offline (or Supabase is briefly unreachable) when the
   * student finishes, this does NOT just drop the report: it hands off to
   * the durable local outbox (kioskResultOutbox.ts), which keeps retrying
   * automatically — on the next 'online' event and periodically in the
   * background — until it actually reaches the admin, with no manual sync
   * step for the student or admin.
   */
  const reportKioskResultToCloud = (closed: StudentAttempt) => {
    if (!repository) return;
    const joinCode = getStoredKioskJoinCode();
    if (!joinCode) return;
    try {
      const result = repository.getExaminationResult(closed.id);
      const version = repository.snapshot.versions.find((item) => item.id === closed.examVersionId);
      if (!result) return;
      const examKey = version?.examId || closed.examVersionId;
      const examTitle = version?.title || 'Examination';
      void submitOrQueueKioskExamResult({
        joinCode,
        studentId: closed.studentId,
        examKey,
        examTitle,
        scorePercentage: result.percentage,
        submittedAt: result.submittedAt || new Date().toISOString(),
      });
      void clearKioskAttemptProgress(joinCode, closed.studentId, examKey);
    } catch {
      // Cloud reporting is a convenience, not the system of record.
    }
  };

  useEffect(() => {
    if (typeof document === 'undefined') return;
    // Native desktop (Tauri) never puts the page itself into DOM fullscreen —
    // secure mode fullscreens the OS window directly (see
    // `enter_secure_exam_mode` / `apply_secure_window_controls` in the Rust
    // host). Checking `document.fullscreenElement` there would always read
    // as "not fullscreen", showing a permanent false "Fullscreen exited"
    // banner regardless of the window's real state, and the matching
    // "Return to Fullscreen" button would have nothing it could actually do
    // (`Element.requestFullscreen()` on a page that was never put into DOM
    // fullscreen is a no-op). Poll the real native state over IPC instead.
    if (detectRuntimePlatform() === 'native-pc') {
      let cancelled = false;
      const pollNativeFullscreen = async () => {
        const active = await queryNativeFullscreenActive();
        // `undefined` means the query itself failed (e.g. no secure exam
        // host available) — treat as unknown rather than flashing a false
        // "exited fullscreen" notice the student cannot act on.
        if (!cancelled && active !== undefined) setFullscreenActive(active);
      };
      void pollNativeFullscreen();
      const timer = window.setInterval(() => void pollNativeFullscreen(), 1500);
      return () => {
        cancelled = true;
        window.clearInterval(timer);
      };
    }
    const isStandalone = typeof window !== 'undefined' && Boolean(
      (navigator as Navigator & { standalone?: boolean }).standalone ||
      window.matchMedia?.('(display-mode: standalone)')?.matches ||
      window.matchMedia?.('(display-mode: fullscreen)')?.matches,
    );
    const hasFullscreenApi = Boolean(
      document.documentElement.requestFullscreen ||
      (document.documentElement as any).webkitRequestFullscreen,
    );
    const checkFullscreen = () => {
      // In installed PWA or when the platform doesn't expose an Element Fullscreen API (e.g. iPhone Safari),
      // we consider fullscreen satisfied so we don't present an impossible/broken fullscreen prompt.
      if (isStandalone || !hasFullscreenApi) {
        setFullscreenActive(true);
        return;
      }
      setFullscreenActive(Boolean(document.fullscreenElement || (document as any).webkitFullscreenElement));
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
        setMessageReturnable(false);
        return;
      }
      const version = opened.snapshot.versions.find((item) => item.id === saved.examVersionId);
      if (!version) {
        setMessage('The immutable examination version is unavailable.');
        setMessageReturnable(false);
        return;
      }
      if (saved.status === 'LOCKED') {
        setMessage('This attempt is locked. An authorized administrator must unlock it.');
        setMessageReturnable(false);
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
      setFlaggedQuestions(loadFlaggedQuestions(saved.id));
      setMessage('');
      setMessageReturnable(false);
      if (saved.status === 'SUBMITTED' || saved.status === 'KIOSK_RELEASED' || saved.status === 'CLOSED') {
        // A reload here (e.g. the device restarted while the post-submission
        // admin-password gate was still pending) does not go through the
        // normal entry setup below, but the native/Android release call
        // still needs a live adapter instance to act on — the Rust/Android
        // side's locked state is a platform-level singleton that outlives
        // this page's own lifecycle, so re-wrapping it here is enough; no
        // enterSecureMode()/install() re-entry is needed for an attempt that
        // is already terminal.
        if (!adapterRef.current) {
          adapterRef.current = await createPlatformKioskAdapter(() => {});
        }
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
              setMessageReturnable(true);
              return;
            }
            let authorized = policy === 'ALLOW_FREE_EXIT';
            if (policy === 'ADMIN_AUTH_REQUIRED') {
              const supplied = await secureWindowPrompt('Enter the exit password set when this exam was created. This is not your RX30 password.');
              authorized = await verifyAdminExitAuthorization(supplied, saved);
            }
            if (!authorized) {
              setMessage('That exit password was not recognized. This is the password set when this exam was created, not RX30 or any login password.');
              setMessageReturnable(true);
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
              setMessage(error instanceof Error ? error.message : 'The exit password could not be processed. Please try again.');
              setMessageReturnable(true);
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
    // The admin can require their own exit authorization even after a valid
    // submission. Until it is supplied (this round or an earlier one in the
    // same browser session), the lock must stay engaged — no auto-release.
    const manualExitPolicy =
      attempt?.settingsSnapshot?.security.manualExitPolicy ?? 'ADMIN_AUTH_REQUIRED';
    if (manualExitPolicy === 'ADMIN_AUTH_REQUIRED' && !exitAuthorized) {
      return;
    }
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
  }, [submitted, repository, attempt, exitAuthorized]);

  /** The only way out of a post-submission, admin-gated lock: the password
   *  staged into this exam package's own `adminExitPasswordVerifier`. It is
   *  per-file by construction (verified against the staged package loaded
   *  for this attempt), never a global/app-wide secret. */
  const unlockDeviceWithAdminPassword = async () => {
    if (unlockBusy) return;
    setUnlockBusy(true);
    setUnlockError('');
    try {
      const supplied = await secureWindowPrompt(
        'Enter the exit password set when this exam was created to unlock this device. This is not your RX30 password.',
      );
      if (!supplied || !attempt) return;
      const authorized = await verifyAdminExitAuthorization(supplied, attempt);
      if (!authorized) {
        // Kept local to this notice (not the full-page `message` takeover)
        // so a mistyped password can be retried immediately — the device
        // stays exactly as locked as it was before the attempt either way.
        setUnlockError('That exit password was not recognized. This is the password set when this exam was created, not RX30 or any login password. This device remains locked.');
        return;
      }
      setExitAuthorized(true);
    } finally {
      setUnlockBusy(false);
    }
  };

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

  // Handle Safari lifecycle events: backgrounding, returning, tab suspension, and network wake
  useEffect(() => {
    if (typeof window === 'undefined' || !repository || !attempt || submitted) return;
    const handleWakeup = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
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
      } catch {
        /* Encrypted local timer remains available */
      }
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
      } else {
        void syncRef.current?.flush();
      }
    };

    window.addEventListener('pageshow', handleWakeup);
    document.addEventListener('visibilitychange', handleWakeup);
    window.addEventListener('online', handleWakeup);
    // The native shell fires this on resume (Android discards the WebView
    // surface while backgrounded); a device that slept through a network drop
    // flushes its queued answer events the moment it is back.
    window.addEventListener('pharmatrack:resume', handleWakeup);
    return () => {
      window.removeEventListener('pageshow', handleWakeup);
      document.removeEventListener('visibilitychange', handleWakeup);
      window.removeEventListener('online', handleWakeup);
      window.removeEventListener('pharmatrack:resume', handleWakeup);
    };
  }, [repository, attempt, submitted]);

  const ordered = useMemo(
    () => attempt?.questionOrder.map((id) => questions[id]).filter(Boolean) || [],
    [attempt, questions],
  );

  // Best-effort live progress heartbeat straight to the cloud, so the
  // administrator's Examination Control Center can see this attempt is
  // underway even when this device is on a completely different network
  // from the admin's device (e.g. a phone on mobile data). Only fires when
  // this attempt's identity was referenced through an admin's kiosk roster
  // (cloud student id + a remembered join code) — never required for the
  // exam itself, which stays fully functional offline regardless.
  useEffect(() => {
    if (!repository || !attempt || submitted) return;
    const joinCode = getStoredKioskJoinCode();
    if (!joinCode) return;
    const version = repository.snapshot.versions.find((item) => item.id === attempt.examVersionId);
    const examKey = version?.examId || attempt.examVersionId;
    const examTitle = version?.title || 'Examination';
    const sendHeartbeat = () => {
      void reportKioskAttemptHeartbeat({
        joinCode,
        studentId: attempt.studentId,
        examKey,
        examTitle,
        currentQuestion: index + 1,
        totalQuestions: ordered.length,
      });
    };
    sendHeartbeat();
    const timer = window.setInterval(sendHeartbeat, 15000);
    return () => window.clearInterval(timer);
  }, [repository, attempt, submitted, index, ordered.length]);

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

  // The question list has its own independent scroll region (like the
  // shared Quick Quiz) — moving to a different set of three should always
  // land the student at the top of that set, not wherever they happened to
  // have scrolled to on the previous one.
  const scrollQuestionsToTop = () => {
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      mainScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });
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
        scrollQuestionsToTop();
      } catch {
        setSaveState('Save problem — retrying');
      }
    }
    setNavigationBusy(false);
  };

  // Questions are shown three at a time (QUIZ_SET_SIZE), matching the shared
  // Quick Quiz layout exactly — "index" is the student's furthest-focused
  // question within the current set of three, used for the progress label,
  // the heartbeat, and the Finish-unlocks-on-last-question gate.
  const setStart = Math.floor(index / QUIZ_SET_SIZE) * QUIZ_SET_SIZE;
  const visibleQuestions = ordered.slice(setStart, setStart + QUIZ_SET_SIZE);
  const setEnd = Math.min(setStart + visibleQuestions.length, ordered.length);
  const allowPrevious = attempt?.settingsSnapshot.navigation.allowPrevious !== false;
  const canGoPreviousSet = allowPrevious && setStart > 0;
  const canGoNextSet = setStart + QUIZ_SET_SIZE < ordered.length;
  const isOnLastQuestion = ordered.length > 0 && index === ordered.length - 1;
  const answeredCount = ordered.filter(
    (question) => (answers[question.id] || '').trim().length > 0,
  ).length;
  const unansweredCount = Math.max(0, ordered.length - answeredCount);
  const flaggedCount = ordered.filter((question) => flaggedQuestions.has(question.id)).length;

  const goToQuestionSet = (startIndex: number) => {
    void goTo(Math.min(Math.max(0, startIndex), Math.max(0, ordered.length - 1)));
  };

  const openSubmitReview = () => {
    if (!isOnLastQuestion) return;
    setSubmitReviewOpen(true);
  };

  /**
   * Moves the "current question" pointer without the full
   * save-then-move round trip `goTo` performs — used when a student
   * interacts with a card inside the visible three-question set that isn't
   * the lead one. The answer itself is already persisted independently by
   * that card's own change handler, so there is nothing stale left to save
   * first, and the pointer move itself is just a best-effort admin-visible
   * "which question is this student looking at" signal.
   */
  const focusQuestion = (targetIndex: number) => {
    if (targetIndex === index || targetIndex < 0 || targetIndex >= ordered.length) return;
    setIndex(targetIndex);
    const target = ordered[targetIndex];
    if (repository && attempt && target) {
      void repository.updateCurrentQuestion(attempt.id, target.id);
    }
  };

  const answerQuestion = (questionId: string, questionIndex: number, value: string) => {
    setAnswers((existing) => ({ ...existing, [questionId]: value }));
    void persistAnswer(questionId, value);
    if (questionIndex !== index) focusQuestion(questionIndex);
  };

  /** Flags never affect grading or security — a purely student-facing "come back to this" bookmark. */
  const toggleFlag = (questionId: string) => {
    setFlaggedQuestions((existing) => {
      const next = new Set(existing);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      if (attempt) saveFlaggedQuestions(attempt.id, next);
      return next;
    });
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
      reportKioskResultToCloud(closed);
      clearFlaggedQuestions(closed.id);
      setSubmitted(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The examination could not be finalized safely.');
      setMessageReturnable(true);
    } finally {
      finalizingRef.current = false;
      setNavigationBusy(false);
    }
  };

  finalizeSubmissionRef.current = finalizeSubmission;

  const submit = async () => finalizeSubmission(false, 'MANUAL');

  if (message)
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
        <div className="max-w-lg text-center rounded-3xl bg-white border border-slate-200 shadow-sm p-8">
          <LockKeyhole className="w-12 h-12 mx-auto mb-4 text-[#2D6A4F]" />
          <h1 className="text-2xl font-black text-slate-900">Secure examination</h1>
          <p className="mt-3 text-slate-600">{message}</p>
          {messageReturnable && attempt && current && (
            <button
              type="button"
              data-testid="return-to-quiz"
              onClick={() => {
                setMessage('');
                setMessageReturnable(false);
              }}
              className="mt-6 w-full px-6 py-3 bg-[#2D6A4F] hover:bg-[#245a41] text-white rounded-xl font-black transition-colors"
            >
              Return to quiz
            </button>
          )}
        </div>
      </div>
    );
  if (!attempt || !current) return null;
  if (submitted) {
    let studentResult: import('../examination/types').StudentVisibleResult | null = null;
    try {
      studentResult =
        repository && attempt
          ? repository.getStudentVisibleResult(attempt.id, attempt.studentId)
          : null;
    } catch {
      studentResult = null;
    }

    const isVisible = Boolean(studentResult?.visible);
    const manualExitPolicy =
      attempt?.settingsSnapshot?.security.manualExitPolicy ?? 'ADMIN_AUTH_REQUIRED';
    // Tied to the durably persisted release, not the transient "password was
    // accepted" flag — if the actual releaseKiosk() write fails (storage
    // hiccup, offline device), the UI must stay on the locked notice rather
    // than claim an unlock that was never made durable.
    const requiresAdminExitAuth =
      manualExitPolicy === 'ADMIN_AUTH_REQUIRED' && attempt?.kioskLifecycle !== 'RELEASED';

    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4 sm:p-6">
        <div className="max-w-2xl w-full bg-white border border-slate-200 rounded-3xl p-6 sm:p-8 text-center shadow-xl">
          <CheckCircle2 className="w-16 h-16 mx-auto mb-4 text-[#2D6A4F]" />
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900">
            {isVisible ? 'Examination Results' : 'Examination Submitted'}
          </h1>
          {studentResult?.examTitle && (
            <p className="text-[#2D6A4F] font-bold text-sm mt-1">{studentResult.examTitle}</p>
          )}

          {!isVisible ? (
            <div className="my-6 p-6 rounded-2xl bg-slate-50 border border-slate-200">
              <p className="text-slate-600 text-base leading-relaxed">
                {studentResult?.message ||
                  'Your examination has been submitted successfully. Your result will be available when released by the administrator.'}
              </p>
            </div>
          ) : (
            <div className="my-6 space-y-6 text-left">
              {/* Summary Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {studentResult?.score !== undefined && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-center">
                    <p className="text-xs uppercase font-black text-slate-500">Score</p>
                    <p className="text-xl sm:text-2xl font-black text-slate-900 mt-1">
                      {studentResult.score}
                      {studentResult.maxMarks ? ` / ${studentResult.maxMarks}` : ''}
                    </p>
                  </div>
                )}
                {studentResult?.percentage !== undefined && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-center">
                    <p className="text-xs uppercase font-black text-slate-500">Percentage</p>
                    <p className="text-xl sm:text-2xl font-black text-[#2D6A4F] mt-1">
                      {studentResult.percentage}%
                    </p>
                  </div>
                )}
                {studentResult?.passed !== undefined && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-center">
                    <p className="text-xs uppercase font-black text-slate-500">Status</p>
                    <span
                      className={`inline-block mt-1 px-3 py-1 rounded-lg text-sm font-black ${
                        studentResult.passed
                          ? 'bg-emerald-100 text-emerald-700 border border-emerald-300'
                          : 'bg-rose-100 text-rose-700 border border-rose-300'
                      }`}
                    >
                      {studentResult.passed ? 'PASSED' : 'FAILED'}
                    </span>
                  </div>
                )}
                {studentResult?.durationSeconds !== undefined && (
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-center">
                    <p className="text-xs uppercase font-black text-slate-500">Time Used</p>
                    <p className="text-xl sm:text-2xl font-black text-slate-900 mt-1">
                      {Math.floor(studentResult.durationSeconds / 60)}m{' '}
                      {studentResult.durationSeconds % 60}s
                    </p>
                  </div>
                )}
              </div>

              {/* Answer Review */}
              {studentResult?.questionResults && studentResult.questionResults.length > 0 && (
                <div className="mt-6 border-t border-slate-200 pt-4">
                  <h3 className="text-lg font-black text-slate-900 mb-3">Answer Review</h3>
                  <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                    {studentResult.questionResults.map((qr, idx) => (
                      <div
                        key={qr.questionId}
                        className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 text-sm"
                      >
                        <div className="flex justify-between items-start gap-2 mb-1">
                          <span className="font-bold text-slate-800">
                            Q{idx + 1}. {qr.questionText || 'Question'}
                          </span>
                          {qr.isCorrect !== undefined && (
                            <span
                              className={`text-xs px-2 py-0.5 rounded font-black shrink-0 ${
                                qr.isCorrect
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : 'bg-rose-100 text-rose-700'
                              }`}
                            >
                              {qr.isCorrect ? 'Correct' : 'Incorrect'}
                            </span>
                          )}
                        </div>
                        <p className="text-slate-600 text-xs">
                          Your answer:{' '}
                          <span className="text-slate-900 font-medium">{qr.answer || '—'}</span>
                        </p>
                        {qr.correctOption !== undefined && (
                          <p className="text-[#2D6A4F] text-xs mt-0.5">
                            Correct option: {String.fromCharCode(65 + qr.correctOption)}
                          </p>
                        )}
                        {qr.correctAnswer && (
                          <p className="text-[#2D6A4F] text-xs mt-0.5">
                            Correct answer: {qr.correctAnswer}
                          </p>
                        )}
                        {qr.explanation && (
                          <p className="text-slate-500 text-xs mt-1 italic">{qr.explanation}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {requiresAdminExitAuth ? (
            <div
              className="mt-4 p-4 rounded-2xl bg-amber-50 border border-amber-200 text-left"
              data-testid="post-submission-lock-notice"
            >
              <div className="flex items-center gap-2 text-amber-800 font-black">
                <LockKeyhole className="w-5 h-5 shrink-0" />
                This device is still locked
              </div>
              <p className="mt-1.5 text-sm text-amber-700">
                This examination requires its own exit password to release this device, even after
                submission — the one set when this exam was created, not RX30 or any login
                password. Hand the device to whoever has it, or enter it below.
              </p>
              <button
                type="button"
                onClick={() => void unlockDeviceWithAdminPassword()}
                disabled={unlockBusy}
                data-testid="unlock-with-admin-password"
                className="mt-3 w-full px-6 py-3 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded-xl font-black transition-colors"
              >
                {unlockBusy ? 'Verifying…' : 'Enter exit password to unlock'}
              </button>
              {unlockError && (
                <p className="mt-2 text-sm text-rose-700" data-testid="unlock-error">
                  {unlockError}
                </p>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                releaseSecureKiosk();
                navigate('/quiz');
              }}
              data-testid="return-to-quiz"
              className="mt-4 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-black transition-colors"
            >
              Return to Quiz
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-slate-100">
      <header className="safe-area-x shrink-0 border-b border-slate-200/80 bg-slate-100/95 px-3 pb-1.5 pt-safe shadow-sm backdrop-blur sm:px-6 sm:pb-2 sm:pt-3">
        <div className="mx-auto max-w-7xl rounded-2xl bg-[#0F172A] p-2.5 text-white shadow-lg sm:p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[8px] font-black uppercase tracking-[0.2em] text-emerald-300 sm:text-[10px]">
                  {adapterRef.current?.matrix.platform === 'TAURI_PC'
                    ? 'Native Desktop Kiosk'
                    : adapterRef.current?.matrix.platform === 'ANDROID_NATIVE'
                      ? 'Android Native Kiosk'
                      : 'Restricted Web Examination Mode'}
                </p>
                {isIOS() && (
                  <span className="rounded-full border border-white/20 bg-white/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-200">
                    {isIOSPWA() ? 'iPhone PWA' : 'iPhone Safari'}
                  </span>
                )}
              </div>
              <h1 className="mt-0.5 truncate text-sm font-black sm:text-lg">Secure Examination</h1>
              <p className="mt-0.5 truncate text-[10px] font-semibold text-slate-300 sm:text-xs">
                Authoritative LAN / local exam timer · Encrypted device state
              </p>
            </div>
            <div
              className={`flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-2.5 font-mono font-black text-xs sm:h-10 sm:px-3 sm:text-base ${
                seconds < 300
                  ? 'animate-pulse bg-red-500/20 text-red-200 ring-1 ring-red-300/40'
                  : 'bg-white/10 text-emerald-100'
              }`}
            >
              <Clock3 className="h-4 w-4 text-emerald-300 sm:h-5 sm:w-5" />
              <span>
                {minutes}:{remainingSeconds}
              </span>
            </div>
          </div>

          <div className="mt-1.5 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="flex flex-1 items-center gap-2 sm:gap-3">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-all duration-300"
                  style={{ width: `${(setEnd / ordered.length) * 100}%` }}
                />
              </div>
              <span className="shrink-0 whitespace-nowrap text-[10px] font-black text-slate-200 sm:text-xs">
                Q{setStart + 1}-{setEnd}/{ordered.length}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold sm:gap-2 sm:text-xs">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
                  saveState === 'SAVED'
                    ? 'border-emerald-400/30 bg-emerald-500/15 text-emerald-200'
                    : saveState === 'SAVING…'
                      ? 'border-blue-400/30 bg-blue-500/15 text-blue-200'
                      : 'border-red-400/30 bg-red-500/15 text-red-200'
                }`}
              >
                <Save className="h-3.5 w-3.5" />
                {saveState}
              </span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
                  syncState === 'SYNCHRONIZED'
                    ? 'border-emerald-400/30 bg-emerald-500/15 text-emerald-200'
                    : 'border-amber-400/30 bg-amber-500/15 text-amber-200'
                }`}
              >
                {syncState === 'SYNCHRONIZED' ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                    Synchronized
                  </>
                ) : (
                  <>
                    <WifiOff className="h-3.5 w-3.5 text-amber-300" />
                    {syncState}
                  </>
                )}
              </span>
              {flaggedCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/15 px-2.5 py-1 text-amber-200">
                  <Flag className="h-3.5 w-3.5" fill="currentColor" />
                  {flaggedCount} flagged
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {!fullscreenActive && !submitted && (
        <div className="safe-area-x shrink-0 bg-slate-100 px-3 pt-2 sm:px-6">
          <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 shadow-sm sm:flex-row sm:items-center sm:p-4 sm:text-sm">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
              <span>
                <strong>Fullscreen exited:</strong> Fullscreen mode is recommended for this secure
                examination.
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                void adapterRef.current?.requestFullscreen();
              }}
              className="shrink-0 rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-bold text-amber-950 transition-colors hover:bg-amber-300"
            >
              Return to Fullscreen
            </button>
          </div>
        </div>
      )}

      <main
        ref={mainScrollRef}
        className="safe-area-x min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2 sm:px-6 sm:py-4"
      >
        <div className="mx-auto grid max-w-7xl gap-3 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
          <section className="min-w-0 space-y-3">
            <div className="grid gap-3">
              {visibleQuestions.map((question, offset) => {
                const absoluteIndex = setStart + offset;
                const isFlagged = flaggedQuestions.has(question.id);
                return (
                  <article
                    key={question.id}
                    className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4 lg:p-5"
                  >
                    <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-slate-900 px-2.5 py-1 text-[10px] font-black uppercase text-white">
                          Q{absoluteIndex + 1}
                        </span>
                        <span className="rounded-full bg-purple-100 px-2.5 py-1 text-[10px] font-black uppercase text-purple-700">
                          {question.questionType === 'mcq'
                            ? 'Multiple Choice'
                            : question.questionType
                                .split('_')
                                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                                .join(' ')}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase text-slate-600">
                          {question.marks || 1} {(question.marks || 1) === 1 ? 'mark' : 'marks'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleFlag(question.id)}
                        aria-pressed={isFlagged}
                        title={isFlagged ? 'Remove flag' : 'Flag this question for review'}
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-black uppercase transition-colors ${
                          isFlagged
                            ? 'bg-amber-400 text-amber-950'
                            : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                        }`}
                      >
                        <Flag className="h-3.5 w-3.5" fill={isFlagged ? 'currentColor' : 'none'} />
                        {isFlagged ? 'Flagged' : 'Flag'}
                      </button>
                    </div>

                    <h2 className="text-[15px] font-black leading-snug text-slate-900 sm:text-base lg:text-lg">
                      {question.questionText}
                    </h2>

                    {question.questionType === 'mcq' ? (
                      <div className="mt-3 grid gap-2">
                        {(
                          attempt.optionOrders[question.id] ||
                          question.options?.map((_, optionIndex) => optionIndex) ||
                          []
                        ).map((optionIndex, displayIdx) => {
                          const isSelected = answers[question.id] === String(optionIndex);
                          const letter = String.fromCharCode(65 + displayIdx);
                          const optionText = question.options?.[optionIndex];
                          return (
                            <button
                              key={optionIndex}
                              type="button"
                              onClick={() =>
                                answerQuestion(question.id, absoluteIndex, String(optionIndex))
                              }
                              className={`flex w-full touch-manipulation items-start gap-2 rounded-xl border p-3 text-left text-sm transition-colors ${
                                isSelected
                                  ? 'border-[#2D6A4F] bg-emerald-50 text-emerald-950 shadow-sm'
                                  : 'border-slate-200 bg-white text-slate-800 hover:border-slate-300 hover:bg-slate-50'
                              }`}
                            >
                              <span
                                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-black ${
                                  isSelected
                                    ? 'bg-[#2D6A4F] text-white'
                                    : 'bg-slate-100 text-slate-500'
                                }`}
                              >
                                {letter}
                              </span>
                              <span className="min-w-0 flex-1 leading-snug">{optionText}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <textarea
                        value={answers[question.id] || ''}
                        onFocus={() => focusQuestion(absoluteIndex)}
                        onChange={(event) =>
                          answerQuestion(question.id, absoluteIndex, event.target.value)
                        }
                        rows={5}
                        placeholder="Type your answer here..."
                        className="mt-3 min-h-[7rem] w-full rounded-xl border border-slate-300 p-3 text-sm text-slate-800 outline-none focus:border-transparent focus:ring-4 focus:ring-[#2D6A4F]/15"
                      />
                    )}
                  </article>
                );
              })}
            </div>

            <div
              className="grid grid-cols-[repeat(3,minmax(0,1fr))] items-center gap-2 rounded-2xl border border-slate-200 bg-white/90 p-2 shadow-sm"
              data-testid="secure-exam-set-navigation"
            >
              <button
                type="button"
                onClick={() => goToQuestionSet(setStart - QUIZ_SET_SIZE)}
                disabled={!canGoPreviousSet || navigationBusy}
                className="inline-flex items-center justify-self-start gap-1 rounded-xl bg-slate-100 px-2 py-2 text-xs font-black text-slate-700 disabled:opacity-35"
              >
                <ChevronLeft className="h-4 w-4" /> Back 3
              </button>
              <button
                type="button"
                onClick={openSubmitReview}
                disabled={!isOnLastQuestion || navigationBusy}
                title={
                  isOnLastQuestion
                    ? 'Review answers before submitting'
                    : `Go to question ${ordered.length} to unlock Finish`
                }
                className="inline-flex items-center justify-self-center gap-1 rounded-xl bg-emerald-600 px-2 py-2 text-xs font-black text-white shadow-sm disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 sm:text-sm"
              >
                Finish <Check className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => goToQuestionSet(setStart + QUIZ_SET_SIZE)}
                disabled={!canGoNextSet || navigationBusy}
                className="inline-flex items-center justify-self-end gap-1 rounded-xl bg-blue-600 px-2 py-2 text-xs font-black text-white shadow-sm disabled:opacity-35 sm:text-sm"
              >
                {navigationBusy ? 'Saving…' : 'Next 3'} <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            {!isOnLastQuestion && ordered.length > 0 && (
              <p className="px-1 text-center text-[11px] font-bold text-slate-500">
                Finish unlocks on question {ordered.length}. Use the jump list to go there when
                you are ready to submit.
              </p>
            )}
          </section>

          {submitReviewOpen && (
            <div
              className="fixed inset-0 z-[260] flex items-end justify-center bg-slate-950/55 p-0 sm:items-center sm:p-4"
              role="dialog"
              aria-modal="true"
              aria-label="Review examination before submission"
            >
              <div className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl">
                <div className="border-b border-slate-100 p-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.2em] text-emerald-700">
                    Final review
                  </p>
                  <h2 className="mt-1 text-xl font-black text-slate-900">
                    Check answered and unanswered questions
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {answeredCount} answered · {unansweredCount} unanswered
                    {flaggedCount ? ` · ${flaggedCount} flagged` : ''}. Use Corrections to go back
                    before submitting.
                  </p>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  <div className="grid gap-2">
                    {ordered.map((question, idx) => {
                      const hasAnswer = (answers[question.id] || '').trim().length > 0;
                      const isFlagged = flaggedQuestions.has(question.id);
                      return (
                        <button
                          key={question.id}
                          type="button"
                          onClick={() => {
                            setSubmitReviewOpen(false);
                            void goTo(idx);
                          }}
                          className={`flex items-start gap-3 rounded-2xl border p-3 text-left ${
                            hasAnswer
                              ? 'border-emerald-200 bg-emerald-50'
                              : 'border-amber-200 bg-amber-50'
                          }`}
                        >
                          <span
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-black ${
                              hasAnswer
                                ? 'bg-emerald-600 text-white'
                                : 'bg-amber-500 text-amber-950'
                            }`}
                          >
                            {idx + 1}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="block line-clamp-2 text-sm font-black text-slate-900">
                                {question.questionText}
                              </span>
                              {isFlagged && (
                                <Flag className="h-3.5 w-3.5 shrink-0 text-amber-500" fill="currentColor" />
                              )}
                            </span>
                            <span
                              className={`mt-1 block text-xs font-bold ${
                                hasAnswer ? 'text-emerald-800' : 'text-amber-800'
                              }`}
                            >
                              {hasAnswer ? 'Answered — tap to review' : 'Unanswered — tap to correct'}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="safe-area-bottom sticky bottom-0 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2 border-t border-slate-100 bg-white p-3">
                  <button
                    type="button"
                    onClick={() => setSubmitReviewOpen(false)}
                    className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-50"
                  >
                    Corrections
                  </button>
                  <button
                    type="button"
                    disabled={navigationBusy}
                    onClick={() => void submit()}
                    className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl bg-[#2D6A4F] px-4 py-3 text-sm font-black text-white transition-colors hover:bg-[#1B4332] disabled:opacity-60"
                  >
                    <Send className="h-4 w-4" /> {navigationBusy ? 'Submitting…' : 'Submit Exam'}
                  </button>
                </div>
              </div>
            </div>
          )}

          <aside
            className="rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm lg:sticky lg:top-3 lg:max-h-[calc(100dvh-1.5rem)] lg:overflow-y-auto"
            aria-label="Jump to question"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs font-black uppercase tracking-wider text-slate-500">
                Jump to question
              </p>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black text-slate-500">
                {ordered.length} Qs
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {ordered.map((question, questionIndex) => {
                const inVisibleSet = questionIndex >= setStart && questionIndex < setEnd;
                const isAnswered = Boolean(answers[question.id]);
                const isFlagged = flaggedQuestions.has(question.id);
                return (
                  <button
                    type="button"
                    key={question.id}
                    onClick={() => void goTo(questionIndex)}
                    disabled={navigationBusy}
                    aria-current={questionIndex === index ? 'step' : undefined}
                    className={`relative flex h-11 w-11 min-h-[44px] min-w-[44px] touch-manipulation items-center justify-center rounded-full text-sm font-black transition-all disabled:opacity-50 ${
                      inVisibleSet
                        ? 'bg-[#2D6A4F] text-white shadow-md ring-2 ring-emerald-200'
                        : isAnswered
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'border border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    {questionIndex + 1}
                    {isFlagged && (
                      <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-amber-950 ring-2 ring-white">
                        <Flag className="h-2.5 w-2.5" fill="currentColor" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <p className="mt-4 flex gap-1.5 text-xs leading-relaxed text-slate-500">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <span>
                Navigation, clipboard, printing, and exit events are audited. Offline state is
                continuously protected.
              </span>
            </p>
          </aside>
        </div>
      </main>
    </div>
  );
};

export default SecureExamination;
