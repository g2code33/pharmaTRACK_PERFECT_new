import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for the "no manual sync" requirement: a kiosk result
 * reported while offline (or during a transient Supabase error) must not be
 * silently lost — it must queue locally and then push itself to the admin's
 * cloud account automatically the moment connectivity is back, without the
 * student or admin doing anything.
 *
 * The module under test registers its auto-flush 'online' listener once, at
 * import time, exactly like it does on a real page — so this file imports
 * it once (no vi.resetModules() per test) rather than re-importing per test,
 * which would otherwise stack up one duplicate listener per test.
 */
const { submitMock, store } = vi.hoisted(() => ({
  submitMock: vi.fn(),
  store: new Map<string, unknown>(),
}));

vi.mock('../examination/kioskRoster', () => ({
  submitKioskExamResultToAdmin: submitMock,
}));

vi.mock('../examination/secureStorage', () => ({
  saveEncryptedJson: async (key: string, value: unknown) => {
    store.set(key, value);
  },
  loadEncryptedJson: async (key: string) => (store.has(key) ? store.get(key) : null),
}));

const {
  submitOrQueueKioskExamResult,
  hasQueuedKioskResult,
  flushKioskResultOutbox,
} = await import('../examination/kioskResultOutbox');

const originalOnLine = navigator.onLine;
function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

const samplePayload = {
  joinCode: 'AB12CD',
  studentId: 's1',
  examKey: 'exam-1',
  examTitle: 'Finals',
  scorePercentage: 87.5,
  submittedAt: '2026-10-20T12:00:00.000Z',
};

beforeEach(async () => {
  submitMock.mockReset();
  store.clear();
  setOnline(true);
  // Let any in-flight module-load-time flush (queue is empty, so a no-op)
  // settle before each test starts.
  await flushKioskResultOutbox();
});

afterEach(() => {
  setOnline(originalOnLine);
});

describe('kiosk result outbox — automatic offline-to-online sync', () => {
  it('submits directly and never queues anything when the report succeeds', async () => {
    submitMock.mockResolvedValue({ ok: true });
    await submitOrQueueKioskExamResult(samplePayload);
    expect(submitMock).toHaveBeenCalledTimes(1);
    // Nothing queued — a second flush should not call submit again.
    await flushKioskResultOutbox();
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('queues the result instead of dropping it when the device is offline', async () => {
    setOnline(false);
    submitMock.mockResolvedValue({ ok: false, reason: 'offline' });
    await submitOrQueueKioskExamResult(samplePayload);
    expect(await hasQueuedKioskResult('s1', 'exam-1')).toBe(true);
  });

  it('queues the result when the submit call throws instead of resolving', async () => {
    submitMock.mockRejectedValue(new Error('network blip'));
    await expect(submitOrQueueKioskExamResult(samplePayload)).resolves.toBeUndefined();
    expect(await hasQueuedKioskResult('s1', 'exam-1')).toBe(true);
  });

  it('flushing a queued result removes it from the queue once it succeeds', async () => {
    submitMock.mockResolvedValueOnce({ ok: false, reason: 'offline' });
    await submitOrQueueKioskExamResult(samplePayload);
    expect(await hasQueuedKioskResult('s1', 'exam-1')).toBe(true);

    submitMock.mockResolvedValueOnce({ ok: true });
    await flushKioskResultOutbox();
    expect(await hasQueuedKioskResult('s1', 'exam-1')).toBe(false);
    expect(submitMock).toHaveBeenCalledTimes(2);
  });

  it('a result still failing after a flush attempt stays queued for the next one', async () => {
    submitMock.mockResolvedValue({ ok: false, reason: 'error', message: 'temporary outage' });
    await submitOrQueueKioskExamResult(samplePayload);
    await flushKioskResultOutbox();
    expect(await hasQueuedKioskResult('s1', 'exam-1')).toBe(true);
  });

  it('automatically flushes once the browser reports it is back online, with no manual step', async () => {
    submitMock.mockResolvedValueOnce({ ok: false, reason: 'offline' });
    await submitOrQueueKioskExamResult(samplePayload);
    expect(await hasQueuedKioskResult('s1', 'exam-1')).toBe(true);

    submitMock.mockResolvedValueOnce({ ok: true });
    setOnline(true);
    window.dispatchEvent(new Event('online'));
    // The 'online' listener's flush is async — give its microtasks a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await hasQueuedKioskResult('s1', 'exam-1')).toBe(false);
  });

  it('re-queuing the same student + exam replaces the pending entry instead of duplicating it', async () => {
    submitMock.mockResolvedValue({ ok: false, reason: 'offline' });
    await submitOrQueueKioskExamResult(samplePayload);
    await submitOrQueueKioskExamResult({ ...samplePayload, scorePercentage: 91 });

    submitMock.mockClear();
    submitMock.mockResolvedValue({ ok: true });
    await flushKioskResultOutbox();
    // Exactly one submit for this student+exam pair, carrying the latest score.
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock).toHaveBeenCalledWith(expect.objectContaining({ scorePercentage: 91 }));
  });
});
