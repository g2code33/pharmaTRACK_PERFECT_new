import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for a real bug report: on a device whose local
 * IndexedDB is unreliable, a student could register successfully (the UI
 * showed a password) and then fail to log in moments later with the exact
 * same details, and the admin/builder password gates would reject the
 * correct password with "Could not check the password" — all because a
 * failed read/write silently lost data or blocked a check that should have
 * still succeeded. This file jams the mocked `idb-keyval` backend on demand
 * to prove the fixes hold even when the underlying store is completely
 * broken.
 */
const { idbStore, jam } = vi.hoisted(() => ({
  idbStore: new Map<string, unknown>(),
  // Toggle these from within a test to simulate a wedged/broken IndexedDB.
  jam: { get: false, set: false },
}));

vi.mock('idb-keyval', () => ({
  get: async (key: string) => {
    if (jam.get) throw new Error('Simulated IndexedDB read failure');
    return idbStore.get(key);
  },
  set: async (key: string, value: unknown) => {
    if (jam.set) throw new Error('Simulated IndexedDB write failure');
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

import { ExaminationRepository } from '../examination/service';
import { loadExaminationState, saveExaminationState } from '../examination/storage';
import { emptyExaminationState } from '../examination/types';
import { verifyBuilderPassword, verifyAdminPassword } from '../examination/adminGate';
import { __storageFallback } from '../examination/secureStorage';

beforeEach(() => {
  idbStore.clear();
  jam.get = false;
  jam.set = false;
  // secureStorage.ts latches "IndexedDB is broken" for the rest of the page
  // session once it has seen a real failure — reset that latch between
  // tests too, or an earlier test's simulated break would silently keep
  // routing every later test straight to localStorage.
  __storageFallback.reset();
  localStorage.clear();
});

describe('Examination storage resilience', () => {
  it('falls back to the last known-good in-memory state when a read fails, instead of an empty one', async () => {
    const populated = { ...emptyExaminationState(), importedPackageKeys: ['abc'] };
    expect(await saveExaminationState(populated)).toBe(true);
    expect((await loadExaminationState()).importedPackageKeys).toEqual(['abc']);

    jam.get = true;
    const fallback = await loadExaminationState();
    expect(fallback.importedPackageKeys).toEqual(['abc']);
  });

  it('a registration made in one repository instance survives a broken read in the next, within the same session', async () => {
    const repoA = await ExaminationRepository.open();
    const { password } = await repoA.registerStudent('Blessing', 'Level 300');

    // Simulate the device's storage becoming unreadable right after
    // registration — exactly the reported symptom (login fails moments
    // after a successful-looking registration).
    jam.get = true;
    const repoB = await ExaminationRepository.open();
    const authenticated = await repoB.authenticateStudent('Blessing', 'Level 300', password);
    expect(authenticated.firstName).toBe('Blessing');
  });

  it('a write survives entirely through the local storage fallback when IndexedDB itself is broken', async () => {
    // secureStorage.ts now mirrors into localStorage as a last-resort
    // backend — a device whose IndexedDB never works at all (a real,
    // reported failure on some locked-down Windows WebView2 profiles) can
    // still save and read back an exam attempt, instead of being told the
    // write quietly failed.
    jam.set = true;
    jam.get = true;
    const populated = { ...emptyExaminationState(), importedPackageKeys: ['via-fallback'] };
    expect(await saveExaminationState(populated)).toBe(true);
    expect((await loadExaminationState()).importedPackageKeys).toEqual(['via-fallback']);
  });

  it('saveExaminationState reports failure but never throws when truly nothing can store it', async () => {
    jam.set = true;
    jam.get = true;
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('Simulated local storage quota failure');
      });
    try {
      await expect(saveExaminationState(emptyExaminationState())).resolves.toBe(false);
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('the builder and admin gates still accept the seed password when storage cannot be read or written at all', async () => {
    jam.get = true;
    jam.set = true;
    expect(await verifyBuilderPassword('admin123')).toBe(true);
    expect(await verifyAdminPassword('godnogosHamEi2')).toBe(true);
    expect(await verifyBuilderPassword('definitely-wrong')).toBe(false);
  });
});

