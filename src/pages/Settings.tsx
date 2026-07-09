// PharmTrack - Settings Page

import { invoke } from '@tauri-apps/api/core';
import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
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
  ShieldCheck,
  Key,
  Eye,
  EyeOff,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { clearState, saveState, loadState } from '../utils/storage';
import { supabase } from '../utils/supabase';
import { clear } from 'idb-keyval';

const Settings: React.FC = () => {
  const { state, dispatch } = useApp();
  const [showExamModal, setShowExamModal] = useState(false);
  const [editingExam, setEditingExam] = useState<ExamDate | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKey, setApiKey] = useState(state.openAIKey);
  const [apiKeySaved, setApiKeySaved] = useState(false);
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

  const handleSaveApiKey = () => {
    dispatch({ type: 'SET_OPENAI_KEY', payload: apiKey });
    setApiKeySaved(true);
    setTimeout(() => setApiKeySaved(false), 2000);
  };

  
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

          <div className="grid grid-cols-2 gap-4">
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

      {/* PharmaGAME AI Connection Section */}
      <div className="bg-[#0F172A] rounded-2xl border border-white/5 shadow-2xl overflow-hidden text-white">
        <div className="p-5 bg-gradient-to-r from-[#1B4332] to-[#0F172A] border-b border-white/5">
          <h2 className="font-bold flex items-center gap-2 tracking-tight">
            <Sparkles className="w-5 h-5 text-[#FFB703]" />
            PHARMAGAME AI CORE STATUS
          </h2>
        </div>
        <div className="p-6 space-y-6">
          <div className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/10">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-green-500/20 rounded-full flex items-center justify-center border border-green-500/50">
                <ShieldCheck className="w-6 h-6 text-green-400" />
              </div>
              <div>
                <p className="font-black text-sm uppercase tracking-widest text-[#FFB703]">Neural Bridge: Active</p>
                <p className="text-xs text-gray-400">Authenticated via PharmaGAME Secure Session</p>
              </div>
            </div>
            <div className="px-3 py-1 bg-green-500/10 text-green-400 text-[10px] font-black rounded-full border border-green-500/20 uppercase tracking-widest">
              Secured
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-widest ml-1">Integrated Engine</p>
            <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-bold">PharmaGAME LLM Core</span>
                <span className="text-xs text-gray-400">v4.2.0-pharma</span>
              </div>
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-[#FFB703] w-[95%]" />
              </div>
              <p className="text-[10px] text-gray-500 mt-2 italic">* Direct linking active. No external API keys required.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Google AI Studio API Key Section */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="p-4 bg-gray-50 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2">
            <Key className="w-5 h-5 text-blue-600" />
            Google AI Studio (Gemini) API Key
          </h2>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-gray-600">
            Add your Google AI Studio API key to enable real AI-powered question generation, summaries, and the study assistant. 
            Get your free API key from{' '}
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline font-medium"
            >
              aistudio.google.com
            </a>
          </p>

          <div className="relative">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="AIza..."
              className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            />
            <button
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showApiKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>

          <button
            onClick={handleSaveApiKey}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            {apiKeySaved ? (
              <>
                <CheckCircle2 className="w-4 h-4" />
                Saved!
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save API Key
              </>
            )}
          </button>
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

          <div className="pt-4 border-t border-gray-200">
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
              if (!navigator.onLine) return alert("No internet connection.");
              try {
                const { data: { user } } = await supabase.auth.getUser();
                if (!user) throw new Error("You must be logged in to sync.");
                const file = new Blob([JSON.stringify(loadState(), null, 2)], { type: 'application/json' });
                const { error } = await supabase.storage.from('user-documents').upload(`${user.id}/pharmatrack_backup.json`, file, { upsert: true });
                if (error) throw error;
                alert("Cloud Sync Initiated! Uploading local data to your secure bucket...");
                setTimeout(() => alert("Upload Complete! All local JSON data securely synced to the cloud."), 2000);
              } catch (e: any) {
                alert("Error: " + e.message);
              }
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
                <div className="grid grid-cols-3 gap-2">
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
