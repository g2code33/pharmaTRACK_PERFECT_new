import { AppState, Course, Topic, Slide, LearningObjective, ExamQuestion, QuizHistory, StudyPlan, Note, ExamDate, Activity } from '../types';
import { DEFAULT_LEARNING_SETTINGS } from './learningEngine';
import * as idb from './idbStore';
import {
  allowWorkspacePersist,
  blockWorkspacePersist,
  isWorkspacePersistBlocked,
  workspacePersistBlockReason,
} from './persistGuard';

const STORAGE_KEY = 'pharmatrack_state';

export {
  allowWorkspacePersist,
  blockWorkspacePersist,
  isWorkspacePersistBlocked,
  workspacePersistBlockReason,
};

export type WorkspaceRawStatus = 'missing' | 'ok' | 'malformed' | 'unavailable';

/** Read the semester file without replacing it. Never writes. */
export function readWorkspaceRaw(): { raw: string | null; status: WorkspaceRawStatus } {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { raw: null, status: 'unavailable' };
  }
  if (raw == null) return { raw: null, status: 'missing' };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { raw, status: 'malformed' };
    return { raw, status: 'ok' };
  } catch {
    return { raw, status: 'malformed' };
  }
}

export const initialState: AppState = {
  isLoggedIn: false,
  student: null,
  courses: [],
  topics: [],
  slides: [],
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
  learningRecords: [],
  learningSettings: DEFAULT_LEARNING_SETTINGS,
  openAIKey: '',
  timetables: { class: [], quiz: [], exam: [] },
  timetablePdf: null,
};

export const loadState = (): AppState => {
  const { raw, status } = readWorkspaceRaw();
  if (status === 'unavailable' || status === 'malformed') {
    // Return an empty in-memory workspace, but do not write it back. The raw
    // file is still in localStorage and saveState will refuse to replace it.
    blockWorkspacePersist(
      status === 'unavailable'
        ? 'localStorage could not be read, so PharmaTRACK will not overwrite whatever is still stored.'
        : 'Saved semester data could not be read, so it will not be overwritten.',
    );
    if (status === 'malformed') console.error('Error loading state from localStorage: saved data is not valid JSON.');
    return initialState;
  }
  if (status === 'missing' || raw == null) {
    allowWorkspacePersist();
    return initialState;
  }
  try {
    allowWorkspacePersist();
    return { ...initialState, ...JSON.parse(raw) };
  } catch (err) {
    blockWorkspacePersist('Saved semester data could not be read, so it will not be overwritten.');
    console.error('Error loading state from localStorage:', err);
    return initialState;
  }
};

/**
 * Extracted PDF/DOCX text can run to tens of KB per slide. Kept in full it
 * dominates the saved blob: 200 slides serialised to ~2 MB and blocked the main
 * thread for ~13 ms on every save, and localStorage's ~5 MB cap meant a heavy
 * user would eventually hit QuotaExceededError and silently stop saving.
 *
 * Slides keep a truncated copy so global search still works offline with no
 * async lookup, and the full text lives in IndexedDB (no practical size limit),
 * fetched only when a slide is actually opened.
 */
const CONTENT_TEXT_SEARCH_LIMIT = 2000;

const fullTextKey = (slideId: string) => `slidetext_${slideId}`;

/** Full extracted text for a slide, or null if it was never long enough to offload. */
export const loadSlideText = async (slideId: string): Promise<string | null> => {
  try {
    return (await idb.get(fullTextKey(slideId))) ?? null;
  } catch (err) {
    console.error(`Error loading slide text ${slideId}:`, err);
    return null;
  }
};

export const deleteSlideText = async (slideId: string): Promise<void> => {
  try {
    await idb.del(fullTextKey(slideId));
  } catch (err) {
    console.error(`Error deleting slide text ${slideId}:`, err);
  }
};

export const saveState = (state: AppState): void => {
  // Never replace a file we could not parse. A migration that needs to write
  // does so only after a verified safety copy, and it does not come through here.
  const existing = readWorkspaceRaw();
  if (existing.status === 'malformed' || existing.status === 'unavailable') {
    const reason = existing.status === 'unavailable'
      ? 'localStorage could not be read, so PharmaTRACK will not overwrite whatever is still stored.'
      : 'Saved semester data could not be read, so it will not be overwritten.';
    blockWorkspacePersist(reason);
    console.error(`Refusing to save over stored data: ${reason}`);
    return;
  }
  if (isWorkspacePersistBlocked()) allowWorkspacePersist();

  try {
    let offloaded = 0;

    const slides = state.slides.map((slide) => {
      const text = slide.contentText;
      if (!text || text.length <= CONTENT_TEXT_SEARCH_LIMIT) return slide;

      // Write the full text to IndexedDB in the background. If it fails the
      // truncated copy is still saved, so search keeps working and the only
      // loss is the tail of the text — never the slide itself.
      offloaded += 1;
      idb.set(fullTextKey(slide.id), text).catch((err) =>
        console.error(`Error offloading slide text ${slide.id}:`, err),
      );

      return { ...slide, contentText: text.slice(0, CONTENT_TEXT_SEARCH_LIMIT) };
    });

    const serializedState = JSON.stringify(
      offloaded > 0 ? { ...state, slides } : state,
    );
    localStorage.setItem(STORAGE_KEY, serializedState);
  } catch (err) {
    // A quota error here used to be invisible: saving just stopped and the
    // user kept working, losing everything on close. Make it loud.
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      console.error(
        'Storage full — your data could not be saved. Export a backup from Settings.',
        err,
      );
    } else {
      console.error('Error saving state to localStorage:', err);
    }
  }
};

// File Storage using IndexedDB (for large files like PDFs, audio, images)

/**
 * How long a Blob → bytes conversion is allowed to take before it is
 * treated as stuck. Generous — a large PDF/PPTX can legitimately take a
 * moment — but finite; see `blobToBytes` for why an unbounded wait is
 * never correct here.
 */
const BLOB_READ_TIMEOUT_MS = 20000;

/**
 * Reads a Blob's bytes without ever hanging forever.
 *
 * Root cause of "Loading Material..." spinning forever when opening a
 * PDF/PPTX: WebKit (and therefore WebKitGTK, which Tauri uses on Linux)
 * cannot reliably round-trip a `Blob`/`File` THROUGH IndexedDB — storing
 * one can fail with an uninformative transaction error, and reading one
 * back out can leave `.arrayBuffer()` pending with no success, no error,
 * nothing to `catch` (see e.g. the WebKit "blobs in IndexedDB are
 * unreliable" reports; Firefox, Chromium and Node have all shipped their
 * own variants of "arrayBuffer() on this Blob never resolves"). Once that
 * happens, `await file.arrayBuffer()` really does hang forever — there is
 * no event coming — so the only correct fix is to race it against a timeout
 * and fail loudly instead of waiting out eternity.
 *
 * Tries the modern `Blob.arrayBuffer()` first (fast, works everywhere for a
 * blob that has never touched IndexedDB), then falls back to `FileReader`
 * for engines where `arrayBuffer()` itself is missing (older Safari; also
 * absent in some non-browser test environments).
 */
const blobToBytes = (blob: Blob, timeoutMs: number = BLOB_READ_TIMEOUT_MS): Promise<Uint8Array> => {
  const read: Promise<ArrayBuffer> = typeof blob.arrayBuffer === 'function'
    ? blob.arrayBuffer()
    : new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
        reader.readAsArrayBuffer(blob);
      });

  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Reading this file's bytes did not finish within ${timeoutMs}ms — the file may be corrupted or this device's storage may be stuck.`)),
      timeoutMs,
    );
    read.then(
      (buf) => { clearTimeout(timer); resolve(new Uint8Array(buf)); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
};

/**
 * Persists a file's bytes to IndexedDB.
 *
 * Returns `true` once the write has actually been confirmed to succeed, and
 * `false` (after logging the real error) if it did not — it never throws.
 *
 * That return value matters: every upload flow creates its material/slide
 * record ONLY after this resolves, so a caller that ignored a failure here
 * used to go on to create a normal-looking material whose bytes were never
 * actually saved. The reader would then open it later and report "No file
 * is stored for this material" — indistinguishable, from the user's side,
 * from an upload that silently failed with no error at all. Callers must
 * check this and stop (surfacing a clear error immediately, before the
 * record is created) rather than proceeding as if the save worked.
 */
export const saveFile = async (id: string, file: Blob | Uint8Array | string): Promise<boolean> => {
  try {
    // Never hand a Blob/File to IndexedDB — always store raw bytes instead.
    // This is the actual fix, applied at the one place every upload path
    // (drag-drop, file picker, bulk upload, edit-and-replace) funnels
    // through: it means no file saved from here on can ever hit the
    // WebKit "Blob through IndexedDB" failure mode on load, because
    // nothing we ever wrote is a Blob to begin with.
    const toStore = file instanceof Blob ? await blobToBytes(file) : file;
    await idb.set(`file_${id}`, toStore);
    return true;
  } catch (err) {
    console.error(`Error saving file ${id} to IndexedDB:`, err);
    return false;
  }
};

export const loadFile = async (id: string): Promise<Blob | Uint8Array | string | null> => {
  try {
    const file = await idb.get(`file_${id}`);
    return file || null;

  } catch (err) {
    console.error(`Error loading file ${id} from IndexedDB:`, err);
    return null;
  }
};

/**
 * Like `loadFile()`, but guarantees the result is never a raw `Blob`.
 *
 * A `Blob` is the one shape `loadFile()` can still return that is unsafe to
 * hand to `pdf.js`/OCR/MIME-sniffing code as-is: on some WebKitGTK builds,
 * a `Blob` that was round-tripped through IndexedDB (saved by an older
 * version of this app, before `saveFile()` started storing raw bytes) can
 * leave `.arrayBuffer()` pending forever. Every call site that needs actual
 * bytes should call this instead of doing its own `instanceof Blob` /
 * `.arrayBuffer()` dance.
 *
 * Resolves to `null` when there is genuinely no file (never uploaded, or a
 * true IndexedDB error — `loadFile()` already logs and swallows those).
 * REJECTS (does not silently hang or return null) when the file exists but
 * its bytes could not be read within the timeout — callers should show a
 * clear "couldn't load, please re-upload" message on that path rather than
 * leaving a loading spinner running forever.
 */
export const loadFileBytes = async (id: string): Promise<Uint8Array | string | null> => {
  const file = await loadFile(id);
  if (file == null) return null;
  if (file instanceof Blob) return blobToBytes(file);
  return file;
};

export const deleteFile = async (id: string): Promise<void> => {
  try {
    await idb.del(`file_${id}`);
  } catch (err) {
    console.error(`Error deleting file ${id} from IndexedDB:`, err);
  }
};

export const clearState = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.error('Error clearing state from localStorage:', err);
  }
};
