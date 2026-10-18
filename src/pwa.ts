/**
 * Small, dependency-free PWA registration layer.
 *
 * The service worker only handles the public application shell. Authentication,
 * Supabase, AI, examination records, and all other user data remain outside its
 * caches and continue to use the app's existing localStorage/IndexedDB stores.
 */
import { isNativeShell } from './platform/runtime';
import {
  deleteAllCaches,
  isServiceWorkerControlled,
  unregisterAllServiceWorkers,
} from './utils/serviceWorkerRecovery';

export const PWA_UPDATE_EVENT = 'pharmatrack:pwa-update';

export { isPWAStandalone as isPwaStandalone } from './platform/runtime';

let registration: ServiceWorkerRegistration | undefined;
let reloadingForUpdate = false;

/**
 * Reload budget for the native cleanup. A single guarded reload was not
 * enough: the reload itself can be interrupted (machine sleeps, window is
 * killed mid-navigation), and the page then stays controlled by the worker
 * for the rest of the session with the guard flag already set. A small
 * budget beats interrupted reloads while still making a loop impossible.
 */
const NATIVE_CLEANUP_FLAG = 'pharmatrack:native-sw-cleanup';
const MAX_CLEANUP_RELOADS = 3;

/**
 * A packaged app must never be served by a service worker.
 *
 * The desktop shell serves its bundle from a custom protocol
 * (https://tauri.localhost on Windows) which browsers treat as a secure
 * origin, so the worker happily registered there — and then broke the app:
 * requests a service worker makes are not handled by the shell's protocol
 * handler, so the worker answered navigations from its own cache (an app
 * build from whenever the cache was filled) and failed outright on every
 * hashed route chunk the cache did not have. That is both the "desktop app is
 * stuck on an old UI" symptom and the "Failed to fetch dynamically imported
 * module" crash. The Android WebView has the same shape of problem.
 */
function canRegister(): boolean {
  return (
    import.meta.env.PROD &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    !isNativeShell()
  );
}

function reloadAlreadyAttempted(): boolean {
  try {
    return (Number(sessionStorage.getItem(NATIVE_CLEANUP_FLAG)) || 0) >= MAX_CLEANUP_RELOADS;
  } catch {
    return true; // No sessionStorage: never risk a reload loop.
  }
}

function markReloadAttempted(): void {
  try {
    const used = Number(sessionStorage.getItem(NATIVE_CLEANUP_FLAG)) || 0;
    sessionStorage.setItem(NATIVE_CLEANUP_FLAG, String(used + 1));
  } catch {
    /* ignore */
  }
}

/**
 * Removes any service worker and shell cache inside a packaged app, then
 * reloads once if the page we are looking at was being served by it.
 *
 * Existing desktop installs already have the bad worker on disk, so this has
 * to run at boot on every launch, not just on the build that introduced it.
 */
export async function purgeNativeShellServiceWorkers(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;

  const wasControlled = isServiceWorkerControlled();
  const unregistered = await unregisterAllServiceWorkers();
  // Every cache in a packaged-shell origin was put there by a worker that
  // should never have existed there, so scrub them all — including any
  // whose names predate the current prefix.
  const cachesDropped = await deleteAllCaches();

  // The document in front of the user is still the one the worker served, so
  // it keeps running whatever build was in that cache until we reload.
  if (wasControlled && !reloadAlreadyAttempted()) {
    markReloadAttempted();
    try {
      window.location.reload();
    } catch {
      /* ignore */
    }
  }
  return unregistered || cachesDropped;
}

/**
 * The relentless guard for a RUNNING packaged app: being controlled by a
 * service worker there is always wrong — every /assets/ request then goes
 * through the worker, whose own fetches bypass the shell's protocol handler
 * and fail or come back with a wrong MIME type (that is the "'application/pdf'
 * is not a valid JavaScript MIME type" crash, and the "every asset fetch
 * fails while the page itself loaded" state the integrity check reported).
 *
 * Call this whenever control is detected. It purges and reloads while the
 * budget lasts; when the budget is spent it reports 'exhausted' so the UI can
 * tell the user to reopen the app instead of spinning.
 */
export type SwEnforcement = 'uncontrolled' | 'purging' | 'exhausted';

export async function enforceNativeShellNoServiceWorker(): Promise<SwEnforcement> {
  if (!isNativeShell()) return 'uncontrolled';
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'uncontrolled';
  if (!isServiceWorkerControlled()) return 'uncontrolled';
  if (reloadAlreadyAttempted()) return 'exhausted';
  await purgeNativeShellServiceWorkers(); // reloads the page while budget remains
  return 'purging';
}

/**
 * Single entry point used at boot: register the worker on the web, remove it
 * everywhere else.
 */
export async function bootstrapPwa(): Promise<ServiceWorkerRegistration | undefined> {
  if (isNativeShell()) {
    await purgeNativeShellServiceWorkers();
    return undefined;
  }
  return registerPwa();
}

function serviceWorkerUrl(): string {
  const base = import.meta.env.BASE_URL || './';
  return new URL(`${base.replace(/\/$/, '')}/sw.js`, document.baseURI).toString();
}

function announceUpdate(): void {
  if (registration?.waiting && navigator.serviceWorker.controller) {
    window.dispatchEvent(new Event(PWA_UPDATE_EVENT));
  }
}

export async function registerPwa(): Promise<ServiceWorkerRegistration | undefined> {
  if (!canRegister()) return undefined;

  try {
    registration = await navigator.serviceWorker.register(serviceWorkerUrl());

    registration.addEventListener('updatefound', () => {
      const worker = registration?.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') announceUpdate();
      });
    });

    // Ask for a fresh worker on later visits. It will wait rather than replace
    // an active session until the user accepts the update banner.
    void registration.update().catch(() => undefined);

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadingForUpdate) return;
      reloadingForUpdate = true;
      window.location.reload();
    });

    announceUpdate();
    return registration;
  } catch (error) {
    // PWA support is progressive enhancement. A blocked registration must not
    // prevent the regular web application from booting.
    console.warn('PharmaTRACK service worker registration skipped:', error);
    return undefined;
  }
}

export async function activatePwaUpdate(): Promise<void> {
  if (!registration?.waiting) return;
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
}

export function getPwaRegistration(): ServiceWorkerRegistration | undefined {
  return registration;
}
