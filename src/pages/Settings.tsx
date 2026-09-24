// PharmTrack - Settings Page

import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import AISettingsPanel from '../components/AISettingsPanel';
import { v4 as uuidv4 } from 'uuid';
import { ExamDate } from '../types';
import {
  Settings as SettingsIcon,
  User,
  Calendar,
  Trash2,
  Download,
  Upload,
  Plus,
  Edit2,
  X,
  Save,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  LogOut,
  Cloud,
  GraduationCap,
  Archive,
  HardDrive,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { clearState, saveState, loadState } from '../utils/storage';
import { clearAllCredentials } from '../ai/credentials';
import { clearConversations } from '../ai/conversations';
import { clearAISettings } from '../ai/settings';
import { supabase } from '../utils/supabase';
import { withCloudAccess } from '../utils/requireAuth';
import { clear } from 'idb-keyval';
import CompleteSemesterModal from '../components/CompleteSemesterModal';

const Settings: React.FC = () => {
  const { state, dispatch, logout } = useApp();
  const navigate = useNavigate();

  // `/settings?tab=ai` (and `/settings#ai`) are the deep links used by the AI
  // panel, the dashboard badge and the AI workspace. Land the student on that
  // section instead of the top of a long page.
  const location = useLocation();
  const aiSectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wantsAI = new URLSearchParams(location.search).get('tab') === 'ai' || location.hash === '#ai';
    if (!wantsAI) return;
    const timer = window.setTimeout(() => {
      aiSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [location.search, location.hash]);

  const [isSigningOut, setIsSigningOut] = useState(false);
  const [showCompleteSemester, setShowCompleteSemester] = useState(false);

  // Signs out via the shared logout() so the Supabase session is actually
  // cleared. Locally cached study data is intentionally kept — use
  // "Clear ALL Data" below to wipe content.
  const handleSignOut = async () => {
    if (!window.confirm('Sign out of PharmaTRACK?\n\nYour courses, slides and notes stay saved on this device.')) return;
    setIsSigningOut(true);
    try {
      await logout();
      navigate('/', { replace: true });
    } finally {
      setIsSigningOut(false);
    }
  };
  const [showExamModal, setShowExamModal] = useState(false);
  const [editingExam, setEditingExam] = useState<ExamDate | null>(null);
  const [examForm, setExamForm] = useState({
    courseId: '',
    examDate: format(new Date(), 'yyyy-MM-dd'),
    examType: 'endsem' as ExamDate['examType'],
  });

  // Profile state
  const [profileForm, setProfileForm] = useState({
    name: state.student?.name || '',
    university: state.student?.university || '',
    level: state.student?.level || '',
    program: state.student?.program || '',
    semester: state.student?.semester || '',
  });
  const [profileSaved, setProfileSaved] = useState(false);

  const levels = ['Level 100', 'Level 200', 'Level 300', 'Level 400', 'Level 500', 'Level 600'];
  const semesters = ['1st Semester', '2nd Semester'];

  const handleSaveProfile = async (e?: React.FormEvent) => {
    if(e) e.preventDefault();
    if (state.student) {
      dispatch({ type: 'UPDATE_STUDENT', payload: profileForm });
      
      const currentState = loadState();
      saveState({
        ...currentState,
        student: { ...currentState.student, ...profileForm }
      } as any);

      if (navigator.onLine) {
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            await supabase.from('profiles').upsert({
              id: user.id,
              full_name: profileForm.name,
              university: profileForm.university,
              level: profileForm.level,
              program: profileForm.program,
              semester: profileForm.semester,
              updated_at: new Date().toISOString()
            });
          }
        } catch (e) {
          console.error("Supabase sync failed (likely missing SQL columns). Safely saved offline.");
        }
      }

      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2000);
    }
  };

  React.useEffect(() => {
    if (state.student) {
      setProfileForm({
        name: state.student.name || '',
        university: state.student.university || '',
        level: state.student.level || '',
        program: state.student.program || '',
        semester: state.student.semester || '',
      });
    }
  }, [state.student?.id]);


  const handleExportData = () => {
    const data = loadState();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pharmtrack_backup_${format(new Date(), 'yyyy-MM-dd')}.json`;
    a.click();
  };

  const handleImportData = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        if (window.confirm('This will replace all your current data. Are you sure?')) {
          saveState(data);
          dispatch({ type: 'LOAD_STATE', payload: data });
          alert('Data imported successfully!');
        }
      } catch (error) {
        alert('Invalid backup file');
      }
    };
    reader.readAsText(file);
  };

  const handleClearData = () => {
    if (
      window.confirm(
        'Are you sure you want to delete ALL your data? This cannot be undone!'
      )
    ) {
      if (window.confirm('Really delete everything?')) {
        clearState();
        // AI credentials live outside the app state (they are deliberately not
        // part of academic data), so a nuclear wipe has to clear them too.
        void clearAllCredentials();
        void clearConversations();
        clearAISettings();
        window.location.reload();
      }
    }
  };

  const handleClearFileStorage = async () => {
    if (
      window.confirm(
        '⚠️ FIX FOR PDF ERRORS: This will delete all uploaded PDFs and images. Your courses, notes, and settings will be kept. You will need to re-upload your slides. Continue?'
      )
    ) {
      try {
        await clear();
        alert('✅ File storage cleared! Please re-upload your PDF slides now.');
        window.location.reload();
      } catch (err) {
        alert('Error clearing storage. Please try manually clearing browser data.');
      }
    }
  };

  // Exam dates management
  const handleAddExam = () => {
    setEditingExam(null);
    setExamForm({
      courseId: state.courses[0]?.id || '',
      examDate: format(new Date(), 'yyyy-MM-dd'),
      examType: 'endsem',
    });
    setShowExamModal(true);
  };

  const handleEditExam = (exam: ExamDate) => {
    setEditingExam(exam);
    setExamForm({
      courseId: exam.courseId,
      examDate: exam.examDate,
      examType: exam.examType,
    });
    setShowExamModal(true);
  };

  const handleSaveExam = () => {
    if (!examForm.courseId) return;

    if (editingExam) {
      dispatch({
        type: 'UPDATE_EXAM_DATE',
        payload: {
          id: editingExam.id,
          updates: examForm,
        },
      });
    } else {
      const newExam: ExamDate = {
        id: uuidv4(),
        ...examForm,
        isReminderSet: false,
      };
      dispatch({ type: 'ADD_EXAM_DATE', payload: newExam });
    }

    setShowExamModal(false);
  };

  const handleDeleteExam = (id: string) => {
    if (window.confirm('Delete this exam date?')) {
      dispatch({ type: 'DELETE_EXAM_DATE', payload: id });
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <SettingsIcon className="w-7 h-7 text-gray-600" />
          Settings
        </h1>
        <p className="text-gray-500">Manage your profile and app preferences</p>
      </div>

      <Link to="/storage" className="block bg-white rounded-xl border border-gray-100 shadow-sm p-4 hover:border-[#2D6A4F]/30">
        <div className="flex items-center gap-3">
          <HardDrive className="w-5 h-5 text-[#2D6A4F]" />
          <div>
            <h2 className="font-semibold text-gray-800">Storage Manager</h2>
            <p className="text-sm text-gray-500">See what is on this device, and recover without deleting a semester.</p>
          </div>
        </div>
      </Link>

      {/* Profile Section */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="p-4 bg-gray-50 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2">
            <User className="w-5 h-5 text-[#2D6A4F]" />
            Profile Information
          </h2>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={profileForm.name}
              onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">University</label>
            <input
              type="text"
              value={profileForm.university}
              onChange={(e) => setProfileForm({ ...profileForm, university: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Level</label>
              <select
                value={profileForm.level}
                onChange={(e) => setProfileForm({ ...profileForm, level: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
              >
                {levels.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Semester</label>
              <select
                value={profileForm.semester}
                onChange={(e) => setProfileForm({ ...profileForm, semester: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
              >
                {semesters.map((sem) => (
                  <option key={sem} value={sem}>
                    {sem}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Program</label>
            <input
              type="text"
              value={profileForm.program}
              onChange={(e) => setProfileForm({ ...profileForm, program: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
            />
          </div>

          <button
            onClick={handleSaveProfile}
            className="flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332]"
          >
            {profileSaved ? (
              <>
                <CheckCircle2 className="w-4 h-4" />
                Saved!
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Profile
              </>
            )}
          </button>
        </div>
      </div>

      {/* Semester Section */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="p-4 bg-gray-50 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2">
            <GraduationCap className="w-5 h-5 text-[#2D6A4F]" />
            Semester
          </h2>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-gray-700">
                Currently studying: <strong>{state.student?.level || '—'} · {state.student?.semester || '—'}</strong>
              </p>
              <p className="text-xs text-gray-500 mt-1">
                When a semester ends, complete it to archive everything locally —
                courses, slides, files, notes and quizzes — then start a fresh workspace.
                Past semesters stay in the Academic Archive.
              </p>
            </div>
            <div className="flex gap-2">
              <Link
                to="/archive"
                className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium"
              >
                <Archive className="w-4 h-4" />
                Academic Archive
              </Link>
              <button
                onClick={() => setShowCompleteSemester(true)}
                className="flex items-center gap-1.5 px-3 py-2 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] text-sm font-bold shadow-sm"
              >
                <GraduationCap className="w-4 h-4 text-[#FFB703]" />
                Complete Semester…
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* AI ENGINE — multi-provider settings (NVIDIA, OpenAI, Gemini, Claude,
          Groq, OpenRouter, Mistral, custom OpenAI-compatible, future local).
          Provider-independent: every provider, model, profile and fallback
          lives in the engine, never in this page. */}
      <div
        id="ai"
        ref={aiSectionRef}
        className="bg-[#0F172A] rounded-2xl border border-white/5 shadow-2xl overflow-hidden text-white scroll-mt-4"
      >
        <div className="p-5 bg-gradient-to-r from-[#1B4332] to-[#0F172A] border-b border-white/5">
          <h2 className="font-bold flex items-center gap-2 tracking-tight">
            <Sparkles className="w-5 h-5 text-[#FFB703]" />
            AI ENGINE
          </h2>
          <p className="text-xs text-gray-400 mt-1">
            Connect one or many providers. PharmaTRACK switches between them automatically, and always tells you which
            one answered.
          </p>
        </div>
        <div className="p-5 bg-white">
          <AISettingsPanel />
        </div>
      </div>

      {/* Exam Dates Section */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="p-4 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2">
            <Calendar className="w-5 h-5 text-[#FFB703]" />
            Exam Dates
          </h2>
          <button
            onClick={handleAddExam}
            disabled={state.courses.length === 0}
            className="flex items-center gap-1 px-3 py-1.5 bg-[#FFB703] text-[#1B4332] text-sm font-medium rounded-lg hover:bg-[#FFA500] disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            Add Exam
          </button>
        </div>
        <div className="p-5">
          {state.examDates.length === 0 ? (
            <p className="text-center text-gray-500 py-4">No exam dates added yet</p>
          ) : (
            <div className="space-y-3">
              {state.examDates.map((exam) => {
                const course = state.courses.find((c) => c.id === exam.courseId);
                return (
                  <div
                    key={exam.id}
                    className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-800">{course?.courseCode}</span>
                        <span className="px-2 py-0.5 bg-gray-200 text-gray-600 text-xs rounded capitalize">
                          {exam.examType}
                        </span>
                      </div>
                      <p className="text-sm text-gray-500">
                        {format(parseISO(exam.examDate), 'EEEE, MMMM d, yyyy')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleEditExam(exam)}
                        className="p-1.5 text-gray-400 hover:text-[#2D6A4F] hover:bg-gray-100 rounded"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteExam(exam.id)}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Data Management Section */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="p-4 bg-gray-50 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2">
            <Download className="w-5 h-5 text-blue-600" />
            Data Management
          </h2>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex gap-4">
            <button
              onClick={handleExportData}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Download className="w-4 h-4" />
              Export Data
            </button>

            <label className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 cursor-pointer">
              <Upload className="w-4 h-4" />
              Import Data
              <input
                type="file"
                accept=".json"
                onChange={handleImportData}
                className="hidden"
              />
            </label>
          </div>

          {/* Account / Session */}
          <div className="pt-4 border-t border-gray-200">
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                  <LogOut className="w-5 h-5 text-slate-500" />
                  Cloud Account
                </h3>
                {state.isLoggedIn ? (
                  <p className="text-sm text-slate-500 mt-1">
                    Signing out keeps your courses, slides and notes on this device.
                  </p>
                ) : (
                  <p className="text-sm font-semibold text-red-700 mt-1">
                    No cloud backup — your work exists only on this device. If it is lost or
                    damaged, the data goes with it. The app works fully offline either way.
                  </p>
                )}
              </div>
              {state.isLoggedIn ? (
                <button
                  onClick={handleSignOut}
                  disabled={isSigningOut}
                  className="flex items-center gap-2 px-4 py-2.5 bg-slate-800 text-white rounded-lg hover:bg-slate-900 font-bold disabled:opacity-50"
                >
                  <LogOut className="w-4 h-4" />
                  {isSigningOut ? 'Signing out…' : 'Sign Out'}
                </button>
              ) : (
                <button
                  onClick={() => navigate('/login')}
                  className="flex items-center gap-2 px-4 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 font-bold shadow-sm"
                >
                  <Cloud className="w-4 h-4" />
                  Sign in to sync
                </button>
              )}
            </div>

            {/* Emergency Fix Section */}
            <div className="bg-red-50 border-2 border-red-200 rounded-xl p-4 mb-4">
              <h3 className="font-bold text-red-800 mb-2 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                PDF NOT LOADING? Follow These Steps:
              </h3>
              <ol className="text-sm text-red-700 space-y-2 list-decimal list-inside mb-4">
                <li>Click the orange button below to clear file storage</li>
                <li>OR press F12 → Console → paste this code:</li>
              </ol>
              <div className="bg-gray-900 text-green-400 p-3 rounded-lg font-mono text-xs overflow-x-auto">
                indexedDB.deleteDatabase('keyval-store'); localStorage.clear(); location.reload();
              </div>
              <button
                onClick={handleClearFileStorage}
                className="w-full mt-4 flex items-center justify-center gap-2 px-4 py-3 bg-orange-500 text-white rounded-lg hover:bg-orange-600 font-bold"
              >
                <AlertTriangle className="w-5 h-5" />
                🚨 CLEAR FILE STORAGE (Fixes PDF Errors)
              </button>
            </div>
            
            <button
              onClick={handleClearData}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              <Trash2 className="w-4 h-4" />
              Clear ALL Data (Nuclear Option)
            </button>
            <p className="text-sm text-gray-500 mt-2">
              <AlertTriangle className="w-4 h-4 inline mr-1 text-red-500" />
              This will permanently delete EVERYTHING: courses, slides, questions, and progress.
            </p>
          </div>
        </div>
      </div>

      
      {/* Cloud Sync Settings */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="p-4 bg-gray-50 border-b border-gray-100">
           <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" /></svg>
            1GB Cloud Storage Sync
          </h2>
        </div>
        <div className="p-5 flex flex-col gap-4">
          <p className="text-sm text-slate-500">
            Push a backup of your local database to your 1GB Supabase storage bucket.
          </p>
          <button 
            onClick={async () => {
              // Cloud-only feature: ask for sign-in here rather than gating the
              // whole app. Declining leaves local data untouched.
              await withCloudAccess(
                async (userId) => {
                  try {
                    const file = new Blob([JSON.stringify(loadState(), null, 2)], { type: 'application/json' });
                    const { error } = await supabase.storage
                      .from('user-documents')
                      .upload(`${userId}/pharmatrack_backup.json`, file, { upsert: true });
                    if (error) throw error;
                    alert("Backup complete — your data is safely copied to the cloud.");
                  } catch (e: any) {
                    alert("Backup failed: " + e.message + "\n\nYour data is still safe on this device.");
                  }
                },
                () => navigate('/login'),
              );
            }}
            className="w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700"
          >
            Sync to Supabase Cloud
          </button>
        </div>
      </div>

      {/* App Info */}
      <div className="bg-gradient-to-r from-[#1B4332] to-[#2D6A4F] rounded-xl p-5 text-white">
        <h3 className="font-semibold text-lg mb-2">PharmTrack Study Tracker</h3>
        <p className="text-white/80 text-sm mb-3">
          A personalized study tracker and exam preparation system for pharmacy students at UCC.
        </p>
        <div className="flex flex-wrap gap-4 text-sm text-white/60">
          <span>Version 1.0.0</span>
          <span>•</span>
          <span>Data stored locally in your browser</span>
        </div>
      </div>

      {/* Complete Semester Modal */}
      <CompleteSemesterModal open={showCompleteSemester} onClose={() => setShowCompleteSemester(false)} />

      {/* Exam Modal */}
      {showExamModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold text-gray-800">
                {editingExam ? 'Edit Exam Date' : 'Add Exam Date'}
              </h2>
              <button onClick={() => setShowExamModal(false)} className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Course</label>
                <select
                  value={examForm.courseId}
                  onChange={(e) => setExamForm({ ...examForm, courseId: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
                >
                  <option value="">Select a course</option>
                  {state.courses.map((course) => (
                    <option key={course.id} value={course.id}>
                      {course.courseCode} - {course.courseName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Exam Type</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {(['midsem', 'endsem', 'practical'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setExamForm({ ...examForm, examType: type })}
                      className={`py-2 px-3 rounded-lg border-2 text-sm font-medium capitalize transition-all ${
                        examForm.examType === type
                          ? 'border-[#2D6A4F] bg-[#2D6A4F]/10 text-[#2D6A4F]'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {type === 'midsem' ? 'Mid-Sem' : type === 'endsem' ? 'End-Sem' : 'Practical'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Exam Date</label>
                <input
                  type="date"
                  value={examForm.examDate}
                  onChange={(e) => setExamForm({ ...examForm, examDate: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setShowExamModal(false)}
                  className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveExam}
                  disabled={!examForm.courseId}
                  className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] disabled:opacity-50"
                >
                  {editingExam ? 'Save Changes' : 'Add Exam'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Settings;
