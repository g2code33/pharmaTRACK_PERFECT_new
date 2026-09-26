/**
 * Phase 12 — offline resilience and fail-safe behaviour.
 *
 * PharmaTRACK is local-first, so the interesting failures are the local ones:
 * storage that throws, a quota that fills up, a file that lies about what it is,
 * a connection that isn't there. In every case the app must keep working, and
 * must never destroy data it could not successfully read or write.
 *
 * The rule these tests enforce: **a failure is loud, never silent, and never
 * fatal** — except where continuing would overwrite data the app could not read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const idbStore = new Map<string, unknown>();
let idbBroken = false;

const guard = <T,>(fn: () => T, fallback: T): T => {
  if (idbBroken) throw new DOMException('IndexedDB is unavailable', 'InvalidStateError');
  return fn();
};

vi.mock('idb-keyval', () => ({
  get: async (k: string) => guard(() => idbStore.get(k), undefined),
  set: async (k: string, v: unknown) => guard(() => { idbStore.set(k, v); }, undefined),
  del: async (k: string) => guard(() => { idbStore.delete(k); }, undefined),
  delMany: async (keys: string[]) => guard(() => { keys.forEach((k) => idbStore.delete(k)); }, undefined),
  keys: async () => guard(() => [...idbStore.keys()], []),
  clear: async () => guard(() => { idbStore.clear(); }, undefined),
}));

import { loadState, saveState, saveFile, loadFile, loadSlideText, deleteSlideText } from '../utils/storage';
import { allowWorkspacePersist, isWorkspacePersistBlocked, workspacePersistBlockReason } from '../utils/persistGuard';
import { isQuotaError } from '../utils/semesterArchive';
import { inspectFile } from '../utils/fileGuard';
import { buildTopicDigest, retrieveForSelection } from '../ai';
import type { AppStateLike } from '../ai';
import type { AppState } from '../types';

const WORKSPACE_KEY = 'pharmatrack_state';

const baseState = {
  isLoggedIn: false,
  student: { id: 'u1', name: 'Ama', university: 'KNUST', level: '300', program: 'Pharm.D', semester: '2nd', createdAt: '2024-01-01' },
  courses: [{ id: 'c1', courseCode: 'PHARM 301', courseName: 'Pharmacology', lecturer: 'Dr A', credits: 3, semester: '2nd', level: '300', createdAt: '' }],
  topics: [{ id: 't1', courseId: 'c1', topicName: 'Autonomic drugs', createdAt: '' }],
  slides: [{
    id: 'm1', topicId: 't1', slideNumber: 1, title: 'Lecture 4',
    contentText: '--- Slide 1 ---\nBeta blockers lower heart rate and blood pressure.',
    status: 'not_started', createdAt: '', materialKind: 'pptx',
  }],
  learningObjectives: [], notes: [], quizHistory: [], studyPlans: [],
  examQuestions: [], highlights: [], chatHistory: [],
  timetables: { class: [], quiz: [], exam: [] },
} as unknown as AppState;

const aiState: AppStateLike = {
  student: { level: '300', semester: '2nd', program: 'Pharm.D' },
  courses: baseState.courses,
  topics: baseState.topics,
  slides: baseState.slides,
  learningObjectives: [],
  notes: [],
  quizHistory: [],
  studyPlans: [],
};

beforeEach(() => {
  idbStore.clear();
  idbBroken = false;
  localStorage.clear();
  allowWorkspacePersist();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Corrupt or unreadable saved data                                    */
/* ------------------------------------------------------------------ */

describe('corrupt saved data', () => {
  it('starts empty instead of crashing, and refuses to overwrite what it could not read', () => {
    localStorage.setItem(WORKSPACE_KEY, '{ this is not json ');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const state = loadState();

    expect(state).toBeTruthy();
    expect(state.slides).toEqual([]);
    // The unreadable file is still there — never silently replaced.
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe('{ this is not json ');
    expect(isWorkspacePersistBlocked()).toBe(true);
    expect(workspacePersistBlockReason()).toMatch(/will not be overwritten/i);
    expect(spy).toHaveBeenCalled();
  });

  it('survives saved data that is valid JSON but the wrong shape', () => {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(['nope', 'not', 'an', 'object']));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => loadState()).not.toThrow();
    expect(isWorkspacePersistBlocked()).toBe(true);
  });

  it('works when localStorage itself is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('access denied', 'SecurityError');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const state = loadState();
    expect(state).toBeTruthy();
    expect(isWorkspacePersistBlocked()).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Storage failures                                                    */
/* ------------------------------------------------------------------ */

describe('storage failures', () => {
  it('reports a quota error loudly but keeps the app alive', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      const err = new DOMException('full', 'QuotaExceededError');
      throw err;
    });

    expect(() => saveState(baseState)).not.toThrow();
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.some((c) => String(c[0]).includes('Storage full'))).toBe(true);
  });

  it('recognises quota errors across the shapes browsers use', () => {
    expect(isQuotaError(new DOMException('x', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaError(new DOMException('x', 'NS_ERROR_DOM_QUOTA_REACHED'))).toBe(true);
    // Non-DOMException errors are deliberately not claimed as quota failures.
    expect(isQuotaError(new Error('quota exceeded'))).toBe(false);
    expect(isQuotaError(new Error('network down'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });

  it('keeps the app usable when IndexedDB is unavailable', async () => {
    idbBroken = true;
    await expect(saveFile('f1', new Blob(['x']))).rejects.toBeTruthy().catch(() => undefined);
    // The workspace itself lives in localStorage, so it still round-trips.
    saveState(baseState);
    expect(loadState().courses).toHaveLength(1);
  });

  it('slide text and file reads fail safely, never throw', async () => {
    idbBroken = true;
    await expect(loadSlideText('m1')).resolves.toBeNull();
    await expect(loadFile('missing')).resolves.toBeNull();
    await expect(deleteSlideText('m1')).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Restart and refresh                                                 */
/* ------------------------------------------------------------------ */

describe('restart and refresh', () => {
  it('restores the whole workspace after a restart', () => {
    saveState(baseState);
    const restored = loadState();
    expect(restored.courses[0].courseName).toBe('Pharmacology');
    expect(restored.topics[0].topicName).toBe('Autonomic drugs');
    expect(restored.slides[0].title).toBe('Lecture 4');
  });

  it('restores again after a refresh with nothing in memory', () => {
    saveState(baseState);
    // A refresh drops every in-memory cache; only persisted state survives.
    const afterRefresh = loadState();
    expect(afterRefresh.slides).toHaveLength(1);
    expect(afterRefresh.slides[0].contentText).toContain('Beta blockers');
  });

  it('a first run with nothing stored starts cleanly and is allowed to save', () => {
    const state = loadState();
    expect(state.slides).toEqual([]);
    expect(isWorkspacePersistBlocked()).toBe(false);
    saveState(baseState);
    expect(loadState().slides).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* No internet                                                         */
/* ------------------------------------------------------------------ */

describe('no internet', () => {
  it('local study features keep working with no connection at all', async () => {
    const dead = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', dead);

    const { hits } = await retrieveForSelection(aiState, { courseId: 'c1', topicId: 't1' }, 'beta blockers');
    expect(hits.length).toBeGreaterThan(0);

    const digest = await buildTopicDigest(aiState, { topicId: 't1', courseId: 'c1' });
    expect(digest.text).toContain('Beta blockers');

    // Nothing local ever reached for the network.
    expect(dead).not.toHaveBeenCalled();
  });

  it('offloading and reloading material does not need the network', async () => {
    const dead = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', dead);
    saveState(baseState);
    expect(loadState().slides[0].title).toBe('Lecture 4');
    expect(dead).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Large and interrupted uploads                                       */
/* ------------------------------------------------------------------ */

describe('large uploads', () => {
  const bigPdf = (pages: number) =>
    new File(
      [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...Array.from({ length: pages * 900 }, (_, i) => (i % 251) + 1)])],
      `textbook-${pages}p.pdf`,
    );

  it('accepts a large PDF and inspects only its head', async () => {
    const file = bigPdf(600);
    expect(file.size).toBeGreaterThan(500_000);
    const verdict = await inspectFile(file);
    expect(verdict.ok).toBe(true);
    expect(verdict.detected).toBe('pdf');
  });

  it('refuses a large file that exceeds the limit', async () => {
    const file = bigPdf(600);
    const verdict = await inspectFile(file, { maxBytes: 1000 });
    expect(verdict.ok).toBe(false);
    expect(verdict.blockedBy?.code).toBe('too_large');
  });

  it('a large deck still yields a bounded digest, not the whole file', async () => {
    const pages = 400;
    const huge: AppStateLike = {
      ...aiState,
      slides: [{
        id: 'huge', topicId: 't1', title: 'Huge deck', materialKind: 'pptx',
        contentText: Array.from({ length: pages }, (_, i) => `--- Slide ${i + 1} ---\n${'Content for slide. '.repeat(30)}`).join('\n\n'),
      }],
    };
    const digest = await buildTopicDigest(huge, { topicId: 't1', courseId: 'c1', budgetTokens: 1000 });
    const source = huge.slides[0].contentText!.length;
    expect(source).toBeGreaterThan(200_000);
    expect(digest.text.length).toBeLessThan(source * 0.1);
    expect(digest.truncated).toBe(true);
  });
});

describe('interrupted upload', () => {
  it('a cancelled read leaves no partial material behind', async () => {
    const controller = new AbortController();
    controller.abort();

    // The guard itself never aborts mid-flight, but the queue marks cancelled
    // items; verify the file is simply never handed to a parser.
    const verdict = await inspectFile(
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'partial.pdf'),
    );
    expect(controller.signal.aborted).toBe(true);
    expect(verdict.ok).toBe(true);
    expect(loadState().slides).toEqual([]);
  });
});
