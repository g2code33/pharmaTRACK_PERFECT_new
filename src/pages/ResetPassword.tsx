import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { getAuthenticatedUser, restoreSession, updatePassword } from '../auth/authService';

const ResetPassword: React.FC = () => {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        // Let Supabase finish exchanging a PKCE recovery code before asking
        // the Auth server to validate the resulting user.
        await restoreSession();
        const user = await getAuthenticatedUser();
        if (!user) setError('This reset link is expired or invalid. Request a new link from the login page.');
      } catch {
        setError('This reset link is expired or invalid. Request a new link from the login page.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (password.length < 6) {
      setError('Use a password with at least 6 characters.');
      return;
    }
    if (password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      const { error: updateError } = await updatePassword(password);
      if (updateError) throw updateError;
      setDone(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The password could not be updated.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#1B4332] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-[2rem] p-6 sm:p-8 shadow-2xl">
        <h1 className="text-2xl font-black text-center text-slate-800">Set a new password</h1>
        <p className="text-center text-sm text-slate-500 mt-2 mb-6">This changes the normal PharmaTRACK account password. It does not change an examination Kiosk credential.</p>
        {loading ? (
          <Loader2 className="mx-auto animate-spin text-[#2D6A4F]" />
        ) : done ? (
          <div className="space-y-4 text-center">
            <CheckCircle2 className="mx-auto text-emerald-600" />
            <p className="text-sm font-semibold text-emerald-700">Password updated successfully.</p>
            <button type="button" onClick={() => navigate('/login', { replace: true })} className="w-full py-3 rounded-xl bg-[#1B4332] text-white font-bold">Return to login</button>
          </div>
        ) : (
          <form onSubmit={save} className="space-y-4">
            {error && <div role="alert" className="p-3 rounded-xl bg-red-50 text-red-700 text-sm flex gap-2"><AlertCircle className="w-4 h-4 shrink-0" />{error}</div>}
            <label className="block text-xs font-bold text-slate-500 uppercase">New password
              <div className="relative mt-2"><Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" /><input type="password" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full pl-12 pr-4 py-3.5 bg-slate-50 rounded-xl outline-none" /></div>
            </label>
            <label className="block text-xs font-bold text-slate-500 uppercase">Confirm password
              <input type="password" minLength={6} required value={confirmation} onChange={(e) => setConfirmation(e.target.value)} className="w-full mt-2 px-4 py-3.5 bg-slate-50 rounded-xl outline-none" />
            </label>
            <button type="submit" disabled={saving} className="w-full py-3.5 bg-[#1B4332] text-white rounded-xl font-bold disabled:opacity-50">{saving ? <Loader2 className="mx-auto animate-spin" /> : 'Update password'}</button>
          </form>
        )}
      </div>
    </div>
  );
};

export default ResetPassword;
