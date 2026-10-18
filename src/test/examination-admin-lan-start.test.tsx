/**
 * ExaminationAdmin — the "Start LAN authority" flow.
 *
 * The button used to be silently disabled whenever no examination session
 * existed on the device, which reads from the outside as "broken". These tests
 * pin the new contract:
 *
 *   - the prerequisites (native host, session) are stated up front in the UI;
 *   - clicking Start without a session explains exactly what to do, with a
 *     link to the Kiosk Entry screen, instead of doing nothing;
 *   - in the browser preview the button explains that a real TCP authority
 *     needs the installed app — and never pretends to be running;
 *   - on the native host with a real session, Start binds the authority,
 *     advertises the auto-detected LAN address, and records it on the session.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  native: false,
  detectedHost: null as string | null,
  startLanExamServer: vi.fn(),
}));

vi.mock('../examination/lanServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../examination/lanServer')>();
  return {
    ...actual,
    isNativeLanServerAvailable: () => lanMocks.native,
    detectLanHost: async () => lanMocks.detectedHost,
    lanExamServerStatus: async () => ({
      running: false,
      endpoint: '',
      discoveryEndpoint: '',
      serverId: '',
      authorityId: '',
      authorityEpoch: 0,
      revision: 0,
      activeConnections: 0,
      activeAttempts: 0,
      submittedAttempts: 0,
      lastHeartbeatAt: '',
    }),
    startLanExamServer: lanMocks.startLanExamServer,
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
import type { ExamQuestion } from '../types';

const question: ExamQuestion = {
  id: 'q1',
  courseId: 'course-1',
  topicId: 'topic-1',
  questionText: 'LAN authority question',
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

/** Creates a real published session in the (mocked) repository. */
async function seedSession() {
  const repository = await ExaminationRepository.open();
  await repository.registerStudent('LAN Student', 'Level 300');
  const exam = await repository.createExam('LAN Authority Exam');
  const version = await repository.createVersion(exam.id, [question], {
    title: 'LAN Authority Exam',
    assessmentType: 'KIOSK_EXAM',
    security: { kioskMode: true, requireLanAuthority: true },
  });
  const published = await repository.publishVersion(exam.id, version.id);
  const session = await repository.createSession(exam.id, published.id);
  return { repository, session };
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
  lanMocks.native = false;
  lanMocks.detectedHost = null;
  lanMocks.startLanExamServer.mockReset();
});

afterEach(() => {
  idbStore.clear();
  sessionStorage.clear();
});

describe('start prerequisites are visible, not a dead button', () => {
  it('names both blockers up front and links to the Kiosk Entry screen', async () => {
    open();
    await waitFor(() => {
      expect(screen.getByTestId('lan-start-prerequisites')).toBeTruthy();
    });
    const prerequisites = screen.getByTestId('lan-start-prerequisites').textContent ?? '';
    expect(prerequisites).toContain('Browser preview');
    expect(prerequisites).toContain('No examination session yet');
    expect(screen.getByText(/open a \.pharmaexam on Kiosk Entry/i)).toBeTruthy();
    // The start button itself is NOT disabled by missing prerequisites —
    // clicking it explains, rather than doing nothing.
    expect((screen.getByTestId('start-lan-authority') as HTMLButtonElement).disabled).toBe(false);
  });

  it('explains the browser preview limitation on click and never fakes a running state', async () => {
    lanMocks.native = false;
    open();
    await waitFor(() => {
      expect(screen.getByTestId('lan-start-prerequisites')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('start-lan-authority'));
    expect(
      await screen.findByText(/Browser preview cannot host the LAN authority/i),
    ).toBeTruthy();
    expect(lanMocks.startLanExamServer).not.toHaveBeenCalled();
    expect(screen.getByText('Stopped')).toBeTruthy();
  });

  it('explains the missing session on the native host and links the fix', async () => {
    lanMocks.native = true;
    open();
    await waitFor(() => {
      expect(screen.getByTestId('lan-start-prerequisites')).toBeTruthy();
    });
    expect(screen.getByTestId('lan-start-prerequisites').textContent).toContain('Native host ready');
    fireEvent.click(screen.getByTestId('start-lan-authority'));
    expect(
      await screen.findByText(/No examination session exists on this device yet/i),
    ).toBeTruthy();
    expect(lanMocks.startLanExamServer).not.toHaveBeenCalled();
  });
});

describe('starting the authority with a real session', () => {
  it('binds the server and advertises the auto-detected LAN address', async () => {
    const { session } = await seedSession();
    lanMocks.native = true;
    lanMocks.detectedHost = '10.42.0.7';
    lanMocks.startLanExamServer.mockResolvedValue({
      running: true,
      endpoint: 'http://10.42.0.7:8787',
      discoveryEndpoint: 'udp://10.42.0.7:8788',
      serverId: session.authoritativeServerId,
      authorityId: `authority-${session.id}`,
      authorityEpoch: session.authorityEpoch,
      revision: 1,
      activeConnections: 0,
      activeAttempts: 0,
      submittedAttempts: 0,
      lastHeartbeatAt: new Date().toISOString(),
    });

    open();
    // The host field is prefilled with the detected address…
    await waitFor(() => {
      expect((screen.getByTestId('lan-host-input') as HTMLInputElement).value).toBe('10.42.0.7');
    });
    // …and the page's async refresh has picked the session up before we click.
    await waitFor(() => {
      expect(screen.getByTestId('lan-start-prerequisites').textContent).toMatch(/Session session_/);
    });

    fireEvent.click(screen.getByTestId('start-lan-authority'));

    await waitFor(() => {
      expect(lanMocks.startLanExamServer).toHaveBeenCalledTimes(1);
    });
    const config = lanMocks.startLanExamServer.mock.calls[0][0];
    expect(config.advertisedHost).toBe('10.42.0.7');
    expect(config.sessionId).toBe(session.id);

    expect(
      await screen.findByText(/LAN examination authority listening at http:\/\/10\.42\.0\.7:8787/i),
    ).toBeTruthy();

    // The session record itself now carries the authority endpoint + token,
    // which is what student devices sync against.
    const repository = await ExaminationRepository.open();
    const stored = repository.snapshot.sessions.find((item) => item.id === session.id);
    expect(stored?.authorityEndpoint).toBe('http://10.42.0.7:8787');
    expect(stored?.authorityAccessToken).toBeTruthy();
  });

  it('refuses to start with an empty advertised host instead of binding a broken endpoint', async () => {
    await seedSession();
    lanMocks.native = true;
    lanMocks.detectedHost = null; // no route: field stays empty

    open();
    await waitFor(() => {
      expect(screen.getByTestId('lan-start-prerequisites').textContent).toMatch(/Session session_/);
    });
    fireEvent.click(screen.getByTestId('start-lan-authority'));

    expect(
      await screen.findByText(/Advertised LAN host is empty/i),
    ).toBeTruthy();
    expect(lanMocks.startLanExamServer).not.toHaveBeenCalled();
  });
});
