/**
 * Service worker recovery, shared by every place that reacts to a failed
 * asset load.
 *
 * There are two opposite correct behaviours:
 *
 *  - On the web a service worker is wanted. When a chunk fails we pull a fresh
 *    worker and let a waiting one take over, so the next load gets the new
 *    asset manifest.
 *
 *  - Inside a packaged shell (desktop app, Android APK) a service worker must
 *    not exist at all. The shell serves its bundle from a custom protocol that
 *    counts as a secure origin, so a worker was able to register there — and
 *    requests made by a worker bypass the shell's protocol handler. Once it was
 *    in charge it answered navigations from its own cache (pinning the window
 *    to an old build) and failed every hashed chunk the cache did not contain,
 *    which is exactly the "Failed to fetch dynamically imported module" crash.
 *    So here recovery means removing it, not refreshing it.
 */
import { isNativeShell } from '../platform/runtime';

/** Cache names created by public/sw.js. */
export const SHELL_CACHE_PREFIX = 'pharmatrack-shell-';

function serviceWorkerAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/** True when a worker is currently serving this document. */
export function isServiceWorkerControlled(): boolean {
  return serviceWorkerAvailable() && Boolean(navigator.serviceWorker.controller);
}

/** Removes every registration for this origin. Returns true if any went away. */
export async function unregisterAllServiceWorkers(): Promise<boolean> {
  if (!serviceWorkerAvailable()) return false;
  let removed = false;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      try {
        removed = (await registration.unregister()) || removed;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}

/** Drops the precached app shell so nothing can be replayed from it. */
export async function deleteShellCaches(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  let removed = false;
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(SHELL_CACHE_PREFIX))
        .map(async (key) => {
          try {
            removed = (await caches.delete(key)) || removed;
          } catch {
            /* ignore */
          }
        }),
    );
  } catch {
    /* ignore */
  }
  return removed;
}

/**
 * Web path: pull a fresh worker and activate a waiting one so the refreshed
 * index/asset pair wins on the next load. Never throws.
 */
export async function refreshServiceWorker(): Promise<void> {
  if (!serviceWorkerAvailable()) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations.map(async (registration) => {
        try {
          await registration.update();
        } catch {
          /* ignore */
        }
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
 * The right recovery for wherever this build happens to be running: refresh on
 * the web, remove entirely in a packaged shell.
 */
export async function recoverServiceWorker(): Promise<void> {
  if (!serviceWorkerAvailable()) return;
  if (isNativeShell()) {
    await unregisterAllServiceWorkers();
    await deleteShellCaches();
    return;
  }
  await refreshServiceWorker();
}
