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
import { examinationResultToQuizHistory } from '../examination/results';
import type { ExamQuestion } from '../types';

const question = (id: string, correctOption = 0): ExamQuestion => ({
  id,
  courseId: 'c1',
  topicId: 't1',
  questionText: `Question ${id}`,
  questionType: 'mcq',
  marksAllocation: 2,
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
  correctOption,
});

beforeEach(() => idbStore.clear());

describe('Admin results and examination audit', () => {
  it('grades a completed Kiosk attempt, creates compatible Quiz History, and retains audit/archive state', async () => {
    const repository = await ExaminationRepository.open();
    const identity = await repository.registerStudent('Results Student', 'Level 200');
    const exam = await repository.createExam('Results Examination');
    const version = await repository.createVersion(exam.id, [question('q1'), question('q2', 1)], {
      title: 'Results Examination',
      assessmentType: 'KIOSK_EXAM',
      availability: { durationMinutes: 60 },
      security: { kioskMode: true },
    });
    expect((await repository.validateVersion(exam.id, version.id)).ok).toBe(true);
    const published = await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, published.id);
    await repository.createDeviceSession({
      deviceId: 'admin-device',
      role: 'ADMIN',
      capabilities: ['authority-control'],
    });
    const device = await repository.createDeviceSession({
      deviceId: 'results-pc',
      studentId: identity.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });
    const started = await repository.createAttempt(session.id, identity.student.id, device.id);
    await repository.recordAnswer(started.attempt.id, {
      questionId: started.attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: device.id,
      isFinal: true,
    });
    await repository.recordAnswer(started.attempt.id, {
      questionId: started.attempt.questionOrder[1],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: device.id,
      isFinal: true,
    });
    const submitted = await repository.submitAttempt(started.attempt.id, false, device.id);
    await repository.logSecurityEvent({
      attemptId: submitted.id,
      sessionId: session.id,
      studentId: identity.student.id,
      deviceSessionId: device.id,
      type: 'SUBMITTED',
      severity: 'info',
      details: 'Test submission.',
    });
    const result = repository.getExaminationResult(submitted.id)!;
    expect(result.assessmentType).toBe('KIOSK_EXAM');
    expect(result.score).toBe(2);
    expect(result.percentage).toBe(50);
    expect(result.answerStatistics).toMatchObject({ answered: 2, correct: 1, incorrect: 1 });
    expect(result.deviceHistory).toContain(device.id);
    const history = examinationResultToQuizHistory(result, published);
    expect(history.mode).toBe('kiosk_exam');
    expect(history.examinationVersionId).toBe(published.id);
    expect(history.questionsUsed).toEqual(['q1', 'q2']);
    expect(repository.snapshot.results).toHaveLength(1);
    expect(
      repository.snapshot.securityEvents.some((event) => event.type === 'ANSWER_PERSISTED'),
    ).toBe(true);
    expect(repository.snapshot.adminActions.map((action) => action.action)).toEqual(
      expect.arrayContaining(['CREATE', 'VALIDATE', 'PUBLISH']),
    );
    await repository.archiveExam(
      exam.id,
      'admin',
      'admin-device',
      'Results reviewed and examination closed.',
    );
    expect(repository.snapshot.exams[0].lifecycle).toBe('ARCHIVED');
    expect(
      repository.snapshot.adminActions[repository.snapshot.adminActions.length - 1]?.action,
    ).toBe('CLOSE');
  });
});
