/**
 * An installed app does not zoom the way a web page zooms.
 *
 * Pinching a native app zooms the thing under your fingers — a photo, a map,
 * a document page — and never the furniture around it. Pinching a web page
 * scales the whole viewport instead: the header slides off the top, the
 * bottom navigation ends up somewhere in the middle of the screen, and the
 * only way back is a pinch that lands exactly on 100%. In an installed PWA
 * that is the single loudest tell that the "app" is a website in a costume,
 * and it is easy to trigger by accident while scrolling with two thumbs.
 *
 * So browser zoom is switched off — but only where the app really is
 * installed: a standalone PWA, the Android APK, the desktop window. In an
 * ordinary browser tab the page stays fully zoomable, because there pinch
 * and ctrl+wheel are legitimate accessibility affordances that belong to the
 * user, not to us.
 *
 * Nothing here takes away a gesture the app itself implements. One finger is
 * never a zoom, so scrolling, swiping, dragging, long-press and text
 * selection are untouched. Anything that owns its own zoom marks itself with
 * `data-app-zoom`, and every zoom gesture inside it is handed straight
 * through — that is how the document readers keep pinch-to-zoom and
 * ctrl+wheel while the shell around them stays exactly where it was put.
 */
import { isNativeShell, isPWAStandalone } from './runtime';

/** Set on <html> while browser zoom is suppressed. See index.css. */
export const ZOOM_LOCK_CLASS = 'pharmatrack-zoom-locked';

/** Marks a surface that implements zooming itself. */
export const APP_ZOOM_ATTRIBUTE = 'data-app-zoom';

/** Added to a surface for the duration of one of its own pinch gestures. */
export const PINCHING_CLASS = 'is-pinching';

const APP_VIEWPORT =
  'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

const ZOOM_KEYS = new Set(['+', '=', '-', '_', '0']);

/**
 * True in a standalone PWA, the Android shell and the desktop window; false in
 * a browser tab, where the user's zoom is the user's business.
 */
export function shouldLockBrowserZoom(): boolean {
  if (typeof window === 'undefined') return false;
  return isPWAStandalone() || isNativeShell();
}

function ownsItsZoom(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return target.closest(`[${APP_ZOOM_ATTRIBUTE}]`) !== null;
}

let installed = false;

/**
 * Suppresses browser zoom for the installed app. Safe to call more than once
 * and a no-op in a browser tab. Returns a cleanup function, which exists for
 * tests more than for the app — the real app installs this for its lifetime.
 */
export function installAppZoomGuard(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  if (installed || !shouldLockBrowserZoom()) return () => undefined;
  installed = true;

  const meta = document.querySelector('meta[name="viewport"]');
  const previousViewport = meta?.getAttribute('content') ?? null;
  // The markup ships the accessible viewport, so a browser tab keeps zoom even
  // though this file is in the same bundle. Only the installed app rewrites it.
  meta?.setAttribute('content', APP_VIEWPORT);
  document.documentElement.classList.add(ZOOM_LOCK_CLASS);

  // iOS Safari drives page zoom with its own non-standard gesture events and
  // has historically ignored `user-scalable=no`, so refusing these is the only
  // thing that actually stops a pinch there.
  const onGesture = (event: Event) => {
    if (ownsItsZoom(event.target)) return;
    if (event.cancelable) event.preventDefault();
  };

  // A second finger outside a zoomable surface can only be a page pinch:
  // touch devices have no two-finger scroll. One finger is left completely
  // alone, which is what keeps every other gesture in the app working.
  const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length < 2) return;
    if (ownsItsZoom(event.target)) return;
    if (event.cancelable) event.preventDefault();
  };

  // ctrl/⌘ + wheel is a trackpad pinch and a mouse-wheel zoom.
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    if (ownsItsZoom(event.target)) return;
    if (event.cancelable) event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    if (event.altKey || !ZOOM_KEYS.has(event.key)) return;
    event.preventDefault();
  };

  // Capture phase, so a page that stops propagation cannot accidentally let a
  // zoom through; non-passive, because the whole point is to call
  // preventDefault.
  const options: AddEventListenerOptions = { passive: false, capture: true };
  window.addEventListener('gesturestart', onGesture, options);
  window.addEventListener('gesturechange', onGesture, options);
  window.addEventListener('gestureend', onGesture, options);
  window.addEventListener('touchmove', onTouchMove, options);
  window.addEventListener('wheel', onWheel, options);
  window.addEventListener('keydown', onKeyDown, options);

  return () => {
    window.removeEventListener('gesturestart', onGesture, options);
    window.removeEventListener('gesturechange', onGesture, options);
    window.removeEventListener('gestureend', onGesture, options);
    window.removeEventListener('touchmove', onTouchMove, options);
    window.removeEventListener('wheel', onWheel, options);
    window.removeEventListener('keydown', onKeyDown, options);
    document.documentElement.classList.remove(ZOOM_LOCK_CLASS);
    if (previousViewport !== null) meta?.setAttribute('content', previousViewport);
    installed = false;
  };
}

/** Test seam: forgets that the guard was installed. */
export function resetAppZoomGuardForTests(): void {
  installed = false;
}
