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
import { recoverServiceWorker } from './serviceWorkerRecovery';
import { DamagedAssetError, isRouteModule, rescueModuleImport } from './moduleRescue';
import { isNativeShell } from '../platform/runtime';

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
    /Loading CSS chunk/i.test(message) ||
    // WebKit refuses to execute a module whose response carries a non-script
    // MIME type (a cached PDF served for a chunk URL, a mis-served asset).
    // That IS a chunk-load failure — the recovery path (cache-busted re-import,
    // service-worker cleanup, reload) is exactly what fixes it.
    /is not a valid JavaScript MIME type/i.test(message)
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
 * Pulls the failing module URL out of a chunk load error.
 *
 * Every engine puts the URL in the message, e.g.
 * `Failed to fetch dynamically imported module: https://tauri.localhost/assets/CourseDetail-CH8k_Lo-.js`.
 */
export function chunkUrlFromError(error: unknown): string | null {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error ?? '');
  const match = message.match(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s'"`()]+\.(?:m?js|css)/i);
  return match ? match[0] : null;
}

/**
 * Best-effort URL for DISPLAY and cache-refresh only — never for re-import.
 *
 * Some engines reject a bad module response without naming the file (WebKit's
 * MIME-type refusal names the MIME, not the URL). The failing module fetch is
 * almost always the most recent script resource in the timeline at the moment
 * the rejection propagates, so we can still show the operator what failed and
 * re-fetch exactly that URL.
 *
 * It must never feed retryChunkFromError: a guess that points at another
 * route's chunk would import that chunk's exports as this page's component.
 */
export function chunkUrlForDiagnostics(error: unknown): string | null {
  const fromMessage = chunkUrlFromError(error);
  if (fromMessage) return fromMessage;
  try {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
      return null;
    }
    const entries = performance.getEntriesByType('resource') as Array<{ name?: string }>;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const name = entries[i]?.name;
      if (name && /\.m?js(?:\?|$)/.test(name)) return name;
    }
  } catch {
    /* timing API unavailable — nothing to add */
  }
  return null;
}

/**
 * Adds a unique query so the request is a genuinely new module specifier.
 *
 * This is the whole point of the second attempt: once an `import()` of a given
 * URL rejects, the engine remembers that rejection, and re-running the exact
 * same `import()` resolves from that memory without touching the network. Any
 * stale HTTP/worker cache entry is skipped for the same reason.
 */
export function withCacheBust(url: string, stamp: number = Date.now()): string {
  try {
    const base = typeof window !== 'undefined' ? window.location.href : undefined;
    const parsed = new URL(url, base);
    parsed.searchParams.set('pharmatrack-retry', String(stamp));
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}pharmatrack-retry=${stamp}`;
  }
}

/**
 * Re-imports a chunk under a fresh URL AND proves the result is a route module.
 *
 * The proof matters whenever the URL came from the performance timeline rather
 * than from the error message: importing another page's chunk would mount the
 * wrong screen, which is worse than showing the recovery card.
 */
async function importChunkFresh<T>(url: string): Promise<{ default: T } | null> {
  const mod = (await import(/* @vite-ignore */ withCacheBust(url))) as { default: T };
  return isRouteModule(mod) ? mod : null;
}

/**
 * Performs the single controlled reload used to recover from a stale chunk.
 * Returns a promise that never resolves so the caller's `import()` does not
 * continue racing the navigation.
 */
async function recoverByReload(): Promise<never> {
  markReloaded();
  await recoverServiceWorker();
  try {
    window.location.reload();
  } catch {
    /* ignore */
  }
  // Hold the pending state; the page is navigating away.
  return new Promise<never>(() => {});
}

/**
 * The exact file a route's source file was bundled into, from `chunk-map.json`
 * (written by the routeChunkMap Vite plugin at build time).
 *
 * This exists because the failure we most need to repair names no URL: WebKit
 * refuses a mis-labelled module with "'application/pdf' is not a valid
 * JavaScript MIME type", full stop. Without this map the only way to find the
 * broken file would be to guess from the resource timeline, and importing a
 * guessed chunk can mount the wrong page. With it, recovery re-fetches exactly
 * the chunk the route asked for.
 */
let chunkMapPromise: Promise<Record<string, string>> | null = null;

export async function chunkFileForModule(moduleId: string | undefined): Promise<string | null> {
  if (!moduleId || typeof document === 'undefined' || typeof fetch !== 'function') return null;
  try {
    chunkMapPromise ??= fetch(new URL('chunk-map.json', document.baseURI).toString(), {
      cache: 'no-store',
    })
      .then((response) => (response.ok ? (response.json() as Promise<Record<string, string>>) : {}))
      .catch(() => ({}));
    const map = await chunkMapPromise;
    const file = map[moduleId];
    if (!file) {
      // Nothing usable: do not remember the miss (a dev build has no map, and
      // the next failure should look again rather than stay blind).
      if (Object.keys(map).length === 0) chunkMapPromise = null;
      return null;
    }
    return new URL(file, document.baseURI).toString();
  } catch {
    chunkMapPromise = null;
    return null;
  }
}

/**
 * Wraps a dynamic import so a transient failure is retried, a stale-asset
 * failure triggers exactly one guarded reload, and a genuine failure is thrown
 * for the error boundary to present with a Retry action.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  moduleId?: string,
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

        // WebKit's MIME refusal names the MIME type but not the file, so the
        // URL comes from the message when present and from the resource
        // timeline otherwise. Every use below re-validates what it gets.
        const failingUrl = chunkUrlFromError(secondError);

        // 2) Re-request the same file under a unique URL. Without this the
        //    retry above is a no-op whenever the engine has already cached the
        //    rejection for that specifier, which is the usual case.
        if (failingUrl) {
          try {
            const mod = await importChunkFresh<T>(failingUrl);
            if (mod) {
              clearReloadStamp();
              return mod;
            }
          } catch {
            /* fall through to the byte-level rescue */
          }
        }

        // 3) Byte-level rescue (see utils/moduleRescue.ts). A module response
        //    that was labelled wrong can still be executed: fetch the file
        //    ourselves, verify it really is JavaScript, and import it from a
        //    blob URL that carries the right type. When the bytes are not
        //    JavaScript at all, the thrown DamagedAssetError names the file
        //    and the repair instead of repeating a MIME type at the user.
        let diagnosed: Error | null = null;
        const candidate =
          failingUrl ??
          (await chunkFileForModule(moduleId)) ??
          chunkUrlForDiagnostics(secondError);
        if (candidate) {
          try {
            const mod = await rescueModuleImport<T>(candidate);
            if (isRouteModule(mod)) {
              clearReloadStamp();
              return mod;
            }
          } catch (rescueError) {
            if (rescueError instanceof DamagedAssetError) diagnosed = rescueError;
          }
        }

        // 4) Looks like the cached HTML points at a chunk from a previous
        //    build. Refresh the worker and reload — but only once.
        if (canControlledReload()) {
          return recoverByReload();
        }
        // 5) Already reloaded and still failing: hand the boundary the most
        //    useful error we have.
        throw diagnosed ?? secondError;
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
  /** Source path of the page, e.g. 'src/pages/StudyMaterials.tsx'. */
  moduleId?: string,
): LazyExoticComponent<T> {
  registerRoute(path, factory);
  return lazyWithRetry(factory, moduleId);
}

/**
 * Warms a single route's chunk. Safe to call repeatedly; each runs once.
 *
 * Deliberately a no-op inside a packaged shell. There the bundle is read from
 * the app's own protocol out of memory, so a warm chunk saves milliseconds
 * while costing something real: background warming is the only time this app
 * fetches a dozen scripts at once, and concurrent responses on the Linux
 * webview are what produce the mis-labelled assets `moduleRescue.ts` exists
 * for. A failed prefetch also poisons the engine's module cache for the route
 * the user later clicks. Navigation there loads exactly what it needs, once.
 */
export function prefetchRoute(path: string): void {
  if (isNativeShell()) return;
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
