/**
 * Mid-exam early-exit rejection must never be a dead end.
 *
 * Before this fix, an ATTEMPTED_EXIT violation whose administrator
 * authorization was rejected replaced the entire quiz UI with a static
 * notice card that had no way back to the questions — the only way forward
 * was to try the exit password again, or leave the device exactly as the
 * reported bug described. Rejection must now offer an explicit
 * "Return to quiz" action that keeps the lock engaged but lets the student
 * resume answering.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
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

let capturedViolationHandler: ((violation: { violation: string; detail?: string }) => void) | null =
  null;

vi.mock('../examination/androidAdapter', () => ({
  createPlatformKioskAdapter: vi.fn(async (onViolation: (violation: any) => void) => {
    capturedViolationHandler = onViolation;
    return {
      matrix: { platform: 'web', capabilities: [] },
      install: () => () => undefined,
      enterSecureMode: async () => true,
      exitSecureMode: async () => true,
      requestFullscreen: async () => true,
    };
  }),
}));

import { ExaminationRepository } from '../examination/service';
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

describe('mid-exam early-exit rejection offers Return to quiz', () => {
  beforeEach(() => {
    idbStore.clear();
    capturedViolationHandler = null;
    cleanup();
  });

  it('shows Return to quiz after an admin-auth rejection and resumes the active attempt', async () => {
    const repository = await ExaminationRepository.open();
    const exam = await repository.createExam('Active Pharmacology Examination');
    const version = await repository.createVersion(exam.id, sampleQuestions, {
      title: 'Active Pharmacology Examination',
      assessmentType: 'KIOSK_EXAM',
      availability: { durationMinutes: 60 },
      security: {
        kioskMode: true,
        manualExitPolicy: 'ADMIN_AUTH_REQUIRED',
        capabilityFailurePolicy: 'ALLOW_WITH_WARNING',
        requiredCapabilities: [KIOSK_CAPABILITY_IDS.navigation],
      },
      navigation: { allowPrevious: true, showQuestionNumbers: true },
    });
    const published = await repository.publishVersion(exam.id, version.id);

    const student = await repository.registerStudent('Kwabena', 'Level 200');
    const session = await repository.createSession(published.examId, published.id);
    const device = await repository.createDeviceSession({
      deviceId: 'active-exam-device',
      role: 'STUDENT',
      studentId: student.student.id,
      sessionId: session.id,
      platform: 'web',
      capabilities: ['encrypted-local-state'],
    });
    const started = await repository.createAttempt(session.id, student.student.id, device.id);

    window.prompt = vi.fn(() => 'wrong-password');

    render(
      <MemoryRouter initialEntries={[`/examination/secure/${started.attempt.id}`]}>
        <AppProvider>
          <Routes>
            <Route path="/examination/secure/:attemptId" element={<SecureExamination />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(capturedViolationHandler).not.toBeNull());
    expect(await screen.findByText(sampleQuestions[0].questionText)).toBeTruthy();

    await act(async () => {
      capturedViolationHandler!({ violation: 'ATTEMPTED_EXIT' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      await screen.findByText(
        /That exit password was not recognized\. This is the password set when this exam was created, not RX30 or any login password\./,
      ),
    ).toBeTruthy();
    const returnButton = await screen.findByTestId('return-to-quiz');
    expect(returnButton).toBeTruthy();

    fireEvent.click(returnButton);

    expect(await screen.findByText(sampleQuestions[0].questionText)).toBeTruthy();

    // The attempt itself is unaffected — still active, never force-submitted
    // just because an exit attempt was rejected.
    const reopened = await ExaminationRepository.open();
    expect(reopened.snapshot.attempts.find((a) => a.id === started.attempt.id)?.status).toBe(
      'ACTIVE',
    );
  });
});
