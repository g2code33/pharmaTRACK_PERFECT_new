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
import { ExaminationHighAvailability } from '../examination/ha';
import { runDemoLoadMatrix, runDemoSimulation } from '../examination/demo';
import type { ExamQuestion } from '../types';

const question: ExamQuestion = {
  id: 'q1',
  courseId: 'c1',
  topicId: 't1',
  questionText: 'Q',
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
  createdAt: new Date().toISOString(),
  options: ['A', 'B'],
  correctOption: 0,
};
beforeEach(() => idbStore.clear());

describe('high availability and demo readiness', () => {
  it('uses controlled secondary promotion, lease epochs, replication snapshots, and standby return', async () => {
    const repository = await ExaminationRepository.open();
    const exam = await repository.createExam('HA Exam');
    const version = await repository.createVersion(exam.id, [question], {
      title: 'HA Exam',
      assessmentType: 'KIOSK_EXAM',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    await repository.createDeviceSession({
      deviceId: 'device',
      role: 'ADMIN',
      capabilities: ['authority-control'],
    });
    const coordinator = new ExaminationHighAvailability(repository);
    const initial = await coordinator.initialize();
    const snapshot = await coordinator.replicateToSecondary(session.id);
    expect(snapshot.sessionIds).toEqual([session.id]);
    expect(initial.lease?.serverId).toBe(initial.activeServerId);
    await expect(
      coordinator.promoteSecondary(
        'admin',
        'device',
        'not confirmed',
        false,
        new Date(Date.now() + 10_000).toISOString(),
      ),
    ).rejects.toThrow('explicit');
    const promoted = await coordinator.promoteSecondary(
      'admin',
      'device',
      'Primary failed during exam',
      true,
      new Date(Date.now() + 10_000).toISOString(),
    );
    expect(promoted.activeServerId).toBe(promoted.secondary.serverId);
    expect(promoted.lease?.epoch).toBeGreaterThan(initial.lease?.epoch || 0);
    expect(repository.snapshot.sessions[0].authoritativeServerId).toBe(promoted.activeServerId);
    const returned = await coordinator.reconnectFormerPrimary(
      promoted.primary.serverId,
      new Date(Date.now() + 11_000).toISOString(),
    );
    expect(returned.primary.status).toBe('STANDBY');
  });

  it('covers every required load size while staging one package and compacting answer traffic', async () => {
    const matrix = await runDemoLoadMatrix();
    expect(matrix.map((item) => item.students)).toEqual([50, 100, 200, 300, 500]);
    expect(matrix.every((item) => item.packageTransfers === 1)).toBe(true);
    expect(matrix[4].answerEvents).toBe(2000);
    const demo = await runDemoSimulation(500);
    expect(demo.packageStagedOnce).toBe(true);
    expect(demo.expectedAuthority).toBe('SECONDARY');
    expect(demo.results).toBe(500);
    expect(demo.events.some((event) => event.type === 'ADMIN_DEVICE_REPLACEMENT')).toBe(true);
    await expect(runDemoSimulation(25)).rejects.toThrow('exactly 50');
  });
});
