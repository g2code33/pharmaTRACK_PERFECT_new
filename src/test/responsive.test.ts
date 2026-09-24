/**
 * Phase 13 — responsive layout guards.
 *
 * jsdom has no layout engine, so this cannot measure how a page looks at 360px.
 * What it can do is catch the two mistakes that reliably break a phone:
 *
 *  1. a fixed pixel width wider than a small screen
 *  2. a multi-column grid with no smaller variant, so three or five columns
 *     are squeezed into 360px forever
 *
 * Both are cheap to prevent here and tedious to notice by hand, because each
 * one looks fine on the laptop it was written on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

const files = globSync('src/**/*.tsx').filter(
  (file) => !file.includes('/test/') && !file.endsWith('.test.tsx'),
);

/** Smallest phone width the app is expected to survive. */
const PHONE_WIDTH = 360;

/**
 * Compact numeric tiles — three short values at a small gap. These are
 * deliberately allowed to keep three columns on a phone because stacking them
 * would make a card three times taller for no gain in readability.
 */
const COMPACT_TILES = new Set([
  'src/pages/Quiz.tsx:511',
  'src/pages/Onboarding.tsx:141',
  'src/pages/AcademicArchive.tsx:735',
  'src/components/AISettingsPanel.tsx:207',
]);

const sourceOf = (file: string): string[] => readFileSync(file, 'utf8').split('\n');

describe('no layout can outgrow a phone', () => {
  it('has no fixed width wider than a small screen', () => {
    const offenders: string[] = [];
    for (const file of files) {
      sourceOf(file).forEach((line, i) => {
        for (const match of line.matchAll(/(?:^|\s)((?:min-)?w-\[(\d+)px\])/g)) {
          if (Number(match[2]) >= PHONE_WIDTH) {
            offenders.push(`${file}:${i + 1} ${match[1]}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('gives every multi-column grid a smaller variant', () => {
    const offenders: string[] = [];
    for (const file of files) {
      sourceOf(file).forEach((line, i) => {
        const where = `${file}:${i + 1}`;
        if (COMPACT_TILES.has(where)) return;
        const grid = line.match(/(?<![\w:-])grid-cols-(\d+)/);
        if (!grid) return;
        // A responsive sibling (sm:/md:/lg:) proves a smaller layout exists.
        if (/(sm|md|lg|xl):grid-cols-/.test(line)) return;
        offenders.push(`${where} grid-cols-${grid[1]}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Renders a PowerPoint slide onto a fixed-size canvas. Tables here are slide
 * geometry, not app UI: they are absolutely positioned inside the slide and
 * must be clipped to its bounds — a scrollbar inside a slide would be wrong.
 */
const SLIDE_CANVAS = new Set(['src/components/PptxViewer.tsx']);

describe('wide content scrolls instead of being clipped', () => {
  it('wraps tables in a horizontal scroll container', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (SLIDE_CANVAS.has(file)) continue;
      const lines = sourceOf(file);
      lines.forEach((line, i) => {
        if (!/<table/.test(line)) return;
        // Walk back a few lines for the wrapper — tables are always nested.
        const window = lines.slice(Math.max(0, i - 4), i + 1).join(' ');
        if (!/overflow-x-auto/.test(window)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('touch targets stay reachable', () => {
  it('does not hide controls behind a hover-only interaction', () => {
    const offenders: string[] = [];
    for (const file of files) {
      sourceOf(file).forEach((line, i) => {
        // `group-hover:block` with no always-visible fallback means the control
        // is unreachable on a touch screen, where hover never fires.
        if (/group-hover:(block|flex)/.test(line) && !/(sm|md|lg):/.test(line)) {
          offenders.push(`${file}:${i + 1}`);
        }
      });
    }
    // This is a warning-level rule, not a hard failure: a couple of legitimately
    // desktop-only affordances are acceptable, a page full of them is not.
    expect(offenders.length).toBeLessThan(3);
  });
});
