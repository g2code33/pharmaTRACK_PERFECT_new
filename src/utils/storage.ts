import { AppState } from '../types';
import { DEFAULT_LEARNING_SETTINGS } from './learningEngine';
import * as idb from './idbStore';
import { isTauriRuntime } from '../platform/runtime';
import { scheduleBackgroundWork } from './idleScheduler';
import {
  allowWorkspacePersist,
  blockWorkspacePersist,
  isWorkspacePersistBlocked,
  workspacePersistBlockReason,
} from './persistGuard';

const STORAGE_KEY = 'pharmatrack_state';
const WORKSPACE_VALIDATION_CACHE_MS = 30_000;
let lastKnownWorkspaceRaw: string | null | undefined;
let lastWorkspaceValidationAt = 0;
const offloadedTextSignatures = new Map<string, string>();

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
  if (raw == null) {
    lastKnownWorkspaceRaw = null;
    lastWorkspaceValidationAt = Date.now();
    offloadedTextSignatures.clear();
    return { raw: null, status: 'missing' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { raw, status: 'malformed' };
    lastKnownWorkspaceRaw = raw;
    lastWorkspaceValidationAt = Date.now();
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
  offloadedTextSignatures.delete(slideId);
  try {
    await idb.del(fullTextKey(slideId));
  } catch (err) {
    console.error(`Error deleting slide text ${slideId}:`, err);
  }
};

const textSignature = (text: string): string => (
  `${text.length}:${text.charCodeAt(0) || 0}:${text.charCodeAt(Math.floor(text.length / 2)) || 0}:${text.charCodeAt(text.length - 1) || 0}`
);

const ensureWorkspaceCanBeWritten = (): boolean => {
  if (isWorkspacePersistBlocked()) return false;
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    const reason = 'localStorage could not be read, so PharmaTRACK will not overwrite whatever is still stored.';
    blockWorkspacePersist(reason);
    console.error(`Refusing to save over stored data: ${reason}`);
    return false;
  }

  const validationFresh = Date.now() - lastWorkspaceValidationAt < WORKSPACE_VALIDATION_CACHE_MS;
  if (validationFresh && raw === lastKnownWorkspaceRaw) return true;
  if (raw == null) {
    lastKnownWorkspaceRaw = null;
    lastWorkspaceValidationAt = Date.now();
    offloadedTextSignatures.clear();
    return true;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Stored state is not an object.');
    lastKnownWorkspaceRaw = raw;
    lastWorkspaceValidationAt = Date.now();
    return true;
  } catch {
    const reason = 'Saved semester data could not be read, so it will not be overwritten.';
    blockWorkspacePersist(reason);
    console.error(`Refusing to save over stored data: ${reason}`);
    return false;
  }
};

export const saveState = (state: AppState): void => {
  // Never replace a file we could not parse. A migration that needs to write
  // does so only after a verified safety copy, and it does not come through here.
  // The validation result is cached briefly so frequent autosaves do not parse
  // the whole workspace before serialising it again.
  if (!ensureWorkspaceCanBeWritten()) return;
  allowWorkspacePersist();

  try {
    let offloaded = 0;

    const slides = state.slides.map((slide) => {
      const text = slide.contentText;
      if (!text || text.length <= CONTENT_TEXT_SEARCH_LIMIT) return slide;

      // Write the full text to IndexedDB in the background. If it fails the
      // truncated copy is still saved, so search keeps working and the only
      // loss is the tail of the text — never the slide itself. The signature
      // check prevents rewriting the same long text on every autosave.
      offloaded += 1;
      const signature = textSignature(text);
      if (offloadedTextSignatures.get(slide.id) !== signature) {
        offloadedTextSignatures.set(slide.id, signature);
        idb.set(fullTextKey(slide.id), text).catch((err) => {
          offloadedTextSignatures.delete(slide.id);
          console.error(`Error offloading slide text ${slide.id}:`, err);
        });
      }

      return { ...slide, contentText: text.slice(0, CONTENT_TEXT_SEARCH_LIMIT) };
    });

    const serializedState = JSON.stringify(
      offloaded > 0 ? { ...state, slides } : state,
    );
    localStorage.setItem(STORAGE_KEY, serializedState);
    lastKnownWorkspaceRaw = serializedState;
    lastWorkspaceValidationAt = Date.now();
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

type StoredFileBytes = Uint8Array | string;

type CachedFileBytes = {
  value: StoredFileBytes;
  bytes: number;
  touchedAt: number;
};

/**
 * Keep opened/uploaded files warm in memory for this app session. PharmaTRACK is
 * local-first, so a material that was just uploaded or recently opened should
 * not have to round-trip through IndexedDB/Tauri IPC again before the viewer can
 * paint. The cap prevents a very large library from turning this speed cache
 * into a memory leak; older entries are evicted first.
 */
const FILE_CACHE_MAX_BYTES = 384 * 1024 * 1024;
const FILE_CACHE_MAX_ENTRIES = 64;
const fileByteCache = new Map<string, CachedFileBytes>();
const pendingFileLoads = new Map<string, Promise<StoredFileBytes | null>>();

const storedByteLength = (value: StoredFileBytes): number => (
  typeof value === 'string' ? value.length * 2 : value.byteLength
);

const cachedByteTotal = (): number => {
  let total = 0;
  fileByteCache.forEach((entry) => { total += entry.bytes; });
  return total;
};

const enforceFileCacheLimit = () => {
  while (fileByteCache.size > FILE_CACHE_MAX_ENTRIES || cachedByteTotal() > FILE_CACHE_MAX_BYTES) {
    let oldestKey = '';
    let oldestTouch = Number.POSITIVE_INFINITY;
    fileByteCache.forEach((entry, key) => {
      if (entry.touchedAt < oldestTouch) {
        oldestTouch = entry.touchedAt;
        oldestKey = key;
      }
    });
    if (!oldestKey) break;
    fileByteCache.delete(oldestKey);
  }
};

const rememberFileBytes = (id: string, value: StoredFileBytes): void => {
  const bytes = storedByteLength(value);
  if (bytes > FILE_CACHE_MAX_BYTES) return;
  fileByteCache.set(id, { value, bytes, touchedAt: Date.now() });
  enforceFileCacheLimit();
};

const cachedFileBytes = (id: string): StoredFileBytes | undefined => {
  const cached = fileByteCache.get(id);
  if (!cached) return undefined;
  cached.touchedAt = Date.now();
  return cached.value;
};

export const forgetCachedFile = (id: string): void => {
  fileByteCache.delete(id);
  pendingFileLoads.delete(id);
};

const scheduleFileWarmup = (callback: () => void, delay = 0): void => {
  scheduleBackgroundWork(callback, {
    delay,
    timeout: 6000,
    retryDelay: 800,
    quietWindowMs: 2000,
    minTimeRemaining: 16,
    runWhenTimedOut: false,
  });
};

/**
 * Background-read material files into the session cache without blocking the
 * first screen. The reader still works if a warmup fails; opening the file will
 * try again and show a proper error if the local copy is missing/corrupt.
 */
export const prewarmFileBytes = (ids: string[], maxToWarm = 12): void => {
  const queue = Array.from(new Set(ids)).filter((id) => id && !fileByteCache.has(id)).slice(0, maxToWarm);
  if (!queue.length) return;

  const warmNext = () => {
    const id = queue.shift();
    if (!id) return;
    void loadFileBytes(id)
      .catch(() => undefined)
      .finally(() => {
        if (queue.length) scheduleFileWarmup(warmNext, 80);
      });
  };

  scheduleFileWarmup(warmNext, 250);
};

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

const NATIVE_FILE_CHUNK_BYTES = 512 * 1024;

type NativeFileInfo = { size: number };

type NativeLoadResult = Uint8Array | null | undefined;

const stringToBytes = (value: string): Uint8Array => {
  if (value.startsWith('data:')) {
    const base64Data = value.split(',')[1];
    if (base64Data) {
      const binaryString = window.atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
      return bytes;
    }
  }
  return new TextEncoder().encode(value);
};

const toFileBytes = async (file: Blob | Uint8Array | string): Promise<Uint8Array | string> => {
  if (file instanceof Blob) return blobToBytes(file);
  return file;
};

const nativePayloadBytes = (value: Uint8Array | string): Uint8Array => (
  typeof value === 'string' ? stringToBytes(value) : value
);

const invokeNativeFile = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
};

const normalizeNativeChunk = (chunk: unknown): Uint8Array => {
  if (chunk instanceof Uint8Array) return chunk;
  if (Array.isArray(chunk)) return Uint8Array.from(chunk as number[]);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (chunk && typeof chunk === 'object' && 'buffer' in chunk) {
    const maybeView = chunk as ArrayBufferView;
    if (maybeView.buffer instanceof ArrayBuffer) {
      return new Uint8Array(maybeView.buffer, maybeView.byteOffset, maybeView.byteLength);
    }
  }
  throw new Error('Native file storage returned an unreadable byte chunk.');
};

/**
 * Native Tauri storage fallback for Ubuntu/Debian builds.
 *
 * IndexedDB is the right backend in browsers, but WebKitGTK can fail IDB writes
 * inside installed .deb apps even when the disk is not full. When the Tauri
 * bridge is present, store uploaded document bytes in the app data directory
 * via small chunks, avoiding the broken WebKitGTK path entirely. If the native
 * command is unavailable (old binary, web/PWA, tests), callers fall back to IDB.
 */
const saveNativeFile = async (id: string, value: Uint8Array | string): Promise<boolean> => {
  if (!isTauriRuntime()) return false;

  const bytes = nativePayloadBytes(value);
  let started = false;
  try {
    await invokeNativeFile<void>('save_material_file_start', { id });
    started = true;
    for (let offset = 0; offset < bytes.byteLength; offset += NATIVE_FILE_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + NATIVE_FILE_CHUNK_BYTES));
      // Tauri IPC serialises byte vectors as JSON-compatible number arrays.
      // Chunking keeps the payload size bounded for 100 MB lecture files.
      await invokeNativeFile<void>('save_material_file_chunk', { id, bytes: Array.from(chunk) });
    }
    await invokeNativeFile<void>('save_material_file_finish', { id });
    return true;
  } catch (err) {
    if (started) {
      try { await invokeNativeFile<void>('save_material_file_abort', { id }); } catch { /* ignore cleanup failure */ }
    }
    console.error(`Native file storage could not save ${id}; falling back to IndexedDB:`, err);
    return false;
  }
};

const loadNativeFileBytes = async (id: string): Promise<NativeLoadResult> => {
  if (!isTauriRuntime()) return undefined;
  try {
    const info = await invokeNativeFile<NativeFileInfo | null>('material_file_info', { id });
    if (!info) return null;

    const size = Math.max(0, Number(info.size) || 0);
    const out = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      const length = Math.min(NATIVE_FILE_CHUNK_BYTES, size - written);
      const chunk = normalizeNativeChunk(await invokeNativeFile<unknown>('load_material_file_chunk', {
        id,
        offset: written,
        length,
      }));
      out.set(chunk, written);
      written += chunk.byteLength;
      if (chunk.byteLength === 0 && written < size) {
        throw new Error('Native file storage returned an empty chunk before the file was fully read.');
      }
    }
    return out;
  } catch (err) {
    console.error(`Native file storage could not load ${id}; falling back to IndexedDB:`, err);
    return undefined;
  }
};

const deleteNativeFile = async (id: string): Promise<void> => {
  if (!isTauriRuntime()) return;
  try {
    await invokeNativeFile<void>('delete_material_file', { id });
  } catch (err) {
    console.error(`Native file storage could not delete ${id}:`, err);
  }
};

/**
 * Persists a file's bytes to durable local storage.
 *
 * In the native desktop app this first uses Tauri's app-data directory, then
 * falls back to IndexedDB. In the browser/PWA it uses IndexedDB only.
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
    // Never hand a Blob/File to storage — always store raw bytes instead.
    // This fixes two WebKitGTK/Tauri Linux failure modes at once:
    //   1. IndexedDB may reject Blob/File values or later hang reading them.
    //   2. On some installed .deb builds, IndexedDB rejects perfectly valid
    //      large byte writes; native app-data storage succeeds there.
    const toStore = await toFileBytes(file);

    if (await saveNativeFile(id, toStore)) {
      rememberFileBytes(id, toStore);
      return true;
    }

    await idb.set(`file_${id}`, toStore);
    rememberFileBytes(id, toStore);
    return true;
  } catch (err) {
    console.error(`Error saving file ${id} to storage:`, err);
    return false;
  }
};

export const loadFile = async (id: string): Promise<Blob | Uint8Array | string | null> => {
  const nativeFile = await loadNativeFileBytes(id);
  if (nativeFile !== undefined && nativeFile !== null) return nativeFile;

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
  const cached = cachedFileBytes(id);
  if (cached !== undefined) return cached;

  const pending = pendingFileLoads.get(id);
  if (pending) return pending;

  const load = (async () => {
    const file = await loadFile(id);
    if (file == null) return null;
    const bytes = file instanceof Blob ? await blobToBytes(file) : file;
    rememberFileBytes(id, bytes);
    return bytes;
  })();

  pendingFileLoads.set(id, load);
  try {
    return await load;
  } finally {
    pendingFileLoads.delete(id);
  }
};

export const deleteFile = async (id: string): Promise<void> => {
  forgetCachedFile(id);
  await deleteNativeFile(id);
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
