import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  APP_STORE_URL,
  clearPendingQuickQuiz,
  consumePendingQuickQuiz,
  isAppleMobileBrowser,
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
