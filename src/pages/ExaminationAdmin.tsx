import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock3, Pause, Play, Plus, ShieldAlert, Square, Unlock } from 'lucide-react';
import { ExaminationRepository } from '../examination/service';
import type { StudentAttempt } from '../examination/types';

const ExaminationAdmin: React.FC = () => {
  const [repository, setRepository] = useState<ExaminationRepository | null>(null);
  const [attempts, setAttempts] = useState<StudentAttempt[]>([]);
  const [adminId, setAdminId] = useState('local-admin');
  const [adminDevice, setAdminDevice] = useState('admin-device');
  const [reason, setReason] = useState('Authorized examination administration');
  const [message, setMessage] = useState('');

  const refresh = async () => {
    const opened = repository || (await ExaminationRepository.open());
    setRepository(opened);
    setAttempts(
      opened.snapshot.attempts.filter((attempt) =>
        ['ACTIVE', 'PAUSED', 'RECOVERY_PENDING', 'LOCKED', 'SUBMITTED'].includes(attempt.status),
      ),
    );
  };
  useEffect(() => {
    void refresh();
  }, []);

  const action = async (
    attempt: StudentAttempt,
    kind: 'pause' | 'resume' | 'add' | 'remove' | 'force' | 'terminate' | 'unlock',
  ) => {
    if (!repository) return;
    try {
      if (kind === 'pause') await repository.pauseAttempt(attempt.id, adminId, adminDevice, reason);
      if (kind === 'resume')
        await repository.resumeAttempt(attempt.id, adminId, adminDevice, reason);
      if (kind === 'add')
        await repository.adjustAttemptTime(attempt.id, 5, adminId, adminDevice, reason);
      if (kind === 'remove')
        await repository.adjustAttemptTime(attempt.id, -5, adminId, adminDevice, reason);
      if (kind === 'force')
        await repository.forceSubmitAttempt(attempt.id, adminId, adminDevice, reason);
      if (kind === 'terminate')
        await repository.terminateAttempt(attempt.id, adminId, adminDevice, reason);
      if (kind === 'unlock')
        await repository.unlockAttempt(attempt.id, adminId, adminDevice, reason);
      setMessage(`${kind} recorded for ${attempt.id}.`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Administrator action failed.');
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header className="rounded-2xl bg-gradient-to-r from-slate-950 to-[#1B4332] text-white p-6">
        <p className="text-xs uppercase tracking-widest text-emerald-300 font-black">
          Examination Authority
        </p>
        <h1 className="text-3xl font-black">Live Admin Controls</h1>
        <p className="text-white/70 mt-2">
          Every timer or state action is append-only audited with administrator identity, device,
          previous state, new state, and reason.
        </p>
      </header>
      <section className="rounded-2xl bg-white border p-5 grid md:grid-cols-3 gap-3">
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
      <section className="space-y-3">
        {attempts.length === 0 && (
          <div className="rounded-2xl bg-white border p-8 text-center text-slate-500">
            No active or recoverable attempts on this authority.
          </div>
        )}
        {attempts.map((attempt) => (
          <AttemptCard key={attempt.id} attempt={attempt} onAction={action} />
        ))}
      </section>
      <Link
        to="/examinations/builder"
        className="inline-block rounded-lg border px-4 py-2 font-bold"
      >
        Back to builder
      </Link>
    </div>
  );
};

const AttemptCard: React.FC<{
  attempt: StudentAttempt;
  onAction: (
    attempt: StudentAttempt,
    kind: 'pause' | 'resume' | 'add' | 'remove' | 'force' | 'terminate' | 'unlock',
  ) => void;
}> = ({ attempt, onAction }) => {
  const [remaining, setRemaining] = useState('—');
  useEffect(() => {
    let alive = true;
    void ExaminationRepository.open()
      .then((repo) => repo.getAttemptTimer(attempt.id))
      .then((timer) => {
        if (alive)
          setRemaining(
            `${Math.floor(timer.remainingMilliseconds / 60000)}m ${Math.floor((timer.remainingMilliseconds % 60000) / 1000)}s`,
          );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [attempt.id, attempt.deadlineAt]);
  return (
    <article className="rounded-2xl bg-white border shadow-sm p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase font-black text-slate-500">
            {attempt.status} · {attempt.securityState || 'NORMAL'}
          </p>
          <h2 className="font-black text-lg">Attempt {attempt.id}</h2>
          <p className="text-sm text-slate-500">
            Student {attempt.studentId} · Device {attempt.deviceSessionId} · Ownership{' '}
            {attempt.ownershipGeneration || 1}
          </p>
        </div>
        <div className="rounded-lg bg-slate-100 px-3 py-2 font-black flex items-center gap-2">
          <Clock3 className="w-4 h-4" />
          {remaining}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
        <button
          onClick={() => onAction(attempt, 'pause')}
          className="rounded-lg border px-3 py-2 text-sm font-bold flex gap-1"
        >
          <Pause className="w-4 h-4" />
          Pause
        </button>
        <button
          onClick={() => onAction(attempt, 'resume')}
          className="rounded-lg border px-3 py-2 text-sm font-bold flex gap-1"
        >
          <Play className="w-4 h-4" />
          Resume
        </button>
        <button
          onClick={() => onAction(attempt, 'add')}
          className="rounded-lg bg-emerald-100 text-emerald-900 px-3 py-2 text-sm font-bold flex gap-1"
        >
          <Plus className="w-4 h-4" />
          +5 min
        </button>
        <button
          onClick={() => onAction(attempt, 'remove')}
          className="rounded-lg bg-amber-100 text-amber-900 px-3 py-2 text-sm font-bold"
        >
          −5 min
        </button>
        <button
          onClick={() => onAction(attempt, 'unlock')}
          className="rounded-lg border px-3 py-2 text-sm font-bold flex gap-1"
        >
          <Unlock className="w-4 h-4" />
          Unlock/recover
        </button>
        <button
          onClick={() => onAction(attempt, 'force')}
          className="rounded-lg bg-amber-400 text-slate-950 px-3 py-2 text-sm font-black"
        >
          Force submit
        </button>
        <button
          onClick={() => onAction(attempt, 'terminate')}
          className="rounded-lg bg-red-100 text-red-800 px-3 py-2 text-sm font-black flex gap-1"
        >
          <Square className="w-4 h-4" />
          Terminate
        </button>
      </div>
      <p className="mt-3 text-xs text-slate-500 flex gap-1">
        <ShieldAlert className="w-4 h-4" />
        Timer adjustments preserve the original duration and append an audit record.
      </p>
    </article>
  );
};

export default ExaminationAdmin;
