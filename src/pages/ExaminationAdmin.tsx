import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  Clock3,
  Database,
  Eye,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Square,
  Unlock,
  Wifi,
  XCircle,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { ExaminationRepository } from '../examination/service';
import { examinationResultToQuizHistory } from '../examination/results';
import { ExaminationHighAvailability, type AuthorityStatusView } from '../examination/ha';
import { runDemoSimulation, type DemoSimulation } from '../examination/demo';
import { LanExamClient } from '../examination/network';
import {
  changeAdminPassword,
  changeBuilderPassword,
  isAdminGateUnlocked,
  lockAdminGate,
  markAdminGateUnlocked,
  verifyAdminPassword,
} from '../examination/adminGate';
import {
  createLanServerConfig,
  detectLanHost,
  isNativeLanServerAvailable,
  lanExamServerStatus,
  startLanExamServer,
  stopLanExamServer,
  type LanServerStatus,
} from '../examination/lanServer';
import type { ExaminationResult, ExamSession, StudentAttempt } from '../examination/types';
import PasswordInput from '../components/PasswordInput';
import { describeError } from '../utils/errorMessage';
import {
  buildKioskResultSyncItems,
  fetchCloudKioskResults,
  pushKioskResultsToCloud,
  type CloudKioskResult,
} from '../examination/resultsCloudSync';

const activeStatuses = [
  'ACTIVE',
  'PAUSED',
  'RECOVERY_PENDING',
  'DEVICE_LOST',
  'LOCKED',
  'SUBMITTED',
];
type Action = 'pause' | 'resume' | 'add' | 'remove' | 'force' | 'terminate' | 'unlock';

const ExaminationAdmin: React.FC = () => {
  const { state: appState, dispatch } = useApp();
  const [repository, setRepository] = useState<ExaminationRepository | null>(null);
  const [session, setSession] = useState<ExamSession | null>(null);
  const [attempts, setAttempts] = useState<StudentAttempt[]>([]);
  const [results, setResults] = useState<ExaminationResult[]>([]);
  const [authority, setAuthority] = useState<AuthorityStatusView | null>(null);
  const [selectedAttemptId, setSelectedAttemptId] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [adminId, setAdminId] = useState('local-admin');
  const [adminDevice, setAdminDevice] = useState('admin-device');
  const [reason, setReason] = useState('Authorized examination administration');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [demo, setDemo] = useState<DemoSimulation | null>(null);
  const [lanStatus, setLanStatus] = useState<LanServerStatus | null>(null);
  const [lanHost, setLanHost] = useState('');
  const [lanHostDetected, setLanHostDetected] = useState(false);
  // Open enrollment is the default: the promise to students is "connect to
  // the Wi-Fi and type nothing" — the token broadcast only authorises student
  // session routes, never admin actions, so zero-typing is the safe default.
  // The invigilator can still untick it for strict, read-the-board entry.
  const [openEnrollment, setOpenEnrollment] = useState(true);
  const [lanImportMessage, setLanImportMessage] = useState('');
  const [reviewResultId, setReviewResultId] = useState('');
  const [kioskResetBusyId, setKioskResetBusyId] = useState('');
  const [kioskResetMessage, setKioskResetMessage] = useState('');
  const [allTimeTab, setAllTimeTab] = useState<'offline' | 'cloud'>('offline');
  const [cloudResults, setCloudResults] = useState<CloudKioskResult[]>([]);
  const [cloudResultsMessage, setCloudResultsMessage] = useState('');
  const [cloudSyncBusy, setCloudSyncBusy] = useState(false);
  // Console password gate: students run the same app, so the admin console
  // renders nothing until the device's stored password is presented.
  const [gateUnlocked, setGateUnlocked] = useState(isAdminGateUnlocked());
  const [gatePassword, setGatePassword] = useState('');
  const [gateError, setGateError] = useState('');
  const [changeCurrent, setChangeCurrent] = useState('');
  const [changeNext, setChangeNext] = useState('');
  const [changeConfirm, setChangeConfirm] = useState('');
  const [changePhantom, setChangePhantom] = useState('');
  const [changeMessage, setChangeMessage] = useState('');
  // The exam builder's lock has its own password; it is changed from this
  // console, under the same two-secret rule (current password + phantom PIN).
  const [builderCurrent, setBuilderCurrent] = useState('');
  const [builderNext, setBuilderNext] = useState('');
  const [builderConfirm, setBuilderConfirm] = useState('');
  const [builderPhantom, setBuilderPhantom] = useState('');
  const [builderChangeMessage, setBuilderChangeMessage] = useState('');
  /** Stable for the page's life: the real TCP server only exists in the app. */
  const nativeHostAvailable = isNativeLanServerAvailable();

  // Prefill the advertised host with THIS device's Wi-Fi address. A hardcoded
  // 192.168.1.x guess was the silent killer: the server started fine and no
  // student could reach it. The field stays editable when detection fails.
  useEffect(() => {
    let disposed = false;
    void detectLanHost().then((host) => {
      if (disposed || !host) return;
      setLanHost(host);
      setLanHostDetected(true);
    });
    return () => {
      disposed = true;
    };
  }, []);
  const [lanToken, setLanToken] = useState('');
  const [selectedForRelease, setSelectedForRelease] = useState<Set<string>>(new Set());

  /**
   * Registers this device as the ADMIN device session so every control the
   * invigilator touches is audit-logged. The password gate decides whether
   * this runs at all; the registration itself is the audit hook, not the
   * security boundary.
   */
  const authenticateAdmin = useCallback(async () => {
    const opened = await ExaminationRepository.open();
    const existing = opened.snapshot.deviceSessions.find(
      (device) =>
        device.deviceId === adminDevice && device.role === 'ADMIN' && device.status === 'CONNECTED',
    );
    if (existing) {
      setAdminAuthenticated(true);
      setRepository(opened);
      setMessage('Authorized administrator device session restored.');
      return;
    }
    await opened.createDeviceSession({
      deviceId: adminDevice,
      role: 'ADMIN',
      capabilities: ['authority-control', 'live-dashboard', 'failover-review'],
    });
    setAdminAuthenticated(true);
    setRepository(opened);
    setMessage(
      'Administrator device session authorized locally; all controls are now audit logged.',
    );
  }, [adminDevice]);

  const refresh = useCallback(async () => {
    let opened = await ExaminationRepository.open();
    const allSessions = opened.snapshot.sessions;
    // The admin chooses which examination to view; by default the live (or
    // most recent) one is shown, and every past session stays visitable.
    const nextSession =
      allSessions.find((item) => item.id === selectedSessionId) ||
      allSessions.find((item) =>
        ['ACTIVE', 'CREATED', 'READY', 'RECOVERY'].includes(item.status),
      ) ||
      allSessions[allSessions.length - 1] ||
      null;

    let lan: LanServerStatus | null = null;
    try {
      lan = await lanExamServerStatus();
    } catch {
      lan = null;
    }
    // While the native authority runs, pull its authoritative view so the
    // invigilator sees every submitted attempt — with the work itself — even
    // though the students answered on their own devices.
    const authorityServesThisSession =
      !!lan?.running &&
      !!nextSession?.authorityAccessToken &&
      (!nextSession.authorityEndpoint || nextSession.authorityEndpoint === lan.endpoint);
    if (lan && authorityServesThisSession && nextSession) {
      try {
        const client = new LanExamClient(lan.endpoint, window.fetch.bind(window), {
          token: nextSession.authorityAccessToken,
        });
        const authorityState = await client.state(nextSession.id);
        const outcome = await opened.importLanAuthorityState(nextSession.id, authorityState);
        if (outcome.gradedResults > 0)
          setLanImportMessage(
            `Imported ${outcome.gradedResults} newly submitted attempt(s) from the LAN authority.`,
          );
        opened = await ExaminationRepository.open();
      } catch (error) {
        // The authority may be mid-restart; the manual import button reports details.
        console.warn('Automatic import from the LAN authority failed.', error);
      }
    }

    setRepository(opened);
    setSession(nextSession);
    if (nextSession?.authorityAccessToken) setLanToken(nextSession.authorityAccessToken);
    const sessionAttempts = nextSession
      ? opened.snapshot.attempts.filter((attempt) => attempt.sessionId === nextSession.id)
      : [];
    setAttempts(sessionAttempts.filter((attempt) => activeStatuses.includes(attempt.status)));
    const attemptIds = new Set(sessionAttempts.map((attempt) => attempt.id));
    setResults(opened.snapshot.results.filter((result) => attemptIds.has(result.attemptId)));
    if (!selectedAttemptId && sessionAttempts[0]) setSelectedAttemptId(sessionAttempts[0].id);
    try {
      const coordinator = new ExaminationHighAvailability(opened);
      setAuthority(await coordinator.initialize());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Authority status unavailable.');
    }
    setLanStatus(lan);
  }, [selectedAttemptId, selectedSessionId]);

  useEffect(() => {
    if (!gateUnlocked) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh, gateUnlocked]);

  // A tab that is already unlocked (reload in the same tab) re-registers the
  // admin device session without asking for the password again.
  useEffect(() => {
    if (gateUnlocked && !adminAuthenticated) void authenticateAdmin();
  }, [gateUnlocked, adminAuthenticated, authenticateAdmin]);

  const selected = attempts.find((attempt) => attempt.id === selectedAttemptId) || null;
  const selectedStudent = repository?.snapshot.students.find(
    (student) => student.id === selected?.studentId,
  );
  const selectedEvents =
    repository?.snapshot.securityEvents.filter((event) => event.attemptId === selected?.id) || [];
  const selectedActions =
    repository?.snapshot.adminActions.filter((action) => action.targetId === selected?.id) || [];
  const selectedResult = results.find((result) => result.attemptId === selected?.id);
  const stats = useMemo(
    () => ({
      connectedStudents:
        repository?.snapshot.deviceSessions.filter(
          (device) => device.role === 'STUDENT' && device.status === 'CONNECTED',
        ).length || 0,
      active: attempts.filter((attempt) => attempt.status === 'ACTIVE').length,
      submitted: attempts.filter((attempt) => attempt.status === 'SUBMITTED').length,
      disconnected: attempts.filter((attempt) =>
        ['DEVICE_LOST', 'RECOVERY_PENDING'].includes(attempt.status),
      ).length,
      recovery: attempts.filter((attempt) => attempt.status === 'RECOVERY_PENDING').length,
      recovered: results.filter((result) => result.recoveryHistory.length > 0).length,
      security: repository?.snapshot.securityEvents.length || 0,
    }),
    [attempts, repository, results],
  );

  const appendResultToQuizHistory = (attempt: StudentAttempt, opened: ExaminationRepository) => {
    const result = opened.getExaminationResult(attempt.id);
    const version = opened.snapshot.versions.find((item) => item.id === attempt.examVersionId);
    if (
      result &&
      version &&
      !appState.quizHistory.some((item) => item.examinationResultId === result.id)
    )
      dispatch({
        type: 'ADD_QUIZ_HISTORY',
        payload: examinationResultToQuizHistory(result, version),
      });
  };

  /**
   * Admin override for a student who forgot (or needs to invalidate) their
   * RX30 kiosk password. Draws a fresh random password exactly like
   * registration does and shows it once — the invigilator reads it to the
   * student the same way the kiosk screen would have.
   */
  const resetKioskPassword = async (studentId: string, studentName: string) => {
    if (!adminAuthenticated) {
      setMessage('Authenticate this administrator device before using live controls.');
      return;
    }
    const opened = repository || (await ExaminationRepository.open());
    setKioskResetBusyId(studentId);
    setKioskResetMessage('');
    try {
      const { password } = await opened.resetStudentKioskPassword(studentId);
      setKioskResetMessage(
        `New RX30 kiosk password for ${studentName}: ${password} — this is shown only once, share it with the student now.`,
      );
      await refresh();
    } catch (error) {
      setMessage(`Could not reset the kiosk password: ${describeError(error, 'unknown error')}`);
    } finally {
      setKioskResetBusyId('');
    }
  };

  /**
   * All-time kiosk results, straight from THIS device's local examination
   * state — every exam and session ever recorded here, not only the one
   * currently selected above. Always available, no internet required.
   */
  const allTimeOfflineResults = useMemo(() => {
    const snapshot = repository?.snapshot;
    if (!snapshot) return [];
    return snapshot.results
      .map((result) => {
        const student = snapshot.students.find((item) => item.id === result.studentId);
        const version = snapshot.versions.find((item) => item.id === result.examVersionId);
        if (!student || !version) return null;
        return {
          resultKey: result.id,
          studentFirstName: student.firstName,
          studentLevel: student.level,
          examTitle: version.title,
          scorePercentage: result.percentage,
          submittedAt: result.submittedAt,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  }, [repository]);

  /** Pushes every local result to this administrator's own cloud log. */
  const syncResultsToCloud = async () => {
    if (!repository) return;
    setCloudSyncBusy(true);
    setCloudResultsMessage('');
    try {
      const items = buildKioskResultSyncItems(
        repository.snapshot.results,
        repository.snapshot.students,
        repository.snapshot.versions,
      );
      const outcome = await pushKioskResultsToCloud(items, adminDevice);
      if (!outcome.ok) {
        setCloudResultsMessage(
          outcome.reason === 'offline'
            ? "You're offline right now — results stay safely on this device until you're back online."
            : 'Sign in to your PharmaTrack account to sync results to the cloud.',
        );
        return;
      }
      setCloudResultsMessage(
        `Synced ${outcome.synced} result(s) to the cloud${outcome.failed ? `, ${outcome.failed} failed` : ''}.`,
      );
      await loadCloudResults();
    } catch (error) {
      setCloudResultsMessage(`Could not sync results: ${describeError(error, 'unknown error')}`);
    } finally {
      setCloudSyncBusy(false);
    }
  };

  /** Reads back every result this administrator's account has ever synced. */
  const loadCloudResults = async () => {
    setCloudResultsMessage('');
    try {
      const outcome = await fetchCloudKioskResults();
      if (!outcome.ok) {
        setCloudResultsMessage(
          outcome.reason === 'offline'
            ? "You're offline right now."
            : 'Sign in to your PharmaTrack account to view the cloud results log.',
        );
        setCloudResults([]);
        return;
      }
      setCloudResults(outcome.results);
    } catch (error) {
      setCloudResultsMessage(`Could not load cloud results: ${describeError(error, 'unknown error')}`);
    }
  };

  const action = async (attempt: StudentAttempt, kind: Action) => {
    if (!adminAuthenticated) {
      setMessage('Authenticate this administrator device before using live controls.');
      return;
    }
    setBusy(true);
    try {
      const opened = await ExaminationRepository.open();
      if (kind === 'pause') await opened.pauseAttempt(attempt.id, adminId, adminDevice, reason);
      if (kind === 'resume') await opened.resumeAttempt(attempt.id, adminId, adminDevice, reason);
      if (kind === 'add')
        await opened.adjustAttemptTime(attempt.id, 5, adminId, adminDevice, reason);
      if (kind === 'remove')
        await opened.adjustAttemptTime(attempt.id, -5, adminId, adminDevice, reason);
      if (kind === 'force') {
        const completed = await opened.forceSubmitAttempt(attempt.id, adminId, adminDevice, reason);
        appendResultToQuizHistory(completed, opened);
      }
      if (kind === 'terminate')
        await opened.terminateAttempt(attempt.id, adminId, adminDevice, reason);
      if (kind === 'unlock') await opened.unlockAttempt(attempt.id, adminId, adminDevice, reason);
      setMessage(`${kind} recorded for ${attempt.id}.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Administrator action failed.');
    } finally {
      setBusy(false);
    }
  };

  const startLanServer = async () => {
    if (!nativeHostAvailable) {
      setMessage(
        'Browser preview cannot host the LAN authority — no browser may bind a TCP listener. Start it from the installed PharmaTRACK app running on the invigilator\'s machine.',
      );
      return;
    }
    if (!session || !repository) {
      setMessage(
        'No examination session exists on this device yet. A LAN authority serves one session: open the signed .pharmaexam package on the Kiosk Entry screen (or publish a version in the Builder) first, then come back and start the authority.',
      );
      return;
    }
    if (!lanHost.trim()) {
      setMessage(
        'Advertised LAN host is empty. Enter this machine\'s Wi-Fi address (or reconnect to the examination Wi-Fi so it can be auto-detected) — student devices connect straight to it.',
      );
      return;
    }
    setBusy(true);
    try {
      const config = createLanServerConfig(repository, session, lanHost.trim(), undefined, {
        openEnrollment,
      });
      const status = await startLanExamServer(config);
      await repository.setSessionAuthority(
        session.id,
        status.endpoint,
        config.accessToken,
        status.serverId,
        status.authorityEpoch,
      );
      setLanToken(config.accessToken);
      setLanStatus(status);
      setMessage(`LAN examination authority listening at ${status.endpoint}.`);
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The LAN examination server could not start.',
      );
    } finally {
      setBusy(false);
    }
  };

  const stopLanServer = async () => {
    setBusy(true);
    try {
      await stopLanExamServer();
      setLanStatus(await lanExamServerStatus());
      setMessage(
        'LAN examination authority stopped. Student devices retain encrypted local recovery state.',
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The LAN examination server could not stop.',
      );
    } finally {
      setBusy(false);
    }
  };

  const releaseResults = async (mode: 'all' | 'selected') => {
    if (!adminAuthenticated) {
      setMessage('Authenticate this administrator device before releasing results.');
      return;
    }
    if (!session) return;
    setBusy(true);
    try {
      const opened = await ExaminationRepository.open();
      if (mode === 'all') {
        const res = await opened.releaseAllResults(session.id, adminId, adminDevice, reason);
        setMessage(`Released examination results for ${res.releasedCount} student(s).`);
      } else {
        const toRelease = Array.from(selectedForRelease);
        if (toRelease.length === 0) {
          setMessage('No students selected for release.');
          return;
        }
        const res = await opened.releaseSelectedResults(
          session.id,
          toRelease,
          adminId,
          adminDevice,
          reason,
        );
        setMessage(`Released examination results for ${res.releasedCount} selected student(s).`);
        setSelectedForRelease(new Set());
      }
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Release failed.');
    } finally {
      setBusy(false);
    }
  };

  const revokeResults = async (mode: 'all' | 'selected') => {
    if (!adminAuthenticated) {
      setMessage('Authenticate this administrator device before revoking results.');
      return;
    }
    if (!session) return;
    setBusy(true);
    try {
      const opened = await ExaminationRepository.open();
      if (mode === 'all') {
        const res = await opened.revokeAllResults(session.id, adminId, adminDevice, reason);
        setMessage(`Revoked examination results visibility for ${res.revokedCount} student(s).`);
      } else {
        const toRevoke = Array.from(selectedForRelease);
        if (toRevoke.length === 0) {
          setMessage('No students selected to revoke.');
          return;
        }
        const res = await opened.revokeSelectedResults(
          session.id,
          toRevoke,
          adminId,
          adminDevice,
          reason,
        );
        setMessage(`Revoked examination results visibility for ${res.revokedCount} selected student(s).`);
        setSelectedForRelease(new Set());
      }
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Revoke failed.');
    } finally {
      setBusy(false);
    }
  };

  const toggleSelectRelease = (attemptId: string) => {
    setSelectedForRelease((prev) => {
      const next = new Set(prev);
      if (next.has(attemptId)) next.delete(attemptId);
      else next.add(attemptId);
      return next;
    });
  };

  const toggleSelectAllRelease = () => {
    if (selectedForRelease.size === results.length) {
      setSelectedForRelease(new Set());
    } else {
      setSelectedForRelease(new Set(results.map((r) => r.attemptId)));
    }
  };

  const archive = async () => {
    if (!adminAuthenticated) {
      setMessage('Authenticate this administrator device before archiving.');
      return;
    }
    if (!session) return;
    setBusy(true);
    try {
      const opened = await ExaminationRepository.open();
      await opened.archiveExam(session.examId, adminId, adminDevice, reason);
      setMessage('Examination archived with results and audit history retained.');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Archive failed.');
    } finally {
      setBusy(false);
    }
  };

  /** Password gate: unlock this tab's admin console. */
  const unlockAdminGate = async () => {
    setGateError('');
    setBusy(true);
    try {
      if (await verifyAdminPassword(gatePassword)) {
        markAdminGateUnlocked();
        setGateUnlocked(true);
        setGatePassword('');
      } else {
        setGateError('Incorrect administrator password.');
      }
    } catch (error) {
      // Never fail silently: a thrown error here used to leave the button
      // looking like it simply did nothing when clicked.
      setGateError(`Could not check the password: ${describeError(error, 'unknown error')}`);
    } finally {
      setBusy(false);
    }
  };

  /** Step away from the console: lock it now instead of waiting for the tab. */
  const lockConsoleNow = () => {
    lockAdminGate();
    setGateUnlocked(false);
    setAdminAuthenticated(false);
    setGatePassword('');
    setChangeCurrent('');
    setChangeNext('');
    setChangeConfirm('');
    setChangePhantom('');
    setChangeMessage('');
  };

  /** Change the console password — requires the current password and the
   *  phantom PIN configured at setup; nothing is stored in plaintext. */
  const performChangePassword = async () => {
    setChangeMessage('');
    if (changeNext !== changeConfirm) {
      setChangeMessage('The new password and its confirmation do not match.');
      return;
    }
    const result = await changeAdminPassword(changeCurrent, changeNext, changePhantom);
    if (result.ok) {
      setChangeMessage(
        'Administrator password changed. The console now unlocks with the new password.',
      );
      setChangeCurrent('');
      setChangeNext('');
      setChangeConfirm('');
      setChangePhantom('');
    } else if (result.error === 'wrong-password') {
      setChangeMessage('The current password is incorrect — nothing was changed.');
    } else if (result.error === 'wrong-phantom-pin') {
      setChangeMessage('The phantom PIN is incorrect — the password was not changed.');
    } else {
      setChangeMessage('The new password must be at least 8 characters.');
    }
  };

  /** Change the exam builder's password — same two-secret rule (current
   *  builder password + phantom PIN), reached from THIS console so an
   *  invigilator never has to hand a student the builder tab to rotate it. */
  const performChangeBuilderPassword = async () => {
    setBuilderChangeMessage('');
    if (builderNext !== builderConfirm) {
      setBuilderChangeMessage('The new builder password and its confirmation do not match.');
      return;
    }
    const result = await changeBuilderPassword(builderCurrent, builderNext, builderPhantom);
    if (result.ok) {
      setBuilderChangeMessage(
        'Builder password changed. The builder now unlocks with the new password.',
      );
      setBuilderCurrent('');
      setBuilderNext('');
      setBuilderConfirm('');
      setBuilderPhantom('');
    } else if (result.error === 'wrong-password') {
      setBuilderChangeMessage('The current builder password is incorrect — nothing was changed.');
    } else if (result.error === 'wrong-phantom-pin') {
      setBuilderChangeMessage('The phantom PIN is incorrect — the builder password was not changed.');
    } else {
      setBuilderChangeMessage('The new builder password must be at least 8 characters.');
    }
  };

  /**
   * Pull the authority's authoritative view of this session on demand. The
   * 5-second refresh already does this while the authority runs; the button
   * exists so the invigilator can force a pull (and see any error verbatim)
   * instead of wondering whether the table is current.
   */
  const importFromAuthority = async () => {    if (!session) return;
    setBusy(true);
    setLanImportMessage('');
    try {
      const status = await lanExamServerStatus();
      if (!status.running)
        throw new Error('The LAN authority is not running on this device.');
      if (!session.authorityAccessToken)
        throw new Error('This session has no authority token to authenticate with.');
      if (session.authorityEndpoint && session.authorityEndpoint !== status.endpoint)
        throw new Error('The running authority belongs to a different examination session.');
      const client = new LanExamClient(status.endpoint, window.fetch.bind(window), {
        token: session.authorityAccessToken,
      });
      const authorityState = await client.state(session.id);
      const outcome = await (await ExaminationRepository.open()).importLanAuthorityState(
        session.id,
        authorityState,
      );
      setLanImportMessage(
        `Imported from the authority: ${outcome.importedAttempts} new attempt(s), ` +
          `${outcome.updatedAttempts} refreshed, ${outcome.gradedResults} newly graded. ` +
          'Results and per-question work are now on this device permanently.',
      );
      await refresh();
    } catch (error) {
      setLanImportMessage(
        error instanceof Error ? error.message : 'Import from the LAN authority failed.',
      );
    } finally {
      setBusy(false);
    }
  };

  const failover = async () => {
    if (!adminAuthenticated) {
      setMessage('Authenticate this administrator device before failover.');
      return;
    }
    if (!authority) return;
    setBusy(true);
    try {
      const opened = await ExaminationRepository.open();
      const coordinator = new ExaminationHighAvailability(opened);
      await coordinator.initialize();
      await coordinator.promoteSecondary(
        adminId,
        adminDevice,
        reason,
        true,
        new Date(Date.now() + 10_000).toISOString(),
      );
      setMessage('Controlled failover completed. The secondary authority now owns the session.');
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Failover requires a stale primary and explicit confirmation.',
      );
    } finally {
      setBusy(false);
    }
  };

  const audit = repository
    ? [
        ...repository.snapshot.securityEvents.map((event) => ({
          id: event.id,
          type: event.type,
          at: event.at,
          details: event.details,
          severity: event.severity,
        })),
        ...repository.snapshot.adminActions.map((action) => ({
          id: action.id,
          type: `ADMIN_${action.action}`,
          at: action.at,
          details: `${action.reason || 'No reason'} · target ${action.targetId || '—'}`,
          severity: 'info' as const,
        })),
      ]
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 30)
    : [];
  const runDemo = async () => {
    setBusy(true);
    try {
      setDemo(await runDemoSimulation(50));
      setMessage(
        '50-student demo simulation completed without modifying the real examination state.',
      );
    } finally {
      setBusy(false);
    }
  };

  // Not unlocked: render ONLY the lock screen. No sessions, no results, no
  // student data — a student who navigates here sees nothing but the prompt.
  if (!gateUnlocked) {
    return (
      <div className="max-w-md mx-auto mt-16 space-y-4" data-testid="admin-gate-locked">
        <div className="rounded-2xl bg-gradient-to-r from-slate-950 to-[#1B4332] text-white p-6">
          <p className="text-xs uppercase tracking-widest text-emerald-300 font-black">
            Examination Authority
          </p>
          <h1 className="text-2xl font-black">Admin Examination Control Center</h1>
          <p className="text-white/70 mt-2 text-sm">
            This console is password-protected. Students cannot open it — enter the
            administrator password to continue.
          </p>
        </div>
        <form
          className="bg-white border rounded-2xl p-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void unlockAdminGate();
          }}
        >
          <label className="block text-sm font-black">
            Administrator password
            <PasswordInput
              autoComplete="current-password"
              value={gatePassword}
              onChange={(event) => setGatePassword(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 font-mono"
              placeholder="Console password"
              data-testid="admin-gate-password"
            />
          </label>
          {gateError && (
            <p className="text-sm font-bold text-red-700" data-testid="admin-gate-error">
              {gateError}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !gatePassword}
            className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 font-black disabled:opacity-40"
            data-testid="admin-gate-unlock"
          >
            {busy ? 'Checking…' : 'Unlock console'}
          </button>
          <p className="text-xs text-slate-500">
            The password is stored only as a salted hash on this device. Unlocking applies to
            this tab only; a new tab always starts locked.
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      <header className="rounded-2xl bg-gradient-to-r from-slate-950 to-[#1B4332] text-white p-6">
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-emerald-300 font-black">
              Examination Authority
            </p>
            <h1 className="text-3xl font-black">Admin Examination Control Center</h1>
            <p className="text-white/70 mt-2">
              Live state, results, failover, interventions, and append-only audit visibility.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() => void refresh()}
              className="rounded-lg bg-white/10 px-3 py-2 font-bold flex gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </button>
            <Link
              to="/examinations/builder"
              className="rounded-lg bg-emerald-400 text-slate-950 px-3 py-2 font-black"
            >
              Builder
            </Link>
          </div>
        </div>
      </header>

      {/* Session picker: every examination ever administered on this device
          stays visitable — live ones first, archived ones any time later. */}
      <section className="bg-white border rounded-2xl p-4 flex flex-wrap items-center gap-3" data-testid="session-picker">
        <label htmlFor="admin-session-picker" className="text-sm font-black whitespace-nowrap">
          Viewing examination
        </label>
        <select
          id="admin-session-picker"
          className="flex-1 min-w-[16rem] rounded-lg border px-3 py-2 text-sm font-bold bg-white"
          value={session?.id ?? ''}
          onChange={(event) => {
            setSelectedSessionId(event.target.value);
            setSelectedAttemptId('');
            setReviewResultId('');
            setSelectedForRelease(new Set());
          }}
        >
          {(repository?.snapshot.sessions ?? []).length === 0 && (
            <option value="">No examination sessions yet</option>
          )}
          {[...(repository?.snapshot.sessions ?? [])].reverse().map((item) => {
            const exam = repository?.snapshot.exams.find((candidate) => candidate.id === item.examId);
            return (
              <option key={item.id} value={item.id}>
                {exam?.title || 'Examination'} · {new Date(item.createdAt).toLocaleDateString()} ·{' '}
                {item.status}
                {item.status === 'CLOSED' ? ' (archived — still viewable)' : ''}
              </option>
            );
          })}
        </select>
        {lanStatus?.running && session?.authorityAccessToken && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void importFromAuthority()}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 text-xs font-black shadow-sm disabled:opacity-40"
            data-testid="import-from-authority"
          >
            Import work from the LAN authority
          </button>
        )}
        {lanImportMessage && (
          <p className="text-xs font-bold text-emerald-800 w-full" data-testid="lan-import-message">
            {lanImportMessage}
          </p>
        )}
        <p className="text-xs text-slate-500 w-full">
          While the LAN authority runs, every submitted attempt is pulled into this device's
          encrypted examination store automatically — scores, each student's answers, and the
          audit trail. Pick any past session above to revisit its results at any time.
        </p>
      </section>

      <section className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          ['Connected students', stats.connectedStudents],
          ['Active attempts', stats.active],
          ['Submitted', stats.submitted],
          ['Disconnected / recovery', stats.disconnected],
          ['Recovery pending', stats.recovery],
          ['Recovered attempts', stats.recovered],
          ['Security events', stats.security],
          [
            'Sync health',
            attempts.filter((item) => item.synchronizationState === 'SYNCHRONIZED').length +
              '/' +
              attempts.length,
          ],
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-white border rounded-xl p-4 shadow-sm">
            <p className="text-xs uppercase font-black text-slate-500">{label}</p>
            <p className="text-2xl font-black text-slate-900 mt-1">{value}</p>
          </div>
        ))}
      </section>
      <section className="grid lg:grid-cols-3 gap-3">
        <InfoCard
          icon={<Database />}
          label="Examination"
          value={session ? `${session.examId} · ${session.examVersionId}` : 'No active session'}
        />
        <InfoCard
          icon={<Wifi />}
          label="Server authority"
          value={
            authority ? `${authority.activeServerId} · epoch ${authority.primary.epoch}` : 'Loading'
          }
        />
        <InfoCard
          icon={<Clock3 />}
          label="Authority lease"
          value={
            authority?.lease
              ? `${authority.lease.serverId} until ${new Date(authority.lease.expiresAt).toLocaleTimeString()}`
              : 'Not established'
          }
        />
      </section>
      <section className="bg-white border rounded-2xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">Production LAN examination server</h2>
            <p className="text-sm text-slate-500">
              The Tauri host binds a real TCP authority on the LAN. Browser preview mode cannot
              listen for student devices and will not show a fake connected state.
            </p>
            {/* The start prerequisites, stated up front instead of a silently
                disabled button: the most common "it does nothing" report was
                exactly this — no session on the device yet. */}
            <p className="text-xs font-bold mt-2" data-testid="lan-start-prerequisites">
              <span className={nativeHostAvailable ? 'text-emerald-700' : 'text-amber-700'}>
                {nativeHostAvailable ? '✓ Native host ready' : '⚠ Browser preview — use the installed app'}
              </span>
              {' · '}
              <span className={session ? 'text-emerald-700' : 'text-amber-700'}>
                {session ? `✓ Session ${session.id}` : '⚠ No examination session yet'}
              </span>
              {!session && (
                <>
                  {' · '}
                  <Link to="/examinations/kiosk" className="text-blue-700 underline">
                    open a .pharmaexam on Kiosk Entry to create one
                  </Link>
                </>
              )}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() => void startLanServer()}
              data-testid="start-lan-authority"
              title={
                !nativeHostAvailable
                  ? 'Requires the installed PharmaTRACK app (desktop or Android)'
                  : !session
                    ? 'Requires an examination session — open a .pharmaexam on the Kiosk Entry screen first'
                    : 'Bind the LAN examination authority on this device'
              }
              className="rounded-lg bg-emerald-600 text-white px-4 py-2 font-black disabled:opacity-40"
            >
              Start LAN authority
            </button>
            <button
              disabled={busy || !lanStatus?.running}
              onClick={() => void stopLanServer()}
              className="rounded-lg border px-4 py-2 font-bold"
            >
              Stop
            </button>
          </div>
        </div>
        <div className="grid md:grid-cols-3 gap-3">
          <div className="text-sm font-bold">
            <span>Advertised LAN host/IP</span>
            <input
              value={lanHost}
              onChange={(event) => { setLanHost(event.target.value); setLanHostDetected(false); }}
              data-testid="lan-host-input"
              className="mt-1 w-full rounded-lg border px-3 py-2"
              placeholder="Auto-detected on this device — or type this machine's Wi-Fi IP"
            />
            <span className="mt-1 block text-xs font-semibold text-slate-500">
              {lanHostDetected
                ? 'Auto-detected: this device’s Wi-Fi address. Students must be on the same network.'
                : 'This must be THIS machine’s Wi-Fi address — student devices connect straight to it.'}
            </span>
            <label className="mt-2 flex items-start gap-2 text-xs font-bold" data-testid="open-enrollment-toggle">
              <input
                type="checkbox"
                checked={openEnrollment}
                onChange={(event) => setOpenEnrollment(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                Open enrollment — student apps on this Wi-Fi discover the authority automatically
                and join without typing the session token (their identity and the exam password
                still gate entry). The token only authorizes student routes, never admin actions.
              </span>
            </label>
          </div>
          <div className="rounded-lg bg-slate-50 border p-3 text-sm">
            <strong>Status</strong>
            <br />
            {lanStatus?.running
              ? `${lanStatus.endpoint} · revision ${lanStatus.revision}`
              : 'Stopped'}
            <br />
            <span className="text-slate-500">
              Connected {lanStatus?.activeConnections ?? 0} · active{' '}
              {lanStatus?.activeAttempts ?? 0} · submitted {lanStatus?.submittedAttempts ?? 0}
            </span>
            <br />
            <span className="text-slate-500">
              Discovery: {lanStatus?.discoveryEndpoint || '—'}
              {lanStatus?.running
                ? openEnrollment
                  ? ' · students on this Wi-Fi join automatically (open enrollment)'
                  : ' · students still enter the session token from the board'
                : ''}
            </span>
          </div>
          <label className="text-sm font-bold">
            Session token for student devices
            <PasswordInput
              readOnly
              value={lanToken}
              className="mt-1 w-full rounded-lg border px-3 py-2 font-mono"
              placeholder="Generated when server starts"
            />
          </label>
        </div>
      </section>
      <section className="bg-white border rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">Primary and secondary authority</h2>
            <p className="text-sm text-slate-500">
              Automatic failover is disabled to prevent split-brain; promotion requires explicit
              administrator confirmation.
            </p>
            <p className="text-xs font-black uppercase tracking-wide text-slate-600 mt-2">
              Replication state: {authority?.replicationState || 'UNKNOWN'} · epoch{' '}
              {authority?.secondary.epoch ?? '—'}
            </p>
          </div>
          <button
            disabled={
              busy ||
              !authority ||
              !adminAuthenticated ||
              authority.replicationState === 'INTERRUPTED'
            }
            onClick={() => void failover()}
            className="rounded-lg bg-amber-400 text-slate-950 px-4 py-2 font-black"
          >
            Confirm controlled failover
          </button>
        </div>
        <div className="grid md:grid-cols-2 gap-3 mt-4">
          <ServerCard title="Primary" server={authority?.primary} />
          <ServerCard title="Secondary" server={authority?.secondary} />
        </div>
      </section>
      <section className="grid lg:grid-cols-[280px_1fr] gap-5">
        <div className="bg-white border rounded-2xl p-4">
          <h2 className="font-black text-lg mb-3">Students and attempts</h2>
          {attempts.length === 0 && <p className="text-sm text-slate-500">No active attempts.</p>}
          {attempts.map((attempt) => (
            <button
              key={attempt.id}
              onClick={() => setSelectedAttemptId(attempt.id)}
              className={`w-full text-left border-b p-3 ${selected?.id === attempt.id ? 'bg-emerald-50 border-emerald-300' : 'hover:bg-slate-50'}`}
            >
              <strong>
                {repository?.snapshot.students.find((student) => student.id === attempt.studentId)
                  ?.firstName || attempt.studentId}
              </strong>
              <br />
              <span className="text-xs text-slate-500">
                {attempt.status} · Q
                {attempt.questionOrder.indexOf(attempt.currentQuestionId || '') + 1 || 1}/
                {attempt.questionOrder.length}
              </span>
            </button>
          ))}
        </div>
        <div>
          <StudentDetail
            attempt={selected}
            student={selectedStudent}
            result={selectedResult}
            events={selectedEvents}
            actions={selectedActions}
          />
          {selected && (
            <div className="mt-3 rounded-xl bg-white border p-3 flex flex-wrap gap-2">
              <button
                disabled={busy || !adminAuthenticated}
                onClick={() => void action(selected, 'pause')}
                className="rounded-lg border px-3 py-2 text-sm font-bold"
              >
                <Pause className="w-4 h-4 inline" /> Pause
              </button>
              <button
                disabled={busy || !adminAuthenticated}
                onClick={() => void action(selected, 'resume')}
                className="rounded-lg border px-3 py-2 text-sm font-bold"
              >
                <Play className="w-4 h-4 inline" /> Resume
              </button>
              <button
                disabled={busy || !adminAuthenticated}
                onClick={() => void action(selected, 'add')}
                className="rounded-lg bg-emerald-100 px-3 py-2 text-sm font-bold"
              >
                <Plus className="w-4 h-4 inline" /> +5 min
              </button>
              <button
                disabled={busy || !adminAuthenticated}
                onClick={() => void action(selected, 'remove')}
                className="rounded-lg bg-amber-100 px-3 py-2 text-sm font-bold"
              >
                −5 min
              </button>
              <button
                disabled={busy || !adminAuthenticated}
                onClick={() => void action(selected, 'unlock')}
                className="rounded-lg border px-3 py-2 text-sm font-bold"
              >
                <Unlock className="w-4 h-4 inline" /> Unlock
              </button>
              <button
                disabled={busy || !adminAuthenticated}
                onClick={() => void action(selected, 'force')}
                className="rounded-lg bg-amber-400 px-3 py-2 text-sm font-black"
              >
                Force submit
              </button>
              <button
                disabled={busy || !adminAuthenticated}
                onClick={() => void action(selected, 'terminate')}
                className="rounded-lg bg-red-100 text-red-800 px-3 py-2 text-sm font-black"
              >
                <Square className="w-4 h-4 inline" /> Terminate
              </button>
            </div>
          )}
        </div>
      </section>
      <section className="bg-white border rounded-2xl p-5 space-y-3">
        <div>
          <h2 className="text-xl font-black">Registered students & RX30 kiosk passwords</h2>
          <p className="text-sm text-slate-500">
            Every student who has registered on a kiosk, regardless of whether they have an
            attempt yet. Resetting issues a brand new random password and invalidates the old one.
          </p>
        </div>
        {kioskResetMessage && (
          <p className="text-sm font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
            {kioskResetMessage}
          </p>
        )}
        {(repository?.snapshot.students.length || 0) === 0 ? (
          <p className="text-sm text-slate-500">No students have registered yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-2">Student</th>
                  <th className="p-2">Level</th>
                  <th className="p-2">Registered</th>
                  <th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {repository?.snapshot.students.map((student) => (
                  <tr key={student.id} className="border-b last:border-0">
                    <td className="p-2 font-bold">{student.firstName}</td>
                    <td className="p-2">{student.level}</td>
                    <td className="p-2 text-slate-500">
                      {new Date(student.registeredAt).toLocaleString()}
                    </td>
                    <td className="p-2">
                      <button
                        disabled={!adminAuthenticated || kioskResetBusyId === student.id}
                        onClick={() => void resetKioskPassword(student.id, student.firstName)}
                        className="rounded-lg border px-3 py-1.5 text-xs font-bold disabled:opacity-40"
                      >
                        {kioskResetBusyId === student.id ? 'Resetting…' : 'Reset RX30 password'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="bg-white border rounded-2xl p-5 space-y-3">
        <div>
          <h2 className="text-xl font-black">All-time kiosk exam results</h2>
          <p className="text-sm text-slate-500">
            Every kiosk exam ever recorded, not just the session selected above. "This device" is
            always available offline; "Cloud" is an optional, explicit sync to your own
            PharmaTrack account so results can be checked from anywhere.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setAllTimeTab('offline')}
            className={`rounded-lg px-3 py-1.5 text-xs font-black ${allTimeTab === 'offline' ? 'bg-slate-800 text-white' : 'border'}`}
          >
            This device (offline)
          </button>
          <button
            type="button"
            onClick={() => {
              setAllTimeTab('cloud');
              void loadCloudResults();
            }}
            className={`rounded-lg px-3 py-1.5 text-xs font-black ${allTimeTab === 'cloud' ? 'bg-slate-800 text-white' : 'border'}`}
          >
            Cloud (all devices)
          </button>
          {allTimeTab === 'cloud' && (
            <button
              type="button"
              disabled={cloudSyncBusy || !repository}
              onClick={() => void syncResultsToCloud()}
              className="rounded-lg border px-3 py-1.5 text-xs font-bold disabled:opacity-40"
            >
              {cloudSyncBusy ? 'Syncing…' : 'Sync this device now'}
            </button>
          )}
        </div>
        {allTimeTab === 'cloud' && cloudResultsMessage && (
          <p className="text-sm font-semibold text-slate-700 bg-slate-50 border rounded-lg p-3">
            {cloudResultsMessage}
          </p>
        )}
        {(() => {
          const rows = allTimeTab === 'offline' ? allTimeOfflineResults : cloudResults;
          if (rows.length === 0)
            return (
              <p className="text-sm text-slate-500">
                {allTimeTab === 'offline'
                  ? 'No kiosk exam results recorded on this device yet.'
                  : 'No results synced to the cloud yet.'}
              </p>
            );
          return (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="p-2">Student</th>
                    <th className="p-2">Level</th>
                    <th className="p-2">Exam</th>
                    <th className="p-2">Score</th>
                    <th className="p-2">Date & time</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.resultKey} className="border-b last:border-0">
                      <td className="p-2 font-bold">{row.studentFirstName}</td>
                      <td className="p-2">{row.studentLevel}</td>
                      <td className="p-2">{row.examTitle}</td>
                      <td className="p-2">{Math.round(row.scorePercentage)}%</td>
                      <td className="p-2 text-slate-500">
                        {new Date(row.submittedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })()}
      </section>
      <section className="bg-white border rounded-2xl p-5 space-y-4">
        <div className="flex flex-wrap justify-between items-center gap-3">
          <div>
            <h2 className="text-xl font-black">Examination-wide results</h2>
            <p className="text-sm text-slate-500">
              Configured visibility:{' '}
              <span className="font-bold text-slate-800">
                {repository?.snapshot.versions.find((v) => v.id === session?.examVersionId)
                  ?.resultVisibilityPolicy || 'IMMEDIATE'}
              </span>{' '}
              · {results.length} completed attempt(s)
            </p>
          </div>
          <button
            disabled={busy || !session || !adminAuthenticated}
            onClick={() => void archive()}
            className="rounded-lg border px-3 py-2 text-sm font-bold"
          >
            Archive examination
          </button>
        </div>

        {/* Release Results Controls Panel */}
        <div className="rounded-xl border bg-slate-50 p-4 space-y-3">
          <div className="flex flex-wrap justify-between items-center gap-2">
            <div>
              <h3 className="font-black text-sm flex items-center gap-2">
                <Eye className="w-4 h-4 text-emerald-700" /> Release Results
              </h3>
              <p className="text-xs text-slate-500">
                Control student result visibility. Release state is stored independently and never modifies scores.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                disabled={busy || !adminAuthenticated || !session}
                onClick={() => void releaseResults('all')}
                className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs font-black shadow-sm"
              >
                Release All
              </button>
              <button
                disabled={busy || !adminAuthenticated || !session || selectedForRelease.size === 0}
                onClick={() => void releaseResults('selected')}
                className="rounded-lg bg-emerald-100 hover:bg-emerald-200 text-emerald-900 border border-emerald-300 px-3 py-1.5 text-xs font-black disabled:opacity-40"
              >
                Release Selected ({selectedForRelease.size})
              </button>
              <button
                disabled={busy || !adminAuthenticated || !session || selectedForRelease.size === 0}
                onClick={() => void revokeResults('selected')}
                className="rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 px-3 py-1.5 text-xs font-black disabled:opacity-40"
              >
                Keep Hidden ({selectedForRelease.size})
              </button>
              <button
                disabled={busy || !adminAuthenticated || !session}
                onClick={() => void revokeResults('all')}
                className="rounded-lg border border-slate-300 bg-white hover:bg-slate-100 px-3 py-1.5 text-xs font-bold"
              >
                Keep All Hidden
              </button>
            </div>
          </div>
        </div>

        {results.length === 0 ? (
          <p className="text-sm text-slate-500">No completed Kiosk Examination results yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-2 w-8">
                    <input
                      type="checkbox"
                      checked={results.length > 0 && selectedForRelease.size === results.length}
                      onChange={toggleSelectAllRelease}
                    />
                  </th>
                  <th className="p-2">Student</th>
                  <th className="p-2">Attempt</th>
                  <th className="p-2">Score</th>
                  <th className="p-2">Visibility</th>
                  <th className="p-2">Release Info</th>
                  <th className="p-2">Answered</th>
                  <th className="p-2">Submitted</th>
                  <th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody>

                {results.map((result) => {
                  const student = repository?.snapshot.students.find(
                    (s) => s.id === result.studentId,
                  );
                  const attemptObj = repository?.snapshot.attempts.find(
                    (a) => a.id === result.attemptId,
                  );
                  const versionObj = repository?.snapshot.versions.find(
                    (v) => v.id === result.examVersionId,
                  );
                  const relRecord = repository?.getResultReleaseRecord(result.attemptId);
                  const relStatus = repository?.getResultReleaseStatus(result.attemptId) || 'HIDDEN';
                  const attemptPolicy =
                    attemptObj?.settingsSnapshot?.resultVisibilityPolicy ||
                    versionObj?.resultVisibilityPolicy ||
                    'IMMEDIATE';

                  return (
                    <tr key={result.id} className="border-b hover:bg-slate-50">
                      <td className="p-2">
                        <input
                          type="checkbox"
                          checked={selectedForRelease.has(result.attemptId)}
                          onChange={() => toggleSelectRelease(result.attemptId)}
                        />
                      </td>
                      <td className="p-2 font-bold">{student?.firstName || result.studentId}</td>
                      <td className="p-2 text-xs font-mono">{result.attemptId}</td>
                      <td className="p-2 font-black text-emerald-800">
                        {result.score}/{result.maxMarks} ({result.percentage}%)
                      </td>
                      <td className="p-2">
                        {attemptPolicy === 'NEVER' ? (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-slate-200 text-slate-700 font-bold">
                            🚫 Never
                          </span>
                        ) : attemptPolicy === 'IMMEDIATE' ? (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold">
                            🟢 Immediate
                          </span>
                        ) : relStatus === 'RELEASED' ? (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold">
                            🟢 Released
                          </span>
                        ) : relStatus === 'PENDING_SYNC' ? (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-bold">
                            🔄 Pending synchronization
                          </span>
                        ) : relStatus === 'FAILED' ? (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-rose-100 text-rose-800 font-bold">
                            ⚠️ Release failed
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-bold">
                            🔒 Hidden
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-xs text-slate-500">
                        {relRecord?.releasedAt ? (
                          <>
                            Released by {relRecord.releasedByAdminId}
                            <br />
                            {new Date(relRecord.releasedAt).toLocaleTimeString()}
                          </>
                        ) : relRecord?.revokedAt ? (
                          <>
                            Revoked by {relRecord.revokedByAdminId}
                            <br />
                            {new Date(relRecord.revokedAt).toLocaleTimeString()}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="p-2">
                        {result.answerStatistics.answered}/
                        {result.answerStatistics.answered + result.answerStatistics.unanswered}
                      </td>
                      <td className="p-2 text-xs">
                        {new Date(result.submittedAt).toLocaleTimeString()}
                      </td>
                      <td className="p-2">
                        <div className="flex gap-1">
                          <button
                            onClick={() =>
                              setReviewResultId(
                                reviewResultId === result.id ? '' : result.id,
                              )
                            }
                            className="px-2 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-white font-bold"
                            data-testid={`review-work-${result.attemptId}`}
                          >
                            {reviewResultId === result.id ? 'Close work' : 'Review work'}
                          </button>
                          {attemptPolicy === 'ON_RELEASE' && (
                          <div className="flex gap-1">
                            {relStatus !== 'RELEASED' ? (
                              <button
                                disabled={busy || !adminAuthenticated}
                                onClick={async () => {
                                  if (!repository) return;
                                  await repository.releaseResultForAttempt(
                                    result.attemptId,
                                    adminId,
                                    adminDevice,
                                    reason,
                                  );
                                  await refresh();
                                }}
                                className="px-2 py-1 text-xs rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
                              >
                                Release
                              </button>
                            ) : (
                              <button
                                disabled={busy || !adminAuthenticated}
                                onClick={async () => {
                                  if (!repository) return;
                                  await repository.revokeResultForAttempt(
                                    result.attemptId,
                                    adminId,
                                    adminDevice,
                                    reason,
                                  );
                                  await refresh();
                                }}
                                className="px-2 py-1 text-xs rounded bg-amber-100 hover:bg-amber-200 text-amber-900 border font-bold"
                              >
                                Revoke
                              </button>
                            )}
                          </div>
                        )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Per-question work review: the invigilator sees exactly what each
            student wrote, question by question, with the marking. */}
        {results
          .filter((result) => result.id === reviewResultId)
          .map((result) => {
            const version = repository?.snapshot.versions.find(
              (candidate) => candidate.id === result.examVersionId,
            );
            const student = repository?.snapshot.students.find(
              (candidate) => candidate.id === result.studentId,
            );
            return (
              <div
                key={result.id}
                data-testid="result-work-review"
                className="rounded-xl border-2 border-emerald-300 bg-emerald-50/60 p-4 space-y-3"
              >
                <div className="flex flex-wrap justify-between items-center gap-2">
                  <div>
                    <h3 className="font-black text-slate-900">
                      {student?.firstName || result.studentId} — submitted work
                    </h3>
                    <p className="text-xs text-slate-600">
                      {result.score}/{result.maxMarks} ({result.percentage}%) ·{' '}
                      {result.answerStatistics.correct} correct ·{' '}
                      {result.answerStatistics.incorrect} incorrect ·{' '}
                      {result.answerStatistics.unanswered} unanswered ·{' '}
                      {Math.round(result.durationSeconds / 60)} min · submitted{' '}
                      {new Date(result.submittedAt).toLocaleString()}
                    </p>
                  </div>
                  <button
                    onClick={() => setReviewResultId('')}
                    className="rounded-lg border px-3 py-1 text-xs font-bold"
                  >
                    Close review
                  </button>
                </div>
                {result.securityEventSummary &&
                  Object.keys(result.securityEventSummary).length > 0 && (
                    <p className="text-xs text-amber-800 font-bold">
                      Security:{' '}
                      {Object.entries(result.securityEventSummary)
                        .map(([type, count]) => `${type} ×${count}`)
                        .join(' · ')}
                    </p>
                  )}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm bg-white rounded-lg border">
                    <thead className="bg-slate-100 text-left text-xs uppercase">
                      <tr>
                        <th className="p-2">#</th>
                        <th className="p-2">Question</th>
                        <th className="p-2">Student's answer</th>
                        <th className="p-2">Correct answer</th>
                        <th className="p-2">Marks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.questionResults.map((questionResult, index) => {
                        const question = version?.questions.find(
                          (candidate) => candidate.id === questionResult.questionId,
                        );
                        const optionText =
                          question?.options &&
                          questionResult.answer !== '' &&
                          /^\d+$/.test(questionResult.answer)
                            ? question.options[Number(questionResult.answer)]
                            : undefined;
                        const correctText = question?.options
                          ? question.correctOption != null
                            ? question.options[question.correctOption]
                            : question.correctAnswer
                          : undefined;
                        return (
                          <tr
                            key={questionResult.questionId}
                            className={
                              questionResult.isCorrect
                                ? 'border-b bg-emerald-50'
                                : questionResult.answer.trim()
                                  ? 'border-b bg-red-50'
                                  : 'border-b bg-slate-50'
                            }
                          >
                            <td className="p-2 font-black">{index + 1}</td>
                            <td className="p-2">
                              <p className="font-bold">{question?.questionText || 'Question unavailable'}</p>
                              {question?.explanation && (
                                <p className="text-xs text-slate-500 mt-1">{question.explanation}</p>
                              )}
                            </td>
                            <td className="p-2 font-bold">
                              {questionResult.answer.trim()
                                ? optionText || questionResult.answer
                                : '— not answered —'}
                            </td>
                            <td className="p-2 text-xs text-slate-600">{correctText ?? '—'}</td>
                            <td className="p-2 font-black whitespace-nowrap">
                              {questionResult.marksAwarded}/{questionResult.maxMarks}{' '}
                              {questionResult.isCorrect ? '✓' : '✗'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}

        {/* Release Audit Trail */}
        {repository && repository.snapshot.resultReleaseAudits.length > 0 && (
          <div className="border-t pt-4">
            <h3 className="font-black text-sm mb-2 text-slate-800">Result Release Audit Trail</h3>
            <div className="max-h-40 overflow-y-auto space-y-1.5 text-xs">
              {repository.snapshot.resultReleaseAudits
                .slice(-10)
                .reverse()
                .map((audit) => (
                  <div
                    key={audit.id}
                    className="p-2 rounded bg-slate-50 border flex justify-between items-center"
                  >
                    <div>
                      <span className="font-bold">
                        {audit.previousState} → {audit.newState}
                      </span>
                      <span className="text-slate-500 ml-2">Attempt: {audit.attemptId}</span>
                      <span className="text-slate-400 ml-2">
                        by {audit.adminId} ({audit.adminDeviceSessionId})
                      </span>
                    </div>
                    <div className="text-slate-500">
                      Epoch {audit.authorityEpoch} ·{' '}
                      {new Date(audit.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}
      </section>
      <section className="bg-white border rounded-2xl p-5">
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">Demo examination mode</h2>
            <p className="text-sm text-slate-500">
              Simulates LAN outage, device replacement, admin replacement, failover, reconciliation,
              timer controls, submission, and archive without mutating live state.
            </p>
          </div>
          <button
            disabled={busy}
            onClick={() => void runDemo()}
            className="rounded-lg bg-slate-900 text-white px-4 py-2 font-bold"
          >
            Run 50-student demo
          </button>
        </div>
        {demo && (
          <div className="grid sm:grid-cols-3 gap-2 mt-4 text-sm">
            <Data label="Students" value={String(demo.studentCount)} />
            <Data
              label="Package transfers"
              value={demo.packageStagedOnce ? '1 (staged)' : 'repeated'}
            />
            <Data label="Expected authority" value={demo.expectedAuthority} />
            <Data label="Reconciled events" value={String(demo.reconciledEvents)} />
            <Data label="Results" value={String(demo.results)} />
            <Data label="Demo audit events" value={String(demo.auditEvents)} />
          </div>
        )}
      </section>
      <section className="bg-white border rounded-2xl p-5">
        <h2 className="text-xl font-black mb-3">Append-only audit trail</h2>
        <p className="text-sm text-slate-500 mb-3">
          The normal UI exposes events for review but has no edit or delete operation.
        </p>
        <div className="max-h-72 overflow-y-auto space-y-2">
          {audit.map((event) => (
            <div key={event.id} className="text-xs border-l-2 border-emerald-500 pl-3">
              <strong>{event.type}</strong> · {new Date(event.at).toLocaleString()} ·{' '}
              {event.severity}
              <br />
              <span className="text-slate-500">{event.details}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-2xl bg-white border p-5 grid md:grid-cols-4 gap-3">
        <div className="flex items-end">
          <button
            disabled={busy}
            onClick={() => void authenticateAdmin()}
            className={`w-full rounded-lg px-3 py-2 font-black ${adminAuthenticated ? 'bg-emerald-100 text-emerald-900' : 'bg-slate-900 text-white'}`}
          >
            {adminAuthenticated ? 'Admin device authenticated' : 'Authenticate admin device'}
          </button>
        </div>
        <label className="text-sm font-bold">
          Admin identity
          <input
            value={adminId}
            onChange={(event) => setAdminId(event.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2"
          />
        </label>
        <label className="text-sm font-bold">
          Admin device/session
          <input
            value={adminDevice}
            onChange={(event) => setAdminDevice(event.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2"
          />
        </label>
        <label className="text-sm font-bold">
          Reason
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2"
          />
        </label>
      </section>

      {/* Administrator access: change the console password (requires the
          phantom PIN) and lock the console when stepping away. */}
      <section className="bg-white border rounded-2xl p-5 space-y-4" data-testid="admin-password-change">
        <div className="flex flex-wrap justify-between items-center gap-2">
          <div>
            <h2 className="text-xl font-black">Administrator access</h2>
            <p className="text-sm text-slate-500">
              The console password keeps students out of this screen. Changing it requires the
              phantom PIN configured at setup; both are stored only as salted hashes on this
              device.
            </p>
          </div>
          <button
            type="button"
            onClick={lockConsoleNow}
            className="rounded-lg bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 font-black"
            data-testid="admin-lock-now"
          >
            Lock console now
          </button>
        </div>
        <form
          className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void performChangePassword();
          }}
        >
          <label className="text-sm font-bold">
            Current password
            <PasswordInput
              autoComplete="current-password"
              value={changeCurrent}
              onChange={(event) => setChangeCurrent(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 font-mono"
              data-testid="admin-change-current"
            />
          </label>
          <label className="text-sm font-bold">
            New password
            <PasswordInput
              autoComplete="new-password"
              value={changeNext}
              onChange={(event) => setChangeNext(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 font-mono"
              data-testid="admin-change-next"
            />
          </label>
          <label className="text-sm font-bold">
            Confirm new password
            <PasswordInput
              autoComplete="new-password"
              value={changeConfirm}
              onChange={(event) => setChangeConfirm(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 font-mono"
              data-testid="admin-change-confirm"
            />
          </label>
          <label className="text-sm font-bold">
            Phantom PIN (authorises the change)
            <PasswordInput
              autoComplete="off"
              value={changePhantom}
              onChange={(event) => setChangePhantom(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 font-mono"
              data-testid="admin-change-phantom"
            />
          </label>
          <div className="sm:col-span-2 lg:col-span-4 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy || !changeCurrent || !changeNext || !changeConfirm || !changePhantom}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 font-black disabled:opacity-40"
              data-testid="admin-change-submit"
            >
              Change console password
            </button>
            {changeMessage && (
              <p className="text-sm font-bold" data-testid="admin-change-message">
                {changeMessage}
              </p>
            )}
          </div>
        </form>
      </section>

      {/* Exam builder access: the builder's lock has its own password, and it
          is rotated from HERE (the live admin) so the change is authorised by
          the phantom PIN — the builder tab itself never changes secrets. */}
      <section className="bg-white border rounded-2xl p-5 space-y-4" data-testid="admin-builder-password-change">
        <div>
          <h2 className="text-xl font-black">Exam builder access</h2>
          <p className="text-sm text-slate-500">
            The Formal Examination Builder is locked with its own password (it publishes signed
            examination packages). Changing that password here requires the current builder
            password and the phantom PIN; the console password is unaffected.
          </p>
        </div>
        <form
          className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void performChangeBuilderPassword();
          }}
        >
          <label className="text-sm font-bold">
            Current builder password
            <PasswordInput
              autoComplete="current-password"
              value={builderCurrent}
              onChange={(event) => setBuilderCurrent(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 font-mono"
              data-testid="admin-change-builder-current"
            />
          </label>
          <label className="text-sm font-bold">
            New builder password
            <PasswordInput
              autoComplete="new-password"
              value={builderNext}
              onChange={(event) => setBuilderNext(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 font-mono"
              data-testid="admin-change-builder-next"
            />
          </label>
          <label className="text-sm font-bold">
            Confirm new builder password
            <PasswordInput
              autoComplete="new-password"
              value={builderConfirm}
              onChange={(event) => setBuilderConfirm(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 font-mono"
              data-testid="admin-change-builder-confirm"
            />
          </label>
          <label className="text-sm font-bold">
            Phantom PIN (authorises the change)
            <PasswordInput
              autoComplete="off"
              value={builderPhantom}
              onChange={(event) => setBuilderPhantom(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 font-mono"
              data-testid="admin-change-builder-phantom"
            />
          </label>
          <div className="sm:col-span-2 lg:col-span-4 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy || !builderCurrent || !builderNext || !builderConfirm || !builderPhantom}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 font-black disabled:opacity-40"
              data-testid="admin-change-builder-submit"
            >
              Change builder password
            </button>
            {builderChangeMessage && (
              <p className="text-sm font-bold" data-testid="admin-change-builder-message">
                {builderChangeMessage}
              </p>
            )}
          </div>
        </form>
      </section>
      {message && <p className="rounded-lg bg-slate-100 p-3 font-semibold">{message}</p>}
    </div>
  );
};

const InfoCard: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({
  icon,
  label,
  value,
}) => (
  <div className="bg-white border rounded-xl p-4 flex gap-3">
    <span className="text-emerald-700">{icon}</span>
    <div>
      <p className="text-xs uppercase font-black text-slate-500">{label}</p>
      <p className="font-bold text-sm break-all">{value}</p>
    </div>
  </div>
);
const ServerCard: React.FC<{ title: string; server?: AuthorityStatusView['primary'] }> = ({
  title,
  server,
}) => (
  <div className="rounded-xl border p-4">
    <div className="flex justify-between">
      <strong>{title}</strong>
      {server?.status === 'PRIMARY' || server?.status === 'SECONDARY' ? (
        <CheckCircle2 className="w-5 h-5 text-emerald-600" />
      ) : (
        <XCircle className="w-5 h-5 text-amber-600" />
      )}
    </div>
    <p className="text-sm mt-2">
      {server ? `${server.label} · ${server.serverId}` : 'Unavailable'}
    </p>
    <p className="text-xs text-slate-500">
      Status: {server?.status || 'unknown'} · heartbeat:{' '}
      {server ? new Date(server.lastHeartbeatAt).toLocaleTimeString() : '—'} · revision{' '}
      {server?.revision ?? '—'}
    </p>
  </div>
);

const StudentDetail: React.FC<{
  attempt: StudentAttempt | null;
  student?: { firstName: string; level: string; id: string };
  result?: ExaminationResult;
  events: Array<{ id: string; type: string; at: string; details?: string }>;
  actions: Array<{ id: string; action: string; at: string; reason?: string }>;
}> = ({ attempt, student, result, events, actions }) => {
  if (!attempt)
    return (
      <div className="bg-white border rounded-2xl p-8 text-slate-500">
        Select a student attempt to view non-sensitive operational detail.
      </div>
    );
  const answered = attempt.answers.filter((answer) => answer.answer.trim()).length;
  return (
    <div className="bg-white border rounded-2xl p-5">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-xl font-black">{student?.firstName || attempt.studentId}</h2>
          <p className="text-sm text-slate-500">
            Level {student?.level || '—'} · Kiosk identity {student?.id || attempt.studentId}
          </p>
        </div>
        <span className="rounded-lg bg-slate-100 px-3 py-2 font-black">{attempt.status}</span>
      </div>
      <div className="grid sm:grid-cols-3 gap-3 mt-4 text-sm">
        <Data
          label="Current question"
          value={`${attempt.questionOrder.indexOf(attempt.currentQuestionId || '') + 1 || 1}/${attempt.questionOrder.length}`}
        />
        <Data label="Answered" value={`${answered}/${attempt.questionOrder.length}`} />
        <Data
          label="Remaining time"
          value={`${Math.max(0, Math.floor((new Date(attempt.deadlineAt).getTime() - Date.now()) / 60000))} minutes`}
        />
        <Data label="Device" value={attempt.deviceSessionId} />
        <Data label="LAN/sync" value={attempt.synchronizationState || 'LOCAL_ONLY'} />
        <Data label="Recovery" value={attempt.recoveryStateId || 'None'} />
      </div>
      {result && (
        <div className="mt-4 rounded-lg bg-emerald-50 p-3 font-bold">
          Result: {result.score}/{result.maxMarks} ({result.percentage}%) ·{' '}
          {result.answerStatistics.correct} correct, {result.answerStatistics.incorrect} incorrect
        </div>
      )}
      <div className="mt-4 grid md:grid-cols-2 gap-4">
        <div>
          <h3 className="font-black mb-2">Security events</h3>
          {events.length ? (
            events.slice(-8).map((event) => (
              <p key={event.id} className="text-xs border-l-2 border-amber-400 pl-2 mb-2">
                {event.type} · {new Date(event.at).toLocaleTimeString()}
                <br />
                {event.details}
              </p>
            ))
          ) : (
            <p className="text-xs text-slate-500">None</p>
          )}
        </div>
        <div>
          <h3 className="font-black mb-2">Administrator actions</h3>
          {actions.length ? (
            actions.map((action) => (
              <p key={action.id} className="text-xs border-l-2 border-emerald-400 pl-2 mb-2">
                {action.action} · {new Date(action.at).toLocaleTimeString()}
                <br />
                {action.reason}
              </p>
            ))
          ) : (
            <p className="text-xs text-slate-500">None</p>
          )}
        </div>
      </div>
    </div>
  );
};
const Data: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg bg-slate-50 p-3">
    <p className="text-xs uppercase font-black text-slate-500">{label}</p>
    <p className="font-bold break-all">{value}</p>
  </div>
);

export default ExaminationAdmin;
