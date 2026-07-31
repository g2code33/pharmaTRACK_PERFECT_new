/**
 * Guards for the PDF viewer's text layer and find-in-document.
 *
 * Highlighting silently did nothing because pdf.js 3.x positions text-layer
 * spans with `calc(var(--scale-factor) * ...)`. With that CSS variable unset
 * every span collapses, so there is nothing to select and no selection event
 * ever fires. pdf.js only reports it as a console.error, which is easy to miss.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const viewer = fs.readFileSync(
  path.resolve(__dirname, '../components/PdfViewer.tsx'), 'utf8',
);
const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');

describe('pdf.js text layer requirements', () => {
  it('sets --scale-factor on the text layer container', () => {
    // The exact requirement pdf.js enforces. Without this line, selection and
    // therefore highlighting are impossible.
    expect(viewer).toMatch(/setProperty\(\s*'--scale-factor'\s*,\s*String\(viewport\.scale\)\s*\)/);
  });

  it('sets it before rendering the text layer, not after', () => {
    const setIdx = viewer.indexOf("setProperty('--scale-factor'");
    const renderIdx = viewer.indexOf('pdfjs.renderTextLayer');
    expect(setIdx).toBeGreaterThan(-1);
    expect(renderIdx).toBeGreaterThan(-1);
    // pdf.js reads the computed value when renderTextLayer is called.
    expect(setIdx).toBeLessThan(renderIdx);
  });

  it('keeps the text layer above saved highlights so selection still works', () => {
    // Highlights sit at z-index 1, the text layer at 2. Reversing these makes
    // highlighted passages unselectable.
    expect(viewer).toMatch(/background: overlayFor\(h\.color\)[\s\S]{0,120}zIndex: 1/);
    expect(viewer).toMatch(/pdf-text-layer[\s\S]{0,140}zIndex: 2/);
  });

  it('styles the text layer spans as transparent and absolutely positioned', () => {
    expect(css).toMatch(/\.pdf-text-layer span[\s\S]{0,200}position:\s*absolute/);
    expect(css).toMatch(/\.pdf-text-layer span[\s\S]{0,200}color:\s*transparent/);
  });
});

describe('find-in-document', () => {
  it('paints matches onto the rendered spans', () => {
    expect(viewer).toMatch(/mark\[data-find\]/);
    expect(css).toMatch(/\.pdf-text-layer mark\[data-find\]/);
  });

  it('clears previous marks before painting new ones', () => {
    // Otherwise marks accumulate and stale matches stay highlighted.
    expect(viewer).toMatch(/querySelectorAll\('mark\[data-find\]'\)/);
  });

  it('escapes regex metacharacters in the query', () => {
    // A query like "C(2)" must not compile as a capture group. Both the
    // hit-finding pass and the mark-painting pass go through escapeRe.
    expect(viewer).toMatch(/const escapeRe = \(s: string\) => s\.replace\(/);
    expect(viewer.split('escapeRe(raw)').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('supports match case, whole words and highlight all', () => {
    expect(viewer).toContain('matchCase');
    expect(viewer).toContain('wholeWords');
    expect(viewer).toContain('highlightAllMatches');
  });

  it('re-applies marks immediately after the text layer is rebuilt', () => {
    // renderTextLayer replaces the layer's children, so without this call the
    // marks vanish every time a page is re-rendered or revisited.
    expect(viewer).toMatch(/await textTask\.promise;[\s\S]{0,140}paintMarks\(pageNum\)/);
  });

  it('re-applies marks when returning to a cached page', () => {
    // Cache hits skip rendering entirely, so they must still repaint.
    expect(viewer).toMatch(/renderedKey\.current\.get\(pageNum\) === key\) \{ paintMarks\(pageNum\); return; \}/);
  });

  it('tracks and styles the active match distinctly', () => {
    expect(viewer).toContain('data-active');
    expect(css).toMatch(/mark\[data-find\]\[data-active\]/);
  });

  it('honours "highlight all" without losing the active match', () => {
    expect(css).toMatch(/\.find-active-only mark\[data-find\]:not\(\[data-active\]\)/);
  });

  it('has a search results panel in the sidebar', () => {
    expect(viewer).toContain('SearchResultsPanel');
    expect(viewer).toMatch(/sidebarTab === 'search'/);
  });
});

describe('viewer toolbar features', () => {
  const required: [string, RegExp][] = [
    ['sidebar toggle', /setSidebarOpen/],
    ['thumbnails', /sidebarTab === 'thumbnails'/],
    ['outline / bookmarks', /getOutline\(\)/],
    ['attachments', /getAttachments\(\)/],
    ['search results panel', /SearchResultsPanel/],
    ['zoom presets', /Automatic Zoom[\s\S]{0,200}Actual Size/],
    ['page fit / width', /'fit', 'Page Fit'[\s\S]{0,60}'width', 'Page Width'/],
    ['rotate both ways', /Rotate Clockwise[\s\S]{0,400}Rotate Counterclockwise/],
    ['scroll modes', /Vertical Scrolling[\s\S]{0,200}Horizontal Scrolling[\s\S]{0,200}Wrapped Scrolling/],
    ['spread modes', /No Spreads[\s\S]{0,200}Odd Spreads[\s\S]{0,200}Even Spreads/],
    ['text selection tool', /tool === 'select'/],
    ['hand tool', /tool === 'hand'/],
    ['first / last page', /Go to First Page[\s\S]{0,300}Go to Last Page/],
    ['print', /handlePrint/],
    ['download', /download=\{title/],
    ['document properties', /Document Properties/],
  ];

  it.each(required)('has %s', (_label, pattern) => {
    expect(viewer).toMatch(pattern);
  });
});

describe('instant page navigation', () => {
  it('caches renders per page, scale and rotation', () => {
    // Without a cache every scroll re-rasterises pages already on screen,
    // which is what made paging feel slow.
    expect(viewer).toMatch(/renderedKey = useRef<Map<number, string>>/);
    expect(viewer).toMatch(/const key = `\$\{scale\.toFixed\(3\)\}\|\$\{rotation\}`/);
    expect(viewer).toMatch(/renderedKey\.current\.set\(pageNum, key\)/);
  });

  it('invalidates the cache when zoom or rotation changes', () => {
    expect(viewer).toMatch(/renderedKey\.current\.clear\(\);[\s\S]{0,120}\[scale, rotation\]/);
  });

  it('sizes page boxes before rendering so scrolling is accurate', () => {
    // Boxes get their real dimensions from the measured viewport, so the
    // scrollbar is correct from the first frame and jumps land in one go.
    expect(viewer).toMatch(/const scaledSize = useCallback/);
    expect(viewer).toMatch(/style=\{\{ width: size\?\.w[\s\S]{0,40}height: size\?\.h/);
  });

  it('pre-renders a window of pages around the viewport', () => {
    expect(viewer).toMatch(/const RENDER_WINDOW = \d+/);
    expect(viewer).toMatch(/const renderWindow = useCallback/);
  });

  it('evicts distant canvases so long documents stay bounded', () => {
    // A single 2x-DPR page canvas is ~20 MB; keeping 100 would exhaust memory.
    expect(viewer).toMatch(/const KEEP_WINDOW = \d+/);
    expect(viewer).toMatch(/Math\.abs\(p - centre\) > KEEP_WINDOW/);
  });

  it('renders the destination before scrolling to it', () => {
    expect(viewer).toMatch(/renderWindow\(clamped\);[\s\S]{0,120}scrollIntoView/);
  });

  it('avoids duplicate concurrent renders of the same page', () => {
    expect(viewer).toMatch(/inFlight\.current\.has\(pageNum\)/);
  });
});
