import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { offsetsAreMeasured, pageIndexAtOffset, pageNumberAtOffset } from '../utils/pageOffsets';

const read = (relative: string) =>
  fs.readFileSync(path.resolve(__dirname, relative), 'utf8');

/** Comments explain what was removed, so assertions must look at code only. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');

const css = read('../index.css');
const layout = read('../components/Layout.tsx');
const titleBar = read('../components/NativeTitleBar.tsx');
const pdfViewer = read('../components/PdfViewer.tsx');
const pptxViewer = read('../components/PptxViewer.tsx');
const idleScheduler = read('../utils/idleScheduler.ts');
const rustMain = read('../../src-tauri/src/main.rs');

describe('page tracking maths', () => {
  const offsets = [0, 900, 1800, 2700, 3600];

  it('finds the page the viewport probe sits inside', () => {
    expect(pageIndexAtOffset(offsets, 0)).toBe(0);
    expect(pageIndexAtOffset(offsets, 899)).toBe(0);
    expect(pageIndexAtOffset(offsets, 900)).toBe(1);
    expect(pageIndexAtOffset(offsets, 2699)).toBe(2);
    expect(pageIndexAtOffset(offsets, 2700)).toBe(3);
  });

  it('clamps instead of running off either end', () => {
    expect(pageIndexAtOffset(offsets, -500)).toBe(0);
    expect(pageIndexAtOffset(offsets, 99999)).toBe(4);
    expect(pageIndexAtOffset([], 120)).toBe(0);
    expect(pageNumberAtOffset(offsets, 99999, 5)).toBe(5);
    expect(pageNumberAtOffset(offsets, -1, 5)).toBe(1);
    // A stale offsets array must never produce a page the document lacks.
    expect(pageNumberAtOffset(offsets, 99999, 3)).toBe(3);
  });

  it('copes with unevenly sized pages', () => {
    const mixed = [0, 400, 1700, 1900, 4200];
    expect(pageNumberAtOffset(mixed, 1699, 5)).toBe(2);
    expect(pageNumberAtOffset(mixed, 1700, 5)).toBe(3);
    expect(pageNumberAtOffset(mixed, 4200, 5)).toBe(5);
  });

  it('refuses to act on a measurement taken before layout', () => {
    // Every rect reads 0 before the first layout; a binary search over that
    // would report the last page and jump the reader to the end.
    expect(offsetsAreMeasured([0, 0, 0, 0], 4)).toBe(false);
    expect(offsetsAreMeasured([], 4)).toBe(false);
    expect(offsetsAreMeasured([0, 900], 4)).toBe(false);
    expect(offsetsAreMeasured([0], 1)).toBe(true);
    expect(offsetsAreMeasured(offsets, offsets.length)).toBe(true);
  });

  it('stays cheap on a large document', () => {
    const many = Array.from({ length: 2000 }, (_, i) => i * 1000);
    // Binary search: a linear scan of 2000 entries per scroll frame is exactly
    // the kind of per-frame work this replaced.
    expect(pageNumberAtOffset(many, 1_250_500, many.length)).toBe(1251);
  });
});

describe('scroll is never handed back to the main thread', () => {
  it('does no hit testing while the reader scrolls', () => {
    // document.elementsFromPoint() forces layout + a paint-order walk.
    expect(code(pdfViewer)).not.toContain('elementsFromPoint');
    expect(pdfViewer).toContain("addEventListener('scroll', onScroll, { passive: true })");
    expect(pdfViewer).toContain('pageNumberAtOffset(offsets, probe, numPages)');
    expect(pdfViewer).toContain('offsets = offsetsAreMeasured(next, numPages) ? next : [];');
  });

  it('coalesces rasterisation instead of restarting it every frame', () => {
    // Each renderWindow() call bumps renderBatch and aborts the in-flight
    // batch; calling it per scroll frame meant no page ever finished painting.
    expect(pdfViewer).toMatch(/const scheduleRenderWindow = useCallback/);
    expect(pdfViewer).toContain('scheduleRenderWindow(pageNum)');
    expect(pdfViewer).toContain('scheduleRenderWindow(currentPageRef.current, 0)');
    const scrollEffect = pdfViewer.slice(pdfViewer.indexOf('const pageAtViewport'));
    expect(scrollEffect.slice(0, scrollEffect.indexOf('}, [doc, numPages'))).not.toMatch(/\brenderWindow\(/);
  });

  it('re-measures page offsets on resize and when scrolling settles', () => {
    expect(pdfViewer).toContain('new ResizeObserver(() => { measure(); })');
    expect(pdfViewer).toMatch(/settleTimer = window\.setTimeout\(settle, \d+\)/);
  });

  it('keeps the slide scroller free of a permanent blocking wheel listener', () => {
    // A non-passive wheel listener makes its element a slow-scroll region:
    // the compositor must wait for JS on every tick.
    expect(pptxViewer).toContain("el.addEventListener('wheel', probe, { passive: true })");
    const blocking = pptxViewer.match(/addEventListener\('wheel', (\w+), \{ passive: false \}\)/g) ?? [];
    expect(blocking).toHaveLength(1);
    expect(pptxViewer).toContain("el.addEventListener('wheel', onZoomWheel, { passive: false });");
    // ...and it is only attached from attach(), which runs on a zoom gesture.
    expect(pptxViewer).toMatch(/const attach = \(\) => \{[\s\S]{0,200}addEventListener\('wheel', onZoomWheel, \{ passive: false \}\)/);
  });
});

describe('style invalidation does not scale with the whole document', () => {
  it('no longer flips a document-wide class on every scroll burst', () => {
    expect(idleScheduler).not.toContain('classList');
    expect(idleScheduler).not.toMatch(/ACTIVE_INPUT_CLASS/);
    const selectors = code(css);
    expect(selectors).not.toContain('pharmatrack-input-active');
    // The universal selector was the worst of it: every toggle recalculated
    // styles for the entire document.
    expect(selectors).not.toMatch(/html\.pharmatrack-input-active \*/);
  });

  it('damps scroll-time work on the scroller itself, not on <html>', () => {
    expect(css).toContain('.pdf-viewer-scroll.is-scrolling .pdf-text-layer');
    expect(pdfViewer).toContain("el.classList.add('is-scrolling')");
    expect(pptxViewer).toContain("el.classList.add('is-scrolling')");
  });

  it('drives the reader layout from a route class instead of :has()', () => {
    // `:has()` whose subject is the main scroll container is re-evaluated on
    // every DOM mutation inside the page.
    const selectors = code(css);
    expect(selectors).not.toContain(':has(');
    expect(selectors).toContain('.app-page-main--reader');
    expect(layout).toContain('app-page-main--reader');
  });
});

describe('desktop shell keeps the GPU', () => {
  it('does not disable WebKit compositing behind the user’s back', () => {
    // WEBKIT_DISABLE_COMPOSITING_MODE=1 turns off threaded scrolling and GPU
    // layers, so every wheel tick repaints in software on the main thread.
    expect(rustMain).toContain('PHARMATRACK_SAFE_GRAPHICS');
    // The only place compositing may be switched off is behind that opt-in.
    const compositingWrites = code(rustMain).match(/set_var\("WEBKIT_DISABLE_COMPOSITING_MODE"[^)]*\)/g) ?? [];
    expect(compositingWrites).toHaveLength(1);
    expect(rustMain).toMatch(/if safe_graphics && std::env::var_os\("WEBKIT_DISABLE_COMPOSITING_MODE"\)/);
    // The targeted blank-window fix stays unconditional.
    expect(rustMain).toMatch(/if std::env::var_os\("WEBKIT_DISABLE_DMABUF_RENDERER"\)\.is_none\(\) \{\s*std::env::set_var\("WEBKIT_DISABLE_DMABUF_RENDERER", "1"\);/);
  });

  it('does not re-disable compositing from the launchers either', () => {
    // main.rs only sets the flag when it is not already present, so a .desktop
    // entry or npm script that exports it would quietly undo the fix.
    const desktopEntry = read('../../src-tauri/templates/deb.desktop');
    const pkg = read('../../package.json');
    expect(desktopEntry).toContain('WEBKIT_DISABLE_DMABUF_RENDERER=1');
    expect(desktopEntry).not.toContain('WEBKIT_DISABLE_COMPOSITING_MODE');
    expect(pkg).not.toContain('WEBKIT_DISABLE_COMPOSITING_MODE');
  });

  it('bounds every update check so the version pill cannot stick on “Checking…”', () => {
    expect(layout).toMatch(/const withUpdateTimeout = <T,>/);
    expect(layout).toContain('await withUpdateTimeout(checkNativeUpdate())');
    expect(layout).toContain("if (!silent) setUpdateStatus('checking');");
    expect(layout).toContain("setUpdateStatus((current) => (current === 'checking' ? 'idle' : current));");
  });

  it('never puts a rounded clip on the element that scrolls', () => {
    // A scroller that carries its own border-radius is dropped out of
    // accelerated overflow scrolling, so the card styling lives on the static
    // frame around it.
    const pageMain = css.match(/\.app-shell \.app-page-main \{([\s\S]*?)\}/)?.[1] ?? '';
    expect(pageMain).not.toContain('border-radius');
    expect(pageMain).not.toContain('box-shadow');
    const frame = css.match(/\.app-shell \.app-page-frame \{([\s\S]*?)\}/)?.[1] ?? '';
    expect(frame).toContain('border-radius');
    expect(frame).toContain('overflow: hidden');
    expect(layout).toContain('app-page-frame flex flex-1 min-h-0 flex-col');
  });

  it('gives every wide surface the same shell chrome, however it was installed', () => {
    // The browser, the EXE, the DEB and an Android tablet are the same
    // product; none of them may be the one that looks plainer.
    const chrome = css.slice(css.indexOf('@media (min-width: 1024px)'));
    for (const selector of [
      '.app-shell .mobile-sidebar',
      '.app-shell .app-header',
      '.app-shell .app-page-frame',
      '.app-shell .app-page-main',
    ]) {
      expect(chrome).toContain(selector);
      expect(chrome).not.toContain(`.native-desktop-shell ${selector.slice('.app-shell '.length)} {`);
    }
    // Being a window rather than a tab is still allowed to mean something.
    expect(chrome).toContain('.native-desktop-shell .app-page-main--reader');
    expect(chrome).toContain('.native-desktop-shell .slide-reader-fullbleed');
  });

  it('keeps layout out of the hover transitions that fire while a list scrolls', () => {
    const narrowed = css.match(/^\.transition-all \{([\s\S]*?)\}/m)?.[1] ?? '';
    expect(narrowed).toContain('transition-property');
    for (const property of ['width', 'height', 'margin', 'padding', 'inset']) {
      expect(narrowed).not.toContain(property);
    }
    // The visible feedback must survive the narrowing.
    for (const property of ['background-color', 'box-shadow', 'transform', 'opacity']) {
      expect(narrowed).toContain(property);
    }
  });

  it('leaves document pages out of content-visibility, which costs a frame on every page boundary', () => {
    // The shells are already given exact pixel sizes and the viewer already
    // rasterises only the pages near the reader, so skipping their contents
    // bought nothing and charged a synchronous layout and paint to the scroll
    // frame each time a page scrolled into view.
    const shell = css.match(/\.pdf-page-shell \{([\s\S]*?)\}/)?.[1] ?? '';
    expect(shell).not.toContain('content-visibility');
    expect(shell).not.toContain('contain-intrinsic-size');
    expect(shell).toContain('contain: layout paint style');
    expect(pdfViewer).toContain('height: size?.h,');
  });

  it('keeps the desktop window strip to a single compact row', () => {
    expect(titleBar).toContain('native-titlebar flex h-9 flex-shrink-0 items-center border-b border-slate-200 bg-white');
    expect(titleBar).not.toContain('native-titlebar flex h-11');
    expect(css).toMatch(/\.native-window-control \{[\s\S]*?height: 2\.25rem;/);
  });
});
