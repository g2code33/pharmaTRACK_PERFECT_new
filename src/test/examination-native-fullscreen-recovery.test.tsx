/**
 * Native-desktop (Tauri) secure exams enforce fullscreen on the OS window
 * itself (`set_fullscreen` in the Rust host), never via the DOM Fullscreen
 * API. Before this fix, the page's exited-fullscreen banner used
 * `document.fullscreenElement` unconditionally, so on native-pc it reported
 * "Fullscreen exited" immediately and permanently regardless of the real
 * window state, and its "Return to Fullscreen" button called a no-op stub
 * that never touched the native window at all. This test locks in the
 * native-aware replacement: polling the real native state over IPC, and
 * actually reasserting fullscreen when the button is pressed.
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

vi.mock('../platform/runtime', async () => {
  const actual = await vi.importActual<typeof import('../platform/runtime')>('../platform/runtime');
  return {
    ...actual,
    detectRuntimePlatform: () => 'native-pc',
  };
});

let nativeFullscreenActive = true;
const requestFullscreenMock = vi.fn(async () => true);
vi.mock('../examination/nativeKiosk', async () => {
  const actual = await vi.importActual<typeof import('../examination/nativeKiosk')>(
    '../examination/nativeKiosk',
  );
  return {
    ...actual,
    queryNativeFullscreenActive: vi.fn(async () => nativeFullscreenActive),
  };
});

vi.mock('../examination/androidAdapter', () => ({
  createPlatformKioskAdapter: vi.fn(async () => ({
    matrix: { platform: 'TAURI_PC', capabilities: [] },
    install: () => () => undefined,
    enterSecureMode: async () => true,
    exitSecureMode: async () => true,
    requestFullscreen: requestFullscreenMock,
  })),
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

async function renderActiveNativeAttempt() {
  const repository = await ExaminationRepository.open();
  const exam = await repository.createExam('Native PC Secure Examination');
  const version = await repository.createVersion(exam.id, sampleQuestions, {
    title: 'Native PC Secure Examination',
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
    deviceId: 'native-pc-device',
    role: 'STUDENT',
    studentId: student.student.id,
    sessionId: session.id,
    platform: 'TAURI_PC',
    capabilities: ['encrypted-local-state'],
  });
  const started = await repository.createAttempt(session.id, student.student.id, device.id);

  render(
    <MemoryRouter initialEntries={[`/examination/secure/${started.attempt.id}`]}>
      <AppProvider>
        <Routes>
          <Route path="/examination/secure/:attemptId" element={<SecureExamination />} />
        </Routes>
      </AppProvider>
    </MemoryRouter>,
  );

  expect(await screen.findByText(sampleQuestions[0].questionText)).toBeTruthy();
}

describe('native-pc fullscreen exited banner uses the real native state, not the DOM API', () => {
  beforeEach(() => {
    idbStore.clear();
    nativeFullscreenActive = true;
    requestFullscreenMock.mockClear();
    cleanup();
  });

  it('does not show the "Fullscreen exited" banner while the native window reports fullscreen active', async () => {
    nativeFullscreenActive = true;
    await renderActiveNativeAttempt();

    await waitFor(() => {
      expect(screen.queryByText(/Fullscreen exited/)).toBeNull();
    });
  });

  it('shows the banner when the native window reports fullscreen inactive, and the button restores it', async () => {
    nativeFullscreenActive = false;
    await renderActiveNativeAttempt();

    expect(await screen.findByText(/Fullscreen exited/)).toBeTruthy();
    const returnButton = screen.getByText('Return to Fullscreen');

    // Pressing the button must actually call into the native adapter now,
    // not the old no-op stub.
    const callsBeforeClick = requestFullscreenMock.mock.calls.length;
    fireEvent.click(returnButton);
    await waitFor(() =>
      expect(requestFullscreenMock.mock.calls.length).toBeGreaterThan(callsBeforeClick),
    );

    // Once the native host reports fullscreen restored, the banner clears.
    nativeFullscreenActive = true;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
    });
    await waitFor(() => {
      expect(screen.queryByText(/Fullscreen exited/)).toBeNull();
    });
  }, 10000);
});
