/**
 * The admin console password gate.
 *
 * Students run the same app as the invigilator, so the only thing standing
 * between a student and the Admin Examination Control Center is this gate.
 * The contract under test:
 *
 *   - the console renders NOTHING but the lock screen until the correct
 *     password is presented (results, sessions, work — all hidden);
 *   - the seeded password works on first launch, and neither the password
 *     nor the phantom PIN is ever stored in plaintext;
 *   - the password can be changed from the console, but only by presenting
 *     BOTH the current password and the phantom PIN — a wrong phantom PIN
 *     leaves the old password in force;
 *   - after a change the old password stops working immediately, and
 *     "Lock console now" re-arms the lock without closing the tab.
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

const lanMocks = vi.hoisted(() => ({ native: false }));

vi.mock('../examination/lanServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../examination/lanServer')>();
  return {
    ...actual,
    isNativeLanServerAvailable: () => lanMocks.native,
    detectLanHost: async () => null,
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
import {
  changeAdminPassword,
  verifyAdminPassword,
} from '../examination/adminGate';

const SEEDED_PASSWORD = 'godnogosHamEi2';
const PHANTOM_PIN = 'iseedeAdpeople';

function open() {
  render(
    <MemoryRouter initialEntries={['/examinations/admin']}>
      <Routes>
        <Route path="/examinations/admin" element={<ExaminationAdmin />} />
        <Route path="/examinations/kiosk" element={<div />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function unlockWith(password: string) {
  fireEvent.change(screen.getByTestId('admin-gate-password'), {
    target: { value: password },
  });
  fireEvent.click(screen.getByTestId('admin-gate-unlock'));
}

beforeEach(() => {
  idbStore.clear();
  sessionStorage.clear();
});

afterEach(() => {
  idbStore.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('adminGate module', () => {
  it('seeds the configured password on first use and stores no plaintext', async () => {
    expect(await verifyAdminPassword(SEEDED_PASSWORD)).toBe(true);
    expect(await verifyAdminPassword('wrong-password')).toBe(false);

    const serialized = JSON.stringify([...idbStore.entries()]);
    expect(serialized).not.toContain(SEEDED_PASSWORD);
    expect(serialized).not.toContain(PHANTOM_PIN);
  });

  it('changes the password only with the current password AND the phantom PIN', async () => {
    expect(await verifyAdminPassword(SEEDED_PASSWORD)).toBe(true);

    // Wrong phantom PIN: refused, old password still in force.
    const refused = await changeAdminPassword(SEEDED_PASSWORD, 'NewPass!234', 'wrong-pin');
    expect(refused).toEqual({ ok: false, error: 'wrong-phantom-pin' });
    expect(await verifyAdminPassword(SEEDED_PASSWORD)).toBe(true);
    expect(await verifyAdminPassword('NewPass!234')).toBe(false);

    // Wrong current password: refused too.
    const wrongCurrent = await changeAdminPassword('nope', 'NewPass!234', PHANTOM_PIN);
    expect(wrongCurrent).toEqual({ ok: false, error: 'wrong-password' });

    // Correct current password + phantom PIN: the change lands, the old
    // password stops working, and the phantom PIN survives (usable again).
    const changed = await changeAdminPassword(SEEDED_PASSWORD, 'NewPass!234', PHANTOM_PIN);
    expect(changed).toEqual({ ok: true });
    expect(await verifyAdminPassword(SEEDED_PASSWORD)).toBe(false);
    expect(await verifyAdminPassword('NewPass!234')).toBe(true);

    const changedAgain = await changeAdminPassword('NewPass!234', 'EvenNewer!56', PHANTOM_PIN);
    expect(changedAgain).toEqual({ ok: true });
    expect(await verifyAdminPassword('EvenNewer!56')).toBe(true);
  });

  it('rejects a too-short new password without touching anything', async () => {
    const refused = await changeAdminPassword(SEEDED_PASSWORD, 'short', PHANTOM_PIN);
    expect(refused).toEqual({ ok: false, error: 'invalid-new-password' });
    expect(await verifyAdminPassword(SEEDED_PASSWORD)).toBe(true);
  });
});

describe('the locked console', () => {
  it('renders nothing but the lock screen until the correct password is given', async () => {
    open();

    // Locked: the gate is the only thing on the page — no sessions, no
    // results, no student data, not even the section headers.
    expect(screen.getByTestId('admin-gate-locked')).toBeTruthy();
    expect(screen.queryByTestId('session-picker')).toBeNull();
    expect(screen.queryByText('Examination-wide results')).toBeNull();

    // A wrong password is refused and keeps the console hidden.
    await unlockWith('student-guess');
    expect(await screen.findByTestId('admin-gate-error')).toBeTruthy();
    expect(screen.getByTestId('admin-gate-locked')).toBeTruthy();
    expect(screen.queryByTestId('session-picker')).toBeNull();

    // The correct password unlocks this tab.
    await unlockWith(SEEDED_PASSWORD);
    await waitFor(() => {
      expect(screen.getByTestId('session-picker')).toBeTruthy();
    });
    expect(screen.queryByTestId('admin-gate-locked')).toBeNull();
    expect(sessionStorage.getItem('pharmatrack:admin-gate-unlocked')).toBe('1');
  });

  it('changes the password from the console, gated by the phantom PIN', async () => {
    open();
    await unlockWith(SEEDED_PASSWORD);
    await waitFor(() => {
      expect(screen.getByTestId('session-picker')).toBeTruthy();
    });

    const fill = (testId: string, value: string) =>
      fireEvent.change(screen.getByTestId(testId), { target: { value } });

    // Wrong phantom PIN: refused, nothing changes.
    fill('admin-change-current', SEEDED_PASSWORD);
    fill('admin-change-next', 'RotatedPass!9');
    fill('admin-change-confirm', 'RotatedPass!9');
    fill('admin-change-phantom', 'wrong-pin');
    fireEvent.click(screen.getByTestId('admin-change-submit'));
    expect(await screen.findByTestId('admin-change-message')).toBeTruthy();
    expect(screen.getByTestId('admin-change-message').textContent).toContain(
      'phantom PIN is incorrect',
    );

    // Correct phantom PIN: the change lands.
    fill('admin-change-phantom', PHANTOM_PIN);
    fireEvent.click(screen.getByTestId('admin-change-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('admin-change-message').textContent).toContain('changed');
    });

    // Locking the console re-arms the gate; the old password no longer works
    // and the new one does.
    fireEvent.click(screen.getByTestId('admin-lock-now'));
    expect(screen.getByTestId('admin-gate-locked')).toBeTruthy();
    await unlockWith(SEEDED_PASSWORD);
    expect(await screen.findByTestId('admin-gate-error')).toBeTruthy();
    await unlockWith('RotatedPass!9');
    await waitFor(() => {
      expect(screen.getByTestId('session-picker')).toBeTruthy();
    });
  });
});
