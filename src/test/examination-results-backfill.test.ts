import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for a real gap: an exam set to "release results only
 * when the administrator says so" records the student's result exactly
 * once — at the moment of submission — into their local Quiz History. If it
 * was still hidden at that instant (the normal case for this policy), it
 * never gets a second chance, even after the administrator releases it
 * later. findNewlyVisibleKioskResults() is the catch-up check, meant to run
 * the next time the student logs back in.
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
import { findNewlyVisibleKioskResults } from '../examination/results';
import type { ExamQuestion } from '../types';

const question = (id: string): ExamQuestion => ({
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
  correctOption: 0,
});

beforeEach(() => idbStore.clear());

describe('kiosk result backfill into Quiz History', () => {
  it('finds a result that only became visible after the exam was submitted', async () => {
    const repository = await ExaminationRepository.open();
    const { student } = await repository.registerStudent('Efua', 'Level 300');
    const exam = await repository.createExam('Pharmacology Finals');
    const version = await repository.createVersion(exam.id, [question('q1')], {
      title: 'Pharmacology Finals',
      resultVisibilityPolicy: 'ON_RELEASE',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    await repository.createDeviceSession({
      deviceId: 'admin-dev-01',
      role: 'ADMIN',
      capabilities: ['authority-control'],
    });
    const dev = await repository.createDeviceSession({
      deviceId: 'dev-efua',
      studentId: student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });
    const { attempt } = await repository.createAttempt(session.id, student.id, dev.id);
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: dev.id,
      isFinal: true,
    });
    await repository.submitAttempt(attempt.id, false, dev.id);

    // Right after submission: nothing visible yet, nothing to backfill.
    expect(findNewlyVisibleKioskResults(repository, student.id, new Set())).toHaveLength(0);

    // Administrator releases the result some time later.
    await repository.releaseResultForAttempt(attempt.id, 'admin-chief', 'admin-dev-01');

    // The student logs back in on a fresh repository instance (a different
    // page load) — the backfill must now find it.
    const freshRepository = await ExaminationRepository.open();
    const newlyVisible = findNewlyVisibleKioskResults(freshRepository, student.id, new Set());
    expect(newlyVisible).toHaveLength(1);
    expect(newlyVisible[0].examinationResultId).toBe(`result:${attempt.id}`);

    // Calling it again after it has already been recorded must not re-add it.
    const alreadyRecorded = new Set([newlyVisible[0].examinationResultId!]);
    expect(findNewlyVisibleKioskResults(freshRepository, student.id, alreadyRecorded)).toHaveLength(0);
  });

  it('never surfaces another student\'s result', async () => {
    const repository = await ExaminationRepository.open();
    const a = await repository.registerStudent('Ama', 'Level 200');
    const b = await repository.registerStudent('Kojo', 'Level 200');
    const exam = await repository.createExam('Shared Exam');
    const version = await repository.createVersion(exam.id, [question('q1')], {
      title: 'Shared Exam',
      resultVisibilityPolicy: 'IMMEDIATE',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    const devA = await repository.createDeviceSession({
      deviceId: 'dev-a',
      studentId: a.student.id,
      role: 'STUDENT',
      sessionId: session.id,
      capabilities: ['encrypted-local-state'],
    });
    const { attempt } = await repository.createAttempt(session.id, a.student.id, devA.id);
    await repository.submitAttempt(attempt.id, false, devA.id);

    expect(findNewlyVisibleKioskResults(repository, b.student.id, new Set())).toHaveLength(0);
    expect(findNewlyVisibleKioskResults(repository, a.student.id, new Set())).toHaveLength(1);
  });
});
