/**
 * Academic Archive — the permanent academic library.
 *
 *   Current Semester     the live workspace (read-only card here)
 *   Previous Semesters   every completed semester, kept forever, each with a
 *                        unique immutable archiveId (never overwritten)
 *   Backup & Transfer    portable .pharmatrack packages:
 *                         - Export Current Semester
 *                         - Export All Academic Data (degree bundle)
 *                         - Import Semester Backup (validated, staged,
 *                           default: into the archive — never auto-replace)
 *
 * Everything is local-first: exports work offline, backups are never
 * uploaded anywhere, and deleting a local archive never affects backup
 * files already downloaded to the device.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import {
  listArchives,
  exportBackup,
  exportDegreeBackup,
  downloadBlob,
  semesterBackupFileName,
  degreeBackupFileName,
  restoreArchive,
  parseBackup,
  importBackupIntoArchive,
  importBackupAsWorkspace,
  findCollidingArchives,
  stagedSummary,
  exportDiagnostic,
  deleteArchive,
  hasWorkspaceContent,
  type ArchiveProgress,
  type ParsedBackup,
} from '../utils/semesterArchive';
import type { SemesterArchiveMeta, StagedBackup, StagedDegreeBackup, ImportDiagnostic } from '../types';
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
  GraduationCap,
  Library,
  PlayCircle,
  FileArchive,
  Eye,
  Info,
} from 'lucide-react';

const formatBytes = (n: number): string => {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const fileToBuffer = (file: File | Blob): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });

type ModalPhase = 'idle' | 'confirm' | 'running' | 'done' | 'error';

// ---------------------------------------------------------------------------
// Export progress modal (shared by semester / live / degree exports)
// ---------------------------------------------------------------------------

interface ExportJob {
  label: string;
  fileName: string;
  progress: ArchiveProgress | null;
  percent: number | null;
  error: string | null;
  done: boolean;
}

const ExportProgressModal: React.FC<{ job: ExportJob; onClose: () => void }> = ({ job, onClose }) => (
  <div className="fixed inset-0 bg-black/60 z-[210] flex items-center justify-center p-4">
    <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl p-6 space-y-4">
      <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
        <FileArchive className="w-5 h-5 text-[#2D6A4F]" />
        {job.label}
      </h2>
      {!job.error && !job.done && (
        <>
          <p className="text-sm text-gray-600">{job.progress?.message || 'Preparing…'}</p>
          {job.percent !== null && (
            <div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-[#2D6A4F] transition-all" style={{ width: `${Math.min(100, job.percent)}%` }} />
              </div>
              <p className="text-xs text-gray-500 mt-1 text-right">{Math.min(100, Math.round(job.percent))}%</p>
            </div>
          )}
          <p className="text-xs text-gray-400">Nothing is uploaded — the package is created on this device.</p>
        </>
      )}
      {job.done && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center space-y-2">
          <CheckCircle2 className="w-8 h-8 text-green-600 mx-auto" />
          <p className="font-bold text-green-800">Backup verified ✓ and downloaded</p>
          <p className="text-xs text-green-700 break-all">{job.fileName}</p>
        </div>
      )}
      {job.error && (
        <div className="bg-red-50 border-2 border-red-200 rounded-xl p-4">
          <p className="font-bold text-red-800 flex items-center gap-2"><AlertTriangle className="w-5 h-5" /> Export failed</p>
          <p className="text-sm text-red-700 mt-1">{job.error}</p>
        </div>
      )}
      <div className="flex gap-3">
        {job.error && (
          <button onClick={onClose} className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium">
            Close
          </button>
        )}
        {job.done && (
          <button onClick={onClose} className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-bold">
            Done
          </button>
        )}
      </div>
    </div>
  </div>
);

// ---------------------------------------------------------------------------

const AcademicArchive: React.FC = () => {
  const { state, dispatch } = useApp();
  const navigate = useNavigate();
  const [archives, setArchives] = useState<SemesterArchiveMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<ArchiveProgress | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setArchives(await listArchives());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // ----- Export job ---------------------------------------------------------
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);

  const runExport = async (opts: { label: string; fileName: string; make: (onProgress: (p: ArchiveProgress) => void) => Promise<Blob> }) => {
    setExportJob({ label: opts.label, fileName: opts.fileName, progress: null, percent: null, error: null, done: false });
    try {
      const blob = await opts.make((p) => setExportJob((j) => (j ? { ...j, progress: p, percent: p.percent ?? j.percent } : j)));
      // Verify the package before handing it to the user (honest "Verifying…").
      setExportJob((j) => (j ? { ...j, progress: { phase: 'verify', message: 'Verifying…' } } : j));
      const check = await parseBackup(await fileToBuffer(blob));
      if (!check.ok) throw new Error(`The generated backup failed its own integrity check: ${check.reason}`);
      downloadBlob(blob, opts.fileName);
      setExportJob((j) => (j ? { ...j, done: true } : j));
    } catch (err) {
      setExportJob((j) => (j ? { ...j, error: err instanceof Error ? err.message : String(err) } : j));
    }
  };

  const exportArchive = (meta: SemesterArchiveMeta) =>
    runExport({
      label: `Exporting ${meta.title}`,
      fileName: semesterBackupFileName(meta.level, meta.semester, meta.academicYear),
      make: (onProgress) => exportBackup({ kind: 'archive', archiveId: meta.id }, onProgress),
    });

  const exportLive = () => {
    const level = state.student?.level || '100';
    const semester = state.student?.semester || '1';
    runExport({
      label: 'Exporting current semester',
      fileName: semesterBackupFileName(level, semester, undefined, format(new Date(), 'yyyy-MM-dd')),
      make: (onProgress) => exportBackup({ kind: 'live', state }, onProgress),
    });
  };

  const exportDegree = () =>
    runExport({
      label: 'Exporting full academic record',
      fileName: degreeBackupFileName(),
      make: (onProgress) => exportDegreeBackup(onProgress),
    });

  // ----- Deletion (permanent — explicit, never casual) ----------------------
  const [deleteTarget, setDeleteTarget] = useState<SemesterArchiveMeta | null>(null);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setBusy(target.id);
    try {
      await deleteArchive(target.id);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  // ----- Restore flow (existing archive → current workspace) -----------------
  const [restoreTarget, setRestoreTarget] = useState<SemesterArchiveMeta | null>(null);
  const [restorePhase, setRestorePhase] = useState<ModalPhase>('idle');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreDone, setRestoreDone] = useState<{ guard: boolean; title: string } | null>(null);

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

  // ----- Import flow ---------------------------------------------------------
  const [importPhase, setImportPhase] = useState<ModalPhase>('idle');
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importFileSize, setImportFileSize] = useState<number>(0);
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<ParsedBackup | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importDiags, setImportDiags] = useState<ImportDiagnostic[] | null>(null);
  const [collision, setCollision] = useState<{ byId: SemesterArchiveMeta | null; byPosition: SemesterArchiveMeta | null } | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [confirmWorkspace, setConfirmWorkspace] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importDone, setImportDone] = useState<{ kind: 'archive'; title: string; archiveId: string } | { kind: 'workspace'; guard: boolean; title: string } | { kind: 'degree'; imported: number; skipped: string[] } | null>(null);

  const resetImport = () => {
    setImportPhase('idle');
    setImportFileName(null);
    setImportFileSize(0);
    setParsed(null);
    setImportError(null);
    setImportDiags(null);
    setCollision(null);
    setShowDetails(false);
    setConfirmWorkspace(false);
    setImportBusy(false);
    setImportDone(null);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    setImportFileName(file.name);
    setImportFileSize(file.size);
    setImportPhase('confirm');
    setImportError(null);
    setImportDiags(null);
    setParsed(null);
    setCollision(null);
    setShowDetails(false);
    setConfirmWorkspace(false);
    setImportDone(null);
    setParsing(true);
    try {
      const result = await parseBackup(await fileToBuffer(file));
      if (!result.ok) {
        setImportError(result.reason);
        setImportDiags(result.diagnostics);
        setImportPhase('error');
        return;
      }
      setParsed(result.parsed);
      if (result.parsed.kind === 'semester') {
        setCollision(await findCollidingArchives(result.parsed.staged));
      } else {
        // Degree bundle: pre-compute which semesters would already be present.
        setCollision(null);
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
      setImportPhase('error');
    } finally {
      setParsing(false);
    }
  };

  const runImportIntoArchive = async (staged: StagedBackup, mode: 'archive' | 'copy' | 'replace', existingId?: string) => {
    setImportBusy(true);
    setImportError(null);
    try {
      const meta = await importBackupIntoArchive(staged, mode, existingId, setProgress);
      setImportDone({ kind: 'archive', title: meta.title, archiveId: meta.id });
      setImportPhase('done');
      void refresh();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
      setImportPhase('error');
    } finally {
      setImportBusy(false);
    }
  };

  const runImportDegree = async (degree: StagedDegreeBackup) => {
    setImportBusy(true);
    setImportError(null);
    let imported = 0;
    const skipped: string[] = [];
    try {
      for (const staged of degree.semesters) {
        const col = await findCollidingArchives(staged);
        if (col.byId || col.byPosition) {
          skipped.push(stagedSummary(staged).title);
          continue; // never silently overwrite — keep what's here
        }
        await importBackupIntoArchive(staged, 'archive', undefined, setProgress);
        imported++;
      }
      setImportDone({ kind: 'degree', imported, skipped });
      setImportPhase('done');
      void refresh();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
      setImportPhase('error');
    } finally {
      setImportBusy(false);
    }
  };

  const runImportAsWorkspace = async (staged: StagedBackup) => {
    setImportBusy(true);
    setImportError(null);
    try {
      const { fresh, guardArchive } = await importBackupAsWorkspace(staged, state, setProgress);
      const title = stagedSummary(staged).title;
      setImportDone({ kind: 'workspace', guard: !!guardArchive, title });
      dispatch({ type: 'LOAD_STATE', payload: fresh });
      setImportPhase('done');
      void refresh();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
      setImportPhase('error');
    } finally {
      setImportBusy(false);
    }
  };

  const currentCounts = {
    courses: state.courses.length,
    topics: state.topics.length,
    materials: state.slides.length,
    notes: state.notes.length,
  };
  const hasCurrentContent = hasWorkspaceContent(state);

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <Library className="w-7 h-7 text-[#2D6A4F]" />
            Academic Archive
          </h1>
          <p className="text-gray-500">Your permanent academic history — every completed semester stays here</p>
        </div>
        <button
          onClick={() => importInputRef.current?.click()}
          className="flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-medium"
        >
          <Upload className="w-4 h-4" />
          Import Semester Backup
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept=".pharmatrack,.zip,application/zip"
          className="hidden"
          onChange={(e) => void handleImportFile(e)}
        />
      </div>

      {/* Current Semester */}
      <section>
        <h2 className="text-[11px] font-black uppercase tracking-widest text-gray-400 mb-2">Current Semester</h2>
        <div className="bg-white rounded-xl border-2 border-[#2D6A4F]/30 shadow-sm p-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-[#2D6A4F]/10 flex items-center justify-center flex-shrink-0">
              <GraduationCap className="w-6 h-6 text-[#2D6A4F]" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-bold text-gray-800">
                  {state.student?.level || 'Not set'} • {state.student?.semester || '—'}
                </h3>
                <span className="px-2 py-0.5 bg-green-100 text-green-700 text-[10px] font-black uppercase tracking-wide rounded-full">
                  Active
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {currentCounts.courses} Courses · {currentCounts.topics} Topics · {currentCounts.materials} Materials · {currentCounts.notes} Notes
              </p>
            </div>
          </div>
          <Link
            to="/"
            className="flex items-center gap-1.5 px-3.5 py-2 bg-[#2D6A4F] text-white text-sm font-medium rounded-lg hover:bg-[#1B4332]"
          >
            <PlayCircle className="w-4 h-4" />
            Continue Semester
          </Link>
        </div>
      </section>

      {/* Previous Semesters */}
      <section>
        <h2 className="text-[11px] font-black uppercase tracking-widest text-gray-400 mb-2">
          Previous Semesters {archives.length > 0 && <span className="text-gray-300">({archives.length})</span>}
        </h2>
        {loading ? (
          <div className="bg-white rounded-xl border border-gray-100 p-10 text-center text-gray-500">
            <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> Loading archives…
          </div>
        ) : archives.length === 0 ? (
          <div className="bg-white rounded-xl p-10 text-center border border-dashed border-gray-300">
            <Archive className="w-14 h-14 text-gray-300 mx-auto mb-3" />
            <h3 className="text-lg font-semibold text-gray-700 mb-1">No completed semesters yet</h3>
            <p className="text-gray-500 text-sm max-w-md mx-auto">
              When you finish a semester, use <strong>Settings → Complete Semester</strong>. It is
              preserved here permanently — browse it, export it, or restore it, any time.
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
                        {meta.academicYear && (
                          <p className="text-[11px] font-black uppercase tracking-widest text-[#2D6A4F]">{meta.academicYear}</p>
                        )}
                        <div className="flex items-center gap-2 flex-wrap mt-0.5">
                          <h3 className="font-bold text-gray-800 text-lg">{meta.title}</h3>
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
                            {meta.counts.courses} Courses · {meta.counts.topics} Topics · {meta.counts.slides} Materials · {meta.counts.notes} Notes
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
                        onClick={() => void exportArchive(meta)}
                        disabled={busy === meta.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
                      >
                        <Download className="w-4 h-4" />
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
                        onClick={() => setDeleteTarget(meta)}
                        disabled={busy === meta.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-red-200 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-50 ml-auto"
                      >
                        <Trash2 className="w-4 h-4" />
                        Delete…
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Backup & Transfer */}
      <section>
        <h2 className="text-[11px] font-black uppercase tracking-widest text-gray-400 mb-2">Backup &amp; Transfer</h2>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-4">
          <div className="grid sm:grid-cols-3 gap-3">
            <button
              onClick={exportLive}
              className="flex flex-col items-start gap-1.5 p-4 rounded-xl border border-gray-200 hover:border-[#2D6A4F] hover:bg-[#2D6A4F]/5 text-left transition-colors"
            >
              <Download className="w-5 h-5 text-[#2D6A4F]" />
              <span className="text-sm font-bold text-gray-800">Export Current Semester</span>
              <span className="text-xs text-gray-500">This live semester as a portable backup</span>
            </button>
            <button
              onClick={exportDegree}
              disabled={archives.length === 0}
              className="flex flex-col items-start gap-1.5 p-4 rounded-xl border border-gray-200 hover:border-[#2D6A4F] hover:bg-[#2D6A4F]/5 text-left transition-colors disabled:opacity-40 disabled:hover:bg-white"
              title={archives.length === 0 ? 'No completed semesters yet' : 'Every completed semester in one package'}
            >
              <Library className="w-5 h-5 text-[#2D6A4F]" />
              <span className="text-sm font-bold text-gray-800">Export All Academic Data</span>
              <span className="text-xs text-gray-500">{archives.length} completed semesters in one degree package</span>
            </button>
            <button
              onClick={() => importInputRef.current?.click()}
              className="flex flex-col items-start gap-1.5 p-4 rounded-xl border border-[#2D6A4F]/40 bg-[#2D6A4F]/5 hover:bg-[#2D6A4F]/10 text-left transition-colors"
            >
              <Upload className="w-5 h-5 text-[#2D6A4F]" />
              <span className="text-sm font-bold text-[#2D6A4F]">Import Semester Backup</span>
              <span className="text-xs text-gray-500">From another device (.pharmatrack)</span>
            </button>
          </div>
          <p className="text-xs text-gray-500 flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            Backups are portable <code className="bg-gray-100 px-1 rounded">.pharmatrack</code> packages containing the actual
            files (PDFs, PPTX, images, extracted text). They work fully offline and are never uploaded
            anywhere — move them by USB, AirDrop, WhatsApp, Drive… and import on any PharmaTRACK device.
          </p>
        </div>
      </section>

      {/* ---- Export progress modal ---- */}
      {exportJob && (
        <ExportProgressModal job={exportJob} onClose={() => setExportJob(null)} />
      )}

      {/* ---- Delete modal (permanent — explicit) ---- */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl p-5 space-y-4">
            <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
              <Trash2 className="w-5 h-5 text-red-500" />
              Delete Archived Semester?
            </h2>
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm text-gray-700">
              <p className="font-bold">{deleteTarget.title}</p>
              {deleteTarget.academicYear && <p className="text-xs text-gray-500">{deleteTarget.academicYear} · completed {format(new Date(deleteTarget.completedAt), 'd MMMM yyyy')}</p>}
            </div>
            <p className="text-sm text-red-700">
              This <strong>permanently removes the local archive</strong> from this device. A
              downloadable backup is strongly recommended first.
            </p>
            <p className="text-xs text-gray-500 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-green-600" />
              Deleting the local archive never affects backup files you already downloaded.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => { const t = deleteTarget; setDeleteTarget(null); void exportArchive(t); }}
                className="py-2.5 border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-50 text-sm font-bold flex items-center justify-center gap-1.5"
              >
                <Download className="w-4 h-4" /> Export Backup First
              </button>
              <button
                onClick={() => void confirmDelete()}
                className="py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-bold flex items-center justify-center gap-1.5"
              >
                <Trash2 className="w-4 h-4" /> Delete Permanently
              </button>
            </div>
            <button onClick={() => setDeleteTarget(null)} className="w-full py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ---- Restore modal (archive → current workspace) ---- */}
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
                  <button onClick={() => { setRestoreTarget(null); setRestorePhase('idle'); }} className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium">
                    Cancel
                  </button>
                  <button onClick={() => void runRestore(restoreTarget)} className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-bold">
                    Back up current &amp; Restore
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

      {/* ---- Import modal ---- */}
      {importPhase !== 'idle' && (
        <div className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl max-h-[92vh] overflow-y-auto">
            {importPhase === 'confirm' && (
              <div className="p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                    <Upload className="w-5 h-5 text-[#2D6A4F]" />
                    Import Semester Backup
                  </h2>
                  <button onClick={resetImport} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5 text-gray-500" /></button>
                </div>

                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-gray-700 space-y-1">
                  <p className="text-xs text-gray-500 truncate">{importFileName}{importFileSize > 0 && ` · ${formatBytes(importFileSize)}`}</p>
                  {parsing ? (
                    <p className="flex items-center gap-2 py-2"><Loader2 className="w-4 h-4 animate-spin text-[#2D6A4F]" /> Validating backup…</p>
                  ) : parsed?.kind === 'semester' && parsed.staged ? (
                    (() => {
                      const sum = stagedSummary(parsed.staged);
                      return (
                        <>
                          <p className="font-bold text-base">{sum.title}</p>
                          <p className="text-gray-500">
                            {sum.academicYear && <>{sum.academicYear} · </>}
                            Backup created {format(new Date(sum.createdAt), 'd MMM yyyy')}
                            {sum.source === 'archive' ? ' · from an archive' : ' · from a live semester'}
                          </p>
                          <div className="grid grid-cols-3 gap-2 pt-2 text-center">
                            {[
                              { label: 'Courses', value: sum.counts.courses },
                              { label: 'Topics', value: sum.counts.topics },
                              { label: 'Materials', value: sum.counts.slides },
                              { label: 'Files', value: sum.counts.files },
                              { label: 'Notes', value: sum.counts.notes },
                              { label: 'Questions', value: sum.counts.questions },
                            ].map((x) => (
                              <div key={x.label} className="bg-white rounded-lg border border-slate-100 p-2">
                                <p className="text-base font-bold text-gray-800 leading-none">{x.value}</p>
                                <p className="text-[10px] text-gray-500 mt-1">{x.label}</p>
                              </div>
                            ))}
                          </div>
                          <p className="text-xs text-gray-500 pt-1">
                            Quizzes: {sum.counts.quizzes} · Study plans: {sum.counts.studyPlans} · Exam dates: {sum.counts.examDates} · {formatBytes(sum.totalBytes)}
                          </p>
                          <p className="text-xs text-green-700 font-bold flex items-center gap-1 pt-1">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Backup integrity: ✓ Valid {sum.integrityAlgorithm && <span className="font-normal text-green-600">({sum.integrityAlgorithm})</span>}
                          </p>
                          <p className="text-[10px] text-gray-400">{sum.versionLabel}{sum.archiveId && ` · archive id ${sum.archiveId}`}</p>
                        </>
                      );
                    })()
                  ) : parsed?.kind === 'degree' ? (
                    <>
                      <p className="font-bold text-base">{parsed.degree.title}</p>
                      <p className="text-xs text-gray-500">{parsed.degree.semesters.length} completed semesters · {formatBytes(parsed.degree.totalBytes)}</p>
                      <div className="divide-y divide-slate-100 bg-white rounded-lg border border-slate-100 max-h-44 overflow-y-auto">
                        {parsed.degree.semesters.map((s, i) => {
                          const sum = stagedSummary(s);
                          return (
                            <div key={i} className="px-3 py-2 flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-gray-700 truncate">{sum.title}</p>
                                <p className="text-[10px] text-gray-400">{sum.academicYear || ''} · {sum.counts.courses} courses · {sum.counts.slides} materials</p>
                              </div>
                              <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : null}
                </div>

                {parsed?.kind === 'semester' && parsed.staged && collision && (collision.byId || collision.byPosition) && (
                  <div className="bg-amber-50 border-2 border-amber-200 rounded-xl p-3 text-sm text-amber-900">
                    <p className="font-bold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" />
                      {collision.byId
                        ? 'This semester already exists on this device (same archive id).'
                        : `This device already has ${collision.byPosition?.title} — this backup appears to be the same semester.`}
                    </p>
                    <p className="text-xs mt-1 text-amber-800">Nothing is overwritten automatically — choose what to do.</p>
                  </div>
                )}

                {showDetails && parsed?.kind === 'semester' && parsed.staged && (
                  <details className="border border-gray-200 rounded-xl p-3 text-sm" open>
                    <summary className="cursor-pointer font-semibold text-gray-700 flex items-center gap-1.5"><Eye className="w-4 h-4" /> What's inside this backup</summary>
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600">
                      {[
                        ['Courses', parsed.staged.snapshot.courses.length],
                        ['Topics', parsed.staged.snapshot.topics.length],
                        ['Slides / materials', parsed.staged.snapshot.slides.length],
                        ['Learning objectives', parsed.staged.snapshot.learningObjectives.length],
                        ['Exam questions', parsed.staged.snapshot.examQuestions.length],
                        ['Quiz history', parsed.staged.snapshot.quizHistory.length],
                        ['Notes', parsed.staged.snapshot.notes.length],
                        ['Study plans', parsed.staged.snapshot.studyPlans.length],
                        ['Exam dates', parsed.staged.snapshot.examDates.length],
                        ['Activities', parsed.staged.snapshot.activities.length],
                        ['Highlights', parsed.staged.snapshot.highlights.length],
                        ['Saved insights', parsed.staged.snapshot.savedInsights.length],
                        ['Chat messages', parsed.staged.snapshot.chatHistory.length],
                        ['Timetable entries', parsed.staged.snapshot.timetables.class.length + parsed.staged.snapshot.timetables.quiz.length + parsed.staged.snapshot.timetables.exam.length],
                        ['Timetable PDF', parsed.staged.snapshot.timetablePdf ? 'yes' : 'no'],
                        ['Packaged files', parsed.staged.files.size],
                      ].map(([label, value]) => (
                        <p key={label as string}><span className="text-gray-400">{label as string}:</span> <strong>{String(value)}</strong></p>
                      ))}
                    </div>
                  </details>
                )}

                {/* Actions */}
                {parsed && !parsing && (
                  <>
                    {parsed.kind === 'semester' && parsed.staged ? (
                      collision && (collision.byId || collision.byPosition) ? (
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            onClick={resetImport}
                            className="py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium"
                          >
                            Keep Existing
                          </button>
                          <button
                            onClick={() => void runImportIntoArchive(parsed.staged, 'copy')}
                            disabled={importBusy}
                            className="py-2.5 border border-[#2D6A4F] text-[#2D6A4F] rounded-lg hover:bg-[#2D6A4F]/5 text-sm font-bold"
                          >
                            Import as Copy
                          </button>
                          <button
                            onClick={() => void runImportIntoArchive(parsed.staged, 'replace', (collision.byId || collision.byPosition)!.id)}
                            disabled={importBusy}
                            className="py-2.5 border border-red-300 text-red-700 rounded-lg hover:bg-red-50 text-sm font-medium col-span-2"
                          >
                            Replace Existing — Advanced
                          </button>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            onClick={() => setShowDetails((v) => !v)}
                            className="py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium flex items-center justify-center gap-1.5"
                          >
                            <Eye className="w-4 h-4" /> {showDetails ? 'Hide Backup' : 'View Backup'}
                          </button>
                          <button
                            onClick={() => void runImportIntoArchive(parsed.staged, 'archive')}
                            disabled={importBusy}
                            className="py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] text-sm font-bold flex items-center justify-center gap-1.5"
                          >
                            <Archive className="w-4 h-4" /> Import into Academic Archive
                          </button>
                        </div>
                      )
                    ) : null}

                    {parsed.kind === 'degree' && (
                      <button
                        onClick={() => void runImportDegree(parsed.degree)}
                        disabled={importBusy}
                        className="w-full py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] text-sm font-bold flex items-center justify-center gap-1.5"
                      >
                        <Library className="w-4 h-4" /> Import All Semesters into Academic Archive
                      </button>
                    )}

                    {parsed.kind === 'semester' && parsed.staged && (
                      !collision || !collision.byId && !collision.byPosition ? (
                        <button
                          onClick={() => setConfirmWorkspace(true)}
                          disabled={importBusy}
                          className="w-full py-2.5 border border-[#2D6A4F] text-[#2D6A4F] rounded-lg hover:bg-[#2D6A4F]/5 text-sm font-bold flex items-center justify-center gap-1.5"
                        >
                          <ArchiveRestore className="w-4 h-4" /> Restore as Current Workspace
                        </button>
                      ) : (
                        <button
                          onClick={() => setConfirmWorkspace(true)}
                          disabled={importBusy}
                          className="w-full py-2 text-xs text-gray-500 underline underline-offset-2 hover:text-gray-700"
                        >
                          Or: restore this backup as the current workspace (backs up the current semester first)
                        </button>
                      )
                    )}
                  </>
                )}

                {confirmWorkspace && parsed?.kind === 'semester' && parsed.staged && (
                  <div className="bg-amber-50 border-2 border-amber-200 rounded-xl p-4 space-y-3">
                    <p className="text-sm text-amber-900 font-bold">Restore as the current workspace?</p>
                    <p className="text-xs text-amber-800">
                      Your current semester {hasCurrentContent ? 'contains data and will be ' : 'is empty. The imported semester will become your active workspace. '}
                      {hasCurrentContent && 'automatically backed up first (verified) before anything is replaced. If the safety backup fails, nothing changes.'}
                    </p>
                    <div className="flex gap-2">
                      <button onClick={() => setConfirmWorkspace(false)} className="flex-1 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-white">
                        Cancel
                      </button>
                      <button
                        onClick={() => { setConfirmWorkspace(false); void runImportAsWorkspace(parsed.staged); }}
                        className="flex-1 py-2 bg-[#2D6A4F] text-white rounded-lg text-sm font-bold hover:bg-[#1B4332]"
                      >
                        Back up current &amp; Restore
                      </button>
                    </div>
                  </div>
                )}

                <button
                  onClick={resetImport}
                  disabled={importBusy || parsing}
                  className="w-full py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium disabled:opacity-50"
                >
                  Cancel
                </button>
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

            {importPhase === 'done' && importDone && (
              <div className="p-6 space-y-4 text-center">
                <div className="w-14 h-14 mx-auto rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8 text-green-600" />
                </div>
                {importDone.kind === 'archive' && (
                  <>
                    <h2 className="text-lg font-bold text-gray-800">Imported into Academic Archive</h2>
                    <p className="text-sm text-gray-600"><strong>{importDone.title}</strong> is now part of your permanent academic history. Your current semester was not touched.</p>
                    <div className="flex gap-3">
                      <Link to={`/archive/${importDone.archiveId}`} className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-bold text-sm">
                        Open Archive
                      </Link>
                      <button onClick={resetImport} className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium text-sm">
                        Close
                      </button>
                    </div>
                  </>
                )}
                {importDone.kind === 'workspace' && (
                  <>
                    <h2 className="text-lg font-bold text-gray-800">{importDone.title} restored</h2>
                    <p className="text-sm text-gray-600">
                      {importDone.guard
                        ? 'Your previous current semester was archived first and is safe in the list below.'
                        : 'Your current workspace was empty, so nothing else needed backing up.'}
                    </p>
                    <div className="flex gap-3">
                      <button onClick={() => { resetImport(); navigate('/'); }} className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-bold text-sm">
                        Go to Dashboard
                      </button>
                      <button onClick={resetImport} className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium text-sm">
                        Close
                      </button>
                    </div>
                  </>
                )}
                {importDone.kind === 'degree' && (
                  <>
                    <h2 className="text-lg font-bold text-gray-800">Degree backup imported</h2>
                    <p className="text-sm text-gray-600">{importDone.imported} of {importDone.imported + importDone.skipped.length} semesters imported.</p>
                    {importDone.skipped.length > 0 && (
                      <p className="text-xs text-gray-500 bg-amber-50 border border-amber-200 rounded-lg p-2">
                        Skipped (already on this device — existing kept): {importDone.skipped.join(' · ')}
                      </p>
                    )}
                    <button onClick={resetImport} className="w-full py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium text-sm">
                      Close
                    </button>
                  </>
                )}
              </div>
            )}

            {importPhase === 'error' && (
              <div className="p-5 space-y-4">
                <div className="bg-red-50 border-2 border-red-200 rounded-xl p-4">
                  <h2 className="font-bold text-red-800 flex items-center gap-2"><AlertTriangle className="w-5 h-5" /> Import failed</h2>
                  <p className="text-sm text-red-700 mt-1">This backup could not be safely imported. <strong>Your current PharmaTRACK data has NOT been changed.</strong></p>
                  <p className="text-xs text-red-600 mt-2 font-mono bg-red-100/60 rounded-lg p-2 break-words">{importError}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => importInputRef.current?.click()}
                    className="flex-1 py-2.5 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] font-bold text-sm"
                  >
                    Try Again
                  </button>
                  <button
                    onClick={() => importError && exportDiagnostic(importError, importDiags || [])}
                    className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium text-sm"
                  >
                    Export Diagnostic
                  </button>
                  <button onClick={resetImport} className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium text-sm">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default AcademicArchive;
