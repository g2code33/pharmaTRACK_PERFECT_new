/**
 * Small, dependency-free PWA registration layer.
 *
 * The service worker only handles the public application shell. Authentication,
 * Supabase, AI, examination records, and all other user data remain outside its
 * caches and continue to use the app's existing localStorage/IndexedDB stores.
 */
export const PWA_UPDATE_EVENT = 'pharmatrack:pwa-update';

let registration: ServiceWorkerRegistration | undefined;
let reloadingForUpdate = false;

function canRegister(): boolean {
  return (
    import.meta.env.PROD &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator
  );
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
