/**
 * Storage Manager.
 *
 * Shows what is on this device, in separate categories, and the safe recovery
 * for each problem. It never offers "clear all storage" as a fix.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Database,
  HardDrive,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import {
  discardIncompleteArchive,
  discardInterruptedImports,
  formatBytes,
  inspectStorage,
  quarantineUnreadableState,
  recheckArchive,
  restoreSafetyBackup,
  retryMigration,
  type RecoveryResult,
  type StorageIssue,
  type StorageReport,
} from '../utils/storageManager';

const STATUS_LABEL: Record<string, string> = {
  current: 'Up to date',
  migrating: 'Update in progress',
  'rolled-back': 'Update rolled back',
  unversioned: 'Not yet updated',
  unreadable: 'Unreadable',
  empty: 'New install',
};

async function runRecovery(issue: StorageIssue): Promise<RecoveryResult> {
  switch (issue.recoveryId) {
    case 'discard-interrupted-imports':
      return discardInterruptedImports();
    case 'discard-incomplete-archive':
      return discardIncompleteArchive(issue.targetId || '');
    case 'recheck-archive':
      return recheckArchive(issue.targetId || '');
    case 'retry-migration':
      return retryMigration();
    case 'restore-safety-backup':
      return restoreSafetyBackup();
    case 'quarantine-unreadable-state':
      return quarantineUnreadableState();
    default:
      return { ok: false, explanation: 'There is no automatic fix for this. Your data was not changed.' };
  }
}

const CONFIRM: Record<string, string> = {
  'discard-interrupted-imports': 'Discard the unfinished import? Your current semester and your archives are not affected.',
  'discard-incomplete-archive': 'Remove this unreadable archive record? Verified archives are never removed by this action.',
  'recheck-archive': 'Re-check this archive? Files are not deleted either way.',
  'retry-migration': 'Retry the update? A safety copy is made first. If it fails, your previous data is restored.',
  'restore-safety-backup': 'Restore the safety copy? Your current file is copied aside first if there is room.',
  'quarantine-unreadable-state': 'Set the unreadable semester file aside and start from an empty workspace? The file is copied first. If that copy cannot be saved, nothing is changed.',
};

const StorageManager: React.FC = () => {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setReport(await inspectStorage());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Storage could not be checked.');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const onRecover = async (issue: StorageIssue) => {
    const prompt = CONFIRM[issue.recoveryId || ''] || 'Continue? Your data will not be cleared globally.';
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await runRecovery(issue);
      setStatus(result.explanation);
      if (result.reload) {
        window.location.reload();
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const maxCategory = Math.max(1, ...(report?.categories.map((c) => c.bytes) ?? [1]));

  return (
    <div className="max-w-3xl mx-auto space-y-6" data-testid="storage-manager">
      <div>
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <HardDrive className="w-7 h-7 text-[#2D6A4F]" />
          Storage
        </h1>
        <p className="text-gray-500 mt-1">
          What is on this device, kept in separate places. An update never wipes a semester to make the new version fit.
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error} Nothing was deleted.
        </div>
      )}

      {status && (
        <div role="status" data-testid="storage-action-result" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {status}
        </div>
      )}

      {!report ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Checking storage…
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-500">
            <ShieldCheck className="w-4 h-4 text-[#2D6A4F]" />
            <span data-testid="storage-schema">
              Data version {report.schemaVersion ?? '—'} · {STATUS_LABEL[report.schemaStatus] || report.schemaStatus}
            </span>
          </div>

          {report.issues.length > 0 && (
            <div className="space-y-3">
              {report.issues.map((issue, index) => (
                <div
                  key={`${issue.code}-${issue.targetId || index}`}
                  data-testid={`storage-issue-${issue.code}`}
                  className={`rounded-xl border p-4 ${issue.severity === 'error' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className={`w-5 h-5 flex-shrink-0 ${issue.severity === 'error' ? 'text-red-500' : 'text-amber-500'}`} />
                    <div className="min-w-0">
                      <h2 className="font-bold text-slate-800">{issue.title}</h2>
                      <p className="text-sm text-slate-600 mt-1">{issue.explanation}</p>
                    </div>
                  </div>
                  {issue.recoveryId && issue.recoveryLabel && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { void onRecover(issue); }}
                      className="mt-3 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#2D6A4F] text-white text-sm font-bold hover:bg-[#1B4332] disabled:opacity-60"
                    >
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                      {issue.recoveryLabel}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {report.issues.length === 0 && (
            <div className="rounded-xl border border-emerald-100 bg-white px-4 py-3 text-sm text-emerald-800 flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5" /> No storage problems found. Nothing was changed by this check.
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Current workspace" value={formatBytes(report.currentWorkspaceBytes)} testId="storage-workspace-size" />
            <Stat label="Archived semesters" value={String(report.archiveCount)} testId="storage-archive-count" />
            <Stat label="Archive size" value={formatBytes(report.archiveBytes)} testId="storage-archive-size" />
            <Stat label="Uploaded files" value={String(report.uploadedFileCount)} testId="storage-file-count" />
            <Stat label="Document storage" value={formatBytes(report.documentBytes)} testId="storage-document-size" />
            <Stat label="IndexedDB" value={report.indexedDbAvailable ? formatBytes(report.indexedDbBytes) : 'Not measurable'} testId="storage-idb" />
            <Stat label="localStorage" value={report.localStorageAvailable ? formatBytes(report.localStorageBytes) : 'Not measurable'} testId="storage-local" />
            <Stat
              label="Available"
              value={report.availableBytes == null ? 'Not reported' : formatBytes(report.availableBytes)}
              testId="storage-available"
            />
          </div>

          {report.quotaBytes == null && (
            <p className="text-xs text-slate-400">This browser does not report a storage quota. Usage above is measured from the records PharmaTRACK can see.</p>
          )}

          <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="p-4 bg-gray-50 border-b border-gray-100">
              <h2 className="font-semibold text-slate-800">Data categories</h2>
              <p className="text-xs text-slate-500 mt-1">These are not mixed. A problem in one is not fixed by clearing another.</p>
            </div>
            <ul className="divide-y divide-gray-100">
              {report.categories.map((cat) => (
                <li key={cat.id} className="p-4" data-testid={`storage-category-${cat.id}`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-bold text-slate-800 text-sm">{cat.label}</span>
                    <span className="text-sm font-semibold text-slate-600">{formatBytes(cat.bytes)}</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">{cat.description} · {cat.items} {cat.items === 1 ? 'record' : 'records'}</p>
                  <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full bg-[#2D6A4F]" style={{ width: cat.bytes ? `${Math.max(4, Math.round((cat.bytes / maxCategory) * 100))}%` : '0%' }} />
                  </div>
                </li>
              ))}
            </ul>
            {report.recoveryBytes > 0 && (
              <p className="px-4 py-3 text-xs text-slate-500 border-t border-gray-100">
                Unfinished import data ({formatBytes(report.recoveryBytes)}) is listed above as a warning. It is not part of any category.
              </p>
            )}
          </section>

          <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="p-4 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
              <Archive className="w-5 h-5 text-[#2D6A4F]" />
              <h2 className="font-semibold text-slate-800">Academic archives</h2>
            </div>
            {report.archives.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">No archived semesters on this device.</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {report.archives.map((archive) => (
                  <li key={archive.id} className="p-4 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-bold text-slate-800 text-sm truncate">{archive.title}</p>
                      <p className="text-xs text-slate-400 truncate">{archive.id}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-semibold text-slate-700">{formatBytes(archive.bytes)}</p>
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{archive.status}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="px-4 py-3 border-t border-gray-100">
              <Link to="/archive" className="text-sm font-bold text-[#2D6A4F] hover:underline">Open Academic Archive</Link>
            </div>
          </section>

          <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="p-4 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
              <Database className="w-5 h-5 text-[#2D6A4F]" />
              <h2 className="font-semibold text-slate-800">Large files</h2>
            </div>
            {report.largeFiles.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">No unusually large files (256 KB or more).</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {report.largeFiles.map((file) => (
                  <li key={file.fileId} className="p-4 flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-slate-800 truncate">{file.title}</span>
                    <span className="text-sm text-slate-500 flex-shrink-0">{formatBytes(file.bytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="text-xs text-slate-400">
            Safety copies made before an update stay on this device. They are not uploaded, and they are not included in a .pharmatrack backup.
          </p>
        </>
      )}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; testId: string }> = ({ label, value, testId }) => (
  <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-3" data-testid={testId}>
    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
    <p className="mt-1 text-lg font-black text-slate-800">{value}</p>
  </div>
);

export default StorageManager;
