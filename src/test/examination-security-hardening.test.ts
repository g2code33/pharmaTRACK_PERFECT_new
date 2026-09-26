import { beforeEach, describe, expect, it, vi } from 'vitest';

const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: async (key: string) => idbStore.get(key),
  set: async (key: string, value: unknown) => idbStore.set(key, value),
  del: async (key: string) => idbStore.delete(key),
  keys: async () => [...idbStore.keys()],
  clear: async () => idbStore.clear(),
}));

import { ExaminationRepository } from '../examination/service';
import {
  enterSecureKiosk,
  getSecureKioskState,
  onBlockedKioskNavigation,
  recordBlockedKioskNavigation,
  releaseSecureKiosk,
  subscribeSecureKiosk,
} from '../examination/kioskState';
import type { ExamQuestion } from '../types';

const question = (id: string): ExamQuestion => ({
  id,
  courseId: 'course',
  topicId: 'topic',
  questionText: id,
  questionType: 'mcq',
  marksAllocation: 1,
  difficulty: 'easy',
  probability: 'medium',
  modelAnswer: 'A',
  correctAnswer: 'A',
  tags: [],
  isPracticed: false,
  needsReview: false,
  isSaved: false,
  createdAt: new Date().toISOString(),
  options: ['A', 'B'],
  correctOption: 0,
});

async function attemptWith(security: Record<string, unknown> = {}) {
  const repository = await ExaminationRepository.open();
  const exam = await repository.createExam('Hardening exam');
  const version = await repository.createVersion(exam.id, [question('q1')], {
    title: 'Hardening exam',
    assessmentType: 'KIOSK_EXAM',
    security: { kioskMode: true, ...security },
  });
  await repository.publishVersion(exam.id, version.id);
  const session = await repository.createSession(exam.id, version.id);
  const device = await repository.createDeviceSession({
    deviceId: 'student-device',
    role: 'STUDENT',
    sessionId: session.id,
    capabilities: ['encrypted-local-state'],
  });
  return {
    repository,
    device,
    attempt: (await repository.createAttempt(session.id, 'student-1', device.id)).attempt,
  };
}

beforeEach(() => {
  idbStore.clear();
  releaseSecureKiosk();
});

describe('secure examination finalization and lockdown hardening', () => {
  it('submits without a credential, is idempotent, and rejects every post-submit edit', async () => {
    const { repository, device, attempt } = await attemptWith();
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: device.id,
      isFinal: false,
    });

    const submitted = await repository.submitAttempt(attempt.id, false, device.id, 'MANUAL');
    const retried = await repository.submitAttempt(attempt.id, false, device.id, 'MANUAL');
    expect(retried.id).toBe(submitted.id);
    expect(repository.snapshot.attempts).toHaveLength(1);
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.submissionState).toBe('SUBMITTED');
    await expect(
      repository.recordAnswer(attempt.id, {
        questionId: attempt.questionOrder[0],
        answer: '1',
        deviceSessionId: device.id,
        isFinal: false,
      }),
    ).rejects.toThrow('no longer accepts');

    const released = await repository.releaseKiosk(attempt.id);
    expect(released.kioskLifecycle).toBe('RELEASED');
    expect(repository.snapshot.securityEvents.some((event) => event.type === 'KIOSK_RELEASED')).toBe(true);
  });

  it('uses the same durable path for password-free authoritative expiry', async () => {
    const { repository, device, attempt } = await attemptWith();
    const expired = await repository.submitAttempt(attempt.id, true, device.id, 'EXPIRY');
    expect(expired.status).toBe('SUBMITTED');
    expect(expired.submissionState).toBe('EXPIRED');
    expect(expired.submissionTrigger).toBe('EXPIRY');
    expect(repository.snapshot.securityEvents.some((event) => event.type === 'EXPIRY_SUBMITTED')).toBe(true);
  });

  it('keeps manual early exit separate from submit and RX30 identity', async () => {
    const adminRequired = await attemptWith({ manualExitPolicy: 'ADMIN_AUTH_REQUIRED' });
    await expect(adminRequired.repository.requestManualEarlyExit(adminRequired.attempt.id)).resolves.toBe(
      'ADMIN_AUTH_REQUIRED',
    );
    await expect(
      adminRequired.repository.authorizeManualEarlyExit(adminRequired.attempt.id, false),
    ).rejects.toThrow('authorization');
    expect(adminRequired.repository.snapshot.attempts[0].status).toBe('ACTIVE');

    const disallowed = await attemptWith({ manualExitPolicy: 'DISALLOW_EARLY_EXIT' });
    await expect(
      disallowed.repository.authorizeManualEarlyExit(disallowed.attempt.id, true),
    ).rejects.toThrow('disabled');

    const free = await attemptWith({ manualExitPolicy: 'ALLOW_FREE_EXIT' });
    const closed = await free.repository.authorizeManualEarlyExit(free.attempt.id, true);
    expect(closed.status).toBe('SUBMITTED');
    expect(closed.submissionTrigger).toBe('ADMIN_FORCE');
    expect(free.repository.snapshot.securityEvents.some((event) => event.type === 'EARLY_EXIT_AUTHORIZED')).toBe(true);
    expect(free.repository.snapshot.securityEvents.some((event) => event.details?.includes('RX30'))).toBe(true);
  });

  it('publishes central SECURE_EXAM_ACTIVE state and records blocked normal routes', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeSecureKiosk(() => undefined);
    expect(getSecureKioskState().active).toBe(false);
    enterSecureKiosk('attempt-1', true);
    expect(getSecureKioskState()).toMatchObject({ mode: 'SECURE_EXAM_ACTIVE', active: true, fullLockdown: true, attemptId: 'attempt-1' });
    const stopObservingBlockedRoutes = onBlockedKioskNavigation((path) => seen.push(path));
    recordBlockedKioskNavigation('/ai');
    expect(seen).toEqual(['/ai']);
    stopObservingBlockedRoutes();
    unsubscribe();
    releaseSecureKiosk();
    expect(getSecureKioskState().active).toBe(false);
    expect(getSecureKioskState().lifecycle).toBe('RELEASED');
  });
});
