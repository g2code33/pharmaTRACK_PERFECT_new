import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import {
  OAuthProvider,
  requestPasswordReset,
  restoreSession,
  signInWithOAuth,
  signInWithPassword,
  signOutEverywhereOnThisDevice,
  signUpWithPassword,
} from '../auth/authService';
import { unlockAccountAI } from '../ai/accountSync';
import { inspectLocalWorkspaceMigration, linkLocalWorkspaceToAccount } from '../auth/migration';
import { User, Mail, Lock, Loader2, WifiOff, Chrome, Github, ArrowLeft } from 'lucide-react';

type AuthMode = 'login' | 'signup' | 'reset';

function friendlyAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid login credentials/i.test(message)) return 'Email or password is incorrect.';
  if (/email not confirmed/i.test(message)) return 'Confirm your email before signing in, then try again.';
  if (/already registered|already exists/i.test(message)) return 'An account with this email already exists. Log in instead of creating another account.';
  if (/password/i.test(message) && /6|weak|short/i.test(message)) return 'Use a stronger password with at least 6 characters.';
  return message || 'Authentication could not be completed.';
}

const Login: React.FC = () => {
  const { dispatch } = useApp();
  const navigate = useNavigate();
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [studentName, setStudentName] = useState('');
  const [studentLevel, setStudentLevel] = useState('Level 100');
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine === false : false,
  );
  const handledRestoredSession = useRef<string | null>(null);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const resetFeedback = () => {
    setError('');
    setMessage('');
  };

  const finishAuthenticatedLogin = async (userId: string, passwordForAi?: string) => {
    const migration = inspectLocalWorkspaceMigration(userId);
    if (migration.required && migration.student) {
      const dataSummary = migration.hasAcademicData
        ? 'courses, notes, study progress, and other local academic data'
        : 'your local student profile';
      const confirmed = window.confirm(
        `This device has ${dataSummary} created before account sign-in.\n\n` +
          'Link this existing workspace to the authenticated PharmaTRACK account? ' +
          'This does not create another account and uses the Supabase user ID as the account identity.',
      );
      if (!confirmed) {
        await signOutEverywhereOnThisDevice().catch(() => undefined);
        dispatch({ type: 'SET_LOGGED_IN', payload: false });
        throw new Error('Sign-in cancelled. Your local workspace was not linked to this account.');
      }
      const linked = await linkLocalWorkspaceToAccount(userId, migration.student);
      dispatch({ type: 'SET_STUDENT', payload: linked });
    }

    // Password-derived AI credentials are an independent vault. OAuth users
    // can use normal account sync immediately, but must set/verify a password
    // before encrypted provider credentials can be unlocked on this device.
    if (passwordForAi) {
      const sync = await unlockAccountAI(userId, passwordForAi);
      if (sync.state === 'error') {
        setMessage('Signed in. AI configuration could not be restored; open Settings → AI to retry.');
      }
    }
    dispatch({ type: 'SET_LOGGED_IN', payload: true });
    navigate('/', { replace: true });
  };

  // OAuth returns to /login without passing through the password handler.
  // Restore that session here so an existing offline workspace gets the same
  // explicit migration/linking prompt as an email login. The AppContext still
  // owns the durable session state and cloud authorization checks.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await restoreSession();
        if (cancelled || !session?.user || handledRestoredSession.current === session.user.id) return;
        handledRestoredSession.current = session.user.id;
        setIsLoading(true);
        resetFeedback();
        await finishAuthenticatedLogin(session.user.id);
      } catch (reason) {
        if (!cancelled) setError(friendlyAuthError(reason));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handlePasswordAuth = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isOffline) {
      setError('Connect to the internet once to authenticate this account. Your study work remains available offline.');
      return;
    }
    setIsLoading(true);
    resetFeedback();
    try {
      if (mode === 'reset') {
        const { error: resetError } = await requestPasswordReset(email);
        if (resetError) throw resetError;
        setMessage('If an account exists for that email, a password-reset link has been sent. Check your inbox.');
        return;
      }

      if (mode === 'login') {
        const { data, error: signInError } = await signInWithPassword(email, password);
        if (signInError) throw signInError;
        if (!data.user) throw new Error('Supabase did not return an authenticated user.');
        await finishAuthenticatedLogin(data.user.id, password);
      } else {
        const { data, error: signUpError } = await signUpWithPassword(email, password, {
          fullName: studentName,
          level: studentLevel,
        });
        if (signUpError) throw signUpError;
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          throw new Error('An account with this email already exists. Log in instead of creating another account.');
        }
        if (data.session && data.user) {
          await finishAuthenticatedLogin(data.user.id, password);
        } else {
          setMessage('Account created. Check your email to confirm the account, then return here to log in.');
          setMode('login');
        }
      }
    } catch (reason) {
      setError(friendlyAuthError(reason));
    } finally {
      setIsLoading(false);
    }
  };

  const handleOAuth = async (provider: OAuthProvider) => {
    if (isOffline) {
      setError('Connect to the internet to continue with Google or GitHub.');
      return;
    }
    setIsLoading(true);
    resetFeedback();
    try {
      const { error: oauthError } = await signInWithOAuth(provider);
      if (oauthError) throw oauthError;
      // A successful OAuth call redirects to Supabase immediately. Keeping the
      // loading state avoids a second click while the provider page opens.
    } catch (reason) {
      setIsLoading(false);
      setError(friendlyAuthError(reason));
    }
  };

  const isReset = mode === 'reset';
  const isSignup = mode === 'signup';

  return (
    <div className="min-h-screen bg-[#1B4332] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md z-10">
        <div className="bg-white/95 rounded-[2rem] p-6 sm:p-8 shadow-2xl">
          <h1 className="text-3xl font-black text-center mb-2 text-slate-800">PharmaTRACK</h1>
          <p className="text-center text-sm text-slate-500 mb-6">
            {isReset
              ? 'Reset your normal PharmaTRACK account password.'
              : 'Sign in to sync your normal PharmaTRACK account across devices. Your examination Kiosk identity stays separate.'}
          </p>

          {isOffline && (
            <div className="mb-5 p-4 bg-orange-50 border border-orange-200 rounded-xl flex items-start gap-3">
              <WifiOff className="text-orange-500 shrink-0" />
              <div><p className="text-sm font-bold text-orange-800">You are offline</p><p className="text-xs text-orange-600 mt-1">Account verification needs internet. Local study data remains available.</p></div>
            </div>
          )}
          {error && <div role="alert" className="mb-4 p-3 bg-red-50 text-red-600 text-sm rounded-xl text-center font-medium">{error}</div>}
          {message && <div role="status" className="mb-4 p-3 bg-emerald-50 text-emerald-700 text-sm rounded-xl text-center font-medium">{message}</div>}

          {!isReset && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-5">
              <button type="button" onClick={() => { setMode('login'); resetFeedback(); }} className={`py-2.5 rounded-xl text-sm font-bold ${mode === 'login' ? 'bg-[#1B4332] text-white' : 'bg-slate-100 text-slate-500'}`}>Log in</button>
              <button type="button" onClick={() => { setMode('signup'); resetFeedback(); }} className={`py-2.5 rounded-xl text-sm font-bold ${isSignup ? 'bg-[#1B4332] text-white' : 'bg-slate-100 text-slate-500'}`}>Create account</button>
            </div>
          )}

          <form onSubmit={handlePasswordAuth} className="space-y-4">
            {isSignup && (
              <label className="block text-xs font-bold text-gray-500 uppercase">
                Full name
                <div className="relative mt-2"><User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" /><input type="text" required value={studentName} onChange={(e) => setStudentName(e.target.value)} className="w-full pl-12 pr-4 py-3.5 bg-gray-50 rounded-2xl outline-none" /></div>
              </label>
            )}
            {isSignup && (
              <label className="block text-xs font-bold text-gray-500 uppercase">
                Level
                <select value={studentLevel} onChange={(e) => setStudentLevel(e.target.value)} className="w-full mt-2 px-4 py-3.5 bg-gray-50 rounded-2xl outline-none">
                  {['Level 100', 'Level 200', 'Level 300', 'Level 400', 'Level 500', 'Level 600'].map((level) => <option key={level}>{level}</option>)}
                </select>
              </label>
            )}
            <label className="block text-xs font-bold text-gray-500 uppercase">
              Email
              <div className="relative mt-2"><Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" /><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full pl-12 pr-4 py-3.5 bg-gray-50 rounded-2xl outline-none" /></div>
            </label>
            {!isReset && (
              <label className="block text-xs font-bold text-gray-500 uppercase">
                Password
                <div className="relative mt-2"><Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" /><input type="password" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full pl-12 pr-4 py-3.5 bg-gray-50 rounded-2xl outline-none" /></div>
              </label>
            )}
            <button type="submit" disabled={isLoading || isOffline} className="w-full py-3.5 bg-[#1B4332] text-white font-bold rounded-2xl hover:bg-[#2D6A4F] transition-all disabled:opacity-50">
              {isLoading ? <Loader2 className="animate-spin mx-auto" /> : isReset ? 'Send reset link' : isSignup ? 'Create account' : 'Log in'}
            </button>
          </form>

          {mode === 'login' && (
            <>
              <button type="button" onClick={() => { setMode('reset'); resetFeedback(); }} className="w-full mt-3 text-xs text-[#2D6A4F] font-bold hover:underline">Forgot password?</button>
              <div className="my-5 flex items-center gap-3 text-xs text-slate-400"><span className="h-px bg-slate-200 flex-1" />or<span className="h-px bg-slate-200 flex-1" /></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button type="button" disabled={isLoading || isOffline} onClick={() => void handleOAuth('google')} className="flex items-center justify-center gap-2 py-3 border border-slate-200 rounded-xl font-bold text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Chrome className="w-4 h-4" /> Google</button>
                <button type="button" disabled={isLoading || isOffline} onClick={() => void handleOAuth('github')} className="flex items-center justify-center gap-2 py-3 border border-slate-200 rounded-xl font-bold text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Github className="w-4 h-4" /> GitHub</button>
              </div>
            </>
          )}

          {isReset && <button type="button" onClick={() => { setMode('login'); resetFeedback(); }} className="w-full mt-4 flex items-center justify-center gap-2 text-sm font-bold text-slate-500 hover:text-[#2D6A4F]"><ArrowLeft className="w-4 h-4" /> Back to login</button>}
          {!isReset && <button type="button" onClick={() => navigate('/', { replace: true })} className="w-full py-3 mt-3 text-sm font-bold text-slate-500 hover:text-[#2D6A4F]">Continue without signing in</button>}
        </div>
      </div>
    </div>
  );
};

export default Login;
