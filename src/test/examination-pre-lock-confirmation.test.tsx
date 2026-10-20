/**
 * Pre-lock confirmation prompt — "when the student clicks sign in, give them
 * a prompt to accept and close all opened windows/apps before the lock
 * engages."
 *
 *   - Clicking "Enter secure examination" opens a confirmation dialog first;
 *     it must NOT touch fullscreen/start the attempt yet.
 *   - "Cancel" dismisses it without starting anything.
 *   - "Accept & lock this device" is the click that actually proceeds — and
 *     since browsers only grant Fullscreen during a direct user gesture, the
 *     fullscreen request must still fire synchronously from THIS click.
 *   - When the staged package requires admin authorization to exit (even
 *     after submission), the dialog says so up front.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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

vi.mock('../examination/lanServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../examination/lanServer')>();
  return {
    ...actual,
    isNativeLanServerAvailable: () => false,
    discoverLanAuthorities: async () => [],
  };
});

import { ExaminationRepository } from '../examination/service';
import {
  createPharmaExamPackage,
  generateExamSigningKeyPair,
  validatePharmaExamPackage,
} from '../examination/package';
import { stagePharmaExamPackage, clearStagedPharmaExam } from '../examination/packageCache';
import { KIOSK_CAPABILITY_IDS } from '../examination/kioskAdapter';
import type { ExamQuestion } from '../types';
import ExamAttemptEntry from '../pages/ExamAttemptEntry';
import { releaseSecureKiosk } from '../examination/kioskState';

const IDENTITY_KEY = 'pharmatrack:kiosk-identity';

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

async function stageTestPackage(
  manualExitPolicy: 'ADMIN_AUTH_REQUIRED' | 'ALLOW_FREE_EXIT',
  password = 'Kiosk-Entry-Secret-1',
) {
  const repository = await ExaminationRepository.open();
  const exam = await repository.createExam('Pre-Lock Pharmacology Examination');
  const version = await repository.createVersion(exam.id, sampleQuestions, {
    title: 'Pre-Lock Pharmacology Examination',
    assessmentType: 'KIOSK_EXAM',
    availability: { durationMinutes: 60 },
    security: {
      kioskMode: true,
      requireExamPassword: true,
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
    examPassword: password,
  });
  const validation = await validatePharmaExamPackage(packageData.blob);
  if (!validation.ok || !validation.staged) throw new Error('Test package failed to validate.');
  await stagePharmaExamPackage(validation.staged);
  return { repository, exam, version: published };
}

function open() {
  render(
    <MemoryRouter initialEntries={['/examinations/kiosk/attempt']}>
      <Routes>
        <Route path="/examinations/kiosk/attempt" element={<ExamAttemptEntry />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  idbStore.clear();
  await clearStagedPharmaExam();
  window.localStorage.clear();
  sessionStorage.setItem(
    IDENTITY_KEY,
    JSON.stringify({
      firstName: 'Esi',
      level: 'Level 400',
      kioskPassword: 'kiosk-pass',
      studentId: 'student-1',
    }),
  );
});

afterEach(() => {
  cleanup();
  releaseSecureKiosk();
  sessionStorage.removeItem(IDENTITY_KEY);
});

describe('pre-lock confirmation before the kiosk engages', () => {
  it('shows the confirmation dialog instead of locking immediately, and cancel backs out cleanly', async () => {
    await stageTestPackage('ALLOW_FREE_EXIT');
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;

    open();

    const startButton = await screen.findByTestId('start-exam-button');
    fireEvent.change(screen.getByTestId('exam-password-input'), {
      target: { value: 'Kiosk-Entry-Secret-1' },
    });
    await screen.findByText('Device ready');
    await waitFor(() =>
      expect(screen.getByTestId('start-exam-button')).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByTestId('start-exam-button'));

    expect(await screen.findByTestId('confirm-lock-dialog')).toBeTruthy();
    expect(requestFullscreen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-lock-cancel'));
    expect(screen.queryByTestId('confirm-lock-dialog')).toBeNull();
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it('warns that admin authorization is required to exit even after submission, when the package is set that way', async () => {
    await stageTestPackage('ADMIN_AUTH_REQUIRED');
    document.documentElement.requestFullscreen = vi.fn().mockResolvedValue(undefined);

    open();

    const startButton = await screen.findByTestId('start-exam-button');
    fireEvent.change(screen.getByTestId('exam-password-input'), {
      target: { value: 'Kiosk-Entry-Secret-1' },
    });
    await screen.findByText('Device ready');
    await waitFor(() =>
      expect(screen.getByTestId('start-exam-button')).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByTestId('start-exam-button'));
    const dialog = await screen.findByTestId('confirm-lock-dialog');
    expect(dialog.textContent).toMatch(/their authorization to unlock/i);
  });

  it('only engages the lock (requests fullscreen) from the Accept click, not the initial button', async () => {
    await stageTestPackage('ALLOW_FREE_EXIT');
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;

    open();

    const startButton = await screen.findByTestId('start-exam-button');
    fireEvent.change(screen.getByTestId('exam-password-input'), {
      target: { value: 'Kiosk-Entry-Secret-1' },
    });
    await screen.findByText('Device ready');
    await waitFor(() =>
      expect(screen.getByTestId('start-exam-button')).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByTestId('start-exam-button'));
    await screen.findByTestId('confirm-lock-dialog');
    expect(requestFullscreen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-lock-accept'));
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });
});
