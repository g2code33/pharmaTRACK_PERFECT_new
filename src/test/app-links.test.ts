import { describe, expect, it } from 'vitest';
import {
  androidIntentForRoute,
  appDeepLinkForRoute,
  appLaunchTargetForRoute,
  getQuickQuizRouteFromHref,
  pwaProtocolLinkForRoute,
  quickQuizRouteFromAnyText,
  routeFromPharmaTrackDeepLink,
} from '../utils/appLinks';

describe('app-first quick quiz links', () => {
  it('maps quick quiz routes to the custom app protocol used by installed apps', () => {
    expect(appDeepLinkForRoute('/q/AbC234xyz9')).toBe('pharmatrack://q/AbC234xyz9');
    expect(appDeepLinkForRoute('/quick-quiz?p=zPACK')).toBe('pharmatrack://quick-quiz?p=zPACK');
  });

  it('builds Android intent URLs with a web fallback for devices without the APK installed', () => {
    const intent = androidIntentForRoute(
      '/q/AbC234xyz9',
      'https://example.com/app/index.html#/q/AbC234xyz9',
    );
    expect(intent).toContain(
      'intent://q/AbC234xyz9#Intent;scheme=pharmatrack;package=com.pharmatrack.app;',
    );
    expect(intent).toContain(
      'S.browser_fallback_url=https%3A%2F%2Fexample.com%2Fapp%2Findex.html%23%2Fq%2FAbC234xyz9;end',
    );
  });

  it('chooses the Android APK intent target before the web fallback on Android browsers', () => {
    const fallback = 'https://pharmatrack-web.pages.dev/#/q/AbC234xyz9';
    const target = appLaunchTargetForRoute(
      '/q/AbC234xyz9',
      fallback,
      'Mozilla/5.0 (Linux; Android 14)',
    );

    expect(target).toBe(androidIntentForRoute('/q/AbC234xyz9', fallback));
    expect(target).toContain('package=com.pharmatrack.app');
    expect(target).toContain(`S.browser_fallback_url=${encodeURIComponent(fallback)};end`);
  });

  it('builds PWA protocol links that installed browser apps can claim', () => {
    const link = pwaProtocolLinkForRoute('/q/Short42');
    expect(link).toBe('web+pharmatrack:pharmatrack%3A%2F%2Fq%2FShort42');
    expect(routeFromPharmaTrackDeepLink(link)).toBe('/q/Short42');
  });

  it('extracts quick quiz routes from public web links and installed-app links', () => {
    expect(getQuickQuizRouteFromHref('https://pharmatrack-web.pages.dev/#/q/Short42')).toBe(
      '/q/Short42',
    );
    expect(
      getQuickQuizRouteFromHref('https://pharmatrack-web.pages.dev/#/quick-quiz?p=zPACK'),
    ).toBe('/quick-quiz?p=zPACK');
    expect(routeFromPharmaTrackDeepLink('pharmatrack://q/Short42')).toBe('/q/Short42');
    expect(routeFromPharmaTrackDeepLink('pharmatrack://quick-quiz?p=zPACK')).toBe(
      '/quick-quiz?p=zPACK',
    );
  });
});

describe('pasted quick quiz links resolved from search text', () => {
  it('accepts links copied from the web app, the desktop app and the APK', () => {
    expect(quickQuizRouteFromAnyText('https://pharmatrack-web.pages.dev/#/q/Short42')).toBe('/q/Short42');
    expect(quickQuizRouteFromAnyText('tauri://localhost/#/quick-quiz?p=zPACK')).toBe('/quick-quiz?p=zPACK');
    expect(quickQuizRouteFromAnyText('pharmatrack://q/Short42')).toBe('/q/Short42');
    expect(quickQuizRouteFromAnyText('web+pharmatrack:pharmatrack%3A%2F%2Fq%2FShort42')).toBe('/q/Short42');
  });

  it('accepts bare routes and links pasted inside a chat message', () => {
    expect(quickQuizRouteFromAnyText('/q/Short42')).toBe('/q/Short42');
    expect(quickQuizRouteFromAnyText('#/quick-quiz?p=zPACK')).toBe('/quick-quiz?p=zPACK');
    expect(
      quickQuizRouteFromAnyText('Try this quiz: https://pharmatrack-web.pages.dev/#/q/Short42 thanks!'),
    ).toBe('/q/Short42');
    expect(
      quickQuizRouteFromAnyText('(https://pharmatrack-web.pages.dev/#/q/Short42).'),
    ).toBe('/q/Short42');
  });

  it('ignores ordinary search words and unrelated links', () => {
    expect(quickQuizRouteFromAnyText('pharmacokinetics notes')).toBeNull();
    expect(quickQuizRouteFromAnyText('https://example.com/#/courses')).toBeNull();
    expect(quickQuizRouteFromAnyText('')).toBeNull();
  });
});
