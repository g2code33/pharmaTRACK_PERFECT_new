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

import { ExaminationHighAvailability } from '../examination/ha';
import { ExaminationRepository } from '../examination/service';
import { emptyExaminationState } from '../examination/types';
import type { ExamQuestion } from '../types';

const question = (id: string, text: string): ExamQuestion => ({
  id,
  courseId: 'course-1',
  topicId: 'topic-1',
  questionText: text,
  questionType: 'mcq',
  marksAllocation: 1,
  difficulty: 'medium',
  probability: 'high',
  modelAnswer: 'A',
  correctAnswer: 'A',
  tags: [],
  isPracticed: false,
  needsReview: false,
  isSaved: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  options: ['A', 'B'],
  correctOption: 0,
});

beforeEach(() => idbStore.clear());

describe('durable HA examination recovery', () => {
  it('replicates complete state, fails over at simulated 40 minutes, reconnects students/admin, and preserves results', async () => {
    const primary = await ExaminationRepository.open();
    const exam = await primary.createExam('Disaster Recovery Examination');
    const version = await primary.createVersion(
      exam.id,
      [question('q1', 'First question'), question('q2', 'Second question')],
      {
        title: 'Disaster Recovery Examination',
        assessmentType: 'KIOSK_EXAM',
        availability: { durationMinutes: 60 },
        security: { kioskMode: true, requireLanAuthority: true },
      },
    );
    await primary.publishVersion(exam.id, version.id);
    const session = await primary.createSession(exam.id, version.id, 'primary-server');
    const adminA = await primary.createDeviceSession({
      id: 'admin-a-session',
      deviceId: 'admin-a',
      role: 'ADMIN',
      sessionId: session.id,
      capabilities: ['authority-control'],
    });
    const student = await primary.registerStudent('Recovery Student', 'Level 400');
    const studentDevice = await primary.createDeviceSession({
      id: 'student-a-session',
      deviceId: 'student-a',
      studentId: student.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state', 'recovery'],
    });
    const created = await primary.createAttempt(
      session.id,
      student.student.id,
      studentDevice.id,
      '2026-09-25T10:00:00.000Z',
    );
    await primary.recordAnswer(created.attempt.id, {
      questionId: created.attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: studentDevice.id,
      isFinal: false,
    });
    const firstQueued = primary.pendingSyncEvents(session.id);
    expect((await primary.processIncomingSyncEvents(session.id, firstQueued)).ok).toBe(true);

    const secondary = ExaminationRepository.fromSnapshot(emptyExaminationState());
    const coordinator = new ExaminationHighAvailability(primary, secondary, {
      primary: { serverId: 'primary-server', authorityId: 'exam-authority' },
      secondary: { serverId: 'secondary-server', authorityId: 'exam-authority' },
    });
    await coordinator.initialize();
    const snapshot = await coordinator.replicateToSecondary(session.id, '2026-09-25T10:01:00.000Z');
    expect(snapshot.payload.students).toHaveLength(1);
    expect(snapshot.payload.attempts[0].answers).toHaveLength(1);
    expect(snapshot.payload.deviceSessions).toHaveLength(2);
    expect(secondary.snapshot.attempts[0].id).toBe(created.attempt.id);
    expect(secondary.snapshot.replicationSnapshots).toHaveLength(1);

    // This answer is durably local on the primary but is intentionally queued
    // after the last replication. It must reconcile after failover.
    const unsynchronized = await primary.recordAnswer(created.attempt.id, {
      questionId: created.attempt.questionOrder[1],
      answer: '1',
      selectedOption: 1,
      deviceSessionId: studentDevice.id,
      isFinal: false,
    });
    const queued = primary.pendingSyncEvents(session.id);
    expect(unsynchronized.eventId).toBeTruthy();
    expect(queued).toHaveLength(1);
    const q2Event = queued.find((event) => event.questionId === created.attempt.questionOrder[1])!;

    const heartbeatAt = '2026-09-25T10:00:00.000Z';
    await coordinator.heartbeat('primary-server', heartbeatAt);
    const beforeFailover = await secondary.getAttemptTimer(
      created.attempt.id,
      '2026-09-25T10:40:00.000Z',
    );
    expect(beforeFailover.remainingMilliseconds).toBe(20 * 60 * 1000);

    const promoted = await coordinator.promoteSecondary(
      'admin-a',
      adminA.id,
      'Primary failed during the examination.',
      true,
      '2026-09-25T10:40:05.000Z',
    );
    expect(promoted.activeServerId).toBe('secondary-server');
    expect(promoted.secondary.epoch).toBe(2);
    expect(promoted.replicationState).toBe('PROMOTED');
    expect(secondary.snapshot.sessions[0].authoritativeServerId).toBe('secondary-server');
    expect(() => coordinator.assertCurrentAuthority('primary-server', 1)).toThrow(
      'not the current',
    );
    expect(() => coordinator.assertCurrentAuthority('secondary-server', 2)).not.toThrow();

    const recovered = await coordinator.reconnectStudent(
      session.id,
      student.student.id,
      studentDevice.id,
      [q2Event],
    );
    expect(recovered.continued).toBe(true);
    expect(recovered.conflicts).toEqual([]);
    expect(recovered.applied).toBe(1);
    expect(secondary.snapshot.attempts).toHaveLength(1);
    expect(secondary.snapshot.attempts[0].answers).toHaveLength(2);
    expect(
      new Set(secondary.snapshot.attempts[0].answers.map((answer) => answer.questionId)).size,
    ).toBe(2);

    const afterReconnect = await secondary.getAttemptTimer(
      created.attempt.id,
      '2026-09-25T10:40:05.000Z',
    );
    expect(afterReconnect.deadlineAt).toBe(created.attempt.deadlineAt);
    expect(afterReconnect.remainingMilliseconds).toBeLessThanOrEqual(20 * 60 * 1000);

    const adminB = await coordinator.reconnectAdministrator(
      session.id,
      'admin-b',
      'admin-b-device',
    );
    expect(adminB.session.id).toBe(session.id);
    expect(secondary.snapshot.sessions).toHaveLength(1);
    expect(
      secondary.snapshot.deviceSessions.some((device) => device.deviceId === 'admin-b-device'),
    ).toBe(true);

    // Failure at approximately the original 60-minute boundary cannot grant
    // time: the same authoritative deadline reaches zero on the promoted node.
    const atDeadline = await secondary.getAttemptTimer(
      created.attempt.id,
      '2026-09-25T11:00:01.000Z',
    );
    expect(atDeadline.remainingMilliseconds).toBe(0);
    const submitted = await secondary.submitAttempt(created.attempt.id, true);
    expect(submitted.status).toBe('SUBMITTED');
    expect(secondary.getExaminationResult(created.attempt.id)?.attemptId).toBe(created.attempt.id);
    expect(secondary.getExaminationResult(created.attempt.id)?.answerStatistics.answered).toBe(2);

    const returned = await coordinator.reconnectFormerPrimary(
      'primary-server',
      '2026-09-25T11:01:00.000Z',
    );
    expect(returned.primary.status).toBe('STANDBY');
    expect(returned.primary.epoch).toBe(2);
    expect(returned.activeServerId).toBe('secondary-server');
    expect(primary.snapshot.attempts[0].id).toBe(created.attempt.id);
    expect(primary.snapshot.sessions[0].authoritativeServerId).toBe('secondary-server');
  });

  it('does not promote after an interrupted durable replication', async () => {
    const primary = await ExaminationRepository.open();
    const exam = await primary.createExam('Interrupted Replication');
    const version = await primary.createVersion(exam.id, [question('q1', 'Q')], {
      title: 'Interrupted Replication',
    });
    await primary.publishVersion(exam.id, version.id);
    const session = await primary.createSession(exam.id, version.id, 'primary-server');
    const secondary = ExaminationRepository.fromSnapshot(emptyExaminationState());
    vi.spyOn(secondary, 'installReplicatedState').mockRejectedValue(
      new Error('simulated secondary storage failure'),
    );
    const coordinator = new ExaminationHighAvailability(primary, secondary, {
      primary: { serverId: 'primary-server', authorityId: 'exam-authority' },
      secondary: { serverId: 'secondary-server', authorityId: 'exam-authority' },
    });
    await coordinator.initialize();
    await expect(coordinator.replicateToSecondary(session.id)).rejects.toThrow('simulated');
    expect(coordinator.status().replicationState).toBe('INTERRUPTED');
    await expect(
      coordinator.promoteSecondary(
        'admin',
        'missing-admin',
        'must not promote stale secondary',
        true,
        new Date(Date.now() + 10_000).toISOString(),
      ),
    ).rejects.toThrow('reconciliation');
  });
});
