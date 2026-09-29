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
  prefetched.add(path);
  void Promise.resolve()
    .then(factory)
    .catch(() => {
      // A failed prefetch is not user-visible; allow a later real navigation
      // (which shows the fallback / retry) to try again.
      prefetched.delete(path);
    });
}

/** Warms several routes. */
export function prefetchRoutes(paths: string[]): void {
  for (const path of paths) prefetchRoute(path);
}

const scheduleIdle = (cb: () => void): void => {
  if (typeof window === 'undefined') return;
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number })
    .requestIdleCallback;
  if (typeof ric === 'function') ric(cb, { timeout: 900 });
  else window.setTimeout(cb, 250);
};

/**
 * After the first screen is idle, warm normal local-first app tabs one at a
 * time. Opening a sidebar tab should not show a loader, but fetching every
 * chunk at once can freeze slower WebViews, so this is deliberately staggered.
 */
export function prefetchLikelyRoutes(
  paths: string[] = [
    '/materials', '/courses', '/questions', '/quiz', '/highlights', '/objectives',
    '/planner', '/learn', '/clinical', '/notes', '/analytics', '/timetable',
    '/search', '/settings', '/profile', '/archive', '/storage', '/library', '/read',
  ],
): void {
  const queue = [...paths];
  const warmNext = () => {
    const next = queue.shift();
    if (!next) return;
    prefetchRoute(next);
    if (queue.length) scheduleIdle(warmNext);
  };
  scheduleIdle(warmNext);
}
