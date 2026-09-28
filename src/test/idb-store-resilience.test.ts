/**
 * Regression test for the "Complete Semester always fails with the same
 * error" bug: idb-keyval's own module-level default store caches a REJECTED
 * connection promise forever once `indexedDB.open()` fails once — every
 * later get/set call (in the real app: the semester archive's preflight
 * probe and file-copy loop) then repeats that exact same rejection for the
 * rest of the app session, no matter how many times the user retries.
 *
 * `../utils/idbStore` is the fix: it owns its own connection and, on any
 * failure, discards it and retries once against a freshly opened database
 * instead of reusing the poisoned one. This test drives a minimal fake
 * `indexedDB` that fails only the very first `open()` call (mirroring the
 * transient WebKitGTK cold-start failure) and asserts that a `set`/`get`
 * through our wrapper still succeeds — proving the session is not bricked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A tiny fake IndexedDB sufficient for idb-keyval's exact call pattern:
//   indexedDB.open(name) -> onupgradeneeded, onsuccess/onerror
//   db.transaction(store, mode).objectStore(store).put/get/delete/getAllKeys
//   idb-keyval awaits the REQUEST for get(), and the TRANSACTION for set()/del().
class FakeRequest<T = unknown> {
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result: T | undefined;
  error: unknown;
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

function makeFakeIndexedDB(opts: { failOpensRemaining: number }) {
  const data = new Map<string, unknown>();

  class FakeObjectStore {
    put(value: unknown, key: string) {
      data.set(key, value);
    }
    get(key: string) {
      const req = new FakeRequest();
      req.result = data.get(key);
      queueMicrotask(() => req.onsuccess?.());
      return req;
    }
    delete(key: string) {
      data.delete(key);
    }
    getAllKeys() {
      const req = new FakeRequest();
      req.result = [...data.keys()];
      queueMicrotask(() => req.onsuccess?.());
      return req;
    }
  }

  class FakeDB {
    onclose: (() => void) | null = null;
    transaction(_storeName: string, _mode: string) {
      const tx = new FakeTransaction();
      const store = new FakeObjectStore() as unknown as IDBObjectStore & { transaction: FakeTransaction };
      (store as unknown as { transaction: FakeTransaction }).transaction = tx;
      queueMicrotask(() => tx.oncomplete?.());
      return { objectStore: () => store };
    }
  }

  const fakeIndexedDB = {
    open(_name: string) {
      const req = new FakeRequest<FakeDB>();
      if (opts.failOpensRemaining > 0) {
        opts.failOpensRemaining -= 1;
        queueMicrotask(() => {
          req.error = new DOMException('cold-start hiccup', 'UnknownError');
          req.onerror?.();
        });
      } else {
        req.result = new FakeDB();
        queueMicrotask(() => req.onsuccess?.());
      }
      return req;
    },
  };

  return fakeIndexedDB;
}

describe('idbStore self-healing (WebKitGTK cold-start regression)', () => {
  let originalIndexedDB: unknown;

  beforeEach(() => {
    originalIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB;
    vi.resetModules();
  });

  afterEach(() => {
    (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDB;
  });

  it('recovers after the very first indexedDB.open() fails, instead of failing forever', async () => {
    // The real bug: idb-keyval's own default store never recovers from this.
    (globalThis as { indexedDB?: unknown }).indexedDB = makeFakeIndexedDB({ failOpensRemaining: 1 });

    const idb = await import('../utils/idbStore');

    // First call hits the broken open() once, self-heals, and still succeeds.
    await expect(idb.set('k1', 'hello')).resolves.toBeUndefined();
    await expect(idb.get('k1')).resolves.toBe('hello');

    // Subsequent calls keep working (no permanently poisoned connection).
    await expect(idb.set('k2', 'world')).resolves.toBeUndefined();
    await expect(idb.get('k2')).resolves.toBe('world');
  });

  it('still surfaces a genuine, persistent failure after the one retry', async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = makeFakeIndexedDB({ failOpensRemaining: 1000 });

    const idb = await import('../utils/idbStore');

    await expect(idb.set('k1', 'hello')).rejects.toBeTruthy();
  });
});
