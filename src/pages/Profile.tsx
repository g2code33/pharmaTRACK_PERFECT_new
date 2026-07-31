import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { supabase } from '../utils/supabase';
import { checkCloudAccess } from '../utils/requireAuth';
import { User, ShieldCheck, Loader2, Building, GraduationCap, BookOpen, Calendar, Cloud, CloudOff } from 'lucide-react';

const LEVELS = ['Level 100', 'Level 200', 'Level 300', 'Level 400', 'Level 500', 'Level 600'];
const SEMESTERS = ['1st Semester', '2nd Semester'];
const PROGRAMS = [
  'Doctor of Pharmacy (Pharm.D)',
  'Bachelor of Pharmacy (B.Pharm)',
  'Pharmaceutical Sciences',
];

const Profile = () => {
  const { state, dispatch } = useApp();
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  // Mirrors every field Onboarding collects. Showing only "Full Name" here
  // meant the other four could be set once and then never corrected.
  const [form, setForm] = useState({
    name: '',
    university: '',
    level: LEVELS[1],
    program: PROGRAMS[0],
    semester: SEMESTERS[0],
  });

  // Repopulate whenever the stored student changes (e.g. after a cloud fetch).
  useEffect(() => {
    if (state.student) {
      setForm({
        name: state.student.name || '',
        university: state.student.university || '',
        level: state.student.level || LEVELS[1],
        program: state.student.program || PROGRAMS[0],
        semester: state.student.semester || SEMESTERS[0],
      });
    }
  }, [state.student?.id]);

  const set = (key: keyof typeof form) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMsg('');
    try {
      // Save locally first — this must always work, with or without an account.
      dispatch({ type: 'UPDATE_STUDENT', payload: { ...form } });
      setMsg('Saved on this device.');

      // Then mirror to the cloud if that's available. Silently skipped when
      // offline or signed out; the local save above already succeeded.
      const access = await checkCloudAccess();
      if (access.ok) {
        const { error } = await supabase.from('profiles').upsert({
          id: access.userId,
          full_name: form.name,
          university: form.university,
          level: form.level,
          program: form.program,
          semester: form.semester,
          updated_at: new Date().toISOString(),
        });
        if (error) throw error;
        setMsg('Saved and synced to your account.');
      }
    } catch (err: any) {
      setMsg('Saved on this device. Cloud sync failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    'w-full px-4 py-3 rounded-xl border border-slate-200 outline-none focus:ring-2 focus:ring-[#2D6A4F] bg-white';

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="bg-gradient-to-r from-slate-800 to-slate-900 rounded-2xl p-8 text-white shadow-lg flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold mb-2">Profile Settings</h1>
          {state.isLoggedIn ? (
            <p className="text-sm text-slate-300">
              Changes save on this device and sync to your account.
            </p>
          ) : (
            // Red because this is the state where work exists in exactly one
            // place — worth emphasising rather than stating quietly.
            <p className="inline-flex items-center gap-2 text-sm font-bold text-red-100 bg-red-600/90 border border-red-400 rounded-lg px-3 py-2">
              <CloudOff className="w-4 h-4 shrink-0" />
              Saved on this device only — no cloud backup. Sign in to protect your work.
            </p>
          )}
        </div>
        <ShieldCheck size={48} className="opacity-50" />
      </div>

      {msg && (
        <div className="p-4 bg-green-100 text-green-800 rounded-xl font-semibold flex items-center gap-2">
          {state.isLoggedIn ? <Cloud className="w-5 h-5" /> : <CloudOff className="w-5 h-5" />}
          {msg}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
        <h2 className="text-xl font-bold flex items-center mb-6">
          <User className="mr-2 text-[#2D6A4F]" /> Student Details
        </h2>

        <form onSubmit={handleUpdateProfile} className="space-y-4">
          <div>
            <label className="block text-sm font-semibold mb-2 flex items-center gap-2">
              <User className="w-4 h-4 text-slate-400" /> Full Name
            </label>
            <input type="text" value={form.name} onChange={set('name')} className={inputClass} />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 flex items-center gap-2">
              <Building className="w-4 h-4 text-slate-400" /> University
            </label>
            <input type="text" value={form.university} onChange={set('university')} className={inputClass} />
          </div>

          <div>
            <label className="block text-sm font-semibold mb-2 flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-slate-400" /> Program
            </label>
            <select value={form.program} onChange={set('program')} className={inputClass}>
              {PROGRAMS.map((p) => <option key={p} value={p}>{p}</option>)}
              {/* Keep any legacy value that isn't in the list selectable. */}
              {!PROGRAMS.includes(form.program) && form.program && (
                <option value={form.program}>{form.program}</option>
              )}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold mb-2 flex items-center gap-2">
                <GraduationCap className="w-4 h-4 text-slate-400" /> Current Level
              </label>
              <select value={form.level} onChange={set('level')} className={inputClass}>
                {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                {!LEVELS.includes(form.level) && form.level && (
                  <option value={form.level}>{form.level}</option>
                )}
              </select>
            </div>

            <div>
              <label className="block text-sm font-semibold mb-2 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-slate-400" /> Current Semester
              </label>
              <select value={form.semester} onChange={set('semester')} className={inputClass}>
                {SEMESTERS.map((s) => <option key={s} value={s}>{s}</option>)}
                {!SEMESTERS.includes(form.semester) && form.semester && (
                  <option value={form.semester}>{form.semester}</option>
                )}
              </select>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#1B4332] text-white font-bold py-3 rounded-xl hover:bg-[#2D6A4F] disabled:opacity-50"
          >
            {loading ? <Loader2 className="animate-spin mx-auto" /> : 'Save Changes'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Profile;
