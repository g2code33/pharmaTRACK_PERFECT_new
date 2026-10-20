/**
 * Post-submission kiosk lock — "only the admin password set for this
 * examination file releases the device, even after submission."
 *
 *   - When the package's manualExitPolicy is ADMIN_AUTH_REQUIRED, submitting
 *     the exam must NOT auto-release the kiosk lock. The student sees a
 *     locked notice instead of "Return to Quiz" until the per-file admin
 *     exit password is supplied correctly.
 *   - A wrong password keeps the device locked (and is retryable inline,
 *     without needing a reload).
 *   - The correct password — verified against THIS package's own
 *     adminExitPasswordVerifier, never a global secret — releases the lock
 *     and reveals "Return to Quiz".
 *   - Policies other than ADMIN_AUTH_REQUIRED keep releasing immediately on
 *     submission, exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

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
import {
  createPharmaExamPackage,
  generateExamSigningKeyPair,
  validatePharmaExamPackage,
} from '../examination/package';
import { stagePharmaExamPackage, clearStagedPharmaExam } from '../examination/packageCache';
import { derivePasswordVerifier } from '../examination/crypto';
import { KIOSK_CAPABILITY_IDS } from '../examination/kioskAdapter';
import type { ExamQuestion } from '../types';
import { AppProvider } from '../context/AppContext';
import SecureExamination from '../pages/SecureExamination';

const sampleQuestions: ExamQuestion[] = [
  {
    id: 'q1',
    courseId: 'pharma-101',
    topicId: 'pharmacokinetics',
    questionText: 'Which organ is the primary site of drug metabolism?',
    questionType: 'mcq',
    marksAllocation: 2,
    difficulty: 'medium',
    probability: 'high',
    modelAnswer: 'Liver',
    correctAnswer: 'Liver',
    tags: ['pharmacology'],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: '2026-09-26T00:00:00.000Z',
    options: ['Kidneys', 'Liver', 'Lungs', 'Heart'],
    correctOption: 1,
  },
];

async function createLockedTestPackage(manualExitPolicy: 'ADMIN_AUTH_REQUIRED' | 'ALLOW_FREE_EXIT') {
  const repository = await ExaminationRepository.open();
  const exam = await repository.createExam('Locked Pharmacology Examination');
  const version = await repository.createVersion(exam.id, sampleQuestions, {
    title: 'Locked Pharmacology Examination',
    assessmentType: 'KIOSK_EXAM',
    availability: { durationMinutes: 60 },
    security: {
      kioskMode: true,
      manualExitPolicy,
      capabilityFailurePolicy: 'ALLOW_WITH_WARNING',
      requiredCapabilities: [KIOSK_CAPABILITY_IDS.navigation],
    },
    navigation: { allowPrevious: true, showQuestionNumbers: true },
  });
  const published = await repository.publishVersion(exam.id, version.id);
  const signingKey = await generateExamSigningKeyPair();
  const packageData = await createPharmaExamPackage({
    version: published,
    institution: { name: 'Faculty of Pharmacy & Pharmaceutical Sciences', code: 'FPPS-KNUST' },
    signingKey,
    adminExitPassword: 'File-Scoped-Admin-Secret-7',
  });
  return { repository, exam, version: published, packageData };
}

describe('post-submission admin-password exit gate', () => {
  beforeEach(async () => {
    idbStore.clear();
    await clearStagedPharmaExam();
    cleanup();
  });

  it('keeps the device locked after submission when the package requires admin auth to exit', async () => {
    const { repository, version, packageData } = await createLockedTestPackage('ADMIN_AUTH_REQUIRED');
    const validation = await validatePharmaExamPackage(packageData.blob);
    expect(validation.ok).toBe(true);
    await stagePharmaExamPackage(validation.staged!);

    const student = await repository.registerStudent('Esi', 'Level 400');
    const session = await repository.createSession(version.examId, version.id);
    const device = await repository.createDeviceSession({
      deviceId: 'web-browser-safari-ios',
      role: 'STUDENT',
      studentId: student.student.id,
      sessionId: session.id,
      platform: 'web',
      capabilities: ['encrypted-local-state'],
    });
    const started = await repository.createAttempt(session.id, student.student.id, device.id);
    await repository.submitAttempt(started.attempt.id, false, device.id, 'MANUAL');

    window.prompt = vi.fn();

    render(
      <MemoryRouter initialEntries={[`/examination/secure/${started.attempt.id}`]}>
        <AppProvider>
          <Routes>
            <Route path="/examination/secure/:attemptId" element={<SecureExamination />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Examination (Submitted|Results)/)).toBeTruthy();
    expect(screen.getByTestId('post-submission-lock-notice')).toBeTruthy();
    expect(screen.queryByTestId('return-to-quiz')).toBeNull();

    // The device really is still locked server-side too — a reload would not
    // find the attempt already released.
    const reopened = await ExaminationRepository.open();
    expect(reopened.snapshot.attempts.find((a) => a.id === started.attempt.id)?.status).toBe(
      'SUBMITTED',
    );

    // Wrong password: stays locked, retryable without a reload.
    (window.prompt as ReturnType<typeof vi.fn>).mockReturnValueOnce('not-the-password');
    fireEvent.click(screen.getByTestId('unlock-with-admin-password'));
    await waitFor(() => {
      expect(screen.getByTestId('unlock-error')).toBeTruthy();
    });
    expect(screen.getByTestId('post-submission-lock-notice')).toBeTruthy();
    expect(screen.queryByTestId('return-to-quiz')).toBeNull();

    // Correct, file-scoped password: unlocks.
    (window.prompt as ReturnType<typeof vi.fn>).mockReturnValueOnce('File-Scoped-Admin-Secret-7');
    fireEvent.click(screen.getByTestId('unlock-with-admin-password'));
    await waitFor(() => {
      expect(screen.getByTestId('return-to-quiz')).toBeTruthy();
    });
    expect(screen.queryByTestId('post-submission-lock-notice')).toBeNull();

    const released = await ExaminationRepository.open();
    expect(
      released.snapshot.attempts.find((a) => a.id === started.attempt.id)?.kioskLifecycle,
    ).toBe('RELEASED');
  });

  it('releases immediately on submission when the package allows free exit', async () => {
    const { repository, version, packageData } = await createLockedTestPackage('ALLOW_FREE_EXIT');
    const validation = await validatePharmaExamPackage(packageData.blob);
    await stagePharmaExamPackage(validation.staged!);

    const student = await repository.registerStudent('Kofi', 'Level 200');
    const session = await repository.createSession(version.examId, version.id);
    const device = await repository.createDeviceSession({
      deviceId: 'web-browser-chrome',
      role: 'STUDENT',
      studentId: student.student.id,
      sessionId: session.id,
      platform: 'web',
      capabilities: ['encrypted-local-state'],
    });
    const started = await repository.createAttempt(session.id, student.student.id, device.id);
    await repository.submitAttempt(started.attempt.id, false, device.id, 'MANUAL');

    render(
      <MemoryRouter initialEntries={[`/examination/secure/${started.attempt.id}`]}>
        <AppProvider>
          <Routes>
            <Route path="/examination/secure/:attemptId" element={<SecureExamination />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Examination (Submitted|Results)/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('return-to-quiz')).toBeTruthy();
    });
    expect(screen.queryByTestId('post-submission-lock-notice')).toBeNull();
  });

  it('verifies the admin exit password from the attempt itself when no .pharmaexam file was ever staged on this device (a join-code-only kiosk login)', async () => {
    // No createPharmaExamPackage / stagePharmaExamPackage call anywhere in
    // this test — this reproduces a student who reached the device entirely
    // through a LAN/cloud join code, exactly like the real kiosk login flow
    // (KioskEntry -> authenticateKioskStudentViaAdmin), never uploading a
    // package file. Before this fix, the admin exit password verifier only
    // ever lived inside a staged package, so this device could never be
    // unlocked no matter what password was supplied.
    const repository = await ExaminationRepository.open();
    const exam = await repository.createExam('Join-Code Pharmacology Examination');
    const version = await repository.createVersion(exam.id, sampleQuestions, {
      title: 'Join-Code Pharmacology Examination',
      assessmentType: 'KIOSK_EXAM',
      availability: { durationMinutes: 60 },
      security: {
        kioskMode: true,
        manualExitPolicy: 'ADMIN_AUTH_REQUIRED',
        capabilityFailurePolicy: 'ALLOW_WITH_WARNING',
        requiredCapabilities: [KIOSK_CAPABILITY_IDS.navigation],
        adminExitPasswordVerifier: await derivePasswordVerifier('Version-Scoped-Admin-Secret-9'),
      },
      navigation: { allowPrevious: true, showQuestionNumbers: true },
    });
    const published = await repository.publishVersion(exam.id, version.id);

    const student = await repository.registerStudent('Ama', 'Level 300');
    const session = await repository.createSession(published.examId, published.id);
    const device = await repository.createDeviceSession({
      deviceId: 'kiosk-join-code-device',
      role: 'STUDENT',
      studentId: student.student.id,
      sessionId: session.id,
      platform: 'web',
      capabilities: ['encrypted-local-state'],
    });
    const started = await repository.createAttempt(session.id, student.student.id, device.id);
    await repository.submitAttempt(started.attempt.id, false, device.id, 'MANUAL');

    window.prompt = vi.fn();

    render(
      <MemoryRouter initialEntries={[`/examination/secure/${started.attempt.id}`]}>
        <AppProvider>
          <Routes>
            <Route path="/examination/secure/:attemptId" element={<SecureExamination />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Examination (Submitted|Results)/)).toBeTruthy();
    expect(screen.getByTestId('post-submission-lock-notice')).toBeTruthy();

    // Wrong password still fails, same as the file-based flow.
    (window.prompt as ReturnType<typeof vi.fn>).mockReturnValueOnce('not-the-password');
    fireEvent.click(screen.getByTestId('unlock-with-admin-password'));
    await waitFor(() => {
      expect(screen.getByTestId('unlock-error')).toBeTruthy();
    });

    // The correct, version-scoped password unlocks even though no package
    // file was ever staged on this device.
    (window.prompt as ReturnType<typeof vi.fn>).mockReturnValueOnce('Version-Scoped-Admin-Secret-9');
    fireEvent.click(screen.getByTestId('unlock-with-admin-password'));
    await waitFor(() => {
      expect(screen.getByTestId('return-to-quiz')).toBeTruthy();
    });
    expect(screen.queryByTestId('post-submission-lock-notice')).toBeNull();
  });
});
