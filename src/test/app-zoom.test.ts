/**
 * The installed app must not zoom like a web page, and must not lose a single
 * gesture in exchange.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const shell = { standalone: false, native: false };

vi.mock('../platform/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/runtime')>();
  return {
    ...actual,
    isPWAStandalone: () => shell.standalone,
    isNativeShell: () => shell.native,
  };
});

const {
  APP_ZOOM_ATTRIBUTE,
  PINCHING_CLASS,
  ZOOM_LOCK_CLASS,
  installAppZoomGuard,
  resetAppZoomGuardForTests,
  shouldLockBrowserZoom,
} = await import('../platform/zoomGuard');
const { attachPinchZoom, keepPinchAnchor } = await import('../platform/pinchZoom');

const root = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

/** jsdom has no Touch constructor; the handlers only read clientX/clientY. */
function touchEvent(type: string, points: Array<{ x: number; y: number }>): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touches = points.map((p) => ({ clientX: p.x, clientY: p.y }));
  Object.defineProperty(event, 'touches', { value: touches, configurable: true });
  return event;
}

let cleanup: (() => void) | undefined;
let viewport: HTMLMetaElement;

beforeEach(() => {
  shell.standalone = false;
  shell.native = false;
  resetAppZoomGuardForTests();
  viewport = document.createElement('meta');
  viewport.setAttribute('name', 'viewport');
  viewport.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
  document.head.appendChild(viewport);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  resetAppZoomGuardForTests();
  viewport.remove();
  document.documentElement.classList.remove(ZOOM_LOCK_CLASS);
  document.body.innerHTML = '';
});

describe('who gets their zoom taken away', () => {
  it('nobody, in an ordinary browser tab', () => {
    expect(shouldLockBrowserZoom()).toBe(false);
    cleanup = installAppZoomGuard();
    expect(document.documentElement.classList.contains(ZOOM_LOCK_CLASS)).toBe(false);
    expect(viewport.getAttribute('content')).toContain('initial-scale=1.0');
    expect(viewport.getAttribute('content')).not.toContain('user-scalable=no');
  });

  it('a standalone PWA', () => {
    shell.standalone = true;
    expect(shouldLockBrowserZoom()).toBe(true);
  });

  it('the Android APK and the desktop window', () => {
    shell.native = true;
    expect(shouldLockBrowserZoom()).toBe(true);
  });

  it('and the markup keeps shipping the zoomable viewport for everyone else', () => {
    const html = read('index.html');
    expect(html).toContain('name="viewport"');
    expect(html).not.toContain('user-scalable=no');
    expect(html).not.toContain('maximum-scale');
  });
});

describe('an installed app', () => {
  beforeEach(() => {
    shell.standalone = true;
    cleanup = installAppZoomGuard();
  });

  it('pins the viewport and flags itself for the stylesheet', () => {
    expect(viewport.getAttribute('content')).toContain('user-scalable=no');
    expect(viewport.getAttribute('content')).toContain('maximum-scale=1');
    expect(viewport.getAttribute('content')).toContain('viewport-fit=cover');
    expect(document.documentElement.classList.contains(ZOOM_LOCK_CLASS)).toBe(true);
  });

  it('refuses the iOS pinch gesture', () => {
    const event = new Event('gesturestart', { bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('refuses a two-finger pinch', () => {
    const event = touchEvent('touchmove', [{ x: 0, y: 0 }, { x: 80, y: 80 }]);
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('refuses ctrl and wheel together', () => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10 });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('refuses the keyboard zoom shortcuts', () => {
    for (const key of ['+', '-', '0', '=']) {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('restores the page exactly as it found it', () => {
    cleanup?.();
    cleanup = undefined;
    expect(viewport.getAttribute('content')).toBe('width=device-width, initial-scale=1.0, viewport-fit=cover');
    expect(document.documentElement.classList.contains(ZOOM_LOCK_CLASS)).toBe(false);
  });
});

describe('but every app gesture still works', () => {
  beforeEach(() => {
    shell.standalone = true;
    cleanup = installAppZoomGuard();
  });

  it('one finger is never a zoom, so scrolling and swiping are untouched', () => {
    const event = touchEvent('touchmove', [{ x: 10, y: 10 }]);
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('a plain wheel still scrolls', () => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('plain keystrokes reach the app', () => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '0' });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('hands a pinch straight through to a surface that owns its zoom', () => {
    const reader = document.createElement('div');
    reader.setAttribute(APP_ZOOM_ATTRIBUTE, '');
    document.body.appendChild(reader);

    const pinch = touchEvent('touchmove', [{ x: 0, y: 0 }, { x: 80, y: 80 }]);
    reader.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(false);

    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10 });
    reader.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });
});

describe('the readers zoom themselves instead', () => {
  it('reports how far the fingers moved apart', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const factors: number[] = [];
    const detach = attachPinchZoom(el, { onZoom: (f) => factors.push(f) });

    el.dispatchEvent(touchEvent('touchstart', [{ x: 0, y: 0 }, { x: 100, y: 0 }]));
    el.dispatchEvent(touchEvent('touchmove', [{ x: 0, y: 0 }, { x: 200, y: 0 }]));
    expect(factors).toEqual([2]);

    el.dispatchEvent(touchEvent('touchmove', [{ x: 0, y: 0 }, { x: 50, y: 0 }]));
    expect(factors).toEqual([2, 0.5]);
    detach();
  });

  it('takes the surface off the browser for the length of the gesture', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const detach = attachPinchZoom(el, { onZoom: () => undefined });

    el.dispatchEvent(touchEvent('touchstart', [{ x: 0, y: 0 }, { x: 100, y: 0 }]));
    expect(el.classList.contains(PINCHING_CLASS)).toBe(true);
    el.dispatchEvent(touchEvent('touchend', []));
    expect(el.classList.contains(PINCHING_CLASS)).toBe(false);
    detach();
  });

  it('ignores one finger, so scrolling the document still scrolls it', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const zoom = vi.fn();
    const detach = attachPinchZoom(el, { onZoom: zoom });

    el.dispatchEvent(touchEvent('touchstart', [{ x: 10, y: 10 }]));
    const move = touchEvent('touchmove', [{ x: 10, y: 60 }]);
    el.dispatchEvent(move);

    expect(zoom).not.toHaveBeenCalled();
    expect(move.defaultPrevented).toBe(false);
    expect(el.classList.contains(PINCHING_CLASS)).toBe(false);
    detach();
  });

  it('ignores two fingers that are already touching, which is a two-thumb tap', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const zoom = vi.fn();
    const detach = attachPinchZoom(el, { onZoom: zoom });

    el.dispatchEvent(touchEvent('touchstart', [{ x: 10, y: 10 }, { x: 18, y: 12 }]));
    el.dispatchEvent(touchEvent('touchmove', [{ x: 10, y: 10 }, { x: 40, y: 12 }]));
    expect(zoom).not.toHaveBeenCalled();
    detach();
  });

  it('keeps the pinched point under the fingers', () => {
    const el = document.createElement('div');
    // Doubling the content: a point 100px down the content and 50px down the
    // viewport moves to 200px down the content, so the scroll offset has to
    // become 150 for it to still appear 50px down.
    keepPinchAnchor(el, { x: 0, y: 50, scrollLeft: 0, scrollTop: 50 }, 2);
    expect(el.scrollTop).toBe(150);

    keepPinchAnchor(el, { x: 0, y: 50, scrollLeft: 0, scrollTop: 50 }, 1);
    expect(el.scrollTop).toBe(50);
  });

  it('refuses a nonsense ratio rather than scrolling somewhere absurd', () => {
    const el = document.createElement('div');
    el.scrollTop = 0;
    keepPinchAnchor(el, { x: 0, y: 10, scrollLeft: 0, scrollTop: 10 }, Number.NaN);
    expect(el.scrollTop).toBe(0);
  });
});

describe('wiring', () => {
  it('locks the viewport before React paints anything', () => {
    const main = read('src/main.tsx');
    expect(main).toContain('installAppZoomGuard()');
    expect(main.indexOf('installAppZoomGuard()')).toBeLessThan(main.indexOf('root.render'));
  });

  it('gives both document readers a real pinch and a real anchor', () => {
    for (const file of ['src/components/PdfViewer.tsx', 'src/components/PptxViewer.tsx']) {
      const source = read(file);
      expect(source).toContain('usePinchZoom(containerRef');
      expect(source).toContain('keepPinchAnchor(el, base.anchor');
    }
    // Desktop keeps the trackpad pinch it already had on the deck, and the
    // PDF gains the one the guard would otherwise have swallowed.
    expect(read('src/components/PdfViewer.tsx')).toContain("el.addEventListener('wheel', onWheel, { passive: false })");
  });

  it('turns off double-tap and pinch with one root declaration, not a universal selector', () => {
    const css = read('src/index.css');
    expect(css).toMatch(/html\.pharmatrack-zoom-locked,\s*html\.pharmatrack-zoom-locked body \{\s*touch-action: pan-x pan-y;/);
    expect(css).toContain('.is-pinching');
    expect(css).not.toContain('html.pharmatrack-zoom-locked * {');
  });
});
