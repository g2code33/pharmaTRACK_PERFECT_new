import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  ChevronDown,
  FileKey2,
  Lock,
  Loader2,
  MonitorCheck,
  ShieldAlert,
  Wifi,
} from 'lucide-react';
import { verifyExamPassword, type StagedPharmaExam } from '../examination/package';
import {
  discoverLanAuthorities,
  isNativeLanServerAvailable,
  type LanDiscoveredAuthority,
} from '../examination/lanServer';
import { ExaminationRepository } from '../examination/service';
import { LanExamClient, LocalExamAuthority, isLanEndpoint } from '../examination/network';
import { encryptedStorageAvailable } from '../examination/secureStorage';
import { loadStagedPharmaExam } from '../examination/packageCache';
import { requiredCapabilitiesReady } from '../examination/kioskAdapter';
import { createPlatformKioskAdapter } from '../examination/androidAdapter';
import type { ExamStudent, PlatformCapabilityMatrix } from '../examination/types';
import { isIOS, isIOSPWA, isIOSSafari } from '../platform/runtime';
import PasswordInput from '../components/PasswordInput';

/** How often the device re-scans for the examination authority while none
 *  has answered yet — same cadence as the identity page's own scan, so a
 *  student who reaches this page before the invigilator starts the
 *  authority still gets connected automatically, without a refresh. */
const DISCOVERY_RETRY_MS = 4000;

const IDENTITY_KEY = 'pharmatrack:kiosk-identity';

type Check = { label: string; ok: boolean; required: boolean; detail: string };

interface KioskIdentity {
  firstName: string;
  level: string;
  kioskPassword: string;
  /**
   * The roster row id the administrator's cloud account already verified
   * this student against at login. Without it this page fell back to
   * re-checking the kiosk password against the LOCAL mirror record's
   * verifier — which `ensureLocalStudentForCloudIdentity` deliberately
   * seeds with an unguessable random value (see service.ts), since cloud
   * login already proved identity. That local re-check could therefore
   * never succeed, and every kiosk exam attempt failed with "First name,
   * level, or RX30 Kiosk password is incorrect." immediately after a
   * correct login. Carrying the id through lets this page just fetch (or
   * create) that same local mirror record instead of re-authenticating it.
   */
  studentId: string;
}

function readStoredIdentity(): KioskIdentity | null {
  try {
    const raw = sessionStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KioskIdentity>;
    if (!parsed.firstName || !parsed.level || !parsed.kioskPassword || !parsed.studentId) return null;
    return {
      firstName: parsed.firstName,
      level: parsed.level,
      kioskPassword: parsed.kioskPassword,
      studentId: parsed.studentId,
    };
  } catch {
    return null;
  }
}

/**
 * The exam-attempt page a student lands on right after logging in on the
 * kiosk identity screen — a distinct, full page (not just another section
 * of the same screen), so the exam's own course/version details have room
 * to be the main thing on screen, and so a kiosk reload mid-flow recovers
 * here via the identity this device remembered, instead of bouncing the
 * student all the way back to retype their name.
 *
 * Everything about the LAN connection is automatic here: discovery keeps
 * scanning in the background and the endpoint/session are filled in with no
 * typing. The ONLY thing a student ever types on this page is the
 * examination password the invigilator announces — the session token only
 * reappears as a manual field for the rare closed-enrollment classroom
 * (and the browser-preview/no-native fallback, where nothing is automatic).
 */
const ExamAttemptEntry: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const identity = useMemo<KioskIdentity | null>(() => {
    const fromState = (location.state as Partial<KioskIdentity> | null) || null;
    if (fromState?.firstName && fromState.level && fromState.kioskPassword && fromState.studentId) {
      return {
        firstName: fromState.firstName,
        level: fromState.level,
        kioskPassword: fromState.kioskPassword,
        studentId: fromState.studentId,
      };
    }
    return readStoredIdentity();
  }, [location.state]);

  const [staged, setStaged] = useState<StagedPharmaExam | null>(null);
  const [stagedChecked, setStagedChecked] = useState(false);
  const [examPassword, setExamPassword] = useState('');
  const [lanEndpoint, setLanEndpoint] = useState('');
  const [lanToken, setLanToken] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [discovered, setDiscovered] = useState<LanDiscoveredAuthority[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [manualOverrideOpen, setManualOverrideOpen] = useState(!isNativeLanServerAvailable());
  const [checksOpen, setChecksOpen] = useState(false);
  const [checks, setChecks] = useState<Check[]>([]);
  const [capabilityMatrix, setCapabilityMatrix] = useState<PlatformCapabilityMatrix | null>(null);
  const [student, setStudent] = useState<ExamStudent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmLockOpen, setConfirmLockOpen] = useState(false);

  const closedEnrollmentDiscovered = useMemo(
    () => (discovered || []).some((item) => !item.openEnrollment),
    [discovered],
  );
  // The token field only needs to appear when there is genuinely no
  // automatic way to get it: no native discovery at all, or a discovered
  // authority that deliberately withholds it (closed enrollment).
  const showTokenField = manualOverrideOpen || closedEnrollmentDiscovered;

  const requiredReady = useMemo(
    () => Boolean(staged && checks.filter((check) => check.required).every((check) => check.ok)),
    [staged, checks],
  );

  useEffect(() => {
    void loadStagedPharmaExam()
      .then((cached) => setStaged(cached))
      .catch(() => undefined)
      .finally(() => setStagedChecked(true));
  }, []);

  // Same zero-config discovery as the identity page: keeps re-scanning while
  // nothing has answered, so arriving here before the invigilator starts the
  // authority still connects automatically, with no refresh needed.
  useEffect(() => {
    if (!isNativeLanServerAvailable()) return;
    let disposed = false;
    let retryTimer: number | null = null;
    try {
      const remembered = window.localStorage.getItem('pharmatrack:lan-endpoint');
      if (remembered && !disposed) setLanEndpoint(remembered);
    } catch {
      /* storage may be unavailable; discovery does not depend on it */
    }
    let foundAny = false;
    const applyFound = (found: LanDiscoveredAuthority[]) => {
      setDiscovered(found);
      foundAny = found.length > 0;
      if (found.length === 1) {
        const match = found[0];
        setLanEndpoint(match.endpoint);
        setSessionId(match.sessionId);
        if (match.openEnrollment && match.sessionToken) setLanToken(match.sessionToken);
      } else if (found.length > 1) {
        setLanEndpoint((current) => current || found[0].endpoint);
      }
    };
    const runScan = async (): Promise<void> => {
      setDiscovering(true);
      try {
        applyFound(await discoverLanAuthorities());
      } catch {
        /* an unreachable authority is not fatal — the next scan retries */
      } finally {
        if (!disposed) setDiscovering(false);
      }
      if (!disposed && !foundAny) {
        retryTimer = window.setTimeout(() => void runScan(), DISCOVERY_RETRY_MS);
      }
    };
    void runScan();
    return () => {
      disposed = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickDiscoveredAuthority = (authority: LanDiscoveredAuthority) => {
    setLanEndpoint(authority.endpoint);
    setSessionId(authority.sessionId);
    if (authority.openEnrollment && authority.sessionToken) setLanToken(authority.sessionToken);
  };

  const runReadiness = async (currentStaged: StagedPharmaExam) => {
    setBusy(true);
    // Everything below is wrapped in try/finally on purpose: an exam package
    // whose device/network/capability checks throw partway through (a
    // transient API quirk, an unsupported browser feature, …) must still
    // release `busy` — otherwise "Enter secure examination" stays disabled
    // forever with no way for the student to recover short of a reload. The
    // getBattery() fix below is exactly the kind of mistake this guards
    // against happening again elsewhere in this function.
    try {
      return await computeReadinessChecks(currentStaged);
    } finally {
      setBusy(false);
    }
  };

  const computeReadinessChecks = async (currentStaged: StagedPharmaExam) => {
    const next: Check[] = [];
    next.push({
      label: 'Exam package valid',
      ok: true,
      required: true,
      detail: `Signed Version ${currentStaged.exam.version} verified`,
    });
    next.push({
      label: 'Correct examination version',
      ok: currentStaged.manifest.examVersionId === currentStaged.exam.id,
      required: true,
      detail:
        currentStaged.manifest.examVersionId === currentStaged.exam.id
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
      currentStaged.exam.security.requiredCapabilities || [],
    );
    const matrix = adapter.matrix;
    setCapabilityMatrix(matrix);
    const capabilityResult = requiredCapabilitiesReady(
      matrix,
      currentStaged.exam.security.requiredCapabilities || [],
    );
    const capabilityRequired =
      currentStaged.exam.security.capabilityFailurePolicy === 'PREVENT_START' ||
      currentStaged.exam.security.capabilityFailurePolicy === 'REQUIRE_ADMIN_APPROVAL';
    next.push({
      label: 'Platform capability policy',
      ok:
        capabilityResult.ok ||
        currentStaged.exam.security.capabilityFailurePolicy === 'ALLOW_WITH_WARNING',
      required: capabilityRequired,
      detail: capabilityResult.ok
        ? `${matrix.platform}: required controls detected`
        : `${capabilityResult.unavailable.map((item) => item.label).join(', ')} unavailable; policy is ${currentStaged.exam.security.capabilityFailurePolicy || 'ALLOW_WITH_WARNING'}`,
    });
    if (lanEndpoint.trim()) {
      if (!isLanEndpoint(lanEndpoint)) {
        next.push({
          label: 'Examination network reachable',
          ok: false,
          required: true,
          detail: 'Stay on the examination Wi-Fi so this device can find the authority',
        });
      } else {
        try {
          const health = await new LanExamClient(lanEndpoint, fetch, { token: lanToken }).health();
          next.push({
            label: 'Examination network reachable',
            ok: health.ok,
            required: true,
            detail: `${health.server.label} · epoch ${health.server.epoch}`,
          });
        } catch (reason) {
          next.push({
            label: 'Examination network reachable',
            ok: false,
            required: true,
            detail: reason instanceof Error ? reason.message : 'Examination authority did not respond',
          });
        }
      }
    } else {
      const repository = await ExaminationRepository.open();
      const health = await new LocalExamAuthority(repository).health();
      next.push({
        label: 'Examination network / local authority',
        ok: health.ok,
        required: currentStaged.exam.security.requireLanAuthority,
        detail:
          'This device can act as the local examination authority when no network is found',
      });
    }
    // getBattery?.() short-circuits to `undefined` (not a Promise) on every
    // browser that lacks the Battery Status API — Safari and Firefox never
    // implemented it, and Chromium itself restricts/omits it in several
    // contexts. Chaining `.catch(...)` straight onto that without its own
    // `?.` throws "Cannot read properties of undefined (reading 'catch')",
    // which aborted this whole readiness pass before it reached the
    // `setBusy(false)` below — "Enter secure examination" stayed disabled
    // forever on exactly those browsers. Guard the `.catch()` too.
    const battery = await (
      navigator as Navigator & { getBattery?: () => Promise<{ level: number }> }
    )
      .getBattery?.()
      ?.catch(() => undefined);
    next.push({
      label: 'Battery / power',
      ok: !battery || battery.level >= 0.15,
      required: false,
      detail: !battery ? 'Battery status unavailable' : `${Math.round(battery.level * 100)}%`,
    });
    setChecks(next);
    return next;
  };

  // Checks run automatically — swift by design, no manual "Run readiness
  // checks" step for the student to remember. They re-run whenever the
  // discovered network changes, so the final gate always reflects the
  // authority this attempt will actually use.
  useEffect(() => {
    if (!staged) return;
    void runReadiness(staged).then((result) => {
      setChecksOpen(result.some((check) => check.required && !check.ok));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staged, lanEndpoint, lanToken]);

  // A failing REQUIRED check (storage warming up, the examination network
  // still being discovered, …) is very often transient — re-checking
  // automatically in the background means a device that recovers on its own
  // clears the banner without the student having to notice and press
  // anything. Stops the moment every required check is green.
  useEffect(() => {
    if (!staged || busy) return;
    const stillFailing = checks.some((check) => check.required && !check.ok);
    if (!stillFailing) return;
    const timer = window.setTimeout(() => {
      void runReadiness(staged);
    }, 4000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staged, checks, busy]);

  const enterExam = async () => {
    if (!staged || !identity) return;
    // Browsers only grant Element.requestFullscreen() during a direct user
    // gesture — calling it later, after SecureExamination.tsx has finished
    // its own async setup (repository opens, attempt creation, a LAN health
    // check…), arrives long after this click's "transient activation" has
    // expired, so the automatic fullscreen entry silently fails on the web
    // build every time (desktop/Android never hit this at all — they use
    // native OS fullscreen/window lockdown, not this browser API). Firing it
    // here, as the very first synchronous thing this click does, is what
    // actually lets web exam-takers get the same fullscreen lockdown
    // desktop and APK users get instead of landing in a plain window.
    try {
      const docEl = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      if (!document.fullscreenElement && !(document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement) {
        void (docEl.requestFullscreen ? docEl.requestFullscreen() : docEl.webkitRequestFullscreen?.())?.catch(() => undefined);
      }
    } catch {
      // Best-effort only — SecureExamination's own "Return to Fullscreen"
      // banner still recovers this with one more click if it didn't take.
    }
    setBusy(true);
    setError('');
    try {
      const repository = await ExaminationRepository.open();
      await repository.markPackageImported(staged.packageKey);
      // Identity was already proven by the administrator's cloud roster at
      // login (see KioskIdentity.studentId above) — this just fetches or
      // creates the matching local mirror record, it never re-checks the
      // password locally.
      const authenticated =
        student ||
        (await repository.ensureLocalStudentForCloudIdentity(
          identity.studentId,
          identity.firstName,
          identity.level,
        ));
      setStudent(authenticated);
      if (!(await verifyExamPassword(examPassword, staged.security)))
        throw new Error('The examination password is incorrect.');
      // Checks must be fresh before the gate is trusted, in case the
      // network only just finished connecting.
      const freshChecks = await runReadiness(staged);
      const stillReady = freshChecks.filter((c) => c.required).every((c) => c.ok);
      if (!stillReady) throw new Error('Readiness checks are not passing yet — please wait a moment and try again.');
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
          sessionId.trim() || undefined,
        );
      const deviceId = `device-${navigator.userAgent.slice(0, 24)}`;
      let lanClient: LanExamClient | null = null;
      let remoteConnection: Awaited<ReturnType<LanExamClient['connect']>> | null = null;
      if (lanEndpoint.trim()) {
        if (!lanToken.trim())
          throw new Error('The administrator must provide the session token for this network.');
        lanClient = new LanExamClient(lanEndpoint, fetch, {
          token: lanToken.trim(),
          studentId: authenticated.id,
        });
        remoteConnection = await lanClient.connect(session.id, deviceId, 'STUDENT', {
          studentId: authenticated.id,
        });
        if (!remoteConnection.deviceSessionId)
          throw new Error('The examination authority did not issue a device session.');
        await repository.setSessionAuthority(
          session.id,
          lanEndpoint.trim(),
          remoteConnection.sessionToken || lanToken.trim(),
          remoteConnection.server.serverId,
          remoteConnection.server.epoch,
        );
      }
      const clientPlatform = isIOSPWA() ? 'IOS_PWA' : isIOSSafari() ? 'IOS_SAFARI' : 'web';
      const deviceSession = await repository.createDeviceSession({
        id: remoteConnection?.deviceSessionId,
        deviceId,
        role: 'STUDENT',
        studentId: authenticated.id,
        sessionId: session.id,
        platform: clientPlatform,
        capabilities: [
          'encrypted-local-state',
          'attempt-recovery',
          'platform-capability-matrix',
          'lan-authenticated',
          'web-client',
          ...(isIOS() ? ['ios-lifecycle-resilience', 'touch-targets-accessible'] : []),
        ],
      });
      let authoritativeStartedAt = new Date().toISOString();
      try {
        const health = lanClient
          ? await lanClient.health()
          : await new LocalExamAuthority(repository).health();
        authoritativeStartedAt = health.serverNowAt || health.checkedAt;
      } catch {
        // The local encrypted timer remains available while the LAN reconnects.
      }
      const remoteAttempt = lanClient
        ? await lanClient.createAttempt(session.id, authenticated.id, deviceSession.id)
        : undefined;
      const result = await repository.createAttempt(
        session.id,
        authenticated.id,
        deviceSession.id,
        authoritativeStartedAt,
        remoteAttempt?.attempt?.id,
      );
      await repository.logSecurityEvent({
        sessionId: session.id,
        attemptId: result.attempt.id,
        studentId: authenticated.id,
        deviceSessionId: deviceSession.id,
        type: 'ATTEMPT_STARTED',
        severity: 'info',
        details: result.continued
          ? 'Continue Exam on another supported device/session.'
          : 'New attempt started.',
      });
      if (lanEndpoint.trim()) {
        try {
          window.localStorage.setItem('pharmatrack:lan-endpoint', lanEndpoint.trim());
        } catch {
          /* remembering is an enhancement, never a gate */
        }
      }
      try {
        sessionStorage.removeItem(IDENTITY_KEY);
      } catch {
        /* best-effort cleanup only */
      }
      navigate(`/examination/secure/${result.attempt.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The examination could not be started.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full max-w-3xl mx-auto space-y-6">
      <header className="rounded-2xl bg-gradient-to-r from-[#0F172A] to-[#1B4332] text-white p-6 shadow-lg">
        <p className="text-xs uppercase tracking-widest font-black text-emerald-300">
          Student Kiosk
        </p>
        <h1 className="text-3xl font-black mt-1">Your examination</h1>
        <p className="text-white/75 mt-2">
          {identity ? `Signed in as ${identity.firstName} · ${identity.level}` : 'Course and exam details'}
        </p>
      </header>

      {!identity && (
        <p
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900"
          data-testid="attempt-no-identity"
        >
          You're not logged in yet.{' '}
          <Link to="/examinations/kiosk" className="underline">
            Go back and enter your name and level
          </Link>
          .
        </p>
      )}

      {stagedChecked && !staged && (
        <p
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900"
          data-testid="attempt-no-package"
        >
          No examination package is loaded yet.{' '}
          <Link to="/examinations/kiosk" className="underline">
            Go back and choose your .pharmaexam package
          </Link>
          .
        </p>
      )}

      {staged && (
        <section className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-2" data-testid="attempt-course-details">
          <div className="flex items-center gap-2">
            <FileKey2 className="text-[#2D6A4F] w-6 h-6" />
            <h2 className="font-black text-xl">{staged.exam.title}</h2>
          </div>
          <p className="text-sm text-slate-600">
            Version {staged.exam.version} · {staged.exam.assessmentType} · {staged.questions.length}{' '}
            questions · Duration: {staged.exam.availability.durationMinutes} minutes
          </p>
          <p className="text-sm text-slate-500">{staged.institution.name}</p>
        </section>
      )}

      <section className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Wifi className="text-[#2D6A4F]" />
          <h2 className="font-black text-xl">Attempt quiz</h2>
        </div>

        {discovering && (
          <p
            className="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-sm font-bold text-sky-900"
            data-testid="discovery-status"
          >
            <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Looking for the examination
            authority on this Wi-Fi…
          </p>
        )}
        {!discovering && discovered && discovered.length === 0 && (
          <p
            className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm font-bold text-amber-900"
            data-testid="discovery-status"
          >
            No examination authority answered yet — this page keeps looking on its own and
            connects the moment the invigilator starts it. Just stay on the examination Wi-Fi.
          </p>
        )}
        {discovered && discovered.length > 0 && (
          <div
            className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 space-y-2"
            data-testid="discovered-authorities"
          >
            <p className="text-sm font-black text-emerald-900">
              {discovered.length === 1
                ? 'Connected to the examination network automatically — nothing to type.'
                : `${discovered.length} examination authorities found — pick yours:`}
            </p>
            {discovered.map((authority) => (
              <button
                key={authority.endpoint}
                type="button"
                onClick={() => pickDiscoveredAuthority(authority)}
                data-testid={`discovered-authority-${authority.serverId}`}
                className={`w-full text-left rounded-lg border px-3 py-2 text-sm font-bold transition-colors ${
                  lanEndpoint === authority.endpoint
                    ? 'border-emerald-500 bg-white ring-2 ring-emerald-500/30'
                    : 'border-emerald-200 bg-white hover:bg-emerald-100'
                }`}
              >
                <span className="block">Examination network — Authority {authority.serverId}</span>
                <span className="block text-xs font-semibold text-slate-500">
                  {authority.openEnrollment
                    ? 'Connects automatically'
                    : 'Ask your invigilator for this session\u2019s token below'}
                </span>
              </button>
            ))}
          </div>
        )}

        <label className="text-sm font-bold block">
          Exam password
          <PasswordInput
            value={examPassword}
            onChange={(event) => setExamPassword(event.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2"
            placeholder="Announced by your invigilator"
            data-testid="exam-password-input"
            autoFocus
          />
        </label>

        {showTokenField && (
          <div className="grid sm:grid-cols-2 gap-3" data-testid="manual-network-fields">
            <label className="text-sm font-bold">
              Session token
              <PasswordInput
                value={lanToken}
                onChange={(event) => setLanToken(event.target.value)}
                data-testid="lan-token-input"
                className="mt-1 w-full rounded-lg border px-3 py-2"
                placeholder="Provided by examination admin"
              />
            </label>
            <label className="text-sm font-bold">
              Network address (only if it isn't found automatically)
              <input
                value={lanEndpoint}
                onChange={(event) => setLanEndpoint(event.target.value)}
                data-testid="lan-endpoint-input"
                className="mt-1 w-full rounded-lg border px-3 py-2"
                placeholder="http://192.168.1.20:8787"
              />
            </label>
          </div>
        )}
        {!showTokenField && (
          <button
            type="button"
            onClick={() => setManualOverrideOpen(true)}
            className="text-xs font-bold text-slate-500 underline"
            data-testid="manual-network-toggle"
          >
            Can't connect automatically? Enter network details manually
          </button>
        )}

        <div>
          <button
            type="button"
            onClick={() => setChecksOpen((open) => !open)}
            className="flex items-center gap-1 text-xs font-bold text-slate-500"
            data-testid="readiness-toggle"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${checksOpen ? 'rotate-180' : ''}`} />
            {checks.length === 0
              ? 'Checking this device…'
              : requiredReady
                ? 'Device ready'
                : 'Some checks need attention'}
          </button>
          {checksOpen && checks.length > 0 && (
            <div className="grid sm:grid-cols-2 gap-2 mt-2" data-testid="readiness-checks">
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
          )}
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-3 flex gap-2">
            <ShieldAlert className="w-5 h-5 shrink-0" />
            {error}
          </p>
        )}

        <span data-testid="debug-state" data-staged={String(!!staged)} data-identity={String(!!identity)} data-password={examPassword} data-busy={String(busy)} />
        <button
          type="button"
          disabled={!staged || !identity || !examPassword || busy}
          onClick={() => setConfirmLockOpen(true)}
          data-testid="start-exam-button"
          className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 font-black disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {busy ? <Loader2 className="animate-spin w-4 h-4" /> : <MonitorCheck className="w-4 h-4" />}
          Enter secure examination
        </button>
      </section>

      {confirmLockOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-4"
          data-testid="confirm-lock-dialog"
        >
          <div className="max-w-md w-full bg-white rounded-2xl p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center gap-2 text-slate-900">
              <Lock className="w-6 h-6 text-emerald-600 shrink-0" />
              <h2 className="text-lg font-black">This device is about to lock</h2>
            </div>
            <p className="mt-3 text-sm text-slate-600">
              Close every other open window and application now. Once you accept, this device
              immediately enters secure examination mode: normal navigation, app switching, and
              most keyboard shortcuts are blocked until you submit.
            </p>
            {staged?.security.settings.manualExitPolicy === 'ADMIN_AUTH_REQUIRED' && (
              <p className="mt-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                Your administrator has set this examination to require their authorization to
                unlock this device — including after you submit. Only they can release the lock.
              </p>
            )}
            <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmLockOpen(false)}
                data-testid="confirm-lock-cancel"
                className="px-4 py-2.5 rounded-xl font-bold text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmLockOpen(false);
                  void enterExam();
                }}
                data-testid="confirm-lock-accept"
                className="px-5 py-2.5 rounded-xl font-black bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center gap-2"
              >
                <Lock className="w-4 h-4" />
                Accept &amp; lock this device
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ExamAttemptEntry;
