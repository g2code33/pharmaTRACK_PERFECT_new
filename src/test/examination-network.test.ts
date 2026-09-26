import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { EXAMINATION_STATE_KEY, loadExaminationState } from '../examination/storage';
import {
  EXAMINATION_PROTOCOL_VERSION,
  LanExamClient,
  LocalExamAuthority,
  acceptReplication,
  createServerIdentity,
  heartbeat,
  makeEnvelope,
  requestManualFailover,
  type ReplicationEnvelope,
} from '../examination/network';
import type { ExamQuestion } from '../types';

const question: ExamQuestion = {
  id: 'q1',
  courseId: 'c1',
  topicId: 't1',
  questionText: 'What is the answer?',
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
  createdAt: '2026-01-01',
  options: ['A', 'B'],
  correctOption: 0,
};

beforeEach(() => idbStore.clear());

describe('encrypted examination state and LAN authority', () => {
  it('stores examination state through an encrypted AES-GCM envelope', async () => {
    const repository = await ExaminationRepository.open();
    await repository.createExam('Encrypted Test');
    const raw = idbStore.get(EXAMINATION_STATE_KEY) as Record<string, unknown>;
    expect(raw.encrypted).toBe(true);
    expect(raw.algorithm).toBe('AES-GCM-256');
    expect(JSON.stringify(raw)).not.toContain('Encrypted Test');
    expect((await loadExaminationState()).exams[0].title).toBe('Encrypted Test');
  });

  it('local authority owns connects, heartbeats, and answer writes', async () => {
    const repository = await ExaminationRepository.open();
    const exam = await repository.createExam('LAN Test');
    const version = await repository.createVersion(exam.id, [question], {
      title: 'LAN Test',
      assessmentType: 'KIOSK_EXAM',
      security: { kioskMode: true },
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    const authority = new LocalExamAuthority(repository);
    const connection = await authority.connect(session.id, 'student-device', 'STUDENT');
    expect(connection.ok).toBe(true);
    const student = await repository.registerStudent('Ama', 'Level 300');
    const attempt = await repository.createAttempt(
      session.id,
      student.student.id,
      'student-device',
    );
    const answer = await authority.submitAnswer(session.id, attempt.attempt.id, {
      questionId: attempt.attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: 'student-device',
      isFinal: true,
      answeredAt: new Date().toISOString(),
      revision: 0,
    });
    expect(answer.ok).toBe(true);
    expect((await authority.health()).activeAttempts).toBe(1);
    expect((await authority.health()).server.lastHeartbeatAt).toBeTruthy();
  });

  it('rejects stale replication and accepts only a newer epoch/revision', async () => {
    const identity = createServerIdentity({
      authorityId: 'authority-1',
      serverId: 'primary',
      epoch: 3,
      revision: 5,
    });
    const stale: ReplicationEnvelope = {
      protocolVersion: EXAMINATION_PROTOCOL_VERSION,
      authorityId: 'authority-1',
      sourceServerId: 'secondary',
      authorityEpoch: 2,
      revision: 99,
      entity: 'ATTEMPT',
      entityId: 'a1',
      payload: {},
      checksum: 'x',
    };
    expect(acceptReplication(identity, stale).accepted).toBe(false);
    const newer = { ...stale, authorityEpoch: 3, revision: 6 };
    expect(acceptReplication(identity, newer).accepted).toBe(true);
    expect(acceptReplication(identity, { ...newer, authorityId: 'other' }).accepted).toBe(false);
  });

  it('manual failover increments the authority epoch and locks the new leader', () => {
    const primary = createServerIdentity({
      authorityId: 'a',
      serverId: 'primary',
      role: 'PRIMARY',
      status: 'PRIMARY',
      epoch: 4,
    });
    const secondary = createServerIdentity({
      authorityId: 'a',
      serverId: 'secondary',
      role: 'SECONDARY',
      status: 'SECONDARY',
      epoch: 4,
    });
    const result = requestManualFailover(primary, secondary, 'Primary heartbeat expired.');
    expect(result.secondary.status).toBe('PRIMARY');
    expect(result.secondary.role).toBe('PRIMARY');
    expect(result.secondary.epoch).toBe(5);
    expect(result.secondary.lockedBy).toBe('secondary');
    expect(result.primary.status).toBe('SECONDARY');
    expect(result.recovery.toServerId).toBe('secondary');
  });

  it('creates checksummed replication envelopes', async () => {
    const identity = createServerIdentity({ authorityId: 'a', serverId: 'p', revision: 10 });
    const envelope = await makeEnvelope(identity, 'ANSWER', 'answer-1', { answer: '0' });
    expect(envelope.revision).toBe(11);
    expect(envelope.checksum).toHaveLength(64);
    expect(envelope.protocolVersion).toBe(1);
  });

  it('uses LAN-only HTTP paths and never silently changes to a cloud provider', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          ok: true,
          protocolVersion: 1,
          server: createServerIdentity(),
          activeSessions: 0,
          activeAttempts: 0,
          checkedAt: new Date().toISOString(),
        }),
        { status: 200 },
      );
    });
    const client = new LanExamClient('http://192.168.1.20:8787', request as typeof fetch);
    await client.health();
    expect(calls[0].url).toBe('http://192.168.1.20:8787/pharmaexam/v1/health');
    expect(calls[0].url).not.toMatch(/github|supabase|openai|google/i);
    expect(calls[0].init?.headers).toEqual(
      expect.objectContaining({ 'content-type': 'application/json' }),
    );
  });

  it('heartbeat never changes authority identity or epoch', () => {
    const identity = createServerIdentity({ authorityId: 'authority', epoch: 7 });
    const updated = heartbeat(identity, '2026-01-01T00:00:00.000Z');
    expect(updated.authorityId).toBe('authority');
    expect(updated.epoch).toBe(7);
    expect(updated.lastHeartbeatAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('signs authenticated LAN requests and never treats an unpersisted transport receipt as an ACK', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          ok: true,
          applied: 0,
          conflicts: [],
          revision: 4,
          acknowledgedEventIds: [],
        }),
        { status: 200 },
      );
    });
    const client = new LanExamClient('http://192.168.1.20:8787', request as typeof fetch, {
      token: 'x'.repeat(48),
      deviceSessionId: 'device-session-a',
    });
    const result = await client.sync('session-a', []);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(result.acknowledgedEventIds).toEqual([]);
    expect(headers['x-pharma-exam-token']).toHaveLength(48);
    expect(headers['x-pharma-exam-signature']).toMatch(/^[a-f0-9]{64}$/);
    expect(headers['x-pharma-device-session']).toBe('device-session-a');
  });
});
