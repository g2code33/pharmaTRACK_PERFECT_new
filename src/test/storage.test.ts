/**
 * Tests for the slide-text offload.
 *
 * Extracted PDF text was stored in full inside the localStorage blob. At 200
 * slides that blob hit ~2 MB and JSON.stringify blocked the main thread for
 * ~13 ms on every save; localStorage's ~5 MB cap also meant a heavy user would
 * eventually hit QuotaExceededError and silently stop saving.
 *
 * Full text now lives in IndexedDB. Slides keep a truncated copy so global
 * search still works offline without an async lookup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => { idbStore.set(k, v); },
  del: async (k: string) => { idbStore.delete(k); },
}));

import { saveState, loadState, loadSlideText, deleteSlideText } from '../utils/storage';
import type { AppState } from '../types';

const LONG = 'Pharmacology lecture content. '.repeat(500); // ~15 KB

const makeState = (contentText: string): AppState => ({
  isLoggedIn: false,
  student: { id: 'u1', name: 'Ama', university: 'UCC', level: '300', program: 'Pharm.D', semester: '1st', createdAt: '2024-01-01' },
  courses: [], topics: [],
  slides: [{ id: 'slide-1', topicId: 't1', slideNumber: 1, title: 'Beta blockers', contentText, status: 'not_started', createdAt: '2024-01-01' }],
  learningObjectives: [], examQuestions: [], quizHistory: [], studyPlans: [],
  notes: [], examDates: [], activities: [], chatHistory: [], highlights: [],
  savedInsights: [], openAIKey: '', timetables: { class: [], quiz: [], exam: [] }, timetablePdf: null,
});

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
});

describe('slide text offload', () => {
  it('keeps long text out of the localStorage blob', async () => {
    saveState(makeState(LONG));

    const raw = localStorage.getItem('pharmatrack_state')!;
    expect(raw.length).toBeLessThan(LONG.length);
    // The full text must not be sitting in localStorage any more.
    expect(raw).not.toContain(LONG);
  });

  it('preserves the full text in IndexedDB', async () => {
    saveState(makeState(LONG));
    await Promise.resolve(); // the offload write is fire-and-forget

    expect(await loadSlideText('slide-1')).toBe(LONG);
  });

  it('keeps enough text inline for global search to still match', () => {
    // Layout.tsx searches slide.contentText synchronously; truncating to
    // nothing would silently break search for every long slide.
    saveState(makeState(LONG));

    const saved = JSON.parse(localStorage.getItem('pharmatrack_state')!);
    expect(saved.slides[0].contentText.length).toBe(2000);
    expect(saved.slides[0].contentText).toContain('Pharmacology');
  });

  it('leaves short text untouched', () => {
    const short = 'Just a quick note.';
    saveState(makeState(short));

    const saved = JSON.parse(localStorage.getItem('pharmatrack_state')!);
    expect(saved.slides[0].contentText).toBe(short);
    expect(idbStore.has('slidetext_slide-1')).toBe(false);
  });

  it('round-trips through loadState with the slide intact', () => {
    saveState(makeState(LONG));
    const restored = loadState();

    expect(restored.slides).toHaveLength(1);
    expect(restored.slides[0].title).toBe('Beta blockers');
    expect(restored.student?.name).toBe('Ama');
  });

  it('deletes offloaded text so nothing is orphaned', async () => {
    saveState(makeState(LONG));
    await Promise.resolve();
    expect(await loadSlideText('slide-1')).toBe(LONG);

    await deleteSlideText('slide-1');
    expect(await loadSlideText('slide-1')).toBeNull();
  });

  it('does not throw when storage is full', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Must not crash the app mid-study; it should report instead.
    expect(() => saveState(makeState(LONG))).not.toThrow();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Storage full'), expect.anything());

    spy.mockRestore();
    err.mockRestore();
  });
});
