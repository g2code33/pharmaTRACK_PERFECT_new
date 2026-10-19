import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileKey2, Loader2 } from 'lucide-react';
import { validatePharmaExamPackage, type StagedPharmaExam } from '../examination/package';
import { ExaminationRepository } from '../examination/service';
import {
  clearStagedPharmaExam,
  loadStagedPharmaExam,
  stagePharmaExamPackage,
} from '../examination/packageCache';
import { readPharmaExamLaunch } from '../examination/nativeKiosk';
import { subscribePharmaExamLaunches, takePharmaExamLaunches } from '../examination/packageLaunch';
import { BROWSER_PHARMAEXAM_ACCEPT } from '../platform/fileSelection';
import { isIOSPWA, isIOSSafari } from '../platform/runtime';
import PasswordInput from '../components/PasswordInput';
import { describeError } from '../utils/errorMessage';
import { findNewlyVisibleKioskResults } from '../examination/results';
import { useApp } from '../context/AppContext';
import {
  authenticateKioskStudentViaAdmin,
  checkKioskLoginStatus,
  registerKioskStudentViaAdmin,
} from '../examination/kioskRoster';

const levels = ['Level 100', 'Level 200', 'Level 300', 'Level 400', 'Level 500', 'Level 600'];

/** Survives a kiosk reload between logging in and starting the exam: the
 * attempt page reads this if it was not reached via a normal navigation
 * (e.g. the device refreshed), so a power blip never forces a student to
 * retype their name from scratch. Cleared the moment an attempt starts. */
const IDENTITY_KEY = 'pharmatrack:kiosk-identity';

/** The administrator's join code, remembered per device so a returning
 * student (or the next student at the same kiosk) does not have to ask for
 * it again — changing schools/administrators is still one click away. */
const JOIN_CODE_KEY = 'pharmatrack:kiosk-admin-join-code';

type GateStatus = 'idle' | 'checking' | 'offline' | 'not-found' | 'disabled' | 'ready';

/** Turns a kiosk roster failure reason into the exact sentence a student
 * should see — never leaking which specific field (name vs. password) was
 * wrong, and always pointing at the one thing they can actually do about it. */
function describeKioskGateFailure(
  reason: 'offline' | 'not-found' | 'login-disabled' | 'name-taken' | 'invalid' | 'error',
  message?: string,
): string {
  switch (reason) {
    case 'offline':
      return "You're offline — connect to the internet to register or log in.";
    case 'not-found':
      return 'That administrator join code was not recognized. Check it and try again.';
    case 'login-disabled':
      return 'Kiosk logins are not currently open. Ask the administrator to enable them.';
    case 'name-taken':
      return 'This first name is already in use. Please use your surname, middle name, or add a number to your first name.';
    case 'invalid':
      return 'First name, level, or RX30 Kiosk password is incorrect.';
    case 'error':
    default:
      return message || 'Could not reach the administrator. Please try again.';
  }
}

const KioskEntry: React.FC = () => {
  const navigate = useNavigate();
  const { state: appState, dispatch } = useApp();
  const [staged, setStaged] = useState<StagedPharmaExam | null>(null);
  const [packageMessage, setPackageMessage] = useState('');
  const [packageFileName, setPackageFileName] = useState('');
  const [isDraggingPackage, setIsDraggingPackage] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [level, setLevel] = useState('');
  const [kioskPassword, setKioskPassword] = useState('');
  const [registeredPassword, setRegisteredPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [joinCode, setJoinCode] = useState(() => {
    try {
      return localStorage.getItem(JOIN_CODE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [joinCodeInput, setJoinCodeInput] = useState(joinCode);
  const [gateStatus, setGateStatus] = useState<GateStatus>('idle');
  const [gateChecking, setGateChecking] = useState(false);

  const checkGate = async (code: string) => {
    if (!code.trim()) {
      setGateStatus('idle');
      return;
    }
    setGateChecking(true);
    try {
      const status = await checkKioskLoginStatus(code.trim());
      if (!status.ok) {
        setGateStatus('offline');
      } else if (!status.found) {
        setGateStatus('not-found');
      } else if (!status.loginEnabled) {
        setGateStatus('disabled');
      } else {
        setGateStatus('ready');
      }
    } catch {
      setGateStatus('offline');
    } finally {
      setGateChecking(false);
    }
  };

  const connectToAdmin = async () => {
    const code = joinCodeInput.trim().toUpperCase();
    if (!code) return;
    setJoinCode(code);
    try {
      localStorage.setItem(JOIN_CODE_KEY, code);
    } catch {
      /* remembering the code is a nicety, never a gate */
    }
    await checkGate(code);
  };

  const disconnectFromAdmin = () => {
    setJoinCode('');
    setJoinCodeInput('');
    setGateStatus('idle');
    try {
      localStorage.removeItem(JOIN_CODE_KEY);
    } catch {
      /* ignore */
    }
  };

  // Check the gate on load if a code is already remembered, and keep it
  // fresh — the administrator can switch logins on/off at any time without
  // a student needing to reload the page to notice.
  useEffect(() => {
    if (!joinCode) return;
    void checkGate(joinCode);
    const interval = setInterval(() => void checkGate(joinCode), 20000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinCode]);

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
    await openPackageInput(file, file.name, file.name);
  };

  const openPackageInput = async (
    input: Blob | Uint8Array,
    source = 'selected file',
    fileName = '',
  ) => {
    setError('');
    const result = await validatePharmaExamPackage(input);
    if (!result.ok || !result.staged) {
      setStaged(null);
      setPackageFileName('');
      setPackageMessage(`${source}: ${result.errors.join(' ')}`);
      return;
    }
    await stagePharmaExamPackage(result.staged);
    setStaged(result.staged);
    setPackageFileName(fileName);
    setPackageMessage(
      `Valid signed package from ${source}: Version ${result.staged.exam.version} · ${result.staged.questions.length} questions`,
    );
  };

  /** Lets the student drop/pick a DIFFERENT package after one is already
   * staged — without this there was no way back to the dropzone once a
   * file had been accepted. */
  const removePackage = () => {
    setStaged(null);
    setPackageFileName('');
    setPackageMessage('');
    void clearStagedPharmaExam().catch(() => undefined);
    const input = document.getElementById('pharmaexam-file-input') as HTMLInputElement | null;
    // Resetting the input's value is required for the browser to fire a new
    // `change` event if the student picks the exact same file again.
    if (input) input.value = '';
  };

  useEffect(() => {
    let disposed = false;
    const openLaunch = async (launch: { path?: string; bytes?: Uint8Array }) => {
      if (disposed) return;
      try {
        const input = launch.bytes || (launch.path ? await readPharmaExamLaunch(launch.path) : undefined);
        if (input) await openPackageInput(input, launch.path ? `native launch ${launch.path}` : 'Android native intent');
      } catch (reason) {
        setError(describeError(reason, 'The native .pharmaexam launch could not be opened.'));
      }
    };
    const remove = subscribePharmaExamLaunches((launch) => void openLaunch(launch));
    takePharmaExamLaunches().forEach((launch) => void openLaunch(launch));
    return () => {
      disposed = true;
      remove();
    };
  }, []);

  const register = async () => {
    setError('');
    if (gateStatus !== 'ready') {
      setError('Connect to your administrator before registering — see step 2 above.');
      return;
    }
    setBusy(true);
    try {
      const outcome = await registerKioskStudentViaAdmin(joinCode, firstName, level);
      if (!outcome.ok) {
        setError(
          describeKioskGateFailure(outcome.reason, outcome.reason === 'error' ? outcome.message : undefined),
        );
        return;
      }
      const repository = await ExaminationRepository.open();
      await repository.ensureLocalStudentForCloudIdentity(outcome.studentId, firstName, level);
      setRegisteredPassword(outcome.password);
      setKioskPassword(outcome.password);
    } catch (reason) {
      setError(describeError(reason, 'Registration failed.'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Logging in only confirms identity — the exam itself, its course details,
   * and the exam password all live on their own full page from here on, so
   * this front screen stays exactly what it says: choose a package, prove
   * who you are, nothing else.
   */
  const login = async () => {
    setError('');
    if (!firstName.trim() || !level || !kioskPassword.trim()) {
      setError('Enter your first name, level, and RX30 kiosk password to continue.');
      return;
    }
    if (gateStatus !== 'ready') {
      setError('Connect to your administrator before logging in — see step 2 above.');
      return;
    }
    setBusy(true);
    try {
      const outcome = await authenticateKioskStudentViaAdmin(
        joinCode,
        firstName.trim(),
        level,
        kioskPassword.trim(),
      );
      if (!outcome.ok) {
        setError(
          describeKioskGateFailure(outcome.reason, outcome.reason === 'error' ? outcome.message : undefined),
        );
        return;
      }
      const repository = await ExaminationRepository.open();
      const student = await repository.ensureLocalStudentForCloudIdentity(
        outcome.studentId,
        outcome.firstName,
        outcome.level,
      );
      // Logging in is the one moment the app knows for certain which
      // student is at the device — the right time to catch Quiz History up
      // with any past kiosk exam result that became visible since they last
      // checked (e.g. the administrator released it after submission).
      try {
        const existingIds = new Set(
          appState.quizHistory
            .map((item) => item.examinationResultId)
            .filter((id): id is string => Boolean(id)),
        );
        const newlyVisible = findNewlyVisibleKioskResults(repository, student.id, existingIds);
        for (const entry of newlyVisible) {
          dispatch({ type: 'ADD_QUIZ_HISTORY', payload: entry });
        }
      } catch {
        // Never block login over a Quiz History backfill problem.
      }
      const identity = { firstName: outcome.firstName, level: outcome.level, kioskPassword: kioskPassword.trim() };
      try {
        sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
      } catch {
        /* resume-on-reload is a nicety, never a gate */
      }
      navigate('/examinations/kiosk/attempt', { state: identity });
    } catch (reason) {
      setError(describeError(reason, 'Could not log in with those details.'));
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
          Choose the signed package, connect to your administrator, then log in with your RX30
          identity — your exam's course details and password screen come next. Registering and
          logging in need a connection to your administrator; once you're in, taking the exam
          keeps working even if the connection drops.
        </p>
      </header>

      {isIOSSafari() && (
        <div className="rounded-2xl bg-sky-50 border border-sky-200 p-4 text-sm text-sky-950 flex items-start gap-3 shadow-sm">
          <div className="p-2 bg-sky-100 text-sky-700 rounded-xl shrink-0 font-bold text-base">📱</div>
          <div>
            <strong className="text-sky-950 font-bold block">iPhone Safari Detected</strong>
            <p className="text-xs text-sky-800 mt-1 leading-relaxed">
              You can take your examination directly in Safari, or optionally tap <strong>Share</strong> (the box with an upward arrow) and select <strong>“Add to Home Screen”</strong> for a borderless standalone PWA kiosk view.
            </p>
          </div>
        </div>
      )}
      {isIOSPWA() && (
        <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-950 flex items-start gap-3 shadow-sm">
          <div className="p-2 bg-emerald-100 text-emerald-700 rounded-xl shrink-0 font-bold text-base">✨</div>
          <div>
            <strong className="text-emerald-950 font-bold block">iPhone PWA Standalone Mode</strong>
            <p className="text-xs text-emerald-800 mt-1 leading-relaxed">
              Running in standalone home-screen mode with full-screen view, safe-area layout, and local encrypted state.
            </p>
          </div>
        </div>
      )}

      <section className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-4">
        <div className="flex items-center gap-2">
          <FileKey2 className="text-[#2D6A4F] w-6 h-6" />
          <h2 className="font-black text-xl">1. Choose .pharmaexam</h2>
        </div>
        <p className="text-sm text-slate-600">
          Open an official signed .pharmaexam package via standard browser file selection. No
          OS-level file association registration is required.
        </p>
        <input
          id="pharmaexam-file-input"
          type="file"
          accept={BROWSER_PHARMAEXAM_ACCEPT}
          onChange={(event) => void choosePackage(event.target.files?.[0])}
          className="hidden"
        />
        {!staged && (
          <div
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDraggingPackage(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // Without an explicit dropEffect some browsers (notably
              // WebKit) treat the hover as "not a valid drop target" and
              // silently refuse the drop even though preventDefault() ran.
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDraggingPackage(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDraggingPackage(false);
              // `files` is empty in a few WebView/WebKit combinations even
              // though the drop carried exactly one item; `items[].getAsFile()`
              // is the fallback that still works there.
              const file =
                e.dataTransfer.files?.[0] ||
                Array.from(e.dataTransfer.items || [])
                  .find((item) => item.kind === 'file')
                  ?.getAsFile() ||
                undefined;
              if (file) void choosePackage(file);
            }}
            className={`relative border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer ${
              isDraggingPackage
                ? 'border-emerald-600 bg-emerald-50'
                : 'border-slate-300 hover:border-emerald-500 bg-slate-50/50 hover:bg-emerald-50/30'
            }`}
            onClick={() => {
              document.getElementById('pharmaexam-file-input')?.click();
            }}
          >
            <FileKey2 className="w-10 h-10 mx-auto text-slate-400 mb-2" />
            <p className="text-sm font-bold text-slate-700">
              Click to choose a .pharmaexam package or drag and drop it here
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Browser file picker · Accepts .pharmaexam and signed exam packages
            </p>
          </div>
        )}
        {packageMessage && (
          <p className={`text-sm font-semibold ${staged ? 'text-emerald-700' : 'text-red-700'}`}>
            {packageMessage}
          </p>
        )}
        {staged && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-sm text-slate-800">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                {packageFileName && (
                  <p className="text-xs font-bold text-emerald-900 truncate flex items-center gap-1.5">
                    <FileKey2 className="w-3.5 h-3.5 shrink-0" /> {packageFileName}
                  </p>
                )}
                <strong className="text-emerald-950 text-base">{staged.exam.title}</strong>
                <p className="text-xs text-emerald-800 mt-0.5">
                  Version {staged.exam.version} · {staged.exam.assessmentType} · {staged.questions.length}{' '}
                  questions · Duration: {staged.exam.availability.durationMinutes} minutes
                </p>
                <p className="text-xs text-slate-600 mt-1">{staged.institution.name}</p>
              </div>
              <div className="flex flex-col items-end gap-2 shrink-0">
                <span className="px-2.5 py-1 bg-emerald-100 text-emerald-800 text-xs font-bold rounded-lg">
                  Package Cached
                </span>
                <button
                  type="button"
                  onClick={removePackage}
                  className="text-xs font-bold text-red-700 hover:text-red-900 underline underline-offset-2"
                >
                  Remove & choose another
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-4">
        <h2 className="font-black text-xl">2. Connect to your administrator</h2>
        <p className="text-sm text-slate-600">
          Kiosk accounts are referenced through your administrator's own account — this is what
          lets the same login work from any device, not just the one you registered on.
          Registering and logging in both require this connection; the administrator must have
          kiosk logins switched on.
        </p>
        {gateStatus === 'ready' ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-emerald-50 border border-emerald-200 p-4">
            <div>
              <p className="text-sm font-black text-emerald-900">
                Connected — join code {joinCode}. Logins are open.
              </p>
              <p className="text-xs text-emerald-700 mt-0.5">
                You can now register or log in below.
              </p>
            </div>
            <button
              type="button"
              onClick={disconnectFromAdmin}
              className="text-xs font-bold text-slate-600 hover:text-slate-900 underline underline-offset-2"
            >
              Not your administrator? Change code
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid sm:grid-cols-[1fr_auto] gap-3">
              <label className="text-sm font-bold">
                Administrator join code
                <input
                  value={joinCodeInput}
                  onChange={(event) => setJoinCodeInput(event.target.value.toUpperCase())}
                  placeholder="e.g. AB12CD"
                  maxLength={6}
                  className="mt-1 w-full rounded-lg border px-3 py-2 font-mono tracking-widest uppercase"
                />
              </label>
              <button
                type="button"
                disabled={gateChecking || !joinCodeInput.trim()}
                onClick={() => void connectToAdmin()}
                className="self-end rounded-xl bg-slate-800 text-white px-6 py-2.5 font-black disabled:opacity-50 flex items-center gap-2"
              >
                {gateChecking && <Loader2 className="animate-spin w-4 h-4" />}
                Connect
              </button>
            </div>
            {gateStatus === 'offline' && (
              <p className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-3 text-sm font-semibold">
                You're offline — connect to the internet to reach your administrator.
              </p>
            )}
            {gateStatus === 'not-found' && (
              <p className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-3 text-sm font-semibold">
                That join code was not recognized. Check it with your administrator and try again.
              </p>
            )}
            {gateStatus === 'disabled' && (
              <p className="rounded-lg bg-amber-50 border border-amber-300 text-amber-900 p-3 text-sm font-semibold">
                Found your administrator, but kiosk logins are not open yet. Ask them to switch
                logins on.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-4">
        <h2 className="font-black text-xl">3. Student identity</h2>
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
            <PasswordInput
              value={kioskPassword}
              onChange={(event) => setKioskPassword(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2"
              placeholder="RX30a"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || gateStatus !== 'ready'}
            onClick={() => void login()}
            data-testid="kiosk-login-button"
            title={gateStatus !== 'ready' ? 'Connect to your administrator first (step 2)' : undefined}
            className="rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2.5 font-black disabled:opacity-50 flex items-center gap-2"
          >
            {busy && <Loader2 className="animate-spin w-4 h-4" />}
            Login
          </button>
          <button
            type="button"
            disabled={busy || gateStatus !== 'ready'}
            onClick={() => void register()}
            title={gateStatus !== 'ready' ? 'Connect to your administrator first (step 2)' : undefined}
            className="rounded-lg bg-slate-800 text-white px-4 py-2 font-bold text-sm disabled:opacity-50"
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
          your surname, middle name, or add a number to your first name.” Logging in takes you to
          your exam's course details and password screen.
        </p>
        {error && (
          <p className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-3 text-sm font-semibold">
            {error}
          </p>
        )}
      </section>

      <div className="flex flex-wrap gap-3">
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
