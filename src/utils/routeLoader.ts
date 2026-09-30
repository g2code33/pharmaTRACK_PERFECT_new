/**
 * Lazy route loading that keeps the application shell alive.
 *
 * Two problems this solves:
 *
 *  1. A slow dynamic import must never blank the whole window. The Suspense
 *     boundary that shows the fallback lives INSIDE the Layout (around the
 *     route outlet only), so the sidebar and header stay mounted. See
 *     src/components/Layout.tsx.
 *
 *  2. After an app update the cached HTML can reference a hashed chunk that no
 *     longer exists (Vite renames bundles on every build; the service worker's
 *     `activate` step deletes the previous cache). Importing that chunk then
 *     rejects with a "Failed to fetch dynamically imported module" style error.
 *     `lazyWithRetry` retries once for a transient blip, then — only once,
 *     guarded against a reload loop — refreshes the service worker and reloads
 *     so the fresh index/asset pair wins. A second failure surfaces to the
 *     route error boundary, which offers a manual Retry instead of spinning
 *     forever.
 *
 * Prefetching: `registerRoute` records each page's import so the sidebar can
 * warm a likely destination on hover/focus, and the app can prefetch a few
 * common pages once the first screen is idle. Nothing large is pulled eagerly
 * at startup.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { scheduleBackgroundWork } from './idleScheduler';

/** sessionStorage flag so a stale-chunk reload happens at most once per tab. */
const RELOAD_FLAG = 'pharmatrack:chunk-reload';
/** A reload is only trusted to help for a short window; older stamps are ignored. */
const RELOAD_WINDOW_MS = 60_000;

/**
 * Recognises the various "the dynamically imported module could not be loaded"
 * errors across engines. WebKitGTK (the Tauri Linux webview) and Safari report
 * this differently from Chromium, so the match is deliberately broad.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const name = error instanceof Error ? error.name : '';
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  if (name === 'ChunkLoadError') return true;
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) || // WebKit / Safari
    /Unable to preload CSS/i.test(message) ||
    /dynamically imported module/i.test(message) ||
    /Loading chunk [\d]+ failed/i.test(message) ||
    /Loading CSS chunk/i.test(message)
  );
}

function readReloadStamp(): number {
  try {
    const raw = sessionStorage.getItem(RELOAD_FLAG);
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  } catch {
    /* private mode — the guard simply degrades to "no auto reload" */
  }
}

/** Cleared after any successful chunk load so a future deploy can recover once. */
function clearReloadStamp(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG);
  } catch {
    /* ignore */
  }
}

/** True when we have NOT already reloaded recently for a stale chunk. */
function canControlledReload(): boolean {
  const stamp = readReloadStamp();
  if (!stamp) return true;
  // A stale stamp (older than the window, e.g. a genuinely different session)
  // is allowed to reload again; a fresh one means we just tried, so stop.
  return Date.now() - stamp > RELOAD_WINDOW_MS;
}

/**
 * Best-effort: pull a fresh service worker and let a waiting one take over so
 * the next navigation is served the new asset manifest. Never throws.
 */
async function refreshServiceWorker(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations.map(async (registration) => {
        try {
          await registration.update();
        } catch {
          /* ignore */
        }
        // Activate a worker that installed but is waiting, so the refreshed
        // index.html (and its new chunk names) becomes the controller.
        if (registration.waiting) {
          try {
            registration.waiting.postMessage({ type: 'SKIP_WAITING' });
          } catch {
            /* ignore */
          }
        }
      }),
    );
  } catch {
    /* best-effort only */
  }
}

/**
 * Performs the single controlled reload used to recover from a stale chunk.
 * Returns a promise that never resolves so the caller's `import()` does not
 * continue racing the navigation.
 */
async function recoverByReload(): Promise<never> {
  markReloaded();
  await refreshServiceWorker();
  try {
    window.location.reload();
  } catch {
    /* ignore */
  }
  // Hold the pending state; the page is navigating away.
  return new Promise<never>(() => {});
}

/**
 * Wraps a dynamic import so a transient failure is retried, a stale-asset
 * failure triggers exactly one guarded reload, and a genuine failure is thrown
 * for the error boundary to present with a Retry action.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const mod = await factory();
      clearReloadStamp();
      return mod;
    } catch (firstError) {
      if (!isChunkLoadError(firstError)) throw firstError;
      // 1) One quick retry covers a dropped connection or a cold cache.
      try {
        const mod = await factory();
        clearReloadStamp();
        return mod;
      } catch (secondError) {
        if (!isChunkLoadError(secondError)) throw secondError;
        // 2) Looks like the cached HTML points at a chunk from a previous
        //    build. Refresh the worker and reload — but only once.
        if (canControlledReload()) {
          return recoverByReload();
        }
        // 3) Already reloaded and still failing: hand it to the boundary.
        throw secondError;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Prefetch registry
// ---------------------------------------------------------------------------

const registry = new Map<string, () => Promise<unknown>>();
const prefetched = new Set<string>();
const scheduledPrefetches = new Map<string, () => void>();

/** Records a route's import so it can be prefetched later. */
export function registerRoute(path: string, factory: () => Promise<unknown>): void {
  registry.set(path, factory);
}

/**
 * Creates a lazy route component AND registers its import for prefetching.
 * `path` is the sidebar/router path used as the prefetch key.
 */
export function lazyRoute<T extends ComponentType<any>>(
  path: string,
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  registerRoute(path, factory);
  return lazyWithRetry(factory);
}

/** Warms a single route's chunk. Safe to call repeatedly; each runs once. */
export function prefetchRoute(path: string): void {
  const factory = registry.get(path);
  if (!factory || prefetched.has(path)) return;
  scheduledPrefetches.get(path)?.();
  scheduledPrefetches.delete(path);
  prefetched.add(path);
  void Promise.resolve()
    .then(factory)
    .catch(() => {
      // A failed prefetch is not user-visible; allow a later real navigation
      // (which shows the fallback / retry) to try again.
      prefetched.delete(path);
    });
}

/**
 * Queues a route warm-up for the next quiet/idle moment. Sidebar hover/focus
 * and mobile touchstart should never parse a route chunk while the user is
 * actively moving, scrolling or tapping; that was the opposite of CLINICAL Rx's
 * instant-feeling shell. Real navigation still loads immediately on click.
 */
export function scheduleRoutePrefetch(path: string): void {
  if (!registry.has(path) || prefetched.has(path) || scheduledPrefetches.has(path)) return;
  const cancel = scheduleBackgroundWork(
    () => {
      scheduledPrefetches.delete(path);
      if (pageCanPrefetch()) prefetchRoute(path);
    },
    {
      delay: 350,
      timeout: 5_000,
      retryDelay: 700,
      quietWindowMs: 1_100,
      minTimeRemaining: 12,
      runWhenTimedOut: false,
    },
  );
  scheduledPrefetches.set(path, cancel);
}

/** Warms several routes. */
export function prefetchRoutes(paths: string[]): void {
  for (const path of paths) prefetchRoute(path);
}

const scheduleIdle = (cb: () => void): void => {
  scheduleBackgroundWork(cb, {
    timeout: 12_000,
    retryDelay: 900,
    quietWindowMs: 2_500,
    minTimeRemaining: 18,
    runWhenTimedOut: false,
  });
};

const INITIAL_BACKGROUND_PREFETCH_DELAY_MS = 7_000;
const BACKGROUND_PREFETCH_STAGGER_MS = 1_800;
const CONSTRAINED_BACKGROUND_PREFETCH_COUNT = 5;

function connectionSaveData(): boolean {
  if (typeof navigator === 'undefined') return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

function constrainedMainThread(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = navigator.hardwareConcurrency || 0;
  return (cores > 0 && cores <= 2) || (typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 2);
}

function pageCanPrefetch(): boolean {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  return !connectionSaveData();
}

/**
 * After the first screen is idle, warm normal local-first app tabs one at a
 * time. Opening a sidebar tab should not show a loader, but fetching every
 * chunk at once can freeze slower WebViews, so this is deliberately staggered.
 */
export const DEFAULT_BACKGROUND_PREFETCH_ROUTES = [
  '/materials',
  '/courses',
  '/questions',
  '/quiz',
  '/highlights',
  '/objectives',
  '/planner',
  '/learn',
  '/notes',
  '/search',
  '/settings',
  '/profile',
] as const;

export function prefetchLikelyRoutes(
  paths: string[] = [...DEFAULT_BACKGROUND_PREFETCH_ROUTES],
): void {
  if (typeof window === 'undefined') return;
  if (!pageCanPrefetch()) return;
  const queue = constrainedMainThread()
    ? paths.slice(0, CONSTRAINED_BACKGROUND_PREFETCH_COUNT)
    : [...paths];
  const warmNext = () => {
    if (!pageCanPrefetch()) return;
    const next = queue.shift();
    if (!next) return;
    prefetchRoute(next);
    if (queue.length) window.setTimeout(() => scheduleIdle(warmNext), BACKGROUND_PREFETCH_STAGGER_MS);
  };
  window.setTimeout(() => scheduleIdle(warmNext), INITIAL_BACKGROUND_PREFETCH_DELAY_MS);
}
