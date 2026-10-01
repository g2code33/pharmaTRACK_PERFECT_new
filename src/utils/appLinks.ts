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

const QUICK_QUIZ_ROUTE_PREFIXES = ['/quick-quiz', '/q/'];

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
  // handler. A top-level navigation is what actually hands the launch over —
  // hidden frames are blocked by Chromium for protocol handlers.
  window.setTimeout(() => {
    if (document.visibilityState === 'hidden') return;
    try {
      window.location.href = pwaTarget;
    } catch {
      openHiddenProtocol(pwaTarget);
    }
  }, 700);
  return target;
};

export const openCurrentQuickQuizInInstalledApp = (automatic = false): string | null => {
  if (typeof window === 'undefined') return null;
  const route = getQuickQuizRouteFromHref(window.location.href);
  if (!route) return null;
  return openRouteInInstalledApp(route, { fallbackHref: window.location.href, automatic });
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
