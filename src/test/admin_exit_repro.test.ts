import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import type { ExamQuestion } from '../types';
import { ExaminationRepository } from '../examination/service';
import {
  createPharmaExamPackage,
  generateExamSigningKeyPair,
  validatePharmaExamPackage,
  verifyAdminExitPassword,
} from '../examination/package';
import { stagePharmaExamPackage, loadStagedPharmaExam } from '../examination/packageCache';

beforeEach(() => idbStore.clear());

const question: ExamQuestion = {
  id: 'q1',
  courseId: 'c1',
  topicId: 't1',
  questionText: 'Which option is correct?',
  questionType: 'mcq',
  marksAllocation: 2,
  difficulty: 'medium',
  probability: 'high',
  modelAnswer: 'A',
  correctAnswer: 'A',
  tags: ['pharmacology'],
  isPracticed: false,
  needsReview: false,
  isSaved: false,
  createdAt: '2026-01-01',
  options: ['A', 'B', 'C'],
  correctOption: 0,
};

describe('repro: admin exit password round trip (build -> validate -> stage -> load -> verify)', () => {
  it('verifies the correct admin exit password after the exact production pipeline', async () => {
    const repository = await ExaminationRepository.open();
    const exam = await repository.createExam('Pharmacology Secure Examination');
    const version = await repository.createVersion(exam.id, [question], {
      title: 'Pharmacology Secure Examination',
      assessmentType: 'KIOSK_EXAM',
      security: { kioskMode: true, requireExamPassword: false, manualExitPolicy: 'ADMIN_AUTH_REQUIRED' },
    });
    const published = await repository.publishVersion(exam.id, version.id);

    const pkg = await createPharmaExamPackage({
      version: published,
      institution: { name: 'Test Institution' },
      signingKey: await generateExamSigningKeyPair(),
      adminExitPassword: '5678',
    });

    const result = await validatePharmaExamPackage(pkg.blob);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await stagePharmaExamPackage(result.staged!);
    const loaded = await loadStagedPharmaExam();
    expect(loaded).toBeTruthy();

    const ok = await verifyAdminExitPassword('5678', loaded!.security);
    expect(ok).toBe(true);

    const bad = await verifyAdminExitPassword('0000', loaded!.security);
    expect(bad).toBe(false);
  });
});
