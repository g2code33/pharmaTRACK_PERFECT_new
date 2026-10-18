import React, { useEffect, useState } from 'react';
import { Loader2, RotateCw } from 'lucide-react';

/**
 * Content-area loading state for lazy routes.
 *
 * This renders INSIDE the persistent Layout (only the main outlet is replaced),
 * so the sidebar, header and background stay visible. Design goals:
 *
 *  - matches the app theme and works in light and dark mode; the container has
 *    a non-white background so it never looks like a blank window;
 *  - a skeleton (not a bare centred spinner) that reserves the page's rough
 *    shape to avoid a layout shift when the real page arrives;
 *  - accessible: role="status" with an accessible label and aria-live, and it
 *    never moves focus, so keyboard users are not trapped;
 *  - a timeout escape hatch: if the chunk is still not ready after a while it
 *    stops looking "stuck" and offers a Retry, so there is never an endless
 *    spinner.
 */

interface RouteLoadingProps {
  /** Milliseconds before the "taking longer than expected" state appears. */
  timeoutMs?: number;
  /** Called when the user asks to retry a slow/failed load. */
  onRetry?: () => void;
  label?: string;
}

const SkeletonBar: React.FC<{ className?: string }> = ({ className }) => (
  <div className={`animate-pulse rounded-lg bg-slate-200/80 dark:bg-slate-700/60 ${className ?? ''}`} />
);

const RouteLoading: React.FC<RouteLoadingProps> = ({
  timeoutMs = 12000,
  onRetry,
  label = 'Loading page…',
}) => {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setTimedOut(true), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [timeoutMs]);

  const handleRetry = () => {
    if (onRetry) onRetry();
    else window.location.reload();
  };

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={!timedOut}
      aria-label={label}
      data-testid="route-loading"
      className="min-h-[60vh] w-full rounded-2xl bg-slate-50 dark:bg-slate-900/40 p-4 sm:p-6"
    >
      {/* A quiet, theme-matched progress cue at the top of the content area. */}
      <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-[#2D6A4F] dark:text-emerald-300">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        <span>Loading</span>
      </div>

      {/* Skeleton that roughly reserves a typical page's layout. */}
      <div className="mt-4 space-y-4" aria-hidden="true">
        <SkeletonBar className="h-8 w-1/3" />
        <SkeletonBar className="h-4 w-2/3" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="rounded-2xl border border-slate-200/70 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 p-5 space-y-3"
            >
              <SkeletonBar className="h-5 w-1/2" />
              <SkeletonBar className="h-3 w-full" />
              <SkeletonBar className="h-3 w-5/6" />
              <SkeletonBar className="h-9 w-24 mt-2" />
            </div>
          ))}
        </div>
      </div>

      {timedOut && (
        <div className="mt-6 flex flex-col items-center gap-3 text-center">
          <p className="text-sm font-bold text-slate-600 dark:text-slate-300">
            This page is taking longer than expected.
          </p>
          <p className="text-xs text-slate-400 dark:text-slate-500 max-w-sm">
            Your data is safe on this device. You can keep waiting, or reload to
            fetch the latest version of the app.
          </p>
          <button
            type="button"
            onClick={handleRetry}
            className="flex items-center gap-2 px-4 py-2 bg-[#2D6A4F] text-white rounded-xl font-bold hover:bg-[#1B4332] focus:outline-none focus:ring-2 focus:ring-[#2D6A4F]/50"
          >
            <RotateCw className="w-4 h-4" aria-hidden="true" /> Retry
          </button>
        </div>
      )}

      {/* Screen-reader-only status text. */}
      <span className="sr-only">{timedOut ? 'Still loading. You can retry.' : label}</span>
    </div>
  );
};

export default RouteLoading;
