import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExamQuestion } from '../types';

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

import { ExaminationRepository, validateExamVersion } from '../examination/service';
import {
  derivePasswordVerifier,
  sequentialKioskPassword,
  verifyPassword,
} from '../examination/crypto';
import { emptyExaminationState } from '../examination/types';
import {
  loadExaminationState,
  normalizeExaminationState,
  EXAMINATION_STATE_KEY,
} from '../examination/storage';

const question = (id: string, text = `Question ${id}`): ExamQuestion => ({
  id,
  courseId: 'course-1',
  topicId: 'topic-1',
  semester: 'Semester 1',
  questionText: text,
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
  createdAt: '2026-01-01T00:00:00.000Z',
  options: ['A', 'B', 'C'],
  correctOption: 0,
});

beforeEach(() => idbStore.clear());

describe('secure examination foundation', () => {
  it('does not alter the existing question-bank or Quiz history model', () => {
    const oldQuestion = question('q-old');
    expect(oldQuestion.questionType).toBe('mcq');
    expect(oldQuestion.correctOption).toBe(0);
    // Examination storage is a separate IndexedDB record, not AppState.
    expect(emptyExaminationState().exams).toEqual([]);
    expect(idbStore.has(EXAMINATION_STATE_KEY)).toBe(false);
  });

  it('creates a draft, validates it, publishes an immutable exact version, and schedules it', async () => {
    const repository = await ExaminationRepository.open();
    const exam = await repository.createExam('PHAR 401 Final Examination', 'admin-device');
    const version = await repository.createVersion(exam.id, [question('q1'), question('q2')], {
      title: 'PHAR 401 Final Examination — Version 1',
      assessmentType: 'FORMAL_EXAM',
      scoring: { passMark: 60 },
      availability: { durationMinutes: 90 },
    });

    expect(version.questions.map((item) => item.sourceQuestionId)).toEqual(['q1', 'q2']);
    expect(version.questions.map((item) => item.order)).toEqual([0, 1]);
    expect((await repository.validateVersion(exam.id, version.id)).ok).toBe(true);
    const published = await repository.publishVersion(exam.id, version.id);
    expect(published.immutable).toBe(true);
    expect(published.publishedAt).toBeTruthy();

    const session = await repository.createSession(exam.id, version.id);
    expect(session.examVersionId).toBe(version.id);
    expect(repository.snapshot.exams[0].lifecycle).toBe('SCHEDULED');
  });

  it('rejects invalid versions before publication', () => {
    const invalid = {
      id: 'v1',
      examId: 'e1',
      version: 1,
      versionHash: 'hash',
      createdAt: '',
      immutable: false,
      title: '',
      instructions: '',
      assessmentType: 'FORMAL_EXAM' as const,
      questions: [],
      scoring: { passMark: 101, negativeMarking: false, negativeMarkValue: 0, defaultMarks: 1 },
      availability: { durationMinutes: 0 },
      security: {
        lockdown: false,
        kioskMode: false,
        allowBackNavigation: true,
        allowQuestionNavigation: true,
        allowReviewBeforeSubmit: true,
        allowCalculator: false,
        allowPause: false,
        requireExamPassword: false,
        requireLanAuthority: false,
        detectFocusLoss: true,
        policyVersion: 1,
      },
      navigation: {
        randomizeQuestions: true,
        randomizeOptions: false,
        allowPrevious: true,
        showQuestionNumbers: true,
      },
      maxAttempts: 0,
    };
    expect(validateExamVersion(invalid)).toEqual(
      expect.arrayContaining([
        'An examination title is required.',
        'At least one question is required.',
        'Pass mark must be between 0 and 100.',
        'Duration must be greater than zero.',
        'At least one attempt must be allowed.',
      ]),
    );
  });

  it('freezes the attempt to the published version and preserves order, options, seed, and settings', async () => {
    const repository = await ExaminationRepository.open();
    const exam = await repository.createExam('Kiosk Test');
    const version = await repository.createVersion(exam.id, [question('q1'), question('q2')], {
      title: 'Kiosk Test',
      assessmentType: 'KIOSK_EXAM',
      security: { kioskMode: true, lockdown: true, requireLanAuthority: true },
      navigation: { randomizeQuestions: true, randomizeOptions: true, allowPrevious: false },
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    const attemptResult = await repository.createAttempt(
      session.id,
      'student-1',
      'device-session-1',
    );
    const attempt = attemptResult.attempt;

    expect(attempt.examVersionId).toBe(version.id);
    expect(attempt.randomizationSeed).toBeTruthy();
    expect(Object.keys(attempt.optionOrders)).toEqual(
      expect.arrayContaining(version.questions.map((q) => q.id)),
    );
    expect(attempt.settingsSnapshot.security.kioskMode).toBe(true);
    expect(attempt.settingsSnapshot.navigation.allowPrevious).toBe(false);
  });

  it('returns Continue Exam rather than creating a second active attempt', async () => {
    const repository = await ExaminationRepository.open();
    const exam = await repository.createExam('Continue Test');
    const version = await repository.createVersion(exam.id, [question('q1')], {
      title: 'Continue Test',
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    const first = await repository.createAttempt(session.id, 'student-1', 'device-a');
    const second = await repository.createAttempt(session.id, 'student-1', 'device-b');

    expect(first.continued).toBe(false);
    expect(second.continued).toBe(true);
    expect(second.attempt.id).toBe(first.attempt.id);
    expect(repository.snapshot.attempts).toHaveLength(1);
  });

  it('stores answers append-safely and preserves the attempt-owned timer', async () => {
    const repository = await ExaminationRepository.open();
    const exam = await repository.createExam('Answer Test');
    const version = await repository.createVersion(exam.id, [question('q1')], {
      title: 'Answer Test',
      availability: { durationMinutes: 30 },
    });
    await repository.publishVersion(exam.id, version.id);
    const session = await repository.createSession(exam.id, version.id);
    const { attempt } = await repository.createAttempt(session.id, 'student-1', 'device-a');
    const deadline = attempt.deadlineAt;
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '0',
      selectedOption: 0,
      deviceSessionId: 'device-a',
      isFinal: false,
    });
    await repository.recordAnswer(attempt.id, {
      questionId: attempt.questionOrder[0],
      answer: '1',
      selectedOption: 1,
      deviceSessionId: 'device-b',
      isFinal: true,
    });

    expect(repository.snapshot.attempts[0].answers).toHaveLength(1);
    expect(repository.snapshot.attempts[0].answers[0].answer).toBe('1');
    expect(repository.snapshot.attempts[0].deadlineAt).toBe(deadline);
    expect(repository.snapshot.attempts[0].localRevision).toBe(2);
  });

  it('registers sequential RX30 passwords without storing plaintext and authenticates on another device', async () => {
    const repository = await ExaminationRepository.open();
    const first = await repository.registerStudent('Blessing', 'Level 300');
    const second = await repository.registerStudent('Jojo', 'Level 300');
    expect(first.password).toBe('RX30a');
    expect(second.password).toBe('RX30b');
    expect(repository.snapshot.students[0]).not.toHaveProperty('password');
    expect(repository.snapshot.students[0].kioskPasswordVerifier.verifier).not.toBe(first.password);
    await expect(repository.registerStudent('blessing', 'Level 300')).rejects.toThrow(
      'This first name is already in use. Please use your surname, middle name, or add a number to your first name.',
    );
    const authenticated = await repository.authenticateStudent(
      'Blessing',
      'Level 300',
      first.password,
    );
    expect(authenticated.id).toBe(first.student.id);
    await expect(
      repository.authenticateStudent('Blessing', 'Level 300', 'RX30b'),
    ).rejects.toThrow();
  });

  it('uses alphabetic kiosk sequence beyond z', () => {
    expect(sequentialKioskPassword(0)).toBe('RX30a');
    expect(sequentialKioskPassword(25)).toBe('RX30z');
    expect(sequentialKioskPassword(26)).toBe('RX30aa');
    expect(sequentialKioskPassword(27)).toBe('RX30ab');
    expect(sequentialKioskPassword(51)).toBe('RX30az');
    expect(sequentialKioskPassword(52)).toBe('RX30ba');
  });

  it('uses a salted KDF verifier and distinguishes the password', async () => {
    const verifier = await derivePasswordVerifier('RX30a');
    expect(verifier.salt).toBeTruthy();
    expect(verifier.verifier).not.toBe('RX30a');
    expect(await verifyPassword('RX30a', verifier)).toBe(true);
    expect(await verifyPassword('RX30b', verifier)).toBe(false);
  });

  it('recovers malformed or missing examination storage as an empty compatible state', async () => {
    idbStore.set(EXAMINATION_STATE_KEY, '{broken');
    expect(normalizeExaminationState(idbStore.get(EXAMINATION_STATE_KEY))).toEqual(
      emptyExaminationState(),
    );
    idbStore.set(EXAMINATION_STATE_KEY, { schemaVersion: 0, exams: [{ id: 'legacy' }] });
    const loaded = await loadExaminationState();
    expect(loaded.schemaVersion).toBe(1);
    expect(loaded.exams).toHaveLength(1);
    expect(loaded.attempts).toEqual([]);
  });
});
