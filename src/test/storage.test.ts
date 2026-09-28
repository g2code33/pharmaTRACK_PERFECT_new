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

import { saveState, loadState, loadSlideText, deleteSlideText, saveFile, loadFile, loadFileBytes } from '../utils/storage';
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

/**
 * Regression tests for "Loading Material..." spinning forever when opening
 * a PDF/PPTX. Root cause: WebKit (and WebKitGTK, used by Tauri on Linux)
 * cannot reliably round-trip a Blob through IndexedDB, and reading a
 * previously-stored Blob back out can leave `.arrayBuffer()` pending with
 * no success, no error and nothing to catch. The fix has two parts:
 *   1. saveFile() never hands a Blob to IndexedDB — it always stores raw
 *      bytes, so nothing saved from now on can hit that failure mode.
 *   2. loadFileBytes() bounds how long it will wait to turn a (legacy)
 *      stored Blob into bytes, so a stuck read fails loudly instead of
 *      hanging the caller — and therefore the UI — forever.
 */
describe('file storage — Blob-through-IndexedDB safety', () => {
  it('saveFile converts a Blob/File to raw bytes before it ever reaches IndexedDB', async () => {
    const file = new Blob(['%PDF-1.4 fake pdf bytes'], { type: 'application/pdf' });
    await saveFile('doc1', file);

    const stored = idbStore.get('file_doc1');
    expect(stored).not.toBeInstanceOf(Blob);
    expect(stored).toBeInstanceOf(Uint8Array);
  });

  it('loadFile still returns whatever was stored (Uint8Array after the fix)', async () => {
    await saveFile('doc2', new Blob(['hello bytes']));
    const loaded = await loadFile('doc2');
    expect(loaded).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(loaded as Uint8Array)).toBe('hello bytes');
  });

  it('loadFileBytes transparently converts a legacy stored Blob to bytes', async () => {
    // Simulates a file saved by an older app version, before saveFile()
    // started normalizing to bytes.
    idbStore.set('file_legacy1', new Blob(['legacy blob content']));

    const bytes = await loadFileBytes('legacy1');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('legacy blob content');
  });

  it('loadFileBytes passes Uint8Array and string values through untouched', async () => {
    idbStore.set('file_bytes1', new Uint8Array([1, 2, 3]));
    expect(await loadFileBytes('bytes1')).toEqual(new Uint8Array([1, 2, 3]));

    idbStore.set('file_str1', 'data:application/pdf;base64,AAA=');
    expect(await loadFileBytes('str1')).toBe('data:application/pdf;base64,AAA=');
  });

  it('loadFileBytes resolves null when there is genuinely no file', async () => {
    expect(await loadFileBytes('never-uploaded')).toBeNull();
  });

  it('loadFileBytes rejects with a clear message instead of hanging when a Blob never finishes reading', async () => {
    const stuck = new Blob(['irrelevant']);
    // Simulate the WebKit hang: arrayBuffer() never settles, ever.
    (stuck as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = () => new Promise(() => {});
    idbStore.set('file_stuck1', stuck);

    vi.useFakeTimers();
    try {
      const pending = loadFileBytes('stuck1');
      const assertion = expect(pending).rejects.toThrow(/did not finish within/i);
      await vi.advanceTimersByTimeAsync(25000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
