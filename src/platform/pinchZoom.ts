/**
 * Two-finger zoom for surfaces that own their own scale.
 *
 * Turning off browser zoom in the installed app (see zoomGuard.ts) would, on
 * its own, leave a phone user with no way to magnify a dense slide or a
 * scanned page — it would trade one annoyance for a worse one. So the readers
 * implement the gesture properly instead: pinching a document zooms the
 * document, the toolbar stays put, and the point you pinched stays under your
 * fingers.
 *
 * The anchoring is the part that makes it feel real rather than merely
 * present. Scaling content without it drags whatever you were looking at off
 * towards a corner, because the scroll offset is measured from the top-left
 * and everything below grows away from it.
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { APP_ZOOM_ATTRIBUTE, PINCHING_CLASS } from './zoomGuard';

export type PinchAnchor = {
  /** Midpoint of the two fingers, relative to the scroller's visible box. */
  x: number;
  y: number;
  /** Scroll offsets when the gesture started. */
  scrollLeft: number;
  scrollTop: number;
};

export type PinchZoomHandlers = {
  /** Multiplicative change since the gesture started: 1 is no change. */
  onZoom: (scale: number) => void;
  onStart?: (anchor: PinchAnchor) => void;
  onEnd?: () => void;
};

/** Fingers must separate by this much before it counts as a zoom, not a tap. */
const MIN_START_DISTANCE = 24;

const distanceBetween = (a: Touch, b: Touch): number =>
  Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

/**
 * Keeps the pinched point under the fingers after the content has been
 * rescaled. Call from a layout effect, once the new scale has been painted.
 *
 * The content is uniformly scaled, so the distance from the content origin to
 * the anchor grows by exactly `ratio`; subtracting the anchor's position
 * within the viewport converts that back into a scroll offset.
 */
export function keepPinchAnchor(el: HTMLElement, anchor: PinchAnchor, ratio: number): void {
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  el.scrollLeft = (anchor.scrollLeft + anchor.x) * ratio - anchor.x;
  el.scrollTop = (anchor.scrollTop + anchor.y) * ratio - anchor.y;
}

export function attachPinchZoom(el: HTMLElement, handlers: PinchZoomHandlers): () => void {
  let startDistance = 0;
  let active = false;

  const stop = () => {
    if (!active) return;
    active = false;
    startDistance = 0;
    el.classList.remove(PINCHING_CLASS);
    handlers.onEnd?.();
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 2) {
      stop();
      return;
    }
    const [a, b] = [event.touches[0], event.touches[1]];
    const separation = distanceBetween(a, b);
    if (separation < MIN_START_DISTANCE) return;

    const box = el.getBoundingClientRect();
    startDistance = separation;
    active = true;
    // While a pinch is in flight the browser must not also scroll the
    // surface. An ancestor's touch-action cannot widen this, only narrow it
    // further, so setting it here is enough.
    el.classList.add(PINCHING_CLASS);
    handlers.onStart?.({
      x: (a.clientX + b.clientX) / 2 - box.left,
      y: (a.clientY + b.clientY) / 2 - box.top,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    });
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!active) return;
    if (event.touches.length !== 2) {
      stop();
      return;
    }
    if (event.cancelable) event.preventDefault();
    const next = distanceBetween(event.touches[0], event.touches[1]);
    if (startDistance <= 0) return;
    handlers.onZoom(next / startDistance);
  };

  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: false });
  el.addEventListener('touchend', stop, { passive: true });
  el.addEventListener('touchcancel', stop, { passive: true });

  return () => {
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('touchmove', onTouchMove);
    el.removeEventListener('touchend', stop);
    el.removeEventListener('touchcancel', stop);
    el.classList.remove(PINCHING_CLASS);
  };
}

/**
 * React binding. Handlers are read through a ref so that a consumer passing
 * fresh closures every render does not detach and reattach the listeners
 * mid-gesture.
 */
export function usePinchZoom(
  ref: RefObject<HTMLElement | null>,
  handlers: PinchZoomHandlers,
  enabled = true,
): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    el.setAttribute(APP_ZOOM_ATTRIBUTE, '');
    const detach = attachPinchZoom(el, {
      onZoom: (scale) => latest.current.onZoom(scale),
      onStart: (anchor) => latest.current.onStart?.(anchor),
      onEnd: () => latest.current.onEnd?.(),
    });
    return () => {
      detach();
      el.removeAttribute(APP_ZOOM_ATTRIBUTE);
    };
  }, [ref, enabled]);
}
