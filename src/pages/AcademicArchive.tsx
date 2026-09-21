/**
 * Academic Archive — previous completed semesters, kept locally forever.
 *
 * Actions per archive:
 *   Open Archive   read-only viewer (never touches the current semester)
 *   Export Backup  portable ZIP to the user's device
 *   Restore        back up the CURRENT semester first (verified), then swap
 *   Delete         explicit double confirmation
 *
 * Import Backup: stage + validate the ZIP first (version, manifest, file
 * integrity), show a summary, and only apply it after the current workspace
 * has been protected by its own verified archive.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import {
  listArchives,
  exportBackup,
  downloadBlob,
  backupFileName,
  restoreArchive,
  parseBackup,
  applyWorkspaceSource,
  createSemesterArchive,
  deleteArchive,
  hasWorkspaceContent,
  type ArchiveProgress,
} from '../utils/semesterArchive';
import type { SemesterArchiveMeta, StagedBackup } from '../types';
import { format } from 'date-fns';
import {
  Archive,
  ArchiveRestore,
  Download,
  Trash2,
  FolderOpen,
  Upload,
  X,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  ShieldCheck,
  Lock,
  FileWarning,
} from 'lucide-react';

const formatBytes = (n: number): string => {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

type ModalPhase = 'idle' | 'confirm' | 'running' | 'done' | 'error';

const AcademicArchive: React.FC = () => {
  const { state, dispatch } = useApp();
  const navigate = useNavigate();
  const [archives, setArchives] = useState<SemesterArchiveMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // archive id currently acting on
  const [progress, setProgress] = useState<ArchiveProgress | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Restore flow
  const [restoreTarget, setRestoreTarget] = useState<SemesterArchiveMeta | null>(null);
  const [restorePhase, setRestorePhase] = useState<ModalPhase>('idle');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreDone, setRestoreDone] = useState<{ guard: boolean; title: string } | null>(null);

  // Import flow
  const [staged, setStaged] = useState<StagedBackup | null>(null);
  const [importPhase, setImportPhase] = useState<ModalPhase>('idle');
  const [importError, setImportError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setArchives(await listArchives());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleExport = async (meta: SemesterArchiveMeta) => {
    setBusy(meta.id);
    try {
      const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });
      downloadBlob(blob, backupFileName(meta));
    } catch (err) {
      alert(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (meta: SemesterArchiveMeta) => {
    if (!window.confirm(`Delete the archive of "${meta.title}"?\n\nThis removes the archived semester from this device permanently.`)) return;
    if (!window.confirm('Really delete it? There is no undo for this.')) return;
    setBusy(meta.id);
    try {
      await deleteArchive(meta.id);
      await refresh();
    } catch (err) {
      alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const runRestore = async (meta: SemesterArchiveMeta) => {
    setRestorePhase('running');
    setRestoreError(null);
    try {
      const { fresh, guardArchive } = await restoreArchive(state, meta.id, setProgress);
      setRestoreDone({ guard: !!guardArchive, title: meta.title });
      dispatch({ type: 'LOAD_STATE', payload: fresh });
      setRestorePhase('done');
      void refresh();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : String(err));
      setRestorePhase('error');
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    setImportError(null);
    try {
      const buffer = await file.arrayBuffer();
      const result = await parseBackup(buffer);
      if (!result.ok) {
        setImportError(result.reason);
        setImportPhase('error');
        return;
      }
      setStaged(result.staged);
      setImportPhase('confirm');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
      setImportPhase('error');
    }
  };

  const runImport = async () => {
    if (!staged) return;
    setImportPhase('running');
    setImportError(null);
    try {
      // Protect the current workspace first — restore can never be a hidden
      // data-loss operation.
      if (hasWorkspaceContent(state)) {
        setProgress({ phase: 'protect', message: 'Backing up your current semester first…' });
        const guard = await createSemesterArchive(state, {
          level: state.student?.level || '100',
          semester: state.student?.semester || '1',
          title: `Level ${state.student?.level || ''} — ${state.student?.semester || ''} (auto-backup before import)`,
          onProgress: (p) => setProgress({ ...p, message: `Backing up current semester: ${p.message || ''}` }),
        });
        if (guard.status !== 'verified') {
          throw new Error('Backing up the current semester failed, so the import was aborted. Nothing was changed.');
        }
      }
      const fresh = await applyWorkspaceSource(staged, state, setProgress);
      dispatch({ type: 'LOAD_STATE', payload: fresh });
      setImportPhase('done');
      void refresh();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
      setImportPhase('error');
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <Archive className="w-7 h-7 text-gray-600" />
            Academic Archive
          </h1>
          <p className="text-gray-500">Completed semesters, archived locally on this device</p>
        </div>
        <button
          onClick={() => importInputRef.current?.click()}
          className="flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-medium"
        >
          <Upload className="w-4 h-4" />
          Import Backup (.zip)
        </button>
        <input ref={importInputRef} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => void handleImportFile(e)} />
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center text-gray-500">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> Loading archives…
        </div>
      ) : archives.length === 0 ? (
        <div className="bg-white rounded-xl p-10 text-center border border-dashed border-gray-300">
          <Archive className="w-14 h-14 text-gray-300 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-gray-700 mb-1">No completed semesters yet</h2>
          <p className="text-gray-500 text-sm max-w-md mx-auto">
            When you finish a semester, use <strong>Settings → Complete Semester</strong> to archive
            it here. Everything — courses, slides, files, notes, quizzes — is preserved locally and
            can be viewed or restored later.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {archives.map((meta) => {
            const failed = meta.status === 'failed';
            return (
              <div key={meta.id} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold text-gray-800 text-lg">{meta.title}</h3>
                        {meta.academicYear && (
                          <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs font-semibold rounded-full">
                            {meta.academicYear}
                          </span>
                        )}
                        {failed ? (
                          <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-bold rounded-full" title={meta.error}>
                            Failed
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-bold rounded-full flex items-center gap-1">
                            <ShieldCheck className="w-3 h-3" /> Verified
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-500 mt-1">
                        Completed: {format(new Date(meta.completedAt), 'd MMMM yyyy')}
                        {meta.totalBytes > 0 && <> · {formatBytes(meta.totalBytes)}</>}
                      </p>
                      {meta.counts && (
                        <p className="text-xs text-gray-500 mt-1">
                          Courses: {meta.counts.courses} · Materials: {meta.counts.slides} ·
                          Files: {meta.fileCount} · Notes: {meta.counts.notes} · Questions: {meta.counts.questions}
                        </p>
                      )}
                      {failed && meta.error && (
                        <p className="text-xs text-red-600 mt-2 flex items-center gap-1">
                          <FileWarning className="w-3.5 h-3.5" /> {meta.error}
                        </p>
                      )}
                    </div>
                    <span className="text-[9px] font-black uppercase tracking-widest bg-[#2D6A4F]/10 text-[#2D6A4F] px-2 py-1 rounded-md flex items-center gap-1">
                      <Lock className="w-3 h-3" /> Read-only
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-2 mt-4">
                    <Link
                      to={`/archive/${meta.id}`}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-[#2D6A4F] text-white text-sm font-medium rounded-lg hover:bg-[#1B4332]"
                    >
                      <FolderOpen className="w-4 h-4" />
                      Open Archive
                    </Link>
                    <button
                      onClick={() => void handleExport(meta)}
                      disabled={busy === meta.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
                    >
                      {busy === meta.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                      Export Backup
                    </button>
                    <button
                      onClick={() => { setRestoreTarget(meta); setRestorePhase('confirm'); setRestoreError(null); setRestoreDone(null); }}
                      disabled={busy === meta.id || failed}
                      title={failed ? 'Failed archives cannot be restored' : 'Backs up your current semester first'}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-[#2D6A4F] text-[#2D6A4F] text-sm font-medium rounded-lg hover:bg-[#2D6A4F]/5 disabled:opacity-40"
                    >
                      <ArchiveRestore className="w-4 h-4" />
                      Restore
                    </button>
                    <button
                      onClick={() => void handleDelete(meta)}
                      disabled={busy === meta.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-red-200 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Restore modal */}
      {restoreTarget && restorePhase !== 'idle' && (
        <div className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
            {restorePhase === 'confirm' && (
              <div className="p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-[#FFB703]" />
                    Restore {restoreTarget.title}?
                  </h2>
                  <button onClick={() => { setRestoreTarget(null); setRestorePhase('idle'); }} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5 text-gray-500" /></button>
                </div>
                <p className="text-sm text-gray-600">
                  Restoring <strong>{restoreTarget.title}</strong> replaces your current workspace
                  with that archived semester.
                </p>
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
                  <strong>To keep everything safe, your current semester is backed up first.</strong>{' '}
                  The restore only continues once that backup is verified — otherwise it is
                  aborted and nothing changes. The restored archive itself is kept.
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => { setRestoreTarget(null); setRestorePhase('idle'); }}
                    className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void runRestore(restoreTarget)}
                    className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-bold"
                  >
                    Back up current & Restore
                  </button>
                </div>
              </div>
            )}
            {restorePhase === 'running' && (
              <div className="p-6 space-y-3">
                <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin text-[#2D6A4F]" />
                  Restoring…
                </h2>
                <p className="text-sm text-gray-600">{progress?.message || 'Working…'}</p>
                <p className="text-xs text-gray-500">Your current semester stays safe behind its verified backup.</p>
              </div>
            )}
            {restorePhase === 'error' && (
              <div className="p-5 space-y-4">
                <div className="bg-red-50 border-2 border-red-200 rounded-xl p-4">
                  <h2 className="font-bold text-red-800 flex items-center gap-2"><AlertTriangle className="w-5 h-5" /> Restore aborted</h2>
                  <p className="text-sm text-red-700 mt-1">{restoreError}</p>
                </div>
                <button onClick={() => { setRestoreTarget(null); setRestorePhase('idle'); }} className="w-full py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium">
                  Close
                </button>
              </div>
            )}
            {restorePhase === 'done' && restoreDone && (
              <div className="p-6 space-y-4 text-center">
                <div className="w-14 h-14 mx-auto rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8 text-green-600" />
                </div>
                <h2 className="text-lg font-bold text-gray-800">{restoreDone.title} restored</h2>
                <p className="text-sm text-gray-600">
                  {restoreDone.guard
                    ? 'Your previous current semester was archived first and is safe in this list.'
                    : 'Your current workspace was empty, so nothing else needed backing up.'}
                </p>
                <div className="flex gap-3">
                  <button onClick={() => navigate('/')} className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-bold">
                    Go to Dashboard
                  </button>
                  <button onClick={() => { setRestoreTarget(null); setRestorePhase('idle'); }} className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium">
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Import modal */}
      {(staged || importError) && importPhase !== 'idle' && (
        <div className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl">
            {importPhase === 'confirm' && staged && (
              <div className="p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                    <Upload className="w-5 h-5 text-[#2D6A4F]" />
                    Import this backup?
                  </h2>
                  <button onClick={() => { setStaged(null); setImportPhase('idle'); }} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5 text-gray-500" /></button>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-gray-700 space-y-1">
                  <p className="font-bold">{staged.manifest.title}</p>
                  <p>
                    {staged.manifest.level} · {staged.manifest.semester}
                    {staged.manifest.academicYear ? ` · ${staged.manifest.academicYear}` : ''}
                  </p>
                  <p className="text-xs text-gray-500">
                    {staged.manifest.counts
                      ? `Courses: ${staged.manifest.counts.courses} · Materials: ${staged.manifest.counts.slides} · Files: ${staged.manifest.fileCount}`
                      : `Files: ${staged.manifest.fileCount}`}
                    {' '}· {formatBytes(staged.manifest.totalBytes)}
                  </p>
                  <p className="text-xs text-green-700 font-bold flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Integrity verified ✓ (format v{staged.manifest.backupVersion})
                  </p>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
                  Your current semester will be <strong>backed up first</strong> (verified) before the
                  imported data replaces it.
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => { setStaged(null); setImportPhase('idle'); }}
                    className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium"
                  >
                    Cancel
                  </button>
                  <button onClick={() => void runImport()} className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-bold">
                    Back up current & Import
                  </button>
                </div>
              </div>
            )}
            {importPhase === 'running' && (
              <div className="p-6 space-y-3">
                <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin text-[#2D6A4F]" />
                  Importing…
                </h2>
                <p className="text-sm text-gray-600">{progress?.message || 'Working…'}</p>
              </div>
            )}
            {importPhase === 'done' && (
              <div className="p-6 space-y-4 text-center">
                <div className="w-14 h-14 mx-auto rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8 text-green-600" />
                </div>
                <h2 className="text-lg font-bold text-gray-800">Backup imported</h2>
                <p className="text-sm text-gray-600">Your previous current semester (if any) is safe in the archive list.</p>
                <div className="flex gap-3">
                  <button onClick={() => navigate('/')} className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-bold">
                    Go to Dashboard
                  </button>
                  <button onClick={() => { setStaged(null); setImportPhase('idle'); }} className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium">
                    Close
                  </button>
                </div>
              </div>
            )}
            {importPhase === 'error' && (
              <div className="p-5 space-y-4">
                <div className="bg-red-50 border-2 border-red-200 rounded-xl p-4">
                  <h2 className="font-bold text-red-800 flex items-center gap-2"><AlertTriangle className="w-5 h-5" /> Could not import</h2>
                  <p className="text-sm text-red-700 mt-1">{importError}</p>
                  <p className="text-xs text-red-600 mt-2">Nothing was changed on this device.</p>
                </div>
                <button onClick={() => { setStaged(null); setImportError(null); setImportPhase('idle'); }} className="w-full py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium">
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default AcademicArchive;
