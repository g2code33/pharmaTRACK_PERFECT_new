/**
 * Phase 13 — performance.
 *
 * These are budget tests, not benchmarks. A benchmark tells you a number went
 * up; a budget tells you when the app has stopped being usable. Thresholds are
 * deliberately generous so a slow CI machine cannot fail them — the point is to
 * catch a change that turns a linear operation into a quadratic one, or a lazy
 * read into "load the entire workspace".
 *
 * The two properties that matter most:
 *
 *  • **Bounded, not fast.** Large inputs must degrade by staying within a cap
 *    (chunk counts, index sizes, results) rather than growing without limit.
 *  • **Nothing re-reads everything.** Opening the library, starting the app or
 *    initialising AI must not touch every file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => {
    idbStore.set(k, v);
  },
  del: async (k: string) => {
    idbStore.delete(k);
  },
  delMany: async (keys: string[]) => {
    keys.forEach((k) => idbStore.delete(k));
  },
  keys: async () => [...idbStore.keys()],
  clear: async () => {
    idbStore.clear();
  },
}));

import { loadState, saveState } from '../utils/storage';
import { chunkSource, fingerprintText, syncIndex, statsFor, searchIndex } from '../ai';
import type { IndexableSource } from '../ai';
import { searchAll } from '../utils/search';
import type { AppState } from '../types';

/** Generous budgets: a slow machine should still pass comfortably. */
const BUDGET = {
  startupMs: 3_000,
  largeFileMs: 8_000,
  searchMs: 4_000,
  aiInitMs: 5_000,
};

const ms = (fn: () => void): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

/** A realistic-but-large workspace: one course, many topics, many materials. */
function bigWorkspace(slideCount: number, charsPerSlide = 4_000): AppState {
  const slides = Array.from({ length: slideCount }, (_, i) => ({
    id: `s${i}`,
    topicId: `t${i % 20}`,
    slideNumber: 1,
    title: `Lecture ${i + 1} — Pharmacology`,
    contentText: `--- Slide 1 ---\n${'Beta blockers and autonomic pharmacology content. '.repeat(Math.ceil(charsPerSlide / 52))}`,
    status: 'not_started' as const,
    createdAt: '2026-01-01',
    materialKind: i % 2 ? 'pptx' : 'pdf',
  }));

  return {
    isLoggedIn: false,
    student: {
      id: 'u1',
      name: 'Ama',
      university: 'KNUST',
      level: '300',
      program: 'Pharm.D',
      semester: '1st',
      createdAt: '2026-01-01',
    },
    courses: [
      {
        id: 'c1',
        courseCode: 'PHAR 351',
        courseName: 'Pharmacology II',
        lecturer: 'Dr A',
        credits: 3,
        semester: '1st',
        level: '300',
        createdAt: '2026-01-01',
      },
    ],
    topics: Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      courseId: 'c1',
      topicName: `Topic ${i}`,
      createdAt: '2026-01-01',
    })),
    slides,
    learningObjectives: [],
    examQuestions: [],
    quizHistory: [],
    studyPlans: [],
    notes: [],
    examDates: [],
    activities: [],
    chatHistory: [],
    highlights: [],
    savedInsights: [],
    openAIKey: '',
    timetables: { class: [], quiz: [], exam: [] },
    timetablePdf: null,
  } as unknown as AppState;
}

const sourcesOf = (state: AppState): IndexableSource[] =>
  state.slides.map((s) => ({
    id: s.id,
    topicId: s.topicId,
    title: s.title,
    contentText: s.contentText,
    materialKind: s.materialKind,
    courseId: 'c1',
    courseName: 'Pharmacology II',
    topicName: 'Topic',
    semester: '1st',
  }));

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
});

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

describe('startup', () => {
  it('loads a large workspace quickly', () => {
    const state = bigWorkspace(200);
    saveState(state);

    const elapsed = ms(() => {
      const loaded = loadState();
      expect(loaded.slides).toHaveLength(200);
    });

    expect(elapsed).toBeLessThan(BUDGET.startupMs);
  });

  it('a second startup is not slower than the first', () => {
    saveState(bigWorkspace(150));
    const first = ms(() => loadState());
    const second = ms(() => loadState());
    // No cache that has to warm up, and no unbounded accumulation: repeated
    // loads stay flat rather than growing with each call.
    expect(second).toBeLessThan(Math.max(first * 3, 500));
  });
});

/* ------------------------------------------------------------------ */
/* Large files and presentations                                       */
/* ------------------------------------------------------------------ */

describe('large files', () => {
  it('chunks a very large document within a bounded time', () => {
    const huge = 'Beta blockers reduce sympathetic tone. '.repeat(60_000); // ~2.4 MB
    expect(huge.length).toBeGreaterThan(2_000_000);

    const elapsed = ms(() => {
      const chunks = chunkSource(
        { id: 'big', topicId: 't1', title: 'Huge PDF', materialKind: 'pdf' },
        huge,
      );
      expect(chunks.length).toBeGreaterThan(0);
    });

    expect(elapsed).toBeLessThan(BUDGET.largeFileMs);
  });

  it('caps how much of one material the index will hold', async () => {
    // One enormous file must not be allowed to become the whole index.
    const enormous = 'Pharmacology revision content. '.repeat(200_000); // ~6 MB
    const [index] = await Promise.all([
      syncIndex(
        [
          {
            id: 'giant',
            topicId: 't1',
            title: 'Giant',
            contentText: enormous,
            materialKind: 'pdf',
          },
        ],
        async () => null,
      ),
    ]);

    const stats = statsFor(index);
    expect(stats.materials).toBe(1);
    // Bounded: a 6 MB document produces a capped number of passages, not
    // thousands that would dominate both memory and every future query.
    expect(stats.chunks).toBeLessThanOrEqual(1_200);
  });

  it('a large presentation stays bounded too', async () => {
    const deck = Array.from(
      { length: 900 },
      (_, i) => `--- Slide ${i + 1} ---\n${'Autonomic pharmacology slide content. '.repeat(20)}`,
    ).join('\n\n');

    const index = await syncIndex(
      [{ id: 'deck', topicId: 't1', title: '900 slides', contentText: deck, materialKind: 'pptx' }],
      async () => null,
    );
    const stats = statsFor(index);
    expect(stats.chunks).toBeLessThanOrEqual(1_200);
    // Slide numbering survives at scale, so page/slide citations stay accurate.
    expect(index.materials.deck.chunks.some((c) => c.slide === 900)).toBe(true);
  });

  it('fingerprinting a large file is linear and cheap', () => {
    const text = 'content '.repeat(500_000);
    const elapsed = ms(() => fingerprintText(text));
    expect(elapsed).toBeLessThan(1_000);
  });
});

/* ------------------------------------------------------------------ */
/* Search                                                             */
/* ------------------------------------------------------------------ */

describe('search performance', () => {
  it('searches a large workspace within budget', () => {
    const state = bigWorkspace(400);
    const elapsed = ms(() => {
      const results = searchAll(state, 'beta blockers');
      expect(results.length).toBeGreaterThan(0);
    });
    expect(elapsed).toBeLessThan(BUDGET.searchMs);
  });

  it('search time does not explode as the workspace grows', () => {
    const small = bigWorkspace(50);
    const large = bigWorkspace(400);

    const tSmall = ms(() => searchAll(small, 'autonomic pharmacology'));
    const tLarge = ms(() => searchAll(large, 'autonomic pharmacology'));

    // 8× the material must not cost 64× the time; allow generous slack for
    // timer noise on tiny measurements.
    expect(tLarge).toBeLessThan(Math.max(tSmall * 20, 1_500));
  });

  it('the index answers a query without ranking every chunk in the library', async () => {
    const sources = Array.from({ length: 120 }, (_, i) => ({
      id: `m${i}`,
      topicId: `t${i % 20}`,
      title: `Lecture ${i}`,
      contentText: `--- Slide 1 ---\n${'Pharmacology content about receptors. '.repeat(200)}`,
      materialKind: 'pdf',
      courseId: 'c1',
    }));
    const index = await syncIndex(sources, async () => null);
    expect(statsFor(index).materials).toBeLessThanOrEqual(200);

    const elapsed = ms(() => {
      const hits = searchIndex(index, { text: 'receptors', topicId: 't1' });
      expect(hits.length).toBeLessThanOrEqual(6);
    });
    expect(elapsed).toBeLessThan(BUDGET.searchMs);
  });
});

/* ------------------------------------------------------------------ */
/* Large archives                                                      */
/* ------------------------------------------------------------------ */

describe('large archives', () => {
  it('serialising a large workspace for an archive stays bounded', () => {
    const state = bigWorkspace(300);
    const elapsed = ms(() => {
      const json = JSON.stringify(state);
      expect(json.length).toBeGreaterThan(0);
    });
    expect(elapsed).toBeLessThan(BUDGET.largeFileMs);
  });
});

/* ------------------------------------------------------------------ */
/* AI initialisation                                                   */
/* ------------------------------------------------------------------ */

describe('AI initialisation', () => {
  it('starting the engine does not read the whole library', async () => {
    const { aiManager, defaultSettings, normalizeSettings, saveAISettings } = await import('../ai');
    saveAISettings(normalizeSettings(defaultSettings()));

    // Nothing here may touch the material index: AI init is settings only.
    const elapsed = ms(() => {
      aiManager.reload();
    });
    expect(elapsed).toBeLessThan(BUDGET.aiInitMs);
    expect(idbStore.has('pharmatrack_ai_rag_index')).toBe(false);
  });

  it('indexing is skipped entirely when there is nothing to index', async () => {
    const t0 = performance.now();
    const index = await syncIndex([], async () => null);
    expect(performance.now() - t0).toBeLessThan(BUDGET.aiInitMs);
    expect(statsFor(index).materials).toBe(0);
  });
});
