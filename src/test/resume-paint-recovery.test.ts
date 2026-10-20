/**
 * The desktop/Android/PWA shell can come back from being hidden (switched
 * away from, minimized, left idle) with a stale or genuinely blank GPU
 * surface. These tests guard the fix for the visible symptom: a themed
 * opaque cover must appear the instant a resume is detected and disappear
 * again once the real content has settled, so the user sees a seamless
 * background instead of a blank/garbled flash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESUME_COVER_ID,
  RESUME_EVENT,
  getResumeCover,
  hideResumeCover,
  installResumePaintRecovery,
  showResumeCover,
} from '../utils/resumePaintRecovery';

function getCoverElement(): HTMLElement | null {
  return document.getElementById(RESUME_COVER_ID);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.classList.remove('dark', 'pharmatrack-resume-paint');
  document.body.innerHTML = '<div id="root"><span>content</span></div>';
  const cover = getCoverElement();
  if (cover) cover.remove();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  const cover = getCoverElement();
  if (cover) cover.remove();
});

describe('resume paint recovery — themed cover', () => {
  it('creates a single, full-viewport, pointer-events-none cover element', () => {
    const cover = getResumeCover();
    expect(cover).not.toBeNull();
    expect(cover!.style.position).toBe('fixed');
    expect(cover!.style.pointerEvents).toBe('none');
    expect(cover!.style.display).toBe('none');
    // Calling it again must not create a second element.
    const again = getResumeCover();
    expect(again).toBe(cover);
    expect(document.querySelectorAll(`#${RESUME_COVER_ID}`).length).toBe(1);
  });

  it('shows with the light-mode background when <html> is not in dark mode', () => {
    showResumeCover();
    const cover = getCoverElement()!;
    expect(cover.style.display).toBe('block');
    expect(cover.style.backgroundColor).toBe('rgb(248, 250, 252)');
  });

  it('shows with the dark-mode background when <html> has the dark class', () => {
    document.documentElement.classList.add('dark');
    showResumeCover();
    const cover = getCoverElement()!;
    expect(cover.style.display).toBe('block');
    expect(cover.style.backgroundColor).toBe('rgb(15, 23, 42)');
  });

  it('hides the cover on request', () => {
    showResumeCover();
    expect(getCoverElement()!.style.display).toBe('block');
    hideResumeCover();
    expect(getCoverElement()!.style.display).toBe('none');
  });

  it('is a no-op to hide a cover that was never shown', () => {
    expect(() => hideResumeCover()).not.toThrow();
  });
});

describe('resume paint recovery — install/uninstall lifecycle', () => {
  it('covers the surface immediately on focus, then uncovers it once the frame settles', () => {
    const cleanup = installResumePaintRecovery();
    try {
      window.dispatchEvent(new Event('focus'));
      // The cover goes up synchronously, before any frame or timer runs.
      expect(getCoverElement()!.style.display).toBe('block');

      // Let both nudge rAFs land and the settle timer fire.
      vi.runOnlyPendingTimers();

      expect(getCoverElement()!.style.display).toBe('none');
      expect(document.documentElement.classList.contains('pharmatrack-resume-paint')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('dispatches the resume event so heavy viewers (PDF/slide canvases) repaint', () => {
    const cleanup = installResumePaintRecovery();
    const handler = vi.fn();
    window.addEventListener(RESUME_EVENT, handler);
    try {
      window.dispatchEvent(new Event('focus'));
      expect(handler).toHaveBeenCalled();
    } finally {
      window.removeEventListener(RESUME_EVENT, handler);
      cleanup();
    }
  });

  it('reacts to visibilitychange only when the document becomes visible', () => {
    const cleanup = installResumePaintRecovery();
    try {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(getCoverElement()).toBeNull();

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(getCoverElement()!.style.display).toBe('block');
    } finally {
      cleanup();
    }
  });

  it('reacts to the native-shell resume event even without a DOM focus event', () => {
    const cleanup = installResumePaintRecovery();
    try {
      window.dispatchEvent(new Event('pharmatrack:native-resume'));
      expect(getCoverElement()!.style.display).toBe('block');
    } finally {
      cleanup();
    }
  });

  it('reloads only as a last resort when the root never regains content, keeping the cover up until then', () => {
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    // jsdom's window.location.reload throws "not implemented"; replace it so
    // the guard path can be observed without that noise.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });

    const cleanup = installResumePaintRecovery();
    try {
      const root = document.getElementById('root')!;
      root.innerHTML = ''; // Simulate a root that never recovered any content.

      window.dispatchEvent(new Event('focus'));
      expect(getCoverElement()!.style.display).toBe('block');

      vi.advanceTimersByTime(1200);
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      // The cover must still be covering the page at the moment reload fires.
      expect(getCoverElement()!.style.display).toBe('block');
    } finally {
      cleanup();
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    }
  });

  it('cleans up listeners and hides the cover when uninstalled mid-flight', () => {
    const cleanup = installResumePaintRecovery();
    window.dispatchEvent(new Event('focus'));
    expect(getCoverElement()!.style.display).toBe('block');

    cleanup();
    expect(getCoverElement()!.style.display).toBe('none');

    // Further events after cleanup must not reopen the cover.
    window.dispatchEvent(new Event('focus'));
    expect(getCoverElement()!.style.display).toBe('none');
  });
});
