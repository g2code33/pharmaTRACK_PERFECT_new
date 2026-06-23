import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { supabase } from '../utils/supabase';
import { User, ShieldCheck, Loader2 } from 'lucide-react';

const Profile = () => {
  const { state, dispatch } = useApp();
  const [name, setName] = useState(state.student?.name || '');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setMsg('');
    try {
      if(!navigator.onLine) throw new Error("Must be online to update cloud profile.");
      const user = (await supabase.auth.getUser()).data.user;
      if (!user) throw new Error("Not authenticated");
      await supabase.from('profiles').upsert({ id: user.id, full_name: name });
      if(state.student) dispatch({ type: 'UPDATE_STUDENT', payload: { name } });
      setMsg('Profile updated successfully!');
    } catch (err: any) { setMsg('Error: ' + err.message); } finally { setLoading(false); }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="bg-gradient-to-r from-slate-800 to-slate-900 rounded-2xl p-8 text-white shadow-lg flex justify-between items-center">
        <div><h1 className="text-3xl font-bold mb-2">Profile Settings</h1></div><ShieldCheck size={48} className="opacity-50" />
      </div>
      {msg && <div className="p-4 bg-green-100 text-green-700 rounded-xl font-semibold">{msg}</div>}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
        <h2 className="text-xl font-bold flex items-center mb-6"><User className="mr-2 text-[#2D6A4F]" /> Details</h2>
        <form onSubmit={handleUpdateProfile} className="space-y-4">
          <div><label className="block text-sm font-semibold mb-2">Full Name</label><input type="text" value={name} onChange={e => setName(e.target.value)} className="w-full px-4 py-3 rounded-xl border outline-none focus:ring-2 focus:ring-[#2D6A4F]" /></div>
          <button type="submit" disabled={loading || !navigator.onLine} className="w-full bg-[#1B4332] text-white font-bold py-3 rounded-xl hover:bg-[#2D6A4F] disabled:opacity-50">{loading ? <Loader2 className="animate-spin mx-auto" /> : 'Save Online'}</button>
        </form>
      </div>
    </div>
  );
};
export default Profile;
