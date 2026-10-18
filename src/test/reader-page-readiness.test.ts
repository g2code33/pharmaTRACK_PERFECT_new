/**
 * Two things that made the app feel like it was thinking when it should have
 * been answering: skipping to a page the reader had not visited, and opening
 * the navigation drawer on Android.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pagesByDistance } from '../utils/pageOffsets';

const root = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const pdfViewer = read('src/components/PdfViewer.tsx');
const layout = read('src/components/Layout.tsx');
const css = read('src/index.css');

describe('preparing pages in the order they are likely to be wanted', () => {
  it('starts where the reader is and works outwards', () => {
    expect(pagesByDistance(5, 3)).toEqual([3, 2, 4, 1, 5]);
  });

  it('still covers the whole document when the reader is at one end', () => {
    expect(pagesByDistance(4, 1)).toEqual([1, 2, 3, 4]);
    expect(pagesByDistance(4, 4)).toEqual([4, 3, 2, 1]);
  });

  it('never leaves a page out, however long the document', () => {
    const pages = pagesByDistance(200, 90);
    expect(pages).toHaveLength(200);
    expect(new Set(pages).size).toBe(200);
    expect(pages[0]).toBe(90);
  });

  it('survives a centre that makes no sense', () => {
    expect(pagesByDistance(3, 0)).toEqual([1, 2, 3]);
    expect(pagesByDistance(3, 99)).toEqual([3, 2, 1]);
    expect(pagesByDistance(0, 1)).toEqual([]);
    expect(pagesByDistance(3, Number.NaN)).toEqual([1, 2, 3]);
  });
});

describe('every page is ready before it is asked for', () => {
  it('keeps a standing preview of each page, built in the background', () => {
    expect(pdfViewer).toContain('const PREVIEW_WIDTH = 640');
    expect(pdfViewer).toContain('pagesByDistance(numPages, currentPageRef.current)');
    expect(pdfViewer).toContain("scratch.toBlob(resolve, 'image/jpeg', PREVIEW_QUALITY)");
  });

  it('shows the preview underneath the live canvas, so a jump lands on something', () => {
    expect(pdfViewer).toContain('className="pdf-page-preview"');
    // The real render has to win wherever both exist.
    expect(pdfViewer).toContain('className="relative z-[1] block rounded-sm"');
    const preview = css.match(/\.pdf-page-preview \{([\s\S]*?)\}/)?.[1] ?? '';
    expect(preview).toContain('position: absolute');
    expect(preview).toContain('z-index: 0');
    expect(preview).toContain('pointer-events: none');
  });

  it('is cheap enough to hold a whole deck: downscaled, never upscaled, as JPEG', () => {
    expect(pdfViewer).toContain('Math.min(1, PREVIEW_WIDTH / Math.max(1, unscaled.width))');
    expect(pdfViewer).toContain('const PREVIEW_QUALITY = 0.62');
  });

  it('yields between pages so preparing the document never blocks the reader', () => {
    const pass = pdfViewer.slice(
      pdfViewer.indexOf('standing page previews'),
      pdfViewer.indexOf('navigation ----------------'),
    );
    expect(pass).toContain('await yieldToMainThread();');
    expect(pass).toContain('if (cancelled) return;');
    // Repainting once per page would cost more than the previews save.
    expect(pass).toContain('sinceRepaint >= PREVIEW_BATCH');
  });

  it('hands every blob back when the document goes away', () => {
    const pass = pdfViewer.slice(pdfViewer.indexOf('standing page previews'));
    expect(pass).toContain('for (const url of urls.values()) URL.revokeObjectURL(url);');
    expect(pass).toContain('urls.clear();');
  });

  it('rebuilds them when the page orientation changes', () => {
    expect(pdfViewer).toContain('}, [doc, numPages, rotation]);');
  });

  it('still releases live canvases, because those are the expensive ones', () => {
    expect(pdfViewer).toContain('const KEEP_WINDOW = 8;');
    expect(pdfViewer).toContain('if (c) { c.width = 0; c.height = 0; }');
  });
});

describe('the navigation drawer', () => {
  it('does not insert a full-screen layer at the moment it starts animating', () => {
    // Mounting the backdrop on open forced layout and paint of everything
    // behind it on the first frame of the slide.
    expect(layout).not.toContain('{mobileMenuOpen && (\n          <button');
    expect(layout).toContain('mobile-sidebar-backdrop fixed inset-0');
    expect(layout).toContain('transition-opacity');
    expect(layout).toContain("mobileMenuOpen ? 'opacity-100' : 'pointer-events-none opacity-0'");
  });

  it('is still closed by tapping outside it, and still out of the way when shut', () => {
    expect(layout).toContain('aria-label="Close navigation menu"');
    expect(layout).toContain('onClick={() => setMobileMenuOpen(false)}');
    expect(layout).toContain('aria-hidden={!mobileMenuOpen}');
    expect(layout).toContain('tabIndex={mobileMenuOpen ? 0 : -1}');
  });

  it('animates only its transform', () => {
    const asideStart = layout.indexOf('<aside className={`mobile-sidebar');
    const aside = layout.slice(asideStart, layout.indexOf('>', asideStart));
    expect(aside).toContain('transition-transform duration-200');
    expect(aside).not.toContain('transition-all');
    // A width that changes with the open state is a width that gets animated.
    expect(aside).toContain('w-[min(84vw,20rem)]');
    expect(aside).not.toContain("translate-x-0 w-[min(84vw,20rem)]");
  });

  it('stops the drawer and the page behind invalidating each other', () => {
    const backdrop = css.match(/\.mobile-sidebar-backdrop \{([\s\S]*?)\}/)?.[1] ?? '';
    expect(backdrop).toContain('contain: layout paint style');
    // A finger dragged across the backdrop must not scroll the page under it.
    expect(backdrop).toContain('touch-action: none');

    const drawer = css.match(/@media \(max-width: 1023px\) \{\s*\.mobile-sidebar \{([\s\S]*?)\}/)?.[1] ?? '';
    expect(drawer).toContain('contain: layout paint style');
    expect(drawer).toContain('will-change: transform');
  });

  it('still covers the header and the bottom navigation', () => {
    expect(layout).toContain('mobile-sidebar-backdrop fixed inset-0 z-[220]');
    expect(layout).toContain('mobile-sidebar fixed inset-y-0 left-0 z-[230]');
    // The bottom bar and the header both sit below those.
    expect(layout).toContain('mobile-bottom-nav lg:hidden fixed inset-x-0 bottom-0 z-[125]');
    expect(layout).toContain('relative z-[120]');
  });
});
