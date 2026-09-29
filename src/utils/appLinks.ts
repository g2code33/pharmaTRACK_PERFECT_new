const PHARMATRACK_PROTOCOL = 'pharmatrack';
const ANDROID_PACKAGE_NAME = 'com.pharmatrack.app';
const DEFAULT_WEB_FALLBACK = 'https://pharmatrack-web.pages.dev/#/';

const QUICK_QUIZ_ROUTE_PREFIXES = ['/quick-quiz', '/q/'];

const normalizeRoute = (route: string): string => {
  const trimmed = route.trim();
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

const isQuickQuizRoute = (route: string): boolean => {
  const normalized = normalizeRoute(route);
  return QUICK_QUIZ_ROUTE_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(prefix));
};

const isAndroidBrowser = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /android/i.test(navigator.userAgent || '');
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

export const pwaProtocolLinkForRoute = (route: string): string => (
  `web+pharmatrack:${safeEncodeParam(appDeepLinkForRoute(route))}`
);

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
): string => {
  const fallback = options.fallbackHref || (typeof window !== 'undefined' ? window.location.href : DEFAULT_WEB_FALLBACK);
  const target = isAndroidBrowser() ? androidIntentForRoute(route, fallback) : appDeepLinkForRoute(route);
  const pwaTarget = pwaProtocolLinkForRoute(route);

  if (typeof window === 'undefined' || typeof document === 'undefined') return target;

  if (isAndroidBrowser()) {
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
  window.setTimeout(() => openHiddenProtocol(pwaTarget), 150);
  return target;
};

export const openCurrentQuickQuizInInstalledApp = (automatic = false): string | null => {
  if (typeof window === 'undefined') return null;
  const route = getQuickQuizRouteFromHref(window.location.href);
  if (!route) return null;
  return openRouteInInstalledApp(route, { fallbackHref: window.location.href, automatic });
};
