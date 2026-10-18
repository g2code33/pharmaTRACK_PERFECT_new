/**
 * The admin console password gate.
 *
 * Students run the same app as the invigilator, so the only thing standing
 * between a student and the Admin Examination Control Center is this gate.
 * The contract under test:
 *
 *   - the console renders NOTHING but the lock screen until the correct
 *     password is presented (results, sessions, work — all hidden);
 *   - the exam BUILDER has its own lock (seeded password admin123), renders
 *     nothing until it is presented, and its password is rotated from the
 *     live admin console under the same phantom-PIN rule — a wrong phantom
 *     PIN leaves the old builder password in force;
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
    state: { quizHistory: [], courses: [], topics: [], examQuestions: [], student: null },
    dispatch,
  }),
}));

import ExaminationAdmin from '../pages/ExaminationAdmin';
import ExaminationBuilder from '../pages/ExaminationBuilder';
import {
  changeAdminPassword,
  changeBuilderPassword,
  verifyAdminPassword,
  verifyBuilderPassword,
} from '../examination/adminGate';

const SEEDED_PASSWORD = 'godnogosHamEi2';
const PHANTOM_PIN = 'iseedeAdpeople';
const SEEDED_BUILDER_PASSWORD = 'admin123';

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

  it('seeds the builder lock with admin123 and stores no plaintext', async () => {
    expect(await verifyBuilderPassword(SEEDED_BUILDER_PASSWORD)).toBe(true);
    expect(await verifyBuilderPassword('wrong-builder-pass')).toBe(false);

    // The builder password is a SEPARATE secret from the console password.
    expect(await verifyBuilderPassword(SEEDED_PASSWORD)).toBe(false);
    expect(await verifyAdminPassword(SEEDED_BUILDER_PASSWORD)).toBe(false);

    const serialized = JSON.stringify([...idbStore.entries()]);
    expect(serialized).not.toContain(SEEDED_BUILDER_PASSWORD);
  });

  it('changes the builder password only with the current one AND the phantom PIN', async () => {
    // Wrong phantom PIN: refused, old builder password still in force.
    const refused = await changeBuilderPassword(SEEDED_BUILDER_PASSWORD, 'Builder!234', 'wrong-pin');
    expect(refused).toEqual({ ok: false, error: 'wrong-phantom-pin' });
    expect(await verifyBuilderPassword(SEEDED_BUILDER_PASSWORD)).toBe(true);

    // Wrong current builder password: refused too.
    const wrongCurrent = await changeBuilderPassword('nope', 'Builder!234', PHANTOM_PIN);
    expect(wrongCurrent).toEqual({ ok: false, error: 'wrong-password' });

    // Correct current password + phantom PIN: the change lands AND the
    // console password plus the phantom PIN keep working unchanged.
    const changed = await changeBuilderPassword(SEEDED_BUILDER_PASSWORD, 'Builder!234', PHANTOM_PIN);
    expect(changed).toEqual({ ok: true });
    expect(await verifyBuilderPassword(SEEDED_BUILDER_PASSWORD)).toBe(false);
    expect(await verifyBuilderPassword('Builder!234')).toBe(true);
    expect(await verifyAdminPassword(SEEDED_PASSWORD)).toBe(true);
    const again = await changeAdminPassword(SEEDED_PASSWORD, 'StillWorks!9', PHANTOM_PIN);
    expect(again).toEqual({ ok: true });
  });

  it('migrates records written before the builder lock existed', async () => {
    // Force the very first seed (this test clears idb in beforeEach).
    expect(await verifyAdminPassword(SEEDED_PASSWORD)).toBe(true);
    // Simulate a pre-builder record: strip the builder hash.
    const record = idbStore.get('pharmatrack:admin-gate') as { builderHash?: string };
    delete record.builderHash;
    await idbStore.set('pharmatrack:admin-gate', record);

    // The builder gate works immediately with the seeded password, without
    // invalidating the console password or the phantom PIN.
    expect(await verifyBuilderPassword(SEEDED_BUILDER_PASSWORD)).toBe(true);
    expect(await verifyAdminPassword(SEEDED_PASSWORD)).toBe(true);
    const migrated = idbStore.get('pharmatrack:admin-gate') as { builderHash?: string };
    expect(migrated.builderHash).toBeTruthy();
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


describe('the locked exam builder', () => {
  function openBuilder() {
    render(
      <MemoryRouter initialEntries={['/examinations/builder']} >
        <Routes>
          <Route path="/examinations/builder" element={<ExaminationBuilder />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('renders nothing but the lock screen until the builder password is given', async () => {
    openBuilder();

    // Locked: no draft state, no question pool, no signing UI.
    expect(screen.getByTestId('builder-gate-locked')).toBeTruthy();
    expect(screen.queryByText('Exam settings')).toBeNull();
    expect(screen.queryByText('Publish and download .pharmaexam')).toBeNull();

    // A wrong password is refused and keeps the builder hidden.
    fireEvent.change(screen.getByTestId('builder-gate-password'), {
      target: { value: 'student-guess' },
    });
    fireEvent.click(screen.getByTestId('builder-gate-unlock'));
    expect(await screen.findByTestId('builder-gate-error')).toBeTruthy();
    expect(screen.getByTestId('builder-gate-locked')).toBeTruthy();

    // The seeded builder password unlocks this tab.
    fireEvent.change(screen.getByTestId('builder-gate-password'), {
      target: { value: SEEDED_BUILDER_PASSWORD },
    });
    fireEvent.click(screen.getByTestId('builder-gate-unlock'));
    await waitFor(() => {
      expect(screen.getByText('Exam settings')).toBeTruthy();
    });
    expect(screen.queryByTestId('builder-gate-locked')).toBeNull();
    expect(sessionStorage.getItem('pharmatrack:builder-gate-unlocked')).toBe('1');

    // "Lock builder" re-arms the gate for this tab.
    fireEvent.click(screen.getByTestId('builder-lock-now'));
    expect(screen.getByTestId('builder-gate-locked')).toBeTruthy();
    expect(sessionStorage.getItem('pharmatrack:builder-gate-unlocked')).toBeNull();
  });
});

describe('rotating the builder password from the live admin console', () => {
  it('changes the builder password only with the phantom PIN', async () => {
    open();
    await unlockWith(SEEDED_PASSWORD);
    await waitFor(() => {
      expect(screen.getByTestId('session-picker')).toBeTruthy();
    });

    const fill = (testId: string, value: string) =>
      fireEvent.change(screen.getByTestId(testId), { target: { value } });

    // Wrong phantom PIN: refused, the builder still unlocks with admin123.
    fill('admin-change-builder-current', SEEDED_BUILDER_PASSWORD);
    fill('admin-change-builder-next', 'Builder!234');
    fill('admin-change-builder-confirm', 'Builder!234');
    fill('admin-change-builder-phantom', 'wrong-pin');
    fireEvent.click(screen.getByTestId('admin-change-builder-submit'));
    expect(await screen.findByTestId('admin-change-builder-message')).toBeTruthy();
    expect(screen.getByTestId('admin-change-builder-message').textContent).toContain(
      'phantom PIN is incorrect',
    );
    expect(await verifyBuilderPassword(SEEDED_BUILDER_PASSWORD)).toBe(true);

    // Correct phantom PIN: the change lands and the console password is
    // untouched — the two locks stay independent secrets.
    fill('admin-change-builder-phantom', PHANTOM_PIN);
    fireEvent.click(screen.getByTestId('admin-change-builder-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('admin-change-builder-message').textContent).toContain('changed');
    });
    expect(await verifyBuilderPassword('Builder!234')).toBe(true);
    expect(await verifyBuilderPassword(SEEDED_BUILDER_PASSWORD)).toBe(false);
    expect(await verifyAdminPassword(SEEDED_PASSWORD)).toBe(true);
  });
});
