/**
 * ExaminationAdmin — results and submitted-work review.
 *
 * The invigilator's console must answer three questions at any time, for any
 * examination this device has ever administered:
 *
 *   1. What did each student score?                    (results table)
 *   2. What work did each student actually submit?     (per-question review)
 *   3. Can I come back and look again later?           (session picker)
 *
 * In native LAN examinations the students answer on their own devices, so the
 * console also has to PULL the authority's view onto this device. These tests
 * pin that the import is wired into refresh, that it is idempotent (the
 * authority wins per question, a regrade follows, nothing duplicates), and
 * that the review shows the work itself — question, answer, marking.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const lanMocks = vi.hoisted(() => ({
  native: true,
  running: false,
  endpoint: 'http://192.168.10.5:8787',
}));

vi.mock('../examination/lanServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../examination/lanServer')>();
  return {
    ...actual,
    isNativeLanServerAvailable: () => lanMocks.native,
    detectLanHost: async () => '192.168.10.5',
    lanExamServerStatus: async () => ({
      running: lanMocks.running,
      endpoint: lanMocks.endpoint,
      discoveryEndpoint: 'http://192.168.10.5:8788',
      serverId: 'server-1',
      authorityId: 'authority-1',
      authorityEpoch: 1,
      revision: 3,
      activeConnections: 1,
      activeAttempts: 1,
      submittedAttempts: 1,
      lastHeartbeatAt: '2026-01-01T00:10:00.000Z',
    }),
    startLanExamServer: vi.fn(),
    stopLanExamServer: vi.fn(async () => undefined),
  };
});

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    state: { quizHistory: [] },
    dispatch,
  }),
}));

import ExaminationAdmin from '../pages/ExaminationAdmin';
import { ExaminationRepository } from '../examination/service';
import type { LanAuthorityStateReport } from '../examination/types';
import type { ExamQuestion } from '../types';

const question: ExamQuestion = {
  id: 'q1',
  courseId: 'course-1',
  topicId: 'topic-1',
  questionText: 'Which option is correct?',
  questionType: 'mcq',
  marksAllocation: 1,
  difficulty: 'easy',
  probability: 'high',
  modelAnswer: 'A',
  correctAnswer: 'A',
  tags: [],
  isPracticed: false,
  needsReview: false,
  isSaved: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  options: ['A', 'B'],
  correctOption: 0,
};

const STARTED_AT = '2026-01-01T09:00:00.000Z';
const SUBMITTED_AT = '2026-01-01T09:20:00.000Z';

/** The authority's /state view of one student who answered and submitted. */
function authorityState(questionId: string, answer: string, revision = 1): LanAuthorityStateReport {
  return {
    attempts: [
      {
        id: 'lan-attempt-1',
        studentId: 'RX30-001',
        deviceSessionId: 'device-session-x',
        status: 'SUBMITTED',
        answers: [
          {
            questionId,
            answer,
            selectedOption: Number(answer),
            deviceSessionId: 'device-session-x',
            revision,
            eventId: `evt-${revision}`,
            serverRevision: revision,
            serverReceiptAt: SUBMITTED_AT,
          },
        ],
        startedAt: STARTED_AT,
        submittedAt: SUBMITTED_AT,
      },
    ],
    securityEvents: [
      {
        type: 'IDENTITY_AUTHENTICATED',
        severity: 'info',
        at: STARTED_AT,
        deviceSessionId: 'device-session-x',
        studentId: 'RX30-001',
      },
      {
        type: 'SUBMITTED',
        severity: 'info',
        at: SUBMITTED_AT,
        attemptId: 'lan-attempt-1',
        studentId: 'RX30-001',
      },
    ],
    revision: 3,
  };
}

/** Creates a real published session in the (mocked) repository. */
async function seedSession(title: string) {
  const repository = await ExaminationRepository.open();
  await repository.registerStudent('LAN Student', 'Level 300');
  const exam = await repository.createExam(title);
  const version = await repository.createVersion(exam.id, [question], {
    title,
    assessmentType: 'KIOSK_EXAM',
    security: { kioskMode: true, requireLanAuthority: true },
  });
  const published = await repository.publishVersion(exam.id, version.id);
  const session = await repository.createSession(exam.id, published.id);
  await repository.setSessionAuthority(
    session.id,
    lanMocks.endpoint,
    'a'.repeat(43),
    'server-1',
    1,
  );
  // Versions snapshot questions under their own ids (`q1:v…:0`), and the
  // authority's answers are keyed by the version's question id.
  const publishedVersion = repository.snapshot.versions.find(
    (item) => item.id === published.id,
  );
  const questionId = publishedVersion?.questions[0]?.id ?? 'q1';
  return { repository, session, questionId };
}

function open() {
  render(
    <MemoryRouter initialEntries={['/examinations/admin']}>
      <Routes>
        <Route path="/examinations/admin" element={<ExaminationAdmin />} />
        <Route path="/examinations/kiosk" element={<div data-testid="kiosk-link-target" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  idbStore.clear();
  // These tests exercise console features, not the password gate — start
  // each one from an already-unlocked admin tab (sessionStorage flag).
  sessionStorage.setItem('pharmatrack:admin-gate-unlocked', '1');
  lanMocks.native = true;
  lanMocks.running = false;
});

afterEach(async () => {
  // The admin console refreshes on a 5 s interval and its async chain can
  // still be in flight when the test body finishes. Give pending promises a
  // macrotask to land while the DOM environment still exists — otherwise
  // their setState dispatches into a torn-down window (the intermittent
  // "window is not defined" failure on CI runners, ExaminationAdmin.tsx:199).
  await new Promise((resolve) => setTimeout(resolve, 10));
  cleanup();
  idbStore.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('importLanAuthorityState — the authority is the source of truth', () => {
  it('grades submitted work and stores it with the answers', async () => {
    const { repository, session, questionId } = await seedSession('Results Review Exam');
    const outcome = await repository.importLanAuthorityState(session.id, authorityState(questionId, '0'));
    expect(outcome.importedAttempts).toBe(1);
    expect(outcome.gradedResults).toBe(1);

    const reopened = await ExaminationRepository.open();
    const attempt = reopened.snapshot.attempts.find((item) => item.id === 'lan-attempt-1');
    expect(attempt).toBeTruthy();
    expect(attempt?.status).toBe('SUBMITTED');
    expect(attempt?.answers[0]?.answer).toBe('0');
    expect(attempt?.synchronizationState).toBe('SYNCHRONIZED');

    const result = reopened.snapshot.results.find((item) => item.attemptId === 'lan-attempt-1');
    expect(result?.score).toBe(1);
    expect(result?.maxMarks).toBe(1);
    expect(result?.percentage).toBe(100);
    expect(result?.questionResults[0]?.answer).toBe('0');
    expect(result?.questionResults[0]?.isCorrect).toBe(true);

    const submittedEvent = reopened.snapshot.securityEvents.find(
      (event) => event.type === 'SUBMITTED' && event.attemptId === 'lan-attempt-1',
    );
    expect(submittedEvent).toBeTruthy();
  });

  it('is idempotent: re-importing never duplicates, and a regrade follows the authority', async () => {
    const { repository, session, questionId } = await seedSession('Idempotent Import Exam');
    await repository.importLanAuthorityState(session.id, authorityState(questionId, '0'));

    // The student's answer is corrected on the authority before the exam
    // closes; the next import must win per question and re-grade — without
    // creating a second attempt or result.
    const second = await repository.importLanAuthorityState(session.id, authorityState(questionId, '1', 2));
    expect(second.importedAttempts).toBe(0);
    expect(second.updatedAttempts).toBe(1);

    const reopened = await ExaminationRepository.open();
    expect(reopened.snapshot.attempts.filter((item) => item.id === 'lan-attempt-1').length).toBe(1);
    const results = reopened.snapshot.results.filter((item) => item.attemptId === 'lan-attempt-1');
    expect(results.length).toBe(1);
    expect(results[0]?.score).toBe(0);
    expect(results[0]?.questionResults[0]?.answer).toBe('1');

    // Identical audit events must not be re-appended.
    const submittedEvents = reopened.snapshot.securityEvents.filter(
      (event) => event.type === 'SUBMITTED' && event.attemptId === 'lan-attempt-1',
    );
    expect(submittedEvents.length).toBe(1);
  });
});

describe('the invigilator console', () => {
  it('shows each student’s submitted work, question by question, with the marking', async () => {
    const { repository, session, questionId } = await seedSession('Work Review Exam');
    await repository.importLanAuthorityState(session.id, authorityState(questionId, '0'));

    open();
    await waitFor(() => {
      expect(screen.getByText('1/1 (100%)')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('review-work-lan-attempt-1'));
    const review = await screen.findByTestId('result-work-review');
    const text = review.textContent ?? '';
    expect(text).toContain('Which option is correct?');
    expect(text).toContain('RX30-001');
    // The stored answer is the option index; the review must show the option
    // text the student actually chose, not the raw index.
    expect(text).toContain('A');
    expect(text).toContain('1/1');
  });

  it('pulls submitted work from the running LAN authority during refresh', async () => {
    const { session, questionId } = await seedSession('Auto Import Exam');
    lanMocks.running = true;
    const stateResponse = authorityState(questionId, '0');
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      json: async () => stateResponse,
    }));
    (window as unknown as { fetch: unknown }).fetch = fetchMock;

    open();
    // The submitted attempt appears on its own — no manual import needed.
    await waitFor(() => {
      expect(screen.getByText('1/1 (100%)')).toBeTruthy();
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/state'))).toBe(true);
    expect(
      screen.getByText(/Imported 1 newly submitted attempt\(s\) from the LAN authority\./),
    ).toBeTruthy();
    // The work itself came across with it.
    fireEvent.click(screen.getByTestId('review-work-lan-attempt-1'));
    expect(await screen.findByTestId('result-work-review')).toBeTruthy();
    void session;
  });

  it('keeps every past session visitable and scopes results to the viewed one', async () => {
    const { repository, session: first, questionId } = await seedSession('First Exam');
    await repository.importLanAuthorityState(first.id, authorityState(questionId, '0'));
    const second = await (async () => {
      const repo = await ExaminationRepository.open();
      const exam = await repo.createExam('Second Exam');
      const version = await repo.createVersion(exam.id, [question], {
        title: 'Second Exam',
        assessmentType: 'KIOSK_EXAM',
        security: { kioskMode: true, requireLanAuthority: true },
      });
      const published = await repo.publishVersion(exam.id, version.id);
      return repo.createSession(exam.id, published.id);
    })();

    open();
    const picker = await screen.findByTestId('session-picker');
    const select = picker.querySelector('select') as HTMLSelectElement;
    // The section renders before the repository has loaded; wait for both
    // sessions to actually appear as options.
    await waitFor(() => {
      const optionTexts = [...select.options].map((option) => option.textContent ?? '');
      expect(optionTexts.some((text) => text.includes('First Exam'))).toBe(true);
      expect(optionTexts.some((text) => text.includes('Second Exam'))).toBe(true);
    });

    // Default view: the first session's result is visible.
    await waitFor(() => {
      expect(screen.getByText('1/1 (100%)')).toBeTruthy();
    });

    // Switching to the second session scopes the table to it — no results
    // there yet, and nothing from the first exam leaks in.
    fireEvent.change(select, { target: { value: second.id } });
    await waitFor(() => {
      expect(screen.queryByText('1/1 (100%)')).toBeNull();
    });

    // And back: the first exam is still there, any time.
    fireEvent.change(select, { target: { value: first.id } });
    await waitFor(() => {
      expect(screen.getByText('1/1 (100%)')).toBeTruthy();
    });
  });
});
