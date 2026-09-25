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

import { LocalExamAuthority } from '../examination/network';
import { ExaminationRepository } from '../examination/service';
import type { ExamQuestion } from '../types';
import type { SyncEvent } from '../examination/types';

const question: ExamQuestion = {
  id: 'q1',
  courseId: 'course-1',
  topicId: 'topic-1',
  questionText: 'LAN authority question',
  questionType: 'mcq',
  marksAllocation: 1,
  difficulty: 'easy',
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
};

async function fixture() {
  const repository = await ExaminationRepository.open();
  const student = await repository.registerStudent('LAN Student', 'Level 300');
  const exam = await repository.createExam('LAN Authority Exam');
  const version = await repository.createVersion(exam.id, [question], {
    title: 'LAN Authority Exam',
    assessmentType: 'KIOSK_EXAM',
    security: { kioskMode: true, requireLanAuthority: true },
  });
  await repository.publishVersion(exam.id, version.id);
  const session = await repository.createSession(exam.id, version.id, 'lan-server');
  const device = await repository.createDeviceSession({
    id: 'device-session-a',
    deviceId: 'pc-a',
    studentId: student.student.id,
    role: 'STUDENT',
    sessionId: session.id,
    capabilities: ['encrypted-local-state', 'lan-authenticated'],
  });
  const attempt = await repository.createAttempt(session.id, student.student.id, device.id);
  const answer = await repository.recordAnswer(attempt.attempt.id, {
    questionId: attempt.attempt.questionOrder[0],
    answer: '0',
    selectedOption: 0,
    deviceSessionId: device.id,
    isFinal: false,
  });
  return { repository, session, attempt: attempt.attempt, answer };
}

beforeEach(() => idbStore.clear());

describe('production LAN authority transaction boundary', () => {
  it('receives, validates, applies, persists, revises, audits, and only then acknowledges an answer', async () => {
    const { repository, session, answer } = await fixture();
    const event = repository.pendingSyncEvents(session.id)[0];
    const authority = new LocalExamAuthority(repository);

    const result = await authority.sync(session.id, [event]);

    expect(result).toMatchObject({ ok: true, applied: 1, revision: 1 });
    expect(result.acknowledgedEventIds).toEqual([event.id]);
    expect(repository.snapshot.syncEvents.find((item) => item.id === event.id)?.status).toBe(
      'APPLIED',
    );
    expect(repository.snapshot.attempts[0].answers[0].serverRevision).toBe(1);
    expect(repository.snapshot.attempts[0].serverRevision).toBe(1);
    expect(repository.snapshot.securityEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'ANSWER_RECORDED',
          attemptId: repository.snapshot.attempts[0].id,
        }),
      ]),
    );
    expect(answer.eventId).toBeTruthy();
  });

  it('returns the previous accepted result for a duplicate without incrementing revision', async () => {
    const { repository, session } = await fixture();
    const event = repository.pendingSyncEvents(session.id)[0];
    const authority = new LocalExamAuthority(repository);

    const first = await authority.sync(session.id, [event]);
    const second = await authority.sync(session.id, [event]);

    expect(first.revision).toBe(1);
    expect(second).toMatchObject({ ok: true, applied: 0, revision: 1 });
    expect(second.acknowledgedEventIds).toEqual([event.id]);
  });

  it('rejects stale answer revisions and invalid attempt ownership without acknowledging them', async () => {
    const { repository, session, answer } = await fixture();
    const original = repository.pendingSyncEvents(session.id)[0];
    const authority = new LocalExamAuthority(repository);
    expect((await authority.sync(session.id, [original])).ok).toBe(true);

    const stale: SyncEvent = {
      ...original,
      id: 'stale-sync-event',
      eventId: 'stale-answer-event',
      answerRevision: answer.revision,
      payload: { ...original.payload, answer: '1' },
    };
    const invalidOwner: SyncEvent = {
      ...stale,
      id: 'invalid-owner-event',
      eventId: 'invalid-owner-answer',
      payload: { ...stale.payload, deviceSessionId: 'device-session-other' },
    };

    const result = await authority.sync(session.id, [stale, invalidOwner]);

    expect(result.ok).toBe(false);
    expect(result.applied).toBe(0);
    expect(result.acknowledgedEventIds).toEqual([]);
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('stale-sync-event'),
        expect.stringContaining('invalid-owner-event'),
      ]),
    );
    expect(repository.snapshot.attempts[0].answers[0].answer).toBe('0');
    expect(repository.snapshot.sessions[0].lastReplicationRevision).toBe(1);
  });

  it('does not acknowledge an event when durable persistence fails and leaves it retryable', async () => {
    const { repository, session } = await fixture();
    const event = repository.pendingSyncEvents(session.id)[0];
    const save = vi.spyOn(repository, 'save').mockResolvedValue(false);
    const result = await new LocalExamAuthority(repository).sync(session.id, [event]);
    save.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.applied).toBe(0);
    expect(result.acknowledgedEventIds).toEqual([]);
    expect(result.conflicts[0]).toContain('Durable examination persistence failed');
    expect(repository.snapshot.syncEvents.find((item) => item.id === event.id)?.status).toBe(
      'PENDING',
    );
    expect(repository.snapshot.sessions[0].lastReplicationRevision).toBe(0);
  });

  it('tracks device heartbeat separately from answer synchronization', async () => {
    const { repository, session } = await fixture();
    const heartbeat = await new LocalExamAuthority(repository).heartbeat(
      session.id,
      'device-session-a',
    );
    expect(heartbeat.ok).toBe(true);
    expect(repository.snapshot.deviceSessions[0].lastHeartbeatAt).toBe(heartbeat.lastSeenAt);
    expect(repository.snapshot.syncEvents).toHaveLength(1);
  });
});
