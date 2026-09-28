/**
 * Self-healing drop-in for `idb-keyval`'s default store.
 *
 * Root cause this fixes (seen on WebKitGTK / Tauri Linux, reported as
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
 * Fix: keep our own `UseStore` (created via idb-keyval's own `createStore`,
 * so it talks to the very same physical database/object store — no data
 * migration needed) and, if any operation through it fails, throw the
 * cached connection away and retry exactly once against a brand new
 * `indexedDB.open()`. A transient cold-start failure now self-heals instead
 * of bricking the session; a genuinely persistent failure (real quota
 * exhaustion, storage permanently denied, …) still surfaces truthfully
 * after the retry.
 *
 * Falls back to calling idb-keyval's plain functions directly whenever
 * `createStore` isn't available (e.g. tests that mock the whole
 * `idb-keyval` module with bare get/set/del stubs) — so this is a
 * behavior-preserving change everywhere except the real IndexedDB backend.
 */
import * as idbKeyval from 'idb-keyval';

const DB_NAME = 'keyval-store';
const STORE_NAME = 'keyval';

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

/**
 * Runs `op` against the current store. On failure, when a real store is in
 * play, discards it and retries exactly once with a freshly opened
 * connection. Test mocks (no `createStore`) pass `undefined` through
 * unchanged, so they behave exactly as before this wrapper existed.
 */
async function withRetry<T>(op: (store: UseStore | undefined) => Promise<T>): Promise<T> {
  const first = currentStore();
  try {
    return await op(first);
  } catch (err) {
    if (!first) throw err; // nothing to heal (mocked / no real IndexedDB backend)
    resetStore();
    return op(currentStore());
  }
}

// `T = any` (not `unknown`) intentionally matches idb-keyval's own
// `get<T = any>` default, so untyped call sites keep inferring the same way.
export const get = <T = any>(key: IDBValidKey): Promise<T | undefined> =>
  withRetry((s) => idbKeyval.get<T>(key, s));

export const set = (key: IDBValidKey, value: unknown): Promise<void> =>
  withRetry((s) => idbKeyval.set(key, value, s));

export const del = (key: IDBValidKey): Promise<void> => withRetry((s) => idbKeyval.del(key, s));

export const delMany = (keys: IDBValidKey[]): Promise<void> => withRetry((s) => idbKeyval.delMany(keys, s));

export const clear = (): Promise<void> => withRetry((s) => idbKeyval.clear(s));

export const keys = <T extends IDBValidKey = string>(): Promise<T[]> => withRetry((s) => idbKeyval.keys<T>(s));

/** Exposed for callers/tests that need to force a brand-new connection. */
export const __resetDefaultStore = resetStore;
