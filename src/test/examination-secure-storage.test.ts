import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for a real bug: `deviceKey()` used to re-resolve (and, on a
 * brand-new device, re-CREATE) the AES key on every single call with no
 * coordination. The first moments after opening the app fire off several
 * storage reads/writes close together — on a device with no key yet, two of
 * those could each decide "no key exists yet" and each generate and save
 * their OWN key, with whichever save landed last becoming the only key from
 * then on. Anything already encrypted under the other call's key becomes
 * permanently undecryptable — "first-time registration doesn't work
 * properly" and "an old registration can no longer log in" are exactly what
 * that looks like from the outside.
 */
const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: async (key: string) => idbStore.get(key),
  set: async (key: string, value: unknown) => {
    idbStore.set(key, value);
  },
  del: async (key: string) => {
    idbStore.delete(key);
  },
  keys: async () => [...idbStore.keys()],
  clear: async () => {
    idbStore.clear();
  },
}));

beforeEach(() => {
  idbStore.clear();
  // secureStorage.ts caches the resolved device key in module scope for the
  // (simulated) page's lifetime — reset the module between tests so each one
  // starts from a genuinely brand-new device, the exact scenario the race
  // happens in.
  vi.resetModules();
});

describe('secureStorage device key resolution', () => {
  it('uses exactly one device key even when many writes race on a brand-new device', async () => {
    const { loadEncryptedJson, saveEncryptedJson } = await import('../examination/secureStorage');
    await Promise.all([
      saveEncryptedJson('a', { n: 1 }),
      saveEncryptedJson('b', { n: 2 }),
      saveEncryptedJson('c', { n: 3 }),
      saveEncryptedJson('d', { n: 4 }),
    ]);

    // Every value written during the race must still be readable — with the
    // old bug, at least one of these would throw because it was encrypted
    // under a key the store no longer has.
    expect(await loadEncryptedJson('a')).toEqual({ n: 1 });
    expect(await loadEncryptedJson('b')).toEqual({ n: 2 });
    expect(await loadEncryptedJson('c')).toEqual({ n: 3 });
    expect(await loadEncryptedJson('d')).toEqual({ n: 4 });
  });

  it('a registration-style write survives more concurrent activity racing right after it', async () => {
    const { loadEncryptedJson, saveEncryptedJson } = await import('../examination/secureStorage');
    await saveEncryptedJson('first', { student: 'Blessing' });
    await Promise.all([
      saveEncryptedJson('second', { student: 'Jojo' }),
      loadEncryptedJson('first'),
      saveEncryptedJson('third', { student: 'Ama' }),
    ]);
    expect(await loadEncryptedJson('first')).toEqual({ student: 'Blessing' });
    expect(await loadEncryptedJson('second')).toEqual({ student: 'Jojo' });
    expect(await loadEncryptedJson('third')).toEqual({ student: 'Ama' });
  });

  it('a device key created by an earlier page load is reused, not regenerated, on the next read', async () => {
    const first = await import('../examination/secureStorage');
    await first.saveEncryptedJson('student', { firstName: 'Kwame' });

    // Simulate a brand-new page session (new module instance) reading what
    // the previous session wrote — this is the real register-then-reload or
    // register-on-one-tab-then-log-in-on-another flow.
    vi.resetModules();
    const second = await import('../examination/secureStorage');
    expect(await second.loadEncryptedJson('student')).toEqual({ firstName: 'Kwame' });
  });
});
