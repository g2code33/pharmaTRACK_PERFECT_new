import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  APP_STORE_URL,
  clearPendingQuickQuiz,
  consumePendingQuickQuiz,
  isAppleMobileBrowser,
  isInstalledPwaDetected,
  isRunningInsideInstalledApp,
  openInstalledAppOrStore,
  openRouteInInstalledApp,
  readPendingQuickQuiz,
  rememberPendingQuickQuiz,
} from '../utils/appLinks';

const quickQuiz = fs.readFileSync(path.resolve(__dirname, '../pages/QuickQuiz.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');

afterEach(() => {
  clearPendingQuickQuiz();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('downloading PharmaTRACK', () => {
  it('sends every "get app" action to the Rx store listing', () => {
    expect(APP_STORE_URL).toBe('https://rx-store-web.pages.dev/app/pharmatrack');
    expect(quickQuiz).toContain('href={APP_STORE_URL}');
    expect(quickQuiz).not.toContain('github.com/g2code33/pharmaTRACK_PERFECT_new/releases/latest');
  });

  it('wires the "get app" buttons through the installed-app-first launcher', () => {
    expect(quickQuiz).toContain('const handleGetApp = (event: ReactMouseEvent<HTMLAnchorElement>)');
    expect(quickQuiz).toContain('void openInstalledAppOrStore(route)');
    expect(quickQuiz).toContain('onClick={handleGetApp}');
    expect(quickQuiz.match(/onClick=\{handleGetApp\}/g)?.length).toBe(2);
  });
});

const stubBrowser = (userAgent: string, extra: Record<string, unknown> = {}) => {
  vi.stubGlobal('navigator', {
    userAgent,
    maxTouchPoints: 0,
    ...extra,
  } as unknown as Navigator);
};

describe('"get app" opens the installed app before the store', () => {
  it('stays put when the page already runs inside the installed app', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const openStore = vi.fn();
    const navigate = vi.fn();
    expect(isRunningInsideInstalledApp()).toBe(true);
    await expect(
      openInstalledAppOrStore('/q/Short42', { openStore, navigate, timeoutMs: 5 }),
    ).resolves.toBe('already-in-app');
    expect(openStore).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('lets Android hand the link to the installed APK, with the store as the OS fallback', async () => {
    stubBrowser('Mozilla/5.0 (Linux; Android 14) Chrome/120');
    const navigate = vi.fn();
    const openStore = vi.fn();
    await expect(
      openInstalledAppOrStore('/q/Short42', { navigate, openStore, timeoutMs: 5 }),
    ).resolves.toBe('installed-app');
    const target = navigate.mock.calls[0][0] as string;
    expect(target.startsWith('intent://q/Short42')).toBe(true);
    expect(target).toContain('package=com.pharmatrack.app');
    expect(target).toContain(`S.browser_fallback_url=${encodeURIComponent(APP_STORE_URL)}`);
    expect(openStore).not.toHaveBeenCalled();
    expect(readPendingQuickQuiz()).toBe('/q/Short42');
  });

  it('hands the launch to a confirmed installed PWA instead of the store', async () => {
    stubBrowser('Mozilla/5.0 (X11; Linux x86_64) Chrome/120', {
      getInstalledRelatedApps: async () => [{ platform: 'webapp', id: 'pharmatrack' }],
    });
    const navigate = vi.fn();
    const openStore = vi.fn();
    await expect(
      openInstalledAppOrStore('/q/Short42', { navigate, openStore, timeoutMs: 5 }),
    ).resolves.toBe('installed-app');
    expect(navigate).toHaveBeenCalledWith('web+pharmatrack:pharmatrack%3A%2F%2Fq%2FShort42');
    expect(openStore).not.toHaveBeenCalled();
  });

  it('pings an installed desktop build first and keeps the store unopened when it answers', async () => {
    stubBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120');
    const openStore = vi.fn();
    const pingInstalledApp = vi.fn(() => {
      // Windows and Linux installs steal the window focus when they launch.
      window.dispatchEvent(new Event('blur'));
    });
    await expect(
      openInstalledAppOrStore('/q/Short42', { openStore, pingInstalledApp, timeoutMs: 50 }),
    ).resolves.toBe('installed-app');
    expect(pingInstalledApp).toHaveBeenCalledWith('pharmatrack://q/Short42');
    expect(openStore).not.toHaveBeenCalled();
  });

  it('falls back to the Rx store page only when nothing on the device answers', async () => {
    stubBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120');
    const openStore = vi.fn();
    const pingInstalledApp = vi.fn();
    await expect(
      openInstalledAppOrStore('/q/Short42', { openStore, pingInstalledApp, timeoutMs: 20 }),
    ).resolves.toBe('store');
    expect(pingInstalledApp).toHaveBeenCalledWith('pharmatrack://q/Short42');
    expect(openStore).toHaveBeenCalledWith(APP_STORE_URL);
  });

  it('sends iPhone and iPad straight to the store, because no link can launch their app', async () => {
    stubBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/605.1.15', {
      maxTouchPoints: 5,
    });
    const openStore = vi.fn();
    const pingInstalledApp = vi.fn();
    await expect(
      openInstalledAppOrStore('/q/Short42', { openStore, pingInstalledApp, timeoutMs: 20 }),
    ).resolves.toBe('store');
    expect(pingInstalledApp).not.toHaveBeenCalled();
    expect(openStore).toHaveBeenCalledWith(APP_STORE_URL);
  });
});

describe('quick quiz handoff into an installed app', () => {
  it('remembers the quiz so the installed app can claim it on its next launch', () => {
    rememberPendingQuickQuiz('/q/Short42');
    expect(readPendingQuickQuiz()).toBe('/q/Short42');
    expect(consumePendingQuickQuiz()).toBe('/q/Short42');
    expect(readPendingQuickQuiz()).toBeNull();
  });

  it('ignores stale or non-quiz pending routes', () => {
    window.localStorage.setItem(
      'pharmatrack:pending-quick-quiz',
      JSON.stringify({ route: '/q/Expired', at: Date.now() - 60 * 60 * 1000 }),
    );
    expect(readPendingQuickQuiz()).toBeNull();

    window.localStorage.setItem(
      'pharmatrack:pending-quick-quiz',
      JSON.stringify({ route: '/courses', at: Date.now() }),
    );
    expect(readPendingQuickQuiz()).toBeNull();
  });

  it('detects Apple mobile browsers, including iPadOS desktop user agents', () => {
    expect(isAppleMobileBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)')).toBe(true);
    expect(isAppleMobileBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true);
    expect(isAppleMobileBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false);
    expect(isAppleMobileBrowser('Mozilla/5.0 (Linux; Android 14)')).toBe(false);
  });

  it('never fires an impossible app launch on iPhone, but still saves the quiz', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/605.1.15',
      maxTouchPoints: 5,
    } as unknown as Navigator);

    expect(openRouteInInstalledApp('/q/Short42', { fallbackHref: 'https://example.com/#/q/Short42' })).toBeNull();
    expect(readPendingQuickQuiz()).toBe('/q/Short42');
  });
});

describe('installed PWA detection', () => {
  it('reports an installed PWA when the browser can confirm it', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120',
      getInstalledRelatedApps: async () => [{ platform: 'webapp', id: 'pharmatrack' }],
    } as unknown as Navigator);
    await expect(isInstalledPwaDetected()).resolves.toBe(true);
  });

  it('reports no installed PWA when the browser says so', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120',
      getInstalledRelatedApps: async () => [],
    } as unknown as Navigator);
    await expect(isInstalledPwaDetected()).resolves.toBe(false);
  });

  it('stays undecided on browsers without the capability instead of guessing', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/126',
    } as unknown as Navigator);
    await expect(isInstalledPwaDetected()).resolves.toBeNull();
  });
});

describe('installed app launch experience', () => {
  it('offers an iPhone copy-and-paste handoff instead of a dead "open in app" button', () => {
    expect(quickQuiz).toContain('const needsAppleHandoff = showWebAppCta && runtime.isIOS;');
    expect(quickQuiz).toContain('setAppleHandoffOpen(true);');
    expect(quickQuiz).toContain('Open this quiz in your PharmaTRACK app');
    expect(quickQuiz).toContain('Copy quiz link');
    expect(quickQuiz).toContain('Open PharmaTRACK from your Home Screen');
    expect(quickQuiz).toContain('rememberPendingQuickQuiz(route)');
  });

  it('claims a pending quiz when the installed app or PWA starts', () => {
    expect(app).toContain('const PendingQuickQuizLauncher');
    expect(app).toContain('consumePendingQuickQuiz()');
    expect(app).toContain('registerQuickQuizProtocolHandler()');
    expect(app).toContain('<PendingQuickQuizLauncher />');
  });
});
