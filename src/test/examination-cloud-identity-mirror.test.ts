import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ensureLocalStudentForCloudIdentity() is the bridge between a kiosk
 * student who authenticated against the administrator's cloud roster (see
 * examination/kioskRoster.ts, never tested with real local storage) and
 * this device's existing, entirely local/offline examination engine, which
 * only ever knows ExamStudent.id. It must create the local record once and
 * reuse it on every later call with the same cloud id — including from a
 * brand-new device, which is the whole point of routing identity through
 * the administrator.
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

import { ExaminationRepository } from '../examination/service';

beforeEach(() => idbStore.clear());

describe('ensureLocalStudentForCloudIdentity', () => {
  it('creates a local student record under the cloud-issued id', async () => {
    const repository = await ExaminationRepository.open();
    const student = await repository.ensureLocalStudentForCloudIdentity(
      'cloud-student-123',
      'Efua',
      'Level 300',
    );
    expect(student.id).toBe('cloud-student-123');
    expect(student.firstName).toBe('Efua');
    expect(student.level).toBe('Level 300');
    expect(repository.snapshot.students.some((item) => item.id === 'cloud-student-123')).toBe(true);
  });

  it('reuses the same local record on a second call with the same cloud id, even from a fresh device', async () => {
    const first = await ExaminationRepository.open();
    await first.ensureLocalStudentForCloudIdentity('cloud-student-123', 'Efua', 'Level 300');

    // Simulate the SAME student logging in on a different device: a fresh
    // repository instance reading the same underlying storage.
    const second = await ExaminationRepository.open();
    const student = await second.ensureLocalStudentForCloudIdentity(
      'cloud-student-123',
      'Efua',
      'Level 300',
    );
    expect(student.id).toBe('cloud-student-123');
    expect(
      second.snapshot.students.filter((item) => item.id === 'cloud-student-123'),
    ).toHaveLength(1);
  });

  it('never lets the local mirror be used to authenticate a different password', async () => {
    const repository = await ExaminationRepository.open();
    await repository.ensureLocalStudentForCloudIdentity('cloud-student-123', 'Efua', 'Level 300');
    // The local offline authenticateStudent() path must not succeed for this
    // mirrored identity under any guessed password — the cloud roster is
    // the only real gate once an account is cloud-referenced.
    await expect(
      repository.authenticateStudent('Efua', 'Level 300', 'RX30a'),
    ).rejects.toThrow('First name, level, or RX30 Kiosk password is incorrect.');
  });
});
