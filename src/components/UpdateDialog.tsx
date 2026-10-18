import React, { useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Loader2, RotateCw, Sparkles, X } from 'lucide-react';
import { formatDownloadSize, updateDownloadPercent } from '../utils/updateProgress';

/**
 * Updating without a single native dialog.
 *
 * The update pill used to drive `window.confirm` and `alert`. Those are the
 * browser's dialogs, not the app's: they block the JavaScript thread (so the
 * download progress behind them never painted), they are styled by the host
 * and look nothing like PharmaTRACK, they ignore dark mode, and in a packaged
 * WebView they are the one piece of UI the app does not control — on some
 * Linux WebKitGTK builds `confirm()` simply returns false, which silently
 * declined every update the user was offered.
 *
 * This sheet replaces all of it with ordinary in-app UI: the same floating
 * card as the share sheet, a real progress bar while the package downloads,
 * and a restart button at the end. It is the only place the update flow talks
 * to the user, so the desktop app behaves exactly like the web app.
 */
export type UpdateFlowState =
  | { kind: 'checking'; version: string }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'downloading'; version: string; received: number; total: number }
  | { kind: 'installed'; version: string }
  | { kind: 'current'; version: string }
  | { kind: 'store'; version: string }
  | { kind: 'failed'; message: string };

export interface UpdateDialogProps {
  state: UpdateFlowState | null;
  onInstall: () => void;
  onRestart: () => void;
  onRetry: () => void;
  onOpenStore: () => void;
  onClose: () => void;
}

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-2xl bg-[#2D6A4F] px-4 py-3 text-sm font-black text-white hover:bg-[#1B4332]';
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700';

const UpdateDialog: React.FC<UpdateDialogProps> = ({
  state,
  onInstall,
  onRestart,
  onRetry,
  onOpenStore,
  onClose,
}) => {
  // A half-written update must never be abandoned by a stray tap or Escape,
  // so the download stage is the one stage without a way out.
  const dismissible = Boolean(state) && state?.kind !== 'downloading';
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const stageKey = state?.kind ?? 'closed';

  useEffect(() => {
    if (stageKey === 'closed') return;
    primaryRef.current?.focus();
  }, [stageKey]);

  useEffect(() => {
    if (!dismissible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismissible, onClose]);

  if (!state) return null;

  const heading =
    state.kind === 'checking'
      ? 'Checking for updates'
      : state.kind === 'available'
      ? 'Update available'
      : state.kind === 'downloading'
        ? 'Downloading update'
        : state.kind === 'installed'
          ? 'Update installed'
          : state.kind === 'current'
            ? 'You are up to date'
            : state.kind === 'store'
              ? 'Get the newest build'
              : 'Update failed';

  const subheading =
    state.kind === 'failed'
      ? 'Nothing was changed on this device'
      : state.kind === 'current'
        ? `Version ${state.version}`
        : `Version ${state.version}`;

  const percent =
    state.kind === 'downloading' ? updateDownloadPercent(state.received, state.total) : null;

  return (
    <div
      // Above the native title bar (z-500) so the sheet is never clipped by
      // the desktop window strip.
      className="fixed inset-0 z-[600] flex items-end justify-center bg-slate-900/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Software update"
      onClick={dismissible ? onClose : undefined}
    >
      <div
        className="max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl safe-area-bottom dark:bg-slate-900 sm:rounded-3xl sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white ${
                state.kind === 'failed' ? 'bg-amber-500' : 'bg-[#2D6A4F]'
              }`}
            >
              {state.kind === 'failed' ? (
                <AlertTriangle className="h-5 w-5" />
              ) : state.kind === 'checking' ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : state.kind === 'installed' || state.kind === 'current' ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : state.kind === 'store' ? (
                <ExternalLink className="h-5 w-5" />
              ) : state.kind === 'downloading' ? (
                <Download className="h-5 w-5" />
              ) : (
                <Sparkles className="h-5 w-5" />
              )}
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-black text-slate-900 dark:text-white">{heading}</h2>
              <p className="truncate text-sm font-semibold text-slate-500 dark:text-slate-400">
                {subheading}
              </p>
            </div>
          </div>
          {dismissible ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close update sheet"
              className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="h-5 w-5" />
            </button>
          ) : null}
        </div>

        {state.kind === 'checking' ? (
          <div>
            <p className="mb-4 text-sm font-bold text-slate-700 dark:text-slate-200">
              Asking the update server whether anything newer than {state.version} is available…
            </p>
            <button ref={primaryRef} type="button" onClick={onClose} className={`w-full ${SECONDARY_BUTTON}`}>
              Cancel
            </button>
          </div>
        ) : null}

        {state.kind === 'available' ? (
          <div>
            <p className="mb-3 text-sm font-bold text-slate-700 dark:text-slate-200">
              PharmaTRACK {state.version} is ready to install. Your courses, slides and notes stay
              exactly where they are.
            </p>
            {state.notes ? (
              <p className="mb-4 max-h-40 overflow-y-auto whitespace-pre-line rounded-2xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {state.notes}
              </p>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <button ref={primaryRef} type="button" onClick={onInstall} className={PRIMARY_BUTTON}>
                <Download className="h-4 w-4" /> Install now
              </button>
              <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
                Later
              </button>
            </div>
          </div>
        ) : null}

        {state.kind === 'downloading' ? (
          <div>
            <div className="mb-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
              <div
                className={`h-full rounded-full bg-[#2D6A4F] ${
                  percent === null ? 'w-1/3 animate-pulse' : 'transition-[width] duration-200'
                }`}
                style={percent === null ? undefined : { width: `${percent}%` }}
                role="progressbar"
                aria-label="Update download progress"
                aria-valuenow={percent ?? undefined}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
            <p className="text-sm font-bold text-slate-700 dark:text-slate-200">
              {percent === null
                ? `${formatDownloadSize(state.received)} downloaded…`
                : `${percent}% · ${formatDownloadSize(state.received)} of ${formatDownloadSize(state.total)}`}
            </p>
            <p className="mt-2 text-xs font-bold text-slate-500 dark:text-slate-400">
              Keep the app open until this finishes. You can carry on reading — the download runs in
              the background.
            </p>
          </div>
        ) : null}

        {state.kind === 'installed' ? (
          <div>
            <p className="mb-4 text-sm font-bold text-slate-700 dark:text-slate-200">
              Version {state.version} is installed. Restart to start using it.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <button ref={primaryRef} type="button" onClick={onRestart} className={PRIMARY_BUTTON}>
                <RotateCw className="h-4 w-4" /> Restart now
              </button>
              <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
                Later
              </button>
            </div>
          </div>
        ) : null}

        {state.kind === 'current' ? (
          <div>
            <p className="mb-4 text-sm font-bold text-slate-700 dark:text-slate-200">
              You already have the newest PharmaTRACK. Nothing to download.
            </p>
            <button ref={primaryRef} type="button" onClick={onClose} className={`w-full ${PRIMARY_BUTTON}`}>
              Done
            </button>
          </div>
        ) : null}

        {state.kind === 'store' ? (
          <div>
            <p className="mb-4 text-sm font-bold text-slate-700 dark:text-slate-200">
              This build updates from the PharmaTRACK download page. Opening it will fetch the
              newest install file for this device.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <button ref={primaryRef} type="button" onClick={onOpenStore} className={PRIMARY_BUTTON}>
                <ExternalLink className="h-4 w-4" /> Open download page
              </button>
              <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
                Not now
              </button>
            </div>
          </div>
        ) : null}

        {state.kind === 'failed' ? (
          <div>
            <div className="mb-4 flex items-start gap-3 rounded-2xl bg-amber-50 p-4 dark:bg-amber-500/10">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
              <p className="text-sm font-bold text-amber-900 dark:text-amber-200">{state.message}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <button ref={primaryRef} type="button" onClick={onRetry} className={PRIMARY_BUTTON}>
                <RotateCw className="h-4 w-4" /> Try again
              </button>
              <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
                Close
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default UpdateDialog;
