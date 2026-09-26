/**
 * Phase 11 — AI context engine & local RAG.
 *
 * These tests pin the properties the phase exists for:
 *
 *  • every chunk knows semester / course / topic / material / page / slide
 *  • retrieval is local (no network) and returns only what matched
 *  • large documents are chunked, never sent whole
 *  • source metadata survives the whole pipeline into the bundle
 *  • the index is incremental, derived, and never part of a semester backup
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { idbStore } = vi.hoisted(() => ({ idbStore: new Map<string, unknown>() }));

vi.mock('idb-keyval', () => ({
  get: (key: string) => Promise.resolve(idbStore.get(key)),
  set: (key: string, value: unknown) => {
    idbStore.set(key, value);
    return Promise.resolve();
  },
  del: (key: string) => {
    idbStore.delete(key);
    return Promise.resolve();
  },
}));

import {
  buildContext,
  buildTopicDigest,
  chunkSource,
  extractUnits,
  fingerprintText,
  indexableSources,
  loadRagIndex,
  RAG_INDEX_KEY,
  retrieveForSelection,
  searchIndex,
  sourceHeader,
  statsFor,
  syncIndex,
} from '../ai';
import type { AppStateLike } from '../ai';
import { PROTECTED_IDB_KEYS } from '../utils/semesterArchive';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const LECTURE_4 = [
  '--- Slide 21 ---',
  'Adrenergic antagonists block adrenoceptors. Propranolol is a non-selective beta blocker.',
  '--- Slide 22 ---',
  'Beta blockers reduce heart rate and blood pressure by lowering sympathetic tone.',
  '--- Slide 23 ---',
  'Adverse effects of beta blockers include bradycardia, bronchospasm in asthmatics and fatigue.',
  '--- Slide 24 ---',
  'Cardioselective beta blockers such as atenolol act mainly on beta-1 receptors.',
].join('\n');

const LECTURE_9 = [
  '--- Slide 2 ---',
  'Diuretics increase urine output. Loop diuretics act on the thick ascending limb.',
  '--- Slide 3 ---',
  'Thiazide diuretics act on the distal convoluted tubule and may cause hypokalaemia.',
].join('\n');

const state: AppStateLike = {
  student: { level: '300', semester: '2', program: 'PharmD' },
  courses: [{ id: 'c1', courseCode: 'PHARM 301', courseName: 'Pharmacology' }],
  topics: [
    { id: 't1', courseId: 'c1', topicName: 'Autonomic drugs' },
    { id: 't2', courseId: 'c1', topicName: 'Diuretics' },
  ],
  slides: [
    { id: 'm1', topicId: 't1', title: 'Lecture 4', contentText: LECTURE_4, materialKind: 'pptx' },
    { id: 'm2', topicId: 't2', title: 'Lecture 9', contentText: LECTURE_9, materialKind: 'pdf' },
  ],
  learningObjectives: [],
  notes: [],
  quizHistory: [],
  studyPlans: [],
};

const loadText = async () => null;

beforeEach(() => {
  idbStore.clear();
});

/* ------------------------------------------------------------------ */
/* Extraction & chunking                                              */
/* ------------------------------------------------------------------ */

describe('extraction keeps location', () => {
  it('splits marker text into located units', () => {
    const units = extractUnits(LECTURE_4);
    expect(units.length).toBe(4);
    expect(units.map((u) => u.slide)).toEqual([21, 22, 23, 24]);
    expect(units[2].text).toContain('bradycardia');
  });

  it('treats unmarked text as one unit', () => {
    const units = extractUnits('Just a plain note with no markers.');
    expect(units).toHaveLength(1);
    expect(units[0].slide).toBeUndefined();
    expect(units[0].page).toBeUndefined();
  });

  it('recognises page markers for PDFs', () => {
    const units = extractUnits('Page 1: intro\nPage 2: kinetics');
    expect(units.map((u) => u.page)).toEqual([1, 2]);
  });
});

describe('chunking attaches full metadata', () => {
  it('carries semester, course, topic, material and slide on every chunk', () => {
    const chunks = chunkSource(
      {
        id: 'm1',
        topicId: 't1',
        title: 'Lecture 4',
        materialKind: 'pptx',
        courseId: 'c1',
        courseCode: 'PHARM 301',
        courseName: 'Pharmacology',
        topicName: 'Autonomic drugs',
        semester: '2',
      },
      LECTURE_4,
    );

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.semester).toBe('2');
      expect(chunk.courseId).toBe('c1');
      expect(chunk.courseName).toBe('Pharmacology');
      expect(chunk.topicId).toBe('t1');
      expect(chunk.topicName).toBe('Autonomic drugs');
      expect(chunk.materialId).toBe('m1');
      expect(chunk.materialTitle).toBe('Lecture 4');
    }
    // Slide numbering survives: slide 23 is the one about adverse effects.
    const adverse = chunks.find((c) => c.slide === 23);
    expect(adverse?.text).toContain('bradycardia');
  });

  it('resolves academic metadata from app state', () => {
    const sources = indexableSources(state);
    const lecture4 = sources.find((s) => s.id === 'm1');
    expect(lecture4).toMatchObject({
      courseName: 'Pharmacology',
      courseCode: 'PHARM 301',
      topicName: 'Autonomic drugs',
      semester: '2',
    });
  });

  it('formats the source header the way the spec shows it', () => {
    expect(
      sourceHeader({
        courseId: 'c1',
        courseCode: 'PHARM 301',
        courseName: 'Pharmacology',
        topicId: 't1',
        topicName: 'Autonomic drugs',
        materialId: 'm1',
        materialTitle: 'Lecture 4',
        slide: 23,
      }),
    ).toBe(
      ['Course: PHARM 301 — Pharmacology', 'Topic: Autonomic drugs', 'Source: Lecture 4', 'Slide: 23'].join('\n'),
    );
  });

  it('fingerprints change when text changes', () => {
    expect(fingerprintText('same')).toBe(fingerprintText('same'));
    expect(fingerprintText('same')).not.toBe(fingerprintText('same!'));
  });
});

/* ------------------------------------------------------------------ */
/* Index: incremental, local, derived                                 */
/* ------------------------------------------------------------------ */

describe('local index', () => {
  it('indexes every material and persists to IndexedDB', async () => {
    const index = await syncIndex(indexableSources(state), loadText);
    expect(statsFor(index).materials).toBe(2);
    expect(statsFor(index).chunks).toBeGreaterThan(4);
    expect(idbStore.has(RAG_INDEX_KEY)).toBe(true);
  });

  it('does not re-chunk a material whose text has not changed', async () => {
    const first = await syncIndex(indexableSources(state), loadText);
    const before = first.materials.m1.indexedAt;
    const second = await syncIndex(indexableSources(state), loadText);
    expect(second.materials.m1.indexedAt).toBe(before);
    expect(second.materials.m1.chunks).toEqual(first.materials.m1.chunks);
  });

  it('re-chunks when the extracted text changes', async () => {
    const first = await syncIndex(indexableSources(state), loadText);
    const edited: AppStateLike = {
      ...state,
      slides: state.slides.map((s) => (s.id === 'm1' ? { ...s, contentText: `${LECTURE_4}\n--- Slide 25 ---\nNew content.` } : s)),
    };
    const second = await syncIndex(indexableSources(edited), loadText);
    expect(second.materials.m1.fingerprint).not.toBe(first.materials.m1.fingerprint);
    expect(second.materials.m1.chunks.length).toBeGreaterThan(first.materials.m1.chunks.length);
  });

  it('drops materials that no longer exist', async () => {
    await syncIndex(indexableSources(state), loadText);
    const reduced: AppStateLike = { ...state, slides: [state.slides[0]] };
    const index = await syncIndex(indexableSources(reduced), loadText);
    expect(index.materials.m2).toBeUndefined();
    expect(statsFor(index).materials).toBe(1);
  });

  it('is local: indexing and retrieval make no network call', async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as never;
    try {
      const index = await syncIndex(indexableSources(state), loadText);
      searchIndex(index, { text: 'adverse effects of beta blockers', topicId: 't1' });
    } finally {
      globalThis.fetch = original;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the index is excluded from semester backups', () => {
    expect(PROTECTED_IDB_KEYS.has(RAG_INDEX_KEY)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Retrieval: selective, scoped, bounded                              */
/* ------------------------------------------------------------------ */

describe('retrieval', () => {
  const build = async () => syncIndex(indexableSources(state), loadText);

  it('returns the passage that answers the question, with its slide', async () => {
    const index = await build();
    const hits = searchIndex(index, { text: 'adverse effects of beta blockers' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].slide).toBe(23);
    expect(hits[0].materialTitle).toBe('Lecture 4');
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('stays inside the topic when the answer is there', async () => {
    const index = await build();
    const hits = searchIndex(index, { text: 'beta blockers', topicId: 't1' });
    expect(hits.every((h) => h.topicId === 't1')).toBe(true);
  });

  it('widens to the course when the topic has no answer', async () => {
    const index = await build();
    const hits = searchIndex(index, { text: 'thiazide hypokalaemia', topicId: 't1' });
    // t1 is autonomic drugs; the answer only exists in the diuretics topic.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].topicId).toBe('t2');
  });

  it('never returns noise for an unrelated question', async () => {
    const index = await build();
    expect(searchIndex(index, { text: 'zzzz qqqq nothing here' })).toHaveLength(0);
  });

  it('excludes the material already in focus', async () => {
    const { hits } = await retrieveForSelection(
      state,
      { courseId: 'c1', topicId: 't1', materialId: 'm1' },
      'adverse effects of beta blockers',
    );
    expect(hits.every((h) => h.materialId !== 'm1')).toBe(true);
  });

  it('caps one huge material so it cannot crowd out the rest', async () => {
    const big: AppStateLike = {
      ...state,
      slides: [
        {
          id: 'big',
          topicId: 't1',
          title: 'Enormous lecture',
          materialKind: 'pdf',
          contentText: Array.from({ length: 60 }, (_, i) => `--- Slide ${i + 1} ---\nBeta blockers appear again on slide ${i + 1}.`).join(
            '\n',
          ),
        },
      ],
    };
    const index = await syncIndex(indexableSources(big), loadText);
    const hits = searchIndex(index, { text: 'beta blockers', perMaterial: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ */
/* Selective context: the bundle carries sources, not the library     */
/* ------------------------------------------------------------------ */

describe('selective context', () => {
  it('sends the slide in focus with its academic source header', () => {
    const bundle = buildContext(state, {
      courseId: 'c1',
      topicId: 't1',
      materialId: 'm1',
      slide: 23,
      materialText: {
        label: 'Lecture 4',
        text: LECTURE_4,
        slide: 23,
        focusText: 'Adverse effects of beta blockers include bradycardia, bronchospasm in asthmatics and fatigue.',
      },
    });

    const focus = bundle.blocks.find((b) => b.source.kind === 'slide');
    expect(focus).toBeTruthy();
    expect(focus!.text).toContain('Course: PHARM 301 — Pharmacology');
    expect(focus!.text).toContain('Topic: Autonomic drugs');
    expect(focus!.text).toContain('Source: Lecture 4');
    expect(focus!.text).toContain('Slide: 23');
    // The whole lecture is not in the bundle — only the slide in focus.
    expect(focus!.text).not.toContain('Propranolol is a non-selective');
    expect(focus!.source.courseId).toBe('c1');
    expect(focus!.source.topicId).toBe('t1');
  });

  it('labels retrieved passages with course, topic, material and slide', async () => {
    const { hits } = await retrieveForSelection(
      state,
      { courseId: 'c1', topicId: 't2', materialId: 'm2' },
      'adverse effects of beta blockers',
    );
    expect(hits.length).toBeGreaterThan(0);

    const bundle = buildContext(state, {
      courseId: 'c1',
      topicId: 't2',
      materialId: 'm2',
      retrieval: hits,
    });
    const retrieved = bundle.blocks.find((b) => b.source.kind === 'retrieval');
    expect(retrieved).toBeTruthy();
    expect(retrieved!.text).toContain('Course: PHARM 301 — Pharmacology');
    expect(retrieved!.text).toContain('Topic: Autonomic drugs');
    expect(retrieved!.text).toContain('Source: Lecture 4');
    expect(retrieved!.source.materialId).toBe('m1');
    expect(retrieved!.source.slide).toBe(23);
  });

  it('sends nothing but the academic position when nothing is selected', () => {
    const bundle = buildContext(state, { courseId: 'c1' });
    // No material was selected, so no material text of any kind is sent.
    expect(bundle.blocks.every((b) => b.source.kind !== 'material')).toBe(true);
    expect(bundle.blocks.every((b) => b.source.kind !== 'slide')).toBe(true);
    expect(bundle.blocks.every((b) => b.source.kind !== 'page')).toBe(true);
    const chars = bundle.blocks.reduce((sum, b) => sum + b.text.length, 0);
    expect(chars).toBeLessThan(500);
  });
});

/* ------------------------------------------------------------------ */
/* Large documents                                                    */
/* ------------------------------------------------------------------ */

describe('large documents', () => {
  const FILLER =
    'Filler paragraph about unrelated pharmacology content: receptor kinetics, dose calculations, ' +
    'formulation science and dispensing practice. '.repeat(10);

  const huge: AppStateLike = {
    ...state,
    slides: [
      {
        id: 'huge',
        topicId: 't1',
        title: '500-page textbook',
        materialKind: 'pdf',
        // ~300k characters across 400 pages: far beyond any context budget.
        contentText: Array.from(
          { length: 400 },
          (_, i) =>
            `Page ${i + 1}:\n${i === 137 ? 'The only place that mentions ototoxicity and aminoglycosides.' : `Section ${i + 1}. ${FILLER}`}`,
        ).join('\n\n'),
      },
    ],
  };

  it('retrieves only the matching section, not the document', async () => {
    const { hits } = await retrieveForSelection(huge, { courseId: 'c1', topicId: 't1' }, 'ototoxicity aminoglycosides');
    expect(hits.length).toBeGreaterThan(0);

    const sent = hits.reduce((sum, h) => sum + h.text.length, 0);
    const total = huge.slides[0].contentText!.length;
    expect(total).toBeGreaterThan(100_000);
    // A large document contributes a fraction of itself, never the whole file.
    expect(sent).toBeLessThan(total * 0.1);
    expect(hits.some((h) => h.text.includes('ototoxicity'))).toBe(true);
  });

  it('bounds a topic digest to the token budget', async () => {
    const digest = await buildTopicDigest(huge, { topicId: 't1', courseId: 'c1', budgetTokens: 2_000 });
    expect(digest.text.length).toBeGreaterThan(0);
    // 2,000 tokens ≈ 7,200 characters, plus a little slack for the last chunk.
    expect(digest.text.length).toBeLessThan(9_000);
    expect(digest.truncated).toBe(true);
    expect(digest.materialsUsed).toBe(1);
  });

  it('a digest keeps every passage labelled with its source', async () => {
    const digest = await buildTopicDigest(huge, { topicId: 't1', courseId: 'c1', budgetTokens: 1_000 });
    expect(digest.text).toContain('Course: PHARM 301 — Pharmacology');
    expect(digest.text).toContain('Source: 500-page textbook');
    expect(digest.hits.length).toBeGreaterThan(0);
    expect(digest.hits.every((h) => h.materialTitle === '500-page textbook')).toBe(true);
  });

  it('a digest spreads across the materials in a topic', async () => {
    const digest = await buildTopicDigest(state, { topicId: 't1', courseId: 'c1', budgetTokens: 2_000 });
    expect(digest.text).toContain('Lecture 4');
    expect(digest.materialsUsed).toBe(1);
  });

  it('a digest prefers the passages that match the question', async () => {
    const digest = await buildTopicDigest(state, {
      topicId: 't1',
      courseId: 'c1',
      query: 'bradycardia bronchospasm',
      budgetTokens: 1_000,
    });
    expect(digest.text).toContain('bradycardia');
  });
});

/* ------------------------------------------------------------------ */
/* Offline behaviour                                                  */
/* ------------------------------------------------------------------ */

describe('local-first', () => {
  it('retrieval works with no provider configured and no network', async () => {
    const fetchSpy = vi.fn();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as never;
    try {
      const { hits } = await retrieveForSelection(
        state,
        { courseId: 'c1', topicId: 't1' },
        'adverse effects of beta blockers',
      );
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].courseName).toBe('Pharmacology');
    } finally {
      globalThis.fetch = original;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a missing index yields no hits instead of throwing', async () => {
    const index = await loadRagIndex();
    expect(index.materials).toEqual({});
    expect(searchIndex(index, { text: 'anything' })).toEqual([]);
  });
});
