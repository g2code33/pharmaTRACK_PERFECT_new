import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, FileKey2, Loader2, MonitorCheck, ShieldAlert, Wifi } from 'lucide-react';
import {
  validatePharmaExamPackage,
  verifyExamPassword,
  type StagedPharmaExam,
} from '../examination/package';
import { ExaminationRepository } from '../examination/service';
import { LanExamClient, LocalExamAuthority, isLanEndpoint } from '../examination/network';
import { encryptedStorageAvailable } from '../examination/secureStorage';
import { loadStagedPharmaExam, stagePharmaExamPackage } from '../examination/packageCache';
import { requiredCapabilitiesReady } from '../examination/kioskAdapter';
import { createPlatformKioskAdapter } from '../examination/androidAdapter';
import type { ExamStudent, PlatformCapabilityMatrix } from '../examination/types';

const levels = ['Level 100', 'Level 200', 'Level 300', 'Level 400', 'Level 500', 'Level 600'];

type Check = { label: string; ok: boolean; required: boolean; detail: string };

const KioskEntry: React.FC = () => {
  const navigate = useNavigate();
  const [staged, setStaged] = useState<StagedPharmaExam | null>(null);
  const [packageMessage, setPackageMessage] = useState('');
  const [firstName, setFirstName] = useState('');
  const [level, setLevel] = useState('');
  const [kioskPassword, setKioskPassword] = useState('');
  const [examPassword, setExamPassword] = useState('');
  const [lanEndpoint, setLanEndpoint] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [registeredPassword, setRegisteredPassword] = useState('');
  const [student, setStudent] = useState<ExamStudent | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [capabilityMatrix, setCapabilityMatrix] = useState<PlatformCapabilityMatrix | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const requiredReady = useMemo(
    () => Boolean(staged && checks.filter((check) => check.required).every((check) => check.ok)),
    [staged, checks],
  );

  useEffect(() => {
    void loadStagedPharmaExam()
      .then((cached) => {
        if (cached) {
          setStaged(cached);
          setPackageMessage(
            `Encrypted staged package restored: Version ${cached.exam.version} · ${cached.questions.length} questions`,
          );
        }
      })
      .catch(() => undefined);
  }, []);

  const choosePackage = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    const result = await validatePharmaExamPackage(file);
    if (!result.ok || !result.staged) {
      setStaged(null);
      setPackageMessage(result.errors.join(' '));
      return;
    }
    await stagePharmaExamPackage(result.staged);
    setStaged(result.staged);
    setPackageMessage(
      `Valid signed package: Version ${result.staged.exam.version} · ${result.staged.questions.length} questions`,
    );
  };

  const register = async () => {
    setError('');
    try {
      const repository = await ExaminationRepository.open();
      const result = await repository.registerStudent(firstName, level);
      setRegisteredPassword(result.password);
      setStudent(result.student);
      setKioskPassword(result.password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Registration failed.');
    }
  };

  const runReadiness = async () => {
    if (!staged) return;
    setBusy(true);
    setError('');
    const next: Check[] = [];
    next.push({
      label: 'Exam package valid',
      ok: true,
      required: true,
      detail: `Signed Version ${staged.exam.version} verified`,
    });
    next.push({
      label: 'Correct examination version',
      ok: staged.manifest.examVersionId === staged.exam.id,
      required: true,
      detail:
        staged.manifest.examVersionId === staged.exam.id
          ? 'Manifest and exam agree'
          : 'Manifest mismatch',
    });
    const storage = await encryptedStorageAvailable();
    next.push({
      label: 'Local encrypted storage available',
      ok: storage,
      required: true,
      detail: storage
        ? 'AES-GCM device state is available'
        : 'Encrypted local storage is unavailable',
    });
    next.push({
      label: 'Device compatibility',
      ok: typeof crypto !== 'undefined' && Boolean(crypto.subtle) && typeof File !== 'undefined',
      required: true,
      detail: 'Web Crypto and file APIs detected',
    });
    const estimate = await (navigator.storage?.estimate
      ? navigator.storage.estimate().catch(() => undefined)
      : Promise.resolve(undefined));
    next.push({
      label: 'Sufficient storage',
      ok: estimate?.quota == null || estimate.quota - (estimate.usage || 0) > 5 * 1024 * 1024,
      required: true,
      detail: estimate?.quota
        ? `${Math.round((estimate.quota - (estimate.usage || 0)) / 1024 / 1024)} MB available`
        : 'Storage estimate unavailable; local store accepted',
    });
    const adapter = await createPlatformKioskAdapter(
      () => undefined,
      staged.exam.security.requiredCapabilities || [],
    );
    const matrix = adapter.matrix;
    setCapabilityMatrix(matrix);
    const capabilityResult = requiredCapabilitiesReady(
      matrix,
      staged.exam.security.requiredCapabilities || [],
    );
    const capabilityRequired =
      staged.exam.security.capabilityFailurePolicy === 'PREVENT_START' ||
      staged.exam.security.capabilityFailurePolicy === 'REQUIRE_ADMIN_APPROVAL';
    next.push({
      label: 'Platform capability policy',
      ok:
        capabilityResult.ok ||
        staged.exam.security.capabilityFailurePolicy === 'ALLOW_WITH_WARNING',
      required: capabilityRequired,
      detail: capabilityResult.ok
        ? `${matrix.platform}: required controls detected`
        : `${capabilityResult.unavailable.map((item) => item.label).join(', ')} unavailable; policy is ${staged.exam.security.capabilityFailurePolicy || 'ALLOW_WITH_WARNING'}`,
    });
    if (lanEndpoint.trim()) {
      if (!isLanEndpoint(lanEndpoint)) {
        next.push({
          label: 'LAN server reachable',
          ok: false,
          required: true,
          detail: 'Enter a valid local http:// or https:// LAN endpoint',
        });
      } else {
        try {
          const health = await new LanExamClient(lanEndpoint).health();
          next.push({
            label: 'LAN server reachable',
            ok: health.ok,
            required: true,
            detail: `${health.server.label} · epoch ${health.server.epoch}`,
          });
        } catch (reason) {
          next.push({
            label: 'LAN server reachable',
            ok: false,
            required: true,
            detail: reason instanceof Error ? reason.message : 'LAN authority did not respond',
          });
        }
      }
    } else {
      const repository = await ExaminationRepository.open();
      const health = await new LocalExamAuthority(repository).health();
      next.push({
        label: 'LAN / local authority',
        ok: health.ok,
        required: staged.exam.security.requireLanAuthority,
        detail:
          'This device can act as the local examination authority when no LAN endpoint is configured',
      });
    }
    const battery = await (
      navigator as Navigator & { getBattery?: () => Promise<{ level: number }> }
    )
      .getBattery?.()
      .catch(() => undefined);
    next.push({
      label: 'Battery / power',
      ok: !battery || battery.level >= 0.15,
      required: false,
      detail: !battery ? 'Battery status unavailable' : `${Math.round(battery.level * 100)}%`,
    });
    next.push({
      label: 'Required permissions',
      ok: true,
      required: false,
      detail: 'No internet or cloud-account permission required',
    });
    setChecks(next);
    setBusy(false);
  };

  const enterExam = async () => {
    if (!staged || !requiredReady) return;
    setBusy(true);
    setError('');
    try {
      const repository = await ExaminationRepository.open();
      await repository.markPackageImported(staged.packageKey);
      const authenticated =
        student || (await repository.authenticateStudent(firstName, level, kioskPassword));
      if (!(await verifyExamPassword(examPassword, staged.security)))
        throw new Error('The examination password is incorrect.');
      const exam = await repository.importPublishedVersion(staged.exam);
      let session = repository.snapshot.sessions.find(
        (item) =>
          item.examVersionId === staged.exam.id && !['CLOSED', 'RECOVERY'].includes(item.status),
      );
      if (sessionId.trim())
        session = repository.snapshot.sessions.find((item) => item.id === sessionId.trim());
      if (!session)
        session = await repository.createSession(
          exam.id,
          staged.exam.id,
          lanEndpoint.trim() || 'local-authority',
          lanEndpoint.trim() || undefined,
        );
      const deviceSession = await repository.createDeviceSession({
        deviceId: `device-${navigator.userAgent.slice(0, 24)}`,
        role: 'STUDENT',
        studentId: authenticated.id,
        sessionId: session.id,
        capabilities: ['encrypted-local-state', 'attempt-recovery', 'platform-capability-matrix'],
      });
      let authoritativeStartedAt = new Date().toISOString();
      try {
        const health = lanEndpoint.trim()
          ? await new LanExamClient(lanEndpoint).health()
          : await new LocalExamAuthority(repository).health();
        authoritativeStartedAt = health.serverNowAt || health.checkedAt;
      } catch {
        // The local authority remains the source of time if a LAN health call races a reconnect.
      }
      const result = await repository.createAttempt(
        session.id,
        authenticated.id,
        deviceSession.id,
        authoritativeStartedAt,
      );
      await repository.logSecurityEvent({
        sessionId: session.id,
        attemptId: result.attempt.id,
        studentId: authenticated.id,
        deviceSessionId: deviceSession.id,
        type: 'ATTEMPT_STARTED',
        severity: result.continued ? 'info' : 'info',
        details: result.continued
          ? 'Continue Exam on another supported device/session.'
          : 'New attempt started.',
      });
      navigate(`/examination/secure/${result.attempt.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The examination could not be started.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full max-w-4xl mx-auto space-y-6">
      <header className="rounded-2xl bg-gradient-to-r from-[#0F172A] to-[#1B4332] text-white p-6 shadow-lg">
        <p className="text-xs uppercase tracking-widest font-black text-emerald-300">
          Student Kiosk
        </p>
        <h1 className="text-3xl font-black mt-1">Secure Examination Entry</h1>
        <p className="text-white/75 mt-2">
          No internet account is required. Choose the signed package, complete readiness checks, and
          use your RX30 identity.
        </p>
      </header>

      <section className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-4">
        <div className="flex items-center gap-2">
          <FileKey2 className="text-[#2D6A4F]" />
          <h2 className="font-black text-xl">1. Choose .pharmaexam</h2>
        </div>
        <input
          type="file"
          accept=".pharmaexam,application/zip"
          onChange={(event) => void choosePackage(event.target.files?.[0])}
          className="block w-full rounded-lg border p-3"
        />
        {packageMessage && (
          <p className={`text-sm font-semibold ${staged ? 'text-emerald-700' : 'text-red-700'}`}>
            {packageMessage}
          </p>
        )}
        {staged && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-sm">
            <strong>{staged.exam.title}</strong>
            <br />
            Version {staged.exam.version} · {staged.exam.assessmentType} · {staged.questions.length}{' '}
            questions
            <br />
            {staged.institution.name}
          </div>
        )}
      </section>

      <section className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-4">
        <h2 className="font-black text-xl">2. Student identity</h2>
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="text-sm font-bold">
            First Name
            <input
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2"
            />
          </label>
          <label className="text-sm font-bold">
            Level
            <select
              value={level}
              onChange={(event) => setLevel(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2"
            >
              <option value="">Choose level</option>
              {levels.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label className="text-sm font-bold">
            RX30 Kiosk password
            <input
              type="password"
              value={kioskPassword}
              onChange={(event) => setKioskPassword(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2"
              placeholder="RX30a"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void register()}
            className="rounded-lg bg-slate-800 text-white px-4 py-2 font-bold text-sm"
          >
            First-time registration
          </button>
          {registeredPassword && (
            <p className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-sm font-black">
              Give this password to the student once: {registeredPassword}
            </p>
          )}
        </div>
        <p className="text-xs text-slate-500">
          A duplicate first name returns exactly: “This first name is already in use. Please use
          your surname, middle name, or add a number to your first name.”
        </p>
      </section>

      <section className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Wifi className="text-[#2D6A4F]" />
          <h2 className="font-black text-xl">3. LAN and examination password</h2>
        </div>
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="text-sm font-bold">
            LAN authority endpoint
            <input
              value={lanEndpoint}
              onChange={(event) => setLanEndpoint(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2"
              placeholder="http://192.168.1.20:8787"
            />
          </label>
          <label className="text-sm font-bold">
            Session ID (optional)
            <input
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2"
              placeholder="Created by admin"
            />
          </label>
          <label className="text-sm font-bold">
            Exam password
            <input
              type="password"
              value={examPassword}
              onChange={(event) => setExamPassword(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2"
            />
          </label>
        </div>
        <button
          type="button"
          disabled={!staged || busy}
          onClick={() => void runReadiness()}
          className="rounded-lg bg-[#2D6A4F] text-white px-4 py-2 font-bold disabled:opacity-50 flex items-center gap-2"
        >
          {busy ? (
            <Loader2 className="animate-spin w-4 h-4" />
          ) : (
            <MonitorCheck className="w-4 h-4" />
          )}{' '}
          Run readiness checks
        </button>
      </section>

      {checks.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
          <h2 className="font-black text-xl mb-3">4. Readiness</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {checks.map((check) => (
              <div
                key={check.label}
                className={`rounded-lg border p-3 flex gap-2 ${check.ok ? 'border-emerald-200 bg-emerald-50' : check.required ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}
              >
                <span>
                  {check.ok ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  ) : (
                    <ShieldAlert className="w-5 h-5 text-red-600" />
                  )}
                </span>
                <span className="text-sm">
                  <strong>{check.label}</strong>
                  <br />
                  {check.detail}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {capabilityMatrix && (
        <section className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
          <h2 className="font-black text-xl mb-2">Platform capability matrix</h2>
          <p className="text-sm text-slate-500 mb-3">
            {capabilityMatrix.platform}. Green means detected; it does not claim OS-level
            enforcement where the platform provides no reliable API.
          </p>
          <div className="grid sm:grid-cols-2 gap-2">
            {capabilityMatrix.capabilities.map((capability) => (
              <div
                key={capability.id}
                className="text-xs rounded-lg border p-2 flex justify-between gap-2"
              >
                <span>
                  <strong>{capability.label}</strong>
                  <br />
                  {capability.notes}
                </span>
                <span
                  className={
                    capability.supported && capability.enforceable
                      ? 'text-emerald-700 font-bold'
                      : 'text-amber-700 font-bold'
                  }
                >
                  {capability.supported
                    ? capability.enforceable
                      ? 'Enforceable'
                      : 'Detected / not guaranteed'
                    : 'Unavailable'}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {error && (
        <p className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-3 flex gap-2">
          <ShieldAlert className="w-5 h-5 shrink-0" />
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!requiredReady || busy}
          onClick={() => void enterExam()}
          className="rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 font-black disabled:opacity-40"
        >
          Enter secure examination
        </button>
        <Link to="/examinations/builder" className="rounded-xl border px-6 py-3 font-bold">
          Admin builder
        </Link>
        <Link to="/quiz" className="rounded-xl border px-6 py-3 font-bold">
          Back to normal Quiz
        </Link>
      </div>
    </div>
  );
};

export default KioskEntry;
