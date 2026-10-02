/**
 * The packaged apps (Windows EXE, Linux DEB, Android APK) must be served by
 * their own shell, never by a service worker.
 *
 * What went wrong: the desktop shell serves the bundle from a custom protocol
 * that browsers treat as a secure origin (https://tauri.localhost on Windows),
 * so the PWA service worker registered inside the app. Requests made by a
 * service worker do not pass through the shell's protocol handler, so once it
 * was in control it answered navigations out of its own cache — freezing the
 * desktop app on whichever build filled that cache, while the web app moved on
 * — and failed every hashed route chunk the cache did not contain, producing
 * "Failed to fetch dynamically imported module: .../assets/CourseDetail-*.js".
 *
 * These tests lock in the fix on every layer: never register, actively remove
 * what is already installed (from the bundle AND from the native side, because
 * a stale bundle is what might be running), serve a worker's requests from the
 * APK assets if one somehow exists, and make a failed chunk retry under a URL
 * the engine has not already cached a rejection for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chunkUrlFromError, isChunkLoadError, withCacheBust } from '../utils/routeLoader';
import {
  SHELL_CACHE_PREFIX,
  deleteShellCaches,
  recoverServiceWorker,
  unregisterAllServiceWorkers,
} from '../utils/serviceWorkerRecovery';
import { isNativeShell, isNativeShellOrigin } from '../platform/runtime';

const root = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

/** Strips comments so prose about the old behaviour cannot satisfy a check. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const realLocation = window.location;

function setLocation(href: string): void {
  const url = new URL(href);
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      href: url.href,
      protocol: url.protocol,
      hostname: url.hostname,
      origin: url.origin,
      reload: vi.fn(),
    },
  });
}

function restoreLocation(): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: realLocation,
  });
}

interface FakeRegistration {
  unregister: () => Promise<boolean>;
  update: () => Promise<void>;
  waiting: { postMessage: (message: unknown) => void } | null;
}

function installServiceWorkerStub(options: {
  registrations: FakeRegistration[];
  controlled?: boolean;
}): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: options.controlled ? {} : null,
      getRegistrations: async () => options.registrations,
    },
  });
}

function removeServiceWorkerStub(): void {
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
}

function installCachesStub(keys: string[]): { deleted: string[] } {
  const deleted: string[] = [];
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    writable: true,
    value: {
      keys: async () => keys,
      delete: async (key: string) => {
        deleted.push(key);
        return true;
      },
    },
  });
  return { deleted };
}

function removeCachesStub(): void {
  delete (globalThis as unknown as { caches?: unknown }).caches;
}

afterEach(() => {
  restoreLocation();
  removeServiceWorkerStub();
  removeCachesStub();
  delete (window as unknown as { PharmaTRACKAndroidKiosk?: unknown }).PharmaTRACKAndroidKiosk;
});

describe('native shell detection', () => {
  it('recognises every origin a packaged app can serve itself from', () => {
    for (const href of [
      'tauri://localhost/index.html',
      'https://tauri.localhost/index.html',
      'file:///opt/pharmatrack/index.html',
      'https://pharmatrack.appassets.androidplatform.net/index.html',
    ]) {
      setLocation(href);
      expect(isNativeShellOrigin(), href).toBe(true);
      expect(isNativeShell(), href).toBe(true);
    }
  });

  it('treats the real web app as the web app', () => {
    for (const href of [
      'https://rx-store-web.pages.dev/',
      'https://pharmatrack.example.com/index.html',
      'http://localhost:5173/',
    ]) {
      setLocation(href);
      expect(isNativeShellOrigin(), href).toBe(false);
      expect(isNativeShell(), href).toBe(false);
    }
  });

  it('still recognises the Android shell through its injected bridge', () => {
    setLocation('https://pharmatrack.example.com/');
    expect(isNativeShell()).toBe(false);
    (window as unknown as { PharmaTRACKAndroidKiosk?: unknown }).PharmaTRACKAndroidKiosk = {};
    expect(isNativeShell()).toBe(true);
  });
});

describe('service worker registration gate', () => {
  it('blocks registration in any native shell, not just Android', () => {
    const source = stripComments(read('src/pwa.ts'));
    expect(source).toContain('!isNativeShell()');
    // The Android-only guard was the bug: Windows passed it.
    expect(source).not.toContain('!hasAndroidNativeBridge()');
  });

  it('boots through a single entry point that purges instead of registering', () => {
    const main = stripComments(read('src/main.tsx'));
    expect(main).toContain('bootstrapPwa()');
    expect(main).not.toMatch(/\bvoid registerPwa\(\)/);

    const pwa = stripComments(read('src/pwa.ts'));
    expect(pwa).toMatch(/export async function bootstrapPwa/);
    expect(pwa).toMatch(/if \(isNativeShell\(\)\) \{\s*await purgeNativeShellServiceWorkers\(\);/);
  });

  it('reloads at most once after a purge so a controlled page cannot loop', () => {
    const pwa = stripComments(read('src/pwa.ts'));
    expect(pwa).toContain("'pharmatrack:native-sw-cleanup'");
    expect(pwa).toContain('reloadAlreadyAttempted()');
    expect(pwa).toContain('markReloadAttempted()');
  });
});

describe('service worker recovery helpers', () => {
  beforeEach(() => {
    setLocation('https://tauri.localhost/index.html');
  });

  it('unregisters every registration it finds', async () => {
    const first = { unregister: vi.fn(async () => true), update: vi.fn(), waiting: null };
    const second = { unregister: vi.fn(async () => true), update: vi.fn(), waiting: null };
    installServiceWorkerStub({ registrations: [first, second] as unknown as FakeRegistration[] });

    await expect(unregisterAllServiceWorkers()).resolves.toBe(true);
    expect(first.unregister).toHaveBeenCalled();
    expect(second.unregister).toHaveBeenCalled();
  });

  it('keeps going when one registration refuses to unregister', async () => {
    const broken = {
      unregister: vi.fn(async () => {
        throw new Error('nope');
      }),
      update: vi.fn(),
      waiting: null,
    };
    const good = { unregister: vi.fn(async () => true), update: vi.fn(), waiting: null };
    installServiceWorkerStub({ registrations: [broken, good] as unknown as FakeRegistration[] });

    await expect(unregisterAllServiceWorkers()).resolves.toBe(true);
    expect(good.unregister).toHaveBeenCalled();
  });

  it('deletes only the app shell caches and leaves user data alone', async () => {
    const { deleted } = installCachesStub([
      `${SHELL_CACHE_PREFIX}1.2.0`,
      `${SHELL_CACHE_PREFIX}1.1.0`,
      'pharmatrack-materials',
      'workbox-runtime',
    ]);

    await expect(deleteShellCaches()).resolves.toBe(true);
    expect(deleted).toEqual([`${SHELL_CACHE_PREFIX}1.2.0`, `${SHELL_CACHE_PREFIX}1.1.0`]);
  });

  it('removes the worker in a native shell instead of refreshing it', async () => {
    const registration = {
      unregister: vi.fn(async () => true),
      update: vi.fn(async () => undefined),
      waiting: null,
    };
    installServiceWorkerStub({ registrations: [registration] as unknown as FakeRegistration[] });
    installCachesStub([`${SHELL_CACHE_PREFIX}1.2.0`]);

    await recoverServiceWorker();

    expect(registration.unregister).toHaveBeenCalled();
    expect(registration.update).not.toHaveBeenCalled();
  });

  it('refreshes the worker on the web instead of removing it', async () => {
    setLocation('https://rx-store-web.pages.dev/');
    const postMessage = vi.fn();
    const registration = {
      unregister: vi.fn(async () => true),
      update: vi.fn(async () => undefined),
      waiting: { postMessage },
    };
    installServiceWorkerStub({ registrations: [registration] as unknown as FakeRegistration[] });

    await recoverServiceWorker();

    expect(registration.update).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(registration.unregister).not.toHaveBeenCalled();
  });

  it('does nothing at all where service workers do not exist', async () => {
    removeServiceWorkerStub();
    await expect(recoverServiceWorker()).resolves.toBeUndefined();
    await expect(unregisterAllServiceWorkers()).resolves.toBe(false);
  });
});

describe('chunk retry after a failed dynamic import', () => {
  it('reads the failing URL out of the error the webview reports', () => {
    const error = new TypeError(
      'Failed to fetch dynamically imported module: https://tauri.localhost/assets/CourseDetail-CH8k_Lo-.js',
    );
    expect(isChunkLoadError(error)).toBe(true);
    expect(chunkUrlFromError(error)).toBe(
      'https://tauri.localhost/assets/CourseDetail-CH8k_Lo-.js',
    );
  });

  it('reads it from the other engines too', () => {
    expect(
      chunkUrlFromError(
        new Error('error loading dynamically imported module: tauri://localhost/assets/Quiz-aB12.js'),
      ),
    ).toBe('tauri://localhost/assets/Quiz-aB12.js');
    expect(chunkUrlFromError(new Error('Unable to preload CSS for /assets/index-9f8.css'))).toBe(
      '/assets/index-9f8.css',
    );
  });

  it('returns nothing when the message carries no module URL', () => {
    expect(chunkUrlFromError(new Error('Something else went wrong'))).toBeNull();
    expect(chunkUrlFromError(null)).toBeNull();
  });

  it('retries under a unique URL, because the same specifier replays the rejection', () => {
    const busted = withCacheBust('https://tauri.localhost/assets/CourseDetail-CH8k_Lo-.js', 1700);
    expect(busted).toBe(
      'https://tauri.localhost/assets/CourseDetail-CH8k_Lo-.js?pharmatrack-retry=1700',
    );
    expect(withCacheBust('/assets/Quiz-aB12.js?v=2', 99)).toContain('pharmatrack-retry=99');
    expect(withCacheBust('/assets/Quiz-aB12.js?v=2', 99)).toContain('v=2');
  });

  it('wires that retry into the lazy route loader ahead of the reload', () => {
    const raw = read('src/utils/routeLoader.ts');
    const source = stripComments(raw);
    expect(source).toContain('retryChunkFromError');
    // The specifier is built at runtime, so Vite must leave it alone.
    expect(raw).toContain('@vite-ignore');
    expect(source.indexOf('retryChunkFromError<T>(secondError)')).toBeLessThan(
      source.indexOf('return recoverByReload()'),
    );
  });

  it('lets the error boundary Retry button clear the worker that caused it', () => {
    const source = stripComments(read('src/components/RouteErrorBoundary.tsx'));
    expect(source).toContain('recoverServiceWorker()');
    expect(source).toContain('window.location.reload()');
  });
});

describe('native side cleanup', () => {
  it('the desktop shell removes the worker itself, without trusting the bundle', () => {
    const rust = read('src-tauri/src/main.rs');
    expect(rust).toContain('const SHELL_SERVICE_WORKER_CLEANUP');
    expect(rust).toContain('navigator.serviceWorker.getRegistrations()');
    expect(rust).toContain("'pharmatrack-shell-'");
    expect(rust).toContain("'pharmatrack:native-sw-cleanup'");
    expect(rust).toContain('main_window.eval(SHELL_SERVICE_WORKER_CLEANUP)');
    // Also re-applied on every document, so a page served from a stale cache
    // cleans itself up instead of staying broken.
    expect(rust).toContain('.on_page_load(');
    expect(rust).toContain('PageLoadEvent::Finished');
  });

  it('the Android shell answers any surviving worker from the APK assets', () => {
    const activity = read('android/app/src/main/java/com/pharmatrack/app/MainActivity.kt');
    expect(activity).toContain('import androidx.webkit.ServiceWorkerControllerCompat');
    expect(activity).toContain('WebViewFeature.SERVICE_WORKER_BASIC_USAGE');
    expect(activity).toContain('setServiceWorkerClient');
    expect(activity).toContain('assetLoader.shouldInterceptRequest(request.url)');
    // The asset loader has to exist before it can be handed to the controller.
    expect(activity.indexOf('assetLoader = WebViewAssetLoader.Builder()')).toBeLessThan(
      activity.lastIndexOf('configureServiceWorkerAssetRouting()'),
    );
  });

  it('keeps the service worker working for the real web app', () => {
    const worker = read('public/sw.js');
    expect(worker).toContain('pharmatrack-shell-');
    expect(worker).toContain("request.mode === 'navigate'");
  });
});

describe('resume repaint recovery', () => {
  it('rebuilds the compositing layer rather than re-applying the same transform', () => {
    const source = stripComments(read('src/App.tsx'));
    expect(source).toContain("root.style.transform = 'none'");
    expect(source).toContain("root.style.transform = 'translateZ(0)'");
    expect(source).toContain("root.style.opacity = '0.999'");
    // Released on the frame after the repaint lands, not after a fixed delay.
    expect(source).toContain('requestAnimationFrame');
    expect(source).toContain('cancelAnimationFrame');
    // Opacity, not filter: a filter would make #root a containing block and
    // drag every fixed header out of place.
    expect(source).not.toContain("root.style.filter =");
  });

  it('still reloads as a last resort when the shell really is empty', () => {
    const source = stripComments(read('src/App.tsx'));
    expect(source).toContain('!root.childElementCount');
    expect(source).toContain('window.location.reload()');
  });
});
