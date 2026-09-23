/**
 * Tests for full-text search inside uploaded documents.
 *
 * Global search reads `slide.contentText`, but saveState caps that at 2000
 * characters to stay under the localStorage quota. So a keyword on page 40 of
 * a lecture was genuinely unfindable, even though the text had been extracted
 * at upload. This index keeps the full per-page text in IndexedDB and is what
 * makes those matches reachable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => { idbStore.set(k, v); },
  del: async (k: string) => { idbStore.delete(k); },
}));

import {
  loadSearchIndex, indexDocument, removeFromIndex, searchDeep, __resetIndex,
} from '../utils/searchIndex';
import { searchAll } from '../utils/search';
import type { AppState } from '../types';

/** Text long enough that the localStorage preview would have cut it off. */
const FILLER = 'General pharmacology background material. '.repeat(80); // ~3.3k chars

beforeEach(async () => {
  idbStore.clear();
  __resetIndex();
  await loadSearchIndex();
});

const seed = () => indexDocument({
  materialId: 'm1',
  topicId: 't1',
  title: 'Sterilization 2026',
  pages: [
    { page: 1, text: 'Title slide. Introduction to sterilization.' },
    { page: 2, text: FILLER },
    { page: 40, text: `${FILLER} Depyrogenation removes bacterial endotoxins from glassware.` },
  ],
});

const searchState = {
  isLoggedIn: false,
  student: null,
  courses: [],
  topics: [{ id: 't1', courseId: 'c1', topicName: 'Beta blockers', orderIndex: 0, createdAt: '' }],
  slides: [{
    id: 's1',
    topicId: 't1',
    slideNumber: 1,
    title: 'Beta blockers',
    contentText: '--- Slide 1 ---\nIntroduction',
    fileType: 'text',
    status: 'not_started',
    createdAt: '',
  }],
  notes: [],
  examQuestions: [],
  learningObjectives: [],
  highlights: [],
  quizHistory: [],
  studyPlans: [],
  examDates: [],
  activities: [],
  chatHistory: [],
  savedInsights: [],
  openAIKey: '',
  timetables: { class: [], quiz: [], exam: [] },
  timetablePdf: null,
} as unknown as AppState;

describe('deep document search', () => {
  it('names the slide and links the search result to that slide', async () => {
    await indexDocument({
      materialId: 's1',
      topicId: 't1',
      title: 'Beta blockers',
      pages: [{ page: 23, text: 'Propranolol is used when a beta blocker is required.' }],
    });
    const hit = searchAll(searchState, 'propranolol').find((r) => r.category === 'In document');
    expect(hit?.title).toBe('Beta blockers → Slide 23');
    expect(hit?.link).toContain('/read/t1?');
    expect(hit?.link).toContain('material=s1');
    expect(hit?.link).toContain('page=23');
  });

  it('keeps PDF hits labelled as pages', async () => {
    await indexDocument({
      materialId: 'pdf1',
      topicId: 't1',
      title: 'Handout',
      pages: [{ page: 4, text: 'The renal clearance of digoxin.' }],
    });
    const pdfState = {
      ...searchState,
      slides: [{
        id: 'pdf1',
        topicId: 't1',
        slideNumber: 1,
        title: 'Handout',
        contentText: '--- Page 1 ---\nIntro',
        fileType: 'pdf',
        materialKind: 'pdf',
        status: 'not_started',
        createdAt: '',
      }],
    } as unknown as AppState;
    const hit = searchAll(pdfState, 'digoxin').find((r) => r.category === 'In document');
    expect(hit?.title).toBe('Handout → Page 4');
    expect(hit?.link).toContain('page=4');
  });

  it('finds a keyword far past the 2000-character preview limit', async () => {
    await seed();
    const hits = searchDeep('depyrogenation');

    expect(hits).toHaveLength(1);
    expect(hits[0].page).toBe(40);
    expect(hits[0].materialId).toBe('m1');
  });

  it('returns the phrase in context so the result is recognisable', async () => {
    await seed();
    expect(searchDeep('endotoxins')[0].snippet).toContain('endotoxins');
  });

  it('carries the topic and title needed to build a link back', async () => {
    await seed();
    const [hit] = searchDeep('depyrogenation');
    expect(hit.topicId).toBe('t1');
    expect(hit.title).toBe('Sterilization 2026');
  });

  it('treats multiple words as AND on the same page', async () => {
    await seed();
    expect(searchDeep('depyrogenation endotoxins')).toHaveLength(1);
    // "depyrogenation" is on page 40, "title" on page 1 - no single page has both.
    expect(searchDeep('depyrogenation title')).toHaveLength(0);
  });

  it('ignores very short queries', async () => {
    await seed();
    expect(searchDeep('de')).toEqual([]);
  });

  it('is case insensitive', async () => {
    await seed();
    expect(searchDeep('DEPYROGENATION')).toHaveLength(1);
  });

  it('ranks pages with more occurrences first', async () => {
    await indexDocument({
      materialId: 'm2', topicId: 't1', title: 'Deck',
      pages: [
        { page: 1, text: 'buffer' },
        { page: 2, text: 'buffer buffer buffer buffer' },
      ],
    });
    expect(searchDeep('buffer')[0].page).toBe(2);
  });

  it('survives a reload from IndexedDB', async () => {
    await seed();
    // Simulate a fresh app start against the same IndexedDB contents.
    __resetIndex();
    await loadSearchIndex();

    expect(searchDeep('depyrogenation')).toHaveLength(1);
  });

  it('drops a document from the index when it is deleted', async () => {
    await seed();
    await removeFromIndex('m1');
    expect(searchDeep('depyrogenation')).toEqual([]);
  });

  it('returns nothing when the index is empty', () => {
    expect(searchDeep('anything')).toEqual([]);
  });
});
