/**
 * Complete Semester dialog.
 *
 * Phases:
 *   confirm  — what will be archived (counts + estimated size), and the NEXT
 *              academic position (suggested by progression, always editable)
 *   running  — live progress: capture → copy files → verify → fresh workspace
 *   error    — archive failed; the current semester is untouched; retryable
 *   success  — 🎓 backup verified ✓, new workspace ready
 *
 * The destructive-looking button is deliberately the long one, and closing is
 * blocked while the archive is in flight so a misclick can't race the copy.
 */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import {
  completeSemester,
  computeNextProgression,
  defaultAcademicYear,
  collectFileRefs,
  type ArchiveProgress,
} from '../utils/semesterArchive';
import { loadFile, loadSlideText } from '../utils/storage';
import type { SemesterArchiveMeta } from '../types';
import {
  GraduationCap,
  X,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Archive,
  BookOpen,
  FileText,
  StickyNote,
  FileQuestion,
  Brain,
  HardDrive,
} from 'lucide-react';

const LEVELS = ['Level 100', 'Level 200', 'Level 300', 'Level 400', 'Level 500', 'Level 600'];
const SEMESTERS = ['1st Semester', '2nd Semester'];

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

type Phase = 'confirm' | 'running' | 'error' | 'success';

const CompleteSemesterModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { state, dispatch } = useApp();
  const navigate = useNavigate();

  const suggested = computeNextProgression(state.student?.level || '100', state.student?.semester || '1');
  const [nextLevel, setNextLevel] = useState(suggested.level);
  const [nextSemester, setNextSemester] = useState(suggested.semester);
  const [academicYear, setAcademicYear] = useState(defaultAcademicYear());
  const [estBytes, setEstBytes] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('confirm');
  const [progress, setProgress] = useState<ArchiveProgress | null>(null);
  const [doneArchive, setDoneArchive] = useState<SemesterArchiveMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setAcademicYear(defaultAcademicYear());
      setPhase('confirm');
      setProgress(null);
      setDoneArchive(null);
      setError(null);
    }
  }, [open]);

  // Keep the suggested position in sync with the (async-loaded) student data
  // while the user hasn't changed it yet — this covers state that arrives
  // after mount. Once the user edits a select, their value is kept: the
  // deps below only track the CURRENT position, not the suggested one.
  useEffect(() => {
    if (!open || phase !== 'confirm') return;
    const s = computeNextProgression(state.student?.level || '100', state.student?.semester || '1');
    setNextLevel(s.level);
    setNextSemester(s.semester);
  }, [open, phase, state.student?.level, state.student?.semester]);

  // Estimated archive size: the actual bytes of every file the semester
  // references. Runs in the background so the dialog opens instantly.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        let total = 0;
        for (const ref of collectFileRefs(state)) {
          const value = ref.kind === 'file'
            ? await loadFile(ref.id)
            : await loadSlideText(ref.id);
          if (value === null || value === undefined) continue;
          if (typeof value === 'string') total += value.length;
          else if (value instanceof Blob) total += value.size;
          else total += (value as Uint8Array).byteLength;
        }
        if (!cancelled) setEstBytes(total);
      } catch {
        if (!cancelled) setEstBytes(null);
      }
    })();
    return () => { cancelled = true; };
  }, [open, state]);

  if (!open) return null;

  const stats = [
    { icon: BookOpen, label: 'Courses', value: state.courses.length },
    { icon: FileText, label: 'Materials', value: state.slides.length },
    { icon: StickyNote, label: 'Notes', value: state.notes.length },
    { icon: FileQuestion, label: 'Questions', value: state.examQuestions.length },
    { icon: Brain, label: 'Quizzes', value: state.quizHistory.length },
  ];

  const run = async () => {
    setPhase('running');
    setError(null);
    try {
      const { archive, fresh } = await completeSemester(state, {
        nextLevel,
        nextSemester,
        academicYear,
        onProgress: setProgress,
      });
      setDoneArchive(archive);
      // The verified archive owns everything; switch the app to the fresh
      // workspace. (saveState already ran inside completeSemester, so this
      // only updates the live UI.)
      dispatch({ type: 'LOAD_STATE', payload: fresh });
      setPhase('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  };

  // Step checklist for the running phase.
  const stepDone = (p: 'files' | 'verify' | 'reset') => {
    if (!progress) return false;
    const order = ['snapshot', 'files', 'verify', 'reset', 'done'];
    return order.indexOf(progress.phase) > order.indexOf(p);
  };
  const stepActive = (p: 'files' | 'verify' | 'reset') => progress?.phase === p;

  return (
    <div className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[92vh] overflow-y-auto">
        {phase === 'confirm' && (
          <>
            <div className="flex items-center justify-between p-5 border-b bg-gradient-to-r from-[#1B4332] to-[#2D6A4F] rounded-t-2xl text-white">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <GraduationCap className="w-6 h-6 text-[#FFB703]" />
                Complete Semester?
              </h2>
              <button onClick={onClose} className="p-1 hover:bg-white/10 rounded" title="Close">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-5">
              <p className="text-sm text-gray-600">
                You're about to finish this semester and begin a fresh academic workspace.
                <strong> {state.student?.level || 'This level'} — {state.student?.semester || 'this semester'}</strong> will
                be archived on this device first, verified, and only then replaced. The archive is
                permanent and read-only. Your new workspace will not inherit its courses, notes,
                quizzes, files or chat history. Previous semesters stay under <strong>Academic Archive</strong>.
              </p>

              {/* What will be archived */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">
                  Archiving — {state.student?.level || 'Level'} / {state.student?.semester || 'Semester'}
                </p>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                  {stats.map((s) => (
                    <div key={s.label} className="bg-white rounded-lg border border-slate-100 p-2 text-center">
                      <s.icon className="w-4 h-4 mx-auto text-[#2D6A4F] mb-1" />
                      <p className="text-lg font-bold text-gray-800 leading-none">{s.value}</p>
                      <p className="text-[10px] text-gray-500 mt-1">{s.label}</p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-3 flex items-center gap-1.5">
                  <HardDrive className="w-3.5 h-3.5" />
                  Estimated archive size:{' '}
                  <span className="font-semibold text-gray-700">{estBytes === null ? 'calculating…' : formatBytes(estBytes)}</span>
                </p>
                <div className="mt-3">
                  <label htmlFor="archive-academic-year" className="block text-sm font-medium text-gray-700 mb-1">
                    Academic year of this semester
                  </label>
                  <input
                    id="archive-academic-year"
                    type="text"
                    value={academicYear}
                    onChange={(e) => setAcademicYear(e.target.value)}
                    placeholder="e.g. 2026/2027"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] outline-none"
                  />
                </div>
              </div>

              {/* Next academic position */}
              <div className="space-y-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                  Your new workspace will start as
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Level</label>
                    <select
                      value={nextLevel}
                      onChange={(e) => setNextLevel(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] outline-none"
                    >
                      {!LEVELS.includes(nextLevel) && nextLevel && <option value={nextLevel}>{nextLevel}</option>}
                      {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Semester</label>
                    <select
                      value={nextSemester}
                      onChange={(e) => setNextSemester(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] outline-none"
                    >
                      {!SEMESTERS.includes(nextSemester) && nextSemester && <option value={nextSemester}>{nextSemester}</option>}
                      {SEMESTERS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  onClick={onClose}
                  className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void run()}
                  className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-bold flex items-center justify-center gap-2"
                >
                  <Archive className="w-4 h-4" />
                  Back Up & Complete Semester
                </button>
              </div>
            </div>
          </>
        )}

        {phase === 'running' && (
          <div className="p-6 space-y-4">
            <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-[#2D6A4F]" />
              Completing your semester…
            </h2>
            <ol className="space-y-3">
              {[
                { key: 'files', label: 'Capturing semester data & copying files',
                  detail: progress?.phase === 'files' && progress.total
                    ? `${progress.current ?? 0}/${progress.total} · ${formatBytes(progress.copiedBytes ?? 0)}`
                    : progress?.phase === 'snapshot' ? 'working…' : undefined },
                { key: 'verify', label: 'Verifying the archive', detail: undefined },
                { key: 'reset', label: 'Starting your fresh workspace', detail: undefined },
              ].map((step) => {
                const done = stepDone(step.key as 'files' | 'verify' | 'reset') || progress?.phase === 'done';
                const active = stepActive(step.key as 'files' | 'verify' | 'reset');
                return (
                  <li key={step.key} className={`flex items-center gap-3 p-3 rounded-xl border ${done ? 'border-green-200 bg-green-50' : active ? 'border-[#2D6A4F]/40 bg-[#2D6A4F]/5' : 'border-gray-200 bg-gray-50'}`}>
                    {done ? (
                      <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />
                    ) : active ? (
                      <Loader2 className="w-5 h-5 animate-spin text-[#2D6A4F] flex-shrink-0" />
                    ) : (
                      <span className="w-5 h-5 rounded-full border-2 border-gray-300 flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className={`text-sm font-semibold ${done ? 'text-green-800' : active ? 'text-gray-800' : 'text-gray-500'}`}>
                        {step.label}
                      </p>
                      {step.detail && <p className="text-xs text-gray-500 mt-0.5">{step.detail}</p>}
                    </div>
                    {step.key === 'verify' && done && (
                      <span className="ml-auto text-[10px] font-black uppercase tracking-widest bg-green-100 text-green-700 px-2 py-1 rounded-md">
                        Backup verified ✓
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            <p className="text-xs text-gray-500">
              Don't close the app while this runs. Nothing is deleted until the archive is verified.
            </p>
          </div>
        )}

        {phase === 'error' && (
          <div className="p-6 space-y-4">
            <div className="bg-red-50 border-2 border-red-200 rounded-xl p-4 flex gap-3">
              <AlertTriangle className="w-6 h-6 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <h2 className="font-bold text-red-800">The archive could not be completed</h2>
                <p className="text-sm text-red-700 mt-1">{error}</p>
              </div>
            </div>
            <p className="text-sm text-gray-600">
              <strong>Your current semester was not touched</strong> — every course, slide and note is
              exactly where it was. You can retry now (e.g. after freeing up storage or exporting a
              backup to your device).
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setPhase('confirm')}
                className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium"
              >
                Keep Current Semester
              </button>
              <button
                onClick={() => void run()}
                className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-bold"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {phase === 'success' && doneArchive && (
          <div className="p-6 space-y-4 text-center">
            <div className="w-16 h-16 mx-auto rounded-full bg-green-100 flex items-center justify-center">
              <GraduationCap className="w-9 h-9 text-[#2D6A4F]" />
            </div>
            <h2 className="text-xl font-bold text-gray-800">Semester completed successfully 🎓</h2>
            <p className="text-sm text-gray-600">
              Your <strong>{doneArchive.title}</strong> workspace has been securely archived on this
              device{doneArchive.academicYear ? ` (${doneArchive.academicYear})` : ''}.
            </p>
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm font-bold text-green-800">
              <CheckCircle2 className="w-4 h-4 inline mr-1" />
              Backup verified ✓
            </div>
            <p className="text-sm text-gray-600">
              Your new <strong>{nextLevel} — {nextSemester}</strong> workspace is ready. Your previous
              semester remains available in <strong>Academic Archive</strong>.
            </p>
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => { onClose(); navigate('/archive'); }}
                className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-bold"
              >
                View Academic Archive
              </button>
              <button
                onClick={() => { onClose(); navigate('/'); }}
                className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium"
              >
                Go to Dashboard
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CompleteSemesterModal;
