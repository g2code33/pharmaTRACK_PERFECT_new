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
    // A query like "C(2)" must not be compiled as a capture group. Both the
    // hit-finding pass and the mark-painting pass must escape.
    const occurrences = viewer.split("const escaped = raw.replace(").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('supports match case, whole words and highlight all', () => {
    expect(viewer).toContain('matchCase');
    expect(viewer).toContain('wholeWords');
    expect(viewer).toContain('highlightAllMatches');
  });

  it('re-paints when zoom or rotation changes', () => {
    // The layer is rebuilt on re-render, which would otherwise drop the marks.
    expect(viewer).toMatch(/highlightAllMatches, matchCase, wholeWords, scale, rotation/);
  });
});

describe('viewer toolbar features', () => {
  const required: [string, RegExp][] = [
    ['sidebar toggle', /setSidebarOpen/],
    ['thumbnails', /sidebarTab === 'thumbnails'/],
    ['outline / bookmarks', /getOutline\(\)/],
    ['attachments', /getAttachments\(\)/],
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
