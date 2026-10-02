import { hasAndroidNativeBridge, isPWAStandalone, isTauriRuntime } from '../platform/runtime';

const PHARMATRACK_PROTOCOL = 'pharmatrack';
const ANDROID_PACKAGE_NAME = 'com.pharmatrack.app';
const DEFAULT_WEB_FALLBACK = 'https://pharmatrack-web.pages.dev/#/';

/** Public store page used by every "Get app" action across the product. */
export const APP_STORE_URL = 'https://rx-store-web.pages.dev/app/pharmatrack';

/**
 * A quick quiz the user asked to continue inside the installed app. Browsers
 * and installed PWAs share storage on Android and desktop, so the app can pick
 * the quiz up on its next launch even when the OS cannot hand the link over.
 */
const PENDING_QUICK_QUIZ_KEY = 'pharmatrack:pending-quick-quiz';
const PENDING_QUICK_QUIZ_TTL_MS = 30 * 60 * 1000;

// A shared course link is handled exactly like a shared quiz link: it opens
// the installed app first and only falls back to the web.
const QUICK_QUIZ_ROUTE_PREFIXES = ['/quick-quiz', '/q/', '/quick-course'];

const normalizeRoute = (route: string): string => {
  const trimmed = route.trim();
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

const isQuickQuizRoute = (route: string): boolean => {
  const normalized = normalizeRoute(route);
  return QUICK_QUIZ_ROUTE_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix),
  );
};

export const shouldUseAndroidApkIntent = (userAgent?: string): boolean => {
  const agent = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent || '');
  return /android/i.test(agent);
};

/**
 * iOS cannot launch an installed Home Screen app from a link, and unknown
 * custom schemes raise a Safari error dialog. Detect it so those attempts are
 * replaced with a working copy-and-paste handoff instead.
 */
export const isAppleMobileBrowser = (userAgent?: string, maxTouchPoints?: number): boolean => {
  const agent = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent || '');
  if (/iphone|ipad|ipod/i.test(agent)) return true;
  const touchPoints =
    maxTouchPoints ?? (typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints || 0);
  return /macintosh/i.test(agent) && touchPoints > 1;
};

export const rememberPendingQuickQuiz = (route: string): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      PENDING_QUICK_QUIZ_KEY,
      JSON.stringify({ route: normalizeRoute(route), at: Date.now() }),
    );
  } catch {
    // Private browsing or a full quota must never break the quiz link itself.
  }
};

export const clearPendingQuickQuiz = (): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PENDING_QUICK_QUIZ_KEY);
  } catch {
    // Ignore storage failures.
  }
};

export const readPendingQuickQuiz = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PENDING_QUICK_QUIZ_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { route?: string; at?: number };
    const route = typeof parsed.route === 'string' ? parsed.route : '';
    const at = typeof parsed.at === 'number' ? parsed.at : 0;
    if (!route || !isQuickQuizRoute(route) || Date.now() - at > PENDING_QUICK_QUIZ_TTL_MS) {
      clearPendingQuickQuiz();
      return null;
    }
    return normalizeRoute(route);
  } catch {
    return null;
  }
};

export const consumePendingQuickQuiz = (): string | null => {
  const route = readPendingQuickQuiz();
  if (route) clearPendingQuickQuiz();
  return route;
};

const safeEncodeParam = (value: string): string => encodeURIComponent(value).replace(/'/g, '%27');

export const getQuickQuizRouteFromHref = (href: string): string | null => {
  try {
    const url = new URL(href);
    if (url.protocol === `${PHARMATRACK_PROTOCOL}:`) {
      const route = routeFromPharmaTrackDeepLink(href);
      return route && isQuickQuizRoute(route) ? route : null;
    }

    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
    if (hash) {
      const normalizedHash = normalizeRoute(hash);
      return isQuickQuizRoute(normalizedHash) ? normalizedHash : null;
    }

    const pathRoute = `${url.pathname}${url.search}`;
    const normalizedPath = normalizeRoute(pathRoute);
    return isQuickQuizRoute(normalizedPath) ? normalizedPath : null;
  } catch {
    return null;
  }
};

const trimPastedLinkToken = (value: string): string =>
  value.trim().replace(/^[<({["']+/, '').replace(/[>)}\]"'.,;]+$/, '');

export const quickQuizRouteFromAnyText = (value: string): string | null => {
  const text = value.trim();
  if (!text) return null;

  const directRoute = text.startsWith('#') ? text.slice(1) : text;
  const normalizedDirectRoute = normalizeRoute(directRoute);
  if (isQuickQuizRoute(normalizedDirectRoute)) return normalizedDirectRoute;

  const candidates = [
    text,
    ...Array.from(text.matchAll(/(?:https?:\/\/|tauri:\/\/|pharmatrack:\/\/|web\+pharmatrack:)[^\s<>'"]+/gi), (match) => match[0]),
  ];

  for (const candidate of candidates) {
    const cleaned = trimPastedLinkToken(candidate);
    const route = getQuickQuizRouteFromHref(cleaned) || routeFromPharmaTrackDeepLink(cleaned);
    if (route && isQuickQuizRoute(route)) return route;
  }

  return null;
};

export const appDeepLinkForRoute = (route: string): string => {
  const normalized = normalizeRoute(route);
  const [pathPart, queryPart = ''] = normalized.split('?');
  const query = queryPart ? `?${queryPart}` : '';

  if (pathPart === '/quick-quiz') {
    return `${PHARMATRACK_PROTOCOL}://quick-quiz${query}`;
  }

  if (pathPart.startsWith('/q/')) {
    const codePath = pathPart.slice('/q'.length);
    return `${PHARMATRACK_PROTOCOL}://q${codePath}${query}`;
  }

  return `${PHARMATRACK_PROTOCOL}://open?route=${safeEncodeParam(normalized)}`;
};

export const webFallbackForRoute = (route: string, href?: string): string => {
  if (href) {
    try {
      const url = new URL(href);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    } catch {
      // Fall back to the public web app below.
    }
  }
  return `https://pharmatrack-web.pages.dev/#${normalizeRoute(route)}`;
};

export const androidIntentForRoute = (route: string, fallbackHref?: string): string => {
  const deepLink = new URL(appDeepLinkForRoute(route));
  const hostAndPath = `${deepLink.hostname}${deepLink.pathname}${deepLink.search}`;
  const fallback = webFallbackForRoute(route, fallbackHref);
  return `intent://${hostAndPath}#Intent;scheme=${PHARMATRACK_PROTOCOL};package=${ANDROID_PACKAGE_NAME};S.browser_fallback_url=${safeEncodeParam(fallback)};end`;
};

export const pwaProtocolLinkForRoute = (route: string): string =>
  `web+pharmatrack:${safeEncodeParam(appDeepLinkForRoute(route))}`;

export const appLaunchTargetForRoute = (
  route: string,
  fallbackHref?: string,
  userAgent?: string,
): string =>
  shouldUseAndroidApkIntent(userAgent)
    ? androidIntentForRoute(route, fallbackHref)
    : appDeepLinkForRoute(route);

export const routeFromPharmaTrackDeepLink = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol === `${PHARMATRACK_PROTOCOL}:`) {
      const host = url.hostname;
      const query = url.search;

      if (host === 'quick-quiz') return `/quick-quiz${query}`;
      if (host === 'q') return normalizeRoute(`/q${url.pathname}${query}`);
      if (host === 'open') return normalizeRoute(url.searchParams.get('route') || '/');

      const pathRoute = normalizeRoute(`${url.pathname}${query}`);
      return pathRoute === '/' ? null : pathRoute;
    }

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
      return hash ? normalizeRoute(hash) : null;
    }

    if (url.protocol === 'web+pharmatrack:') {
      const embedded = decodeURIComponent(value.replace(/^web\+pharmatrack:/i, ''));
      return routeFromPharmaTrackDeepLink(embedded);
    }
  } catch {
    return null;
  }

  return null;
};

export const openRouteInInstalledApp = (
  route: string,
  options: { fallbackHref?: string; automatic?: boolean } = {},
): string | null => {
  const fallback =
    options.fallbackHref ||
    (typeof window !== 'undefined' ? window.location.href : DEFAULT_WEB_FALLBACK);
  const target = appLaunchTargetForRoute(route, fallback);
  const pwaTarget = pwaProtocolLinkForRoute(route);

  if (typeof window === 'undefined' || typeof document === 'undefined') return target;

  // The quiz is remembered first: if the OS cannot hand the link over, the
  // installed app still finds it on its next launch.
  if (isQuickQuizRoute(route)) rememberPendingQuickQuiz(route);

  // iOS never launches an installed Home Screen app from a link, and unknown
  // schemes raise a Safari error sheet. Callers handle iOS with an explicit
  // copy-and-paste handoff instead of a launch attempt that cannot work.
  if (isAppleMobileBrowser()) return null;

  if (shouldUseAndroidApkIntent()) {
    window.location.href = target;
    return target;
  }

  const openHiddenProtocol = (url: string, removeAfter = 1600) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.position = 'absolute';
    frame.style.left = '-9999px';
    frame.style.width = '1px';
    frame.style.height = '1px';
    frame.src = url;
    document.body.appendChild(frame);
    window.setTimeout(() => frame.remove(), removeAfter);
  };

  if (options.automatic) {
    openHiddenProtocol(target);
    window.setTimeout(() => openHiddenProtocol(pwaTarget), 150);
    return target;
  }

  const link = document.createElement('a');
  link.href = target;
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => link.remove(), 1000);

  // Installed PWAs claim web+pharmatrack: through the manifest protocol
  // handler, and only a top-level navigation hands the launch over. That
  // navigation is used exclusively when the browser confirms the PWA is
  // installed, so browsers without the app never land on a protocol error.
  window.setTimeout(() => {
    if (document.visibilityState === 'hidden') return;
    void isInstalledPwaDetected().then((installed) => {
      if (document.visibilityState === 'hidden') return;
      if (installed === true) {
        window.location.href = pwaTarget;
        return;
      }
      if (installed === null) openHiddenProtocol(pwaTarget);
    });
  }, 700);
  return target;
};

/**
 * `true`/`false` when the browser can answer whether this PWA is installed,
 * `null` when the browser has no way to tell.
 */
export const isInstalledPwaDetected = async (): Promise<boolean | null> => {
  if (typeof navigator === 'undefined') return null;
  const getInstalledRelatedApps = (navigator as Navigator & {
    getInstalledRelatedApps?: () => Promise<Array<{ platform?: string; id?: string }>>;
  }).getInstalledRelatedApps;
  if (typeof getInstalledRelatedApps !== 'function') return null;
  try {
    const apps = await getInstalledRelatedApps.call(navigator);
    return Array.isArray(apps) ? apps.some((app) => app?.platform === 'webapp') : false;
  } catch {
    return null;
  }
};

export const openCurrentQuickQuizInInstalledApp = (automatic = false): string | null => {
  if (typeof window === 'undefined') return null;
  const route = getQuickQuizRouteFromHref(window.location.href);
  if (!route) return null;
  return openRouteInInstalledApp(route, { fallbackHref: window.location.href, automatic });
};

/** True when this page is already running inside an installed PharmaTRACK app. */
export const isRunningInsideInstalledApp = (): boolean => {
  if (typeof window === 'undefined') return false;
  return isTauriRuntime() || hasAndroidNativeBridge() || isPWAStandalone();
};

export type AppLaunchOutcome = 'already-in-app' | 'installed-app' | 'store';

const clickHiddenLink = (href: string): void => {
  const link = document.createElement('a');
  link.href = href;
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => link.remove(), 1000);
};

/**
 * Resolves `true` as soon as the OS hands the window over to another app (the
 * page is hidden or loses focus), and `false` when nothing claimed the link.
 */
const waitForInstalledAppTakeover = (timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (launched: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onLeft);
      window.removeEventListener('pagehide', onLeft);
      resolve(launched);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') finish(true);
    };
    const onLeft = () => finish(true);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onLeft);
    window.addEventListener('pagehide', onLeft);
  });

/**
 * "Get app" behaviour for every platform: try the copy of PharmaTRACK already
 * installed on this device first — Android APK, Windows EXE, Linux DEB or an
 * installed PWA — and only send the user to the public store page when nothing
 * on the device claims the link. The store page serves all of those builds, so
 * it is the final fallback rather than the first stop.
 */
export const openInstalledAppOrStore = async (
  route = '/',
  options: {
    storeUrl?: string;
    timeoutMs?: number;
    /** Top-level navigation that hands the launch to the installed app. */
    navigate?: (url: string) => void;
    /** How a desktop install is pinged; a hidden link keeps error pages away. */
    pingInstalledApp?: (url: string) => void;
    /** How the store page is opened once nothing on the device answered. */
    openStore?: (url: string) => void;
  } = {},
): Promise<AppLaunchOutcome> => {
  const storeUrl = options.storeUrl || APP_STORE_URL;
  const timeoutMs = options.timeoutMs ?? 1200;

  if (typeof window === 'undefined' || typeof document === 'undefined') return 'store';

  const navigate = options.navigate || ((url: string) => {
    window.location.href = url;
  });
  const pingInstalledApp = options.pingInstalledApp || clickHiddenLink;
  const goToStore = () => {
    if (options.openStore) {
      options.openStore(storeUrl);
      return;
    }
    const opened = window.open(storeUrl, '_blank', 'noopener,noreferrer');
    if (!opened) window.location.href = storeUrl;
  };

  // Already inside the installed app — there is nothing to download, so stay
  // where the user is instead of bouncing them out to a store page.
  if (isRunningInsideInstalledApp()) return 'already-in-app';

  // The installed app finds the quiz on its next launch even when the OS
  // refuses to hand the link over.
  if (isQuickQuizRoute(route)) rememberPendingQuickQuiz(route);

  // iPhone and iPad cannot launch an installed app from a link, and unknown
  // schemes only raise a Safari error sheet, so the store page is the one
  // place that can actually help there.
  if (isAppleMobileBrowser()) {
    goToStore();
    return 'store';
  }

  // Android decides this natively: the intent opens the installed APK, and
  // Android itself follows the fallback URL to the store when it is missing.
  if (shouldUseAndroidApkIntent()) {
    navigate(androidIntentForRoute(route, storeUrl));
    return 'installed-app';
  }

  // An installed PWA claims web+pharmatrack: through the manifest, but only a
  // top-level navigation hands the launch over, so it is used exclusively when
  // the browser confirms the app is installed.
  if ((await isInstalledPwaDetected()) === true) {
    navigate(pwaProtocolLinkForRoute(route));
    return 'installed-app';
  }

  // Windows EXE and Linux DEB installs register the pharmatrack: scheme.
  const takeover = waitForInstalledAppTakeover(timeoutMs);
  pingInstalledApp(appDeepLinkForRoute(route));
  if (await takeover) return 'installed-app';

  goToStore();
  return 'store';
};

/**
 * Ask the browser to let this installed PWA own `web+pharmatrack:` links, so a
 * quick quiz opened anywhere can be handed to the installed app window.
 */
export const registerQuickQuizProtocolHandler = (): boolean => {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const register = (navigator as Navigator & {
    registerProtocolHandler?: (scheme: string, url: string) => void;
  }).registerProtocolHandler;
  if (typeof register !== 'function') return false;
  try {
    register.call(navigator, 'web+pharmatrack', `${window.location.origin}/#/app-link?url=%s`);
    return true;
  } catch {
    return false;
  }
};
