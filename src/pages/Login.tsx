import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { supabase } from '../utils/supabase';
import { User, Award, Mail, Lock, ArrowRight, Loader2, WifiOff } from 'lucide-react';

const Login: React.FC = () => {
  const { dispatch } = useApp();
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [studentName, setStudentName] = useState('');
  const [studentLevel, setStudentLevel] = useState('Level 100');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); };
  }, []);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if(isOffline) { setError('You are offline. Please connect once to verify credentials.'); setIsLoading(false); return; }
    setIsLoading(true); setError('');

    try {
      if (isLoginMode) {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (data.session) dispatch({ type: 'SET_LOGGED_IN', payload: true });
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (data.user) {
           await supabase.from('profiles').insert([{ id: data.user.id, full_name: studentName, level: studentLevel }]);
           setError("Registration successful! Check your email to verify.");
        }
      }
    } catch(err: any) { setError(err.message); } finally { setIsLoading(false); }
  };

  return (
    <div className="min-h-screen bg-[#1B4332] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md z-10">
        <div className="bg-white/95 rounded-[2rem] p-8 shadow-2xl">
          <h1 className="text-3xl font-black text-center mb-6 text-slate-800">PharmaTRACK</h1>
          
          {isOffline && (
            <div className="mb-6 p-4 bg-orange-50 border border-orange-200 rounded-xl flex items-start space-x-3">
              <WifiOff className="text-orange-500 shrink-0" />
              <div><p className="text-sm font-bold text-orange-800">You are offline</p><p className="text-xs text-orange-600 mt-1">Please connect to authenticate.</p></div>
            </div>
          )}

          <form onSubmit={handleAuth} className="space-y-5">
            {error && <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl text-center font-medium">{error}</div>}

            {!isLoginMode && (
              <div>
                <label className="block text-xs font-bold text-gray-400 uppercase mb-2">Full Name</label>
                <div className="relative"><User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" /><input type="text" required value={studentName} onChange={(e) => setStudentName(e.target.value)} className="w-full pl-12 pr-4 py-4 bg-gray-50 rounded-2xl outline-none" /></div>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-gray-400 uppercase mb-2">Email</label>
              <div className="relative"><Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" /><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full pl-12 pr-4 py-4 bg-gray-50 rounded-2xl outline-none" /></div>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-400 uppercase mb-2">Password</label>
              <div className="relative"><Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" /><input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full pl-12 pr-4 py-4 bg-gray-50 rounded-2xl outline-none" /></div>
            </div>

            <button type="button" onClick={() => {setIsLoginMode(!isLoginMode); setError('');}} className="text-xs text-[#2D6A4F] font-bold hover:underline">
              {isLoginMode ? 'First time? Create account' : 'Have an account? Log in'}
            </button>

            <button type="submit" disabled={isLoading || isOffline} className="w-full py-4 bg-[#1B4332] text-white font-bold rounded-2xl hover:bg-[#2D6A4F] transition-all">
              {isLoading ? <Loader2 className="animate-spin mx-auto" /> : <>{isLoginMode ? 'Connect' : 'Sign Up'}</>}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
export default Login;
