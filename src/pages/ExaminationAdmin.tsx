import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  Clock3,
  Database,
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
import {
  createLanServerConfig,
  isNativeLanServerAvailable,
  lanExamServerStatus,
  startLanExamServer,
  stopLanExamServer,
  type LanServerStatus,
} from '../examination/lanServer';
import type { ExaminationResult, ExamSession, StudentAttempt } from '../examination/types';

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
  const [adminId, setAdminId] = useState('local-admin');
  const [adminDevice, setAdminDevice] = useState('admin-device');
  const [reason, setReason] = useState('Authorized examination administration');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [demo, setDemo] = useState<DemoSimulation | null>(null);
  const [lanStatus, setLanStatus] = useState<LanServerStatus | null>(null);
  const [lanHost, setLanHost] = useState('192.168.1.20');
  const [lanToken, setLanToken] = useState('');

  const refresh = useCallback(async () => {
    const opened = await ExaminationRepository.open();
    const nextSession =
      opened.snapshot.sessions.find((item) =>
        ['ACTIVE', 'CREATED', 'READY', 'RECOVERY'].includes(item.status),
      ) ||
      opened.snapshot.sessions[opened.snapshot.sessions.length - 1] ||
      null;
    setRepository(opened);
    setSession(nextSession);
    if (nextSession?.authorityAccessToken) setLanToken(nextSession.authorityAccessToken);
    setAttempts(
      opened.snapshot.attempts.filter((attempt) => activeStatuses.includes(attempt.status)),
    );
    setResults(opened.snapshot.results);
    if (!selectedAttemptId && opened.snapshot.attempts[0])
      setSelectedAttemptId(opened.snapshot.attempts[0].id);
    try {
      const coordinator = new ExaminationHighAvailability(opened);
      setAuthority(await coordinator.initialize());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Authority status unavailable.');
    }
    try {
      setLanStatus(await lanExamServerStatus());
    } catch {
      setLanStatus(null);
    }
  }, [selectedAttemptId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

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

  const authenticateAdmin = async () => {
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
    if (!session || !repository) return;
    if (!isNativeLanServerAvailable()) {
      setMessage('The real LAN server runs from the authorized Tauri admin/examination host.');
      return;
    }
    setBusy(true);
    try {
      const config = createLanServerConfig(repository, session, lanHost.trim());
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
          </div>
          <div className="flex gap-2">
            <button
              disabled={busy || !session}
              onClick={() => void startLanServer()}
              className="rounded-lg bg-emerald-600 text-white px-4 py-2 font-black"
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
          <label className="text-sm font-bold">
            Advertised LAN host/IP
            <input
              value={lanHost}
              onChange={(event) => setLanHost(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2"
              placeholder="192.168.1.20"
            />
          </label>
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
            <span className="text-slate-500">Discovery: {lanStatus?.discoveryEndpoint || '—'}</span>
          </div>
          <label className="text-sm font-bold">
            Session token for student devices
            <input
              type="password"
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
          </div>
          <button
            disabled={busy || !authority || !adminAuthenticated}
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
      <section className="bg-white border rounded-2xl p-5">
        <div className="flex flex-wrap justify-between gap-3">
          <h2 className="text-xl font-black mb-3">Examination-wide results</h2>
          <button
            disabled={busy || !session || !adminAuthenticated}
            onClick={() => void archive()}
            className="rounded-lg border px-3 py-2 text-sm font-bold"
          >
            Archive examination
          </button>
        </div>
        {results.length === 0 ? (
          <p className="text-sm text-slate-500">No completed Kiosk Examination results yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="p-2">Student</th>
                  <th className="p-2">Attempt</th>
                  <th className="p-2">Score</th>
                  <th className="p-2">Answered</th>
                  <th className="p-2">Submitted</th>
                  <th className="p-2">Security</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr key={result.id} className="border-b">
                    <td className="p-2">
                      {repository?.snapshot.students.find(
                        (student) => student.id === result.studentId,
                      )?.firstName || result.studentId}
                    </td>
                    <td className="p-2">{result.attemptId}</td>
                    <td className="p-2 font-bold">
                      {result.score}/{result.maxMarks} ({result.percentage}%)
                    </td>
                    <td className="p-2">
                      {result.answerStatistics.answered}/
                      {result.answerStatistics.answered + result.answerStatistics.unanswered}
                    </td>
                    <td className="p-2">{new Date(result.submittedAt).toLocaleString()}</td>
                    <td className="p-2">
                      {Object.values(result.securityEventSummary).reduce(
                        (sum, count) => sum + count,
                        0,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
