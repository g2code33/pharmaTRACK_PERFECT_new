/**
 * Self-healing drop-in for `idb-keyval`'s default store.
 *
 * Root cause #1 this fixes (seen on WebKitGTK / Tauri Linux, reported as
 * "Complete Semester" always failing with the same storage error no matter
 * how many times it is retried):
 *
 *   idb-keyval's `createStore()` opens the database once and caches the
 *   connection promise in a module-level variable (`dbp`). That cache is
 *   only ever cleared by the `db.onclose` handler — NEVER when the initial
 *   `indexedDB.open()` request itself fails. WebKitGTK can transiently fail
 *   that very first open() call at cold start (before its storage backend is
 *   fully attached). Once that happens, idb-keyval's shared default store is
 *   permanently wedged to a rejected promise for the rest of the page's
 *   lifetime: every future get/set/keys/etc. call — across the WHOLE app,
 *   not just the archive flow — rejects with that exact same error, forever,
 *   until the app is fully restarted. That is exactly the symptom reported:
 *   "still same error", unresolved by simply clicking retry.
 *
 * Root cause #2 this fixes (reported as "Loading Material..." spinning
 * forever when opening a PDF/PPTX):
 *
 *   The above self-heal only fires when an operation REJECTS. Some
 *   WebKitGTK builds instead let an `indexedDB.open()` request or a
 *   transaction just sit there — it never calls `onsuccess`, `onerror`, nor
 *   `onblocked` — so the returned promise neither resolves nor rejects,
 *   ever. A plain `await` on that promise hangs the calling code (and any
 *   UI state gated on it, e.g. a loading spinner) forever, with nothing to
 *   catch. There is no way to make the browser finish a request it has
 *   already abandoned, so the only correct fix is to stop waiting on it:
 *   race every operation against a timeout and, on timeout, treat it
 *   exactly like a rejection — heal by opening a fresh connection and
 *   retrying once, so a wedged connection self-repairs instead of hanging
 *   the app indefinitely.
 *
 * Fix: keep our own `UseStore` (created via idb-keyval's own `createStore`,
 * so it talks to the very same physical database/object store — no data
 * migration needed) and, if any operation through it fails OR simply never
 * settles within `DEFAULT_TIMEOUT_MS`, throw the cached connection away and
 * retry exactly once against a brand new `indexedDB.open()`. A transient
 * cold-start failure or a wedged connection now self-heals instead of
 * bricking the session; a genuinely persistent failure (real quota
 * exhaustion, storage permanently denied, a hang that recurs even after a
 * fresh connection, …) still surfaces truthfully — as a normal rejection —
 * after the retry, instead of hanging forever.
 *
 * Falls back to calling idb-keyval's plain functions directly whenever
 * `createStore` isn't available (e.g. tests that mock the whole
 * `idb-keyval` module with bare get/set/del stubs) — so this is a
 * behavior-preserving change everywhere except the real IndexedDB backend.
 */
import * as idbKeyval from 'idb-keyval';

const DB_NAME = 'keyval-store';
const STORE_NAME = 'keyval';

/**
 * How long a single IndexedDB operation is allowed to sit with no result
 * before it is treated as wedged. Generous on purpose — a large slide/PDF
 * legitimately takes real time on slow disks — but finite, because no
 * amount of waiting ever un-wedges a request WebKitGTK has abandoned.
 */
export const DEFAULT_TIMEOUT_MS = 20000;

type UseStore = ReturnType<typeof idbKeyval.createStore>;

let store: UseStore | undefined;

// Vitest's module mocks are proxies that THROW (not just return undefined)
// when a property the mock factory didn't define is read — so this has to be
// a try/catch, not a plain `typeof` check, or every test that mocks
// `idb-keyval` with a bare `{ get, set, ... }` object (i.e. almost all of
// them) would crash instead of falling back to the plain pass-through below.
const realCreateStore = (): typeof idbKeyval.createStore | undefined => {
  try {
    return typeof idbKeyval.createStore === 'function' ? idbKeyval.createStore : undefined;
  } catch {
    return undefined;
  }
};

const currentStore = (): UseStore | undefined => {
  const factory = realCreateStore();
  if (!factory) return undefined;
  if (!store) store = factory(DB_NAME, STORE_NAME);
  return store;
};

const resetStore = (): void => {
  store = undefined;
};

class IdbTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`IndexedDB ${label} did not respond within ${ms}ms — the connection appears stuck.`);
    this.name = 'IdbTimeoutError';
  }
}

/**
 * Races `promise` against a timer. The original promise is never cancelled
 * (browsers give us no way to cancel a live IDB request) — it is simply
 * abandoned and left to settle on its own later, silently, while the caller
 * moves on as if it had rejected.
 */
const withTimeout = <T>(promise: Promise<T>, label: string, ms: number): Promise<T> => {
  if (!ms) return promise;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IdbTimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Runs `op` against the current store. On failure OR on timeout, when a
 * real store is in play, discards it and retries exactly once with a
 * freshly opened connection. Test mocks (no `createStore`) pass `undefined`
 * through unchanged and skip the timeout race, so they behave exactly as
 * before this wrapper existed (and never wait out a real timer).
 */
async function withRetry<T>(
  label: string,
  op: (store: UseStore | undefined) => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const first = currentStore();
  try {
    return await (first ? withTimeout(op(first), label, timeoutMs) : op(first));
  } catch (err) {
    if (!first) throw err; // nothing to heal (mocked / no real IndexedDB backend)
    resetStore();
    const second = currentStore();
    return withTimeout(op(second), label, timeoutMs);
  }
}

// `T = any` (not `unknown`) intentionally matches idb-keyval's own
// `get<T = any>` default, so untyped call sites keep inferring the same way.
export const get = <T = any>(key: IDBValidKey): Promise<T | undefined> =>
  withRetry('get', (s) => idbKeyval.get<T>(key, s));

export const set = (key: IDBValidKey, value: unknown): Promise<void> =>
  withRetry('set', (s) => idbKeyval.set(key, value, s));

export const del = (key: IDBValidKey): Promise<void> => withRetry('del', (s) => idbKeyval.del(key, s));

export const delMany = (keys: IDBValidKey[]): Promise<void> =>
  withRetry('delMany', (s) => idbKeyval.delMany(keys, s));

export const clear = (): Promise<void> => withRetry('clear', (s) => idbKeyval.clear(s));

export const keys = <T extends IDBValidKey = string>(): Promise<T[]> =>
  withRetry('keys', (s) => idbKeyval.keys<T>(s));

/** Exposed for callers/tests that need to force a brand-new connection. */
export const __resetDefaultStore = resetStore;
