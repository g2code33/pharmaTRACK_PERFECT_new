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
import type { ExamQuestion } from '../types';

const question = (id: string): ExamQuestion => ({
  id,
  courseId: 'c1',
  topicId: 't1',
  semester: 'Semester 1',
  questionText: `Question ${id}`,
  questionType: 'mcq',
  difficulty: 'medium',
  probability: 'medium',
  marksAllocation: 2,
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

beforeEach(() => idbStore.clear());

describe('Kiosk examination workflow', () => {
  it('registers sequential RX30 identities, owns the timer by attempt, and restores across devices', async () => {
    const repository = await ExaminationRepository.open();
    const first = await repository.registerStudent('Ama', 'Level 100');
    const second = await repository.registerStudent('Kojo', 'Level 100');
    expect(first.password).toBe('RX30a');
    expect(second.password).toBe('RX30b');
    await expect(repository.registerStudent('Ama', 'Level 100')).rejects.toThrow(
      'This first name is already in use',
    );
    await expect(repository.authenticateStudent('Ama', 'Level 100', 'wrong')).rejects.toThrow();
    const authenticated = await repository.authenticateStudent('Ama', 'Level 100', first.password);

    const exam = await repository.createExam('Kiosk Exam');
    const version = await repository.createVersion(exam.id, [question('q1'), question('q2')], {
      title: 'Kiosk Exam',
      assessmentType: 'KIOSK_EXAM',
      availability: { durationMinutes: 45 },
      security: { kioskMode: true, requireLanAuthority: false },
      navigation: { randomizeQuestions: true, randomizeOptions: true },
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    const deviceA = await repository.createDeviceSession({
      deviceId: 'pc-a',
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });
    const started = await repository.createAttempt(session.id, authenticated.id, deviceA.id);
    expect(started.attempt.deadlineAt).toBe(
      new Date(new Date(started.attempt.startedAt).getTime() + 45 * 60_000).toISOString(),
    );
    expect(started.attempt.questionOrder).toHaveLength(2);
    expect(started.attempt.randomizationSeed).toBeTruthy();
    await repository.recordAnswer(started.attempt.id, {
      questionId: started.attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: deviceA.id,
      isFinal: false,
    });

    const deviceB = await repository.createDeviceSession({
      deviceId: 'android-b',
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });
    const restored = await repository.createAttempt(session.id, authenticated.id, deviceB.id);
    expect(restored.continued).toBe(true);
    expect(restored.attempt.id).toBe(started.attempt.id);
    expect(restored.attempt.deviceSessionId).toBe(deviceB.id);
    expect(restored.attempt.answers).toHaveLength(1);
    await repository.submitAttempt(restored.attempt.id);
    await expect(
      repository.recordAnswer(restored.attempt.id, {
        questionId: 'q',
        answer: '',
        deviceSessionId: deviceB.id,
        isFinal: false,
      }),
    ).rejects.toThrow('no longer accepts');
  });
});
