import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { LocalExamAuthority, type LanExamTransport } from '../examination/network';
import { ExaminationSyncEngine, reconcileAnswer } from '../examination/sync';
import {
  adjustAttemptTimer,
  createAttemptTimer,
  pauseAttemptTimer,
  remainingMilliseconds,
  resumeAttemptTimer,
} from '../examination/timer';
import {
  createCapabilityMatrix,
  requiredCapabilitiesReady,
  KIOSK_CAPABILITY_IDS,
} from '../examination/kioskAdapter';
import { createAndroidKioskAdapter } from '../examination/androidAdapter';
import type { ExamQuestion } from '../types';

const question = (id: string): ExamQuestion => ({
  id,
  courseId: 'c1',
  topicId: 't1',
  questionText: `Question ${id}`,
  questionType: 'mcq',
  marksAllocation: 1,
  difficulty: 'medium',
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

async function activeAttempt(security = {}) {
  const repository = await ExaminationRepository.open();
  const student = await repository.registerStudent('Secure Student', 'Level 100');
  const exam = await repository.createExam('Secure Engine Exam');
  const version = await repository.createVersion(exam.id, [question('q1'), question('q2')], {
    title: 'Secure Engine Exam',
    assessmentType: 'KIOSK_EXAM',
    availability: { durationMinutes: 60 },
    security: { kioskMode: true, ...security },
  });
  await repository.publishVersion(exam.id, version.id);
  const session = await repository.createSession(exam.id, version.id);
  const device = await repository.createDeviceSession({
    deviceId: 'pc-a',
    studentId: student.student.id,
    role: 'STUDENT',
    sessionId: session.id,
    capabilities: ['encrypted-local-state'],
  });
  const created = await repository.createAttempt(
    session.id,
    student.student.id,
    device.id,
    '2026-09-24T10:00:00.000Z',
  );
  return {
    repository,
    student: student.student,
    exam,
    version,
    session,
    device,
    attempt: created.attempt,
  };
}

beforeEach(() => idbStore.clear());

describe('PharmaTRACK secure kiosk and attempt engine', () => {
  it('reports actual web capability limits without falsely claiming OS lockdown', () => {
    const matrix = createCapabilityMatrix('PC_WEB', [
      KIOSK_CAPABILITY_IDS.devTools,
      KIOSK_CAPABILITY_IDS.copyPaste,
    ]);
    const devTools = matrix.capabilities.find((item) => item.id === KIOSK_CAPABILITY_IDS.devTools)!;
    const copyPaste = matrix.capabilities.find(
      (item) => item.id === KIOSK_CAPABILITY_IDS.copyPaste,
    )!;
    expect(devTools.supported).toBe(false);
    expect(devTools.enforceable).toBe(false);
    expect(copyPaste.enforceable).toBe(true);
    expect(requiredCapabilitiesReady(matrix, [KIOSK_CAPABILITY_IDS.devTools]).ok).toBe(false);
  });

  it('uses an optional Android native bridge without overstating browser capabilities', async () => {
    const adapter = await createAndroidKioskAdapter(
      () => undefined,
      [KIOSK_CAPABILITY_IDS.lockTask],
      {
        enterLockTask: () => true,
        setImmersiveMode: () => true,
        capabilityStatus: () => ({
          [KIOSK_CAPABILITY_IDS.lockTask]: true,
          [KIOSK_CAPABILITY_IDS.screenCapture]: true,
        }),
      },
    );
    expect(adapter.matrix.platform).toBe('ANDROID_NATIVE');
    expect(
      adapter.matrix.capabilities.find((item) => item.id === KIOSK_CAPABILITY_IDS.lockTask)
        ?.enforceable,
    ).toBe(true);
    expect(await adapter.requestFullscreen()).toBe(true);
  });

  it('persists an answer before queueing only an incremental sync event', async () => {
    const { repository, attempt, session } = await activeAttempt();
    const answer = await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: attempt.deviceSessionId,
      isFinal: false,
    });
    expect(answer.eventId).toBeTruthy();
    expect(repository.snapshot.syncEvents).toHaveLength(1);
    expect(repository.snapshot.syncEvents[0].entity).toBe('ANSWER');
    const engine = new ExaminationSyncEngine(
      repository,
      new LocalExamAuthority(repository),
      session.id,
    );
    const result = await engine.flush();
    expect(result).toMatchObject({ ok: true, queued: 1, applied: 1, state: 'SYNCHRONIZED' });
    expect(repository.snapshot.syncEvents[0].status).toBe('APPLIED');
    expect((await engine.flush()).queued).toBe(0);
  });

  it('keeps the previous answer when encrypted local persistence fails', async () => {
    const { repository, attempt } = await activeAttempt();
    const save = vi.spyOn(repository, 'save').mockResolvedValue(false);
    await expect(
      repository.recordAnswer(attempt.id, {
        questionId: attempt.questionOrder[0],
        answer: '0',
        selectedOption: 0,
        deviceSessionId: attempt.deviceSessionId,
        isFinal: false,
      }),
    ).rejects.toThrow('persisted locally');
    expect(repository.snapshot.attempts[0].answers).toEqual([]);
    save.mockRestore();
  });

  it('queues through LAN loss, then enters recovery pending without ejecting immediately', async () => {
    const { repository, attempt, session } = await activeAttempt();
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: attempt.deviceSessionId,
      isFinal: false,
    });
    const unavailable: LanExamTransport = {
      health: async () => {
        throw new Error('LAN unavailable');
      },
      connect: async () => {
        throw new Error('LAN unavailable');
      },
      submitAnswer: async () => {
        throw new Error('LAN unavailable');
      },
      sync: async () => {
        throw new Error('LAN unavailable');
      },
      recover: async () => {
        throw new Error('LAN unavailable');
      },
    };
    const engine = new ExaminationSyncEngine(repository, unavailable, session.id);
    expect((await engine.flush()).state).toBe('DEGRADED');
    expect(repository.snapshot.attempts[0].status).toBe('ACTIVE');
    expect((await engine.flush()).state).toBe('DEGRADED');
    expect((await engine.flush()).state).toBe('RECOVERY_PENDING');
    expect(repository.snapshot.attempts[0].status).toBe('RECOVERY_PENDING');
  });

  it('switches ownership instead of creating a second attempt and rejects stale Device A writes', async () => {
    const { repository, student, session, attempt, device } = await activeAttempt();
    const deviceB = await repository.createDeviceSession({
      deviceId: 'android-b',
      studentId: student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });
    const continued = await repository.createAttempt(session.id, student.id, deviceB.id);
    expect(continued.continued).toBe(true);
    expect(continued.attempt.id).toBe(attempt.id);
    expect(continued.attempt.deviceSessionId).toBe(deviceB.id);
    expect(repository.snapshot.deviceSessions.find((item) => item.id === device.id)?.status).toBe(
      'DISCONNECTED',
    );
    await expect(
      repository.recordAnswer(attempt.id, {
        questionId: attempt.questionOrder[0],
        answer: '0',
        deviceSessionId: device.id,
        isFinal: false,
      }),
    ).rejects.toThrow('no longer owns');
  });

  it('keeps the original duration while applying authoritative pause, resume, and admin time changes', async () => {
    const started = '2026-09-24T10:00:00.000Z';
    const timer = createAttemptTimer(60, started, 4);
    expect(remainingMilliseconds(timer, '2026-09-24T10:15:00.000Z')).toBe(45 * 60 * 1000);
    const paused = pauseAttemptTimer(timer, '2026-09-24T10:15:00.000Z');
    const resumed = resumeAttemptTimer(paused, '2026-09-24T10:25:00.000Z');
    expect(resumed.originalDurationMinutes).toBe(60);
    expect(resumed.authoritativeDeadlineAt).toBe('2026-09-24T11:10:00.000Z');
    const adjusted = adjustAttemptTimer(
      resumed,
      10,
      'admin',
      'Approved accommodation',
      '2026-09-24T10:30:00.000Z',
    );
    expect(adjusted.authoritativeDeadlineAt).toBe('2026-09-24T11:20:00.000Z');
    expect(adjusted.adjustments[0].minutes).toBe(10);
  });

  it('applies configured violation policy and records administrator actions with state transitions', async () => {
    const { repository, attempt } = await activeAttempt({
      violationPolicies: { FOCUS_LOST: 'REQUIRE_ADMIN_UNLOCK' },
    });
    const violation = await repository.recordSecurityViolation(
      attempt.id,
      'FOCUS_LOST',
      'Focus changed during answer entry.',
    );
    expect(violation.policy).toBe('REQUIRE_ADMIN_UNLOCK');
    expect(violation.attempt.status).toBe('LOCKED');
    expect(violation.attempt.securityState).toBe('ADMIN_REVIEW');
    const unlocked = await repository.unlockAttempt(
      attempt.id,
      'admin',
      'admin-device',
      'Student identified and approved to continue.',
    );
    expect(unlocked.status).toBe('RECOVERY_PENDING');
    expect(
      repository.snapshot.adminActions[repository.snapshot.adminActions.length - 1]?.action,
    ).toBe('UNLOCK');
  });

  it('reconciles equal-revision divergent answers as a conflict instead of silently overwriting', () => {
    const base = {
      questionId: 'q',
      answer: '0',
      answeredAt: '2026-09-24T10:00:00.000Z',
      revision: 2,
      eventId: 'a',
      deviceSessionId: 'A',
      isFinal: false,
    };
    const incoming = {
      ...base,
      answer: '1',
      answeredAt: '2026-09-24T10:00:01.000Z',
      eventId: 'b',
      deviceSessionId: 'B',
    };
    const result = reconcileAnswer(base, incoming);
    expect(result.conflict).toBe(true);
    expect(result.winner.answer).toBe('1');
  });
});
