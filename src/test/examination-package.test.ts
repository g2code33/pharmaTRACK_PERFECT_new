import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';

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
  isDuplicateExamPackage,
  markExamPackageImported,
  packageContainsPlaintextPassword,
  validatePharmaExamPackage,
  verifyExamPassword,
} from '../examination/package';
import { readBlobArrayBuffer } from '../utils/fileGuard';
import { emptyExaminationState } from '../examination/types';

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

async function publishedVersion(requireExamPassword = false) {
  const repository = await ExaminationRepository.open();
  const exam = await repository.createExam('Pharmacology Secure Examination');
  const version = await repository.createVersion(exam.id, [question], {
    title: 'Pharmacology Secure Examination',
    assessmentType: 'KIOSK_EXAM',
    security: { kioskMode: true, requireExamPassword },
  });
  return repository.publishVersion(exam.id, version.id);
}

describe('.pharmaexam package', () => {
  it('generates a signed package with all required records and no plaintext password', async () => {
    const version = await publishedVersion(true);
    const password = 'Exam-Only-Password-42';
    const packageData = await createPharmaExamPackage({
      version,
      institution: { name: 'KNUST Pharmacy Department', code: 'KNUST-PHARM' },
      signingKey: await generateExamSigningKeyPair(),
      examPassword: password,
    });

    const result = await validatePharmaExamPackage(packageData.blob, {
      expectedExamVersionId: version.id,
    });
    expect(result.ok).toBe(true);
    expect(result.staged?.exam.id).toBe(version.id);
    expect(result.staged?.institution.name).toContain('KNUST');
    expect(await verifyExamPassword(password, result.staged!.security)).toBe(true);
    expect(await verifyExamPassword('wrong-password', result.staged!.security)).toBe(false);
    const raw = new TextDecoder().decode(
      new Uint8Array(await readBlobArrayBuffer(packageData.blob)),
    );
    expect(packageContainsPlaintextPassword(raw, password)).toBe(false);
  });

  it('detects checksum and signature tampering before accepting the package', async () => {
    const version = await publishedVersion();
    const packageData = await createPharmaExamPackage({
      version,
      institution: { name: 'Test Institution' },
      signingKey: await generateExamSigningKeyPair(),
    });
    const zip = await JSZip.loadAsync(await readBlobArrayBuffer(packageData.blob));
    zip.file(
      'questions.json',
      JSON.stringify([{ ...version.questions[0], questionText: 'TAMPERED' }]),
    );
    const tampered = await zip.generateAsync({ type: 'blob' });
    const result = await validatePharmaExamPackage(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/checksum|signature|digest/i);
  });

  it('rejects missing files, unsupported versions, and malformed packages', async () => {
    const missing = new JSZip();
    missing.file(
      'manifest.json',
      JSON.stringify({ app: 'pharmatrack', format: 'pharmaexam', formatVersion: 1 }),
    );
    const missingResult = await validatePharmaExamPackage(
      await missing.generateAsync({ type: 'blob' }),
    );
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors.join(' ')).toMatch(/missing/i);

    const version = await publishedVersion();
    const packageData = await createPharmaExamPackage({
      version,
      institution: { name: 'Test' },
      signingKey: await generateExamSigningKeyPair(),
    });
    const unsupportedZip = await JSZip.loadAsync(await readBlobArrayBuffer(packageData.blob));
    const manifest = JSON.parse(await unsupportedZip.file('manifest.json')!.async('string'));
    manifest.formatVersion = 999;
    unsupportedZip.file('manifest.json', JSON.stringify(manifest));
    const unsupported = await validatePharmaExamPackage(
      await unsupportedZip.generateAsync({ type: 'blob' }),
    );
    expect(unsupported.ok).toBe(false);
    expect(unsupported.errors.join(' ')).toContain('Unsupported examination package version');

    const malformed = await validatePharmaExamPackage(new Blob(['not a zip']));
    expect(malformed.ok).toBe(false);
  });

  it('does not accept a package signed by an unexpected trusted key', async () => {
    const version = await publishedVersion();
    const packageData = await createPharmaExamPackage({
      version,
      institution: { name: 'Test' },
      signingKey: await generateExamSigningKeyPair(),
    });
    const other = await generateExamSigningKeyPair();
    const trustedKey = await crypto.subtle.exportKey('jwk', other.publicKey);
    const result = await validatePharmaExamPackage(packageData.blob, {
      trustedPublicKeyJwk: trustedKey,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('signer is not trusted');
  });

  it('handles duplicate packages by immutable package key, not filename', async () => {
    const version = await publishedVersion();
    const packageData = await createPharmaExamPackage({
      version,
      institution: { name: 'Test' },
      packageId: 'same-package',
      signingKey: await generateExamSigningKeyPair(),
    });
    const parsed = await validatePharmaExamPackage(packageData.blob);
    expect(parsed.ok).toBe(true);
    const state = emptyExaminationState();
    expect(isDuplicateExamPackage(state, parsed.staged!.manifest)).toBe(false);
    const next = markExamPackageImported(state, parsed.staged!.manifest);
    expect(isDuplicateExamPackage(next, parsed.staged!.manifest)).toBe(true);
    expect(markExamPackageImported(next, parsed.staged!.manifest).importedPackageKeys).toHaveLength(
      1,
    );
  });
});
