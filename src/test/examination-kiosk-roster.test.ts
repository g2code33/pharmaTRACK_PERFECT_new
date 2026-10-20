import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Kiosk roster — student accounts referenced through the administrator's own
 * account instead of a single local device. A kiosk device is never signed
 * into Supabase, so every student-facing call here is an anonymous RPC;
 * password generation reuses the already-tested randomUnusedKioskPassword()
 * algorithm and the SERVER (a UNIQUE constraint) is the real guard against a
 * concurrent double-issue, not client-side trust.
 *
 * RLS/SECURITY DEFINER behavior lives in supabase/kiosk-admin-roster.sql and
 * needs deployment-level validation against the real project — this file
 * only proves the client-side contract against a mocked RPC boundary.
 */
const { rpcMock, getAuthenticatedUserMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  getAuthenticatedUserMock: vi.fn(),
}));

vi.mock('../utils/supabase', () => ({
  supabase: { rpc: rpcMock },
}));

vi.mock('../auth/authService', () => ({
  getAuthenticatedUser: getAuthenticatedUserMock,
}));

import {
  adminResetKioskStudentPassword,
  authenticateKioskStudentViaAdmin,
  checkKioskLoginStatus,
  clearKioskAttemptProgress,
  ensureKioskAdminProfile,
  getStoredKioskJoinCode,
  KIOSK_JOIN_CODE_STORAGE_KEY,
  listKioskLiveAttempts,
  listKioskRosterStudents,
  regenerateKioskJoinCode,
  registerKioskStudentViaAdmin,
  reportKioskAttemptHeartbeat,
  setKioskLoginEnabled,
  submitKioskExamResultToAdmin,
} from '../examination/kioskRoster';

const originalOnLine = navigator.onLine;
function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

beforeEach(() => {
  rpcMock.mockReset();
  getAuthenticatedUserMock.mockReset();
  setOnline(true);
});

afterEach(() => {
  setOnline(originalOnLine);
});

describe('kiosk roster — administrator side (requires sign-in)', () => {
  it('refuses every admin action while offline, without calling Supabase', async () => {
    setOnline(false);
    expect(await ensureKioskAdminProfile()).toEqual({ ok: false, reason: 'offline' });
    expect(await setKioskLoginEnabled(true)).toEqual({ ok: false, reason: 'offline' });
    expect(await regenerateKioskJoinCode()).toEqual({ ok: false, reason: 'offline' });
    expect(await listKioskRosterStudents()).toEqual({ ok: false, reason: 'offline' });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('refuses every admin action while signed out', async () => {
    getAuthenticatedUserMock.mockResolvedValue(null);
    expect(await ensureKioskAdminProfile()).toEqual({ ok: false, reason: 'signed-out' });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('ensures a profile and reports the join code + login state', async () => {
    getAuthenticatedUserMock.mockResolvedValue({ id: 'admin-1' });
    rpcMock.mockResolvedValue({ data: { join_code: 'AB12CD', login_enabled: false }, error: null });
    const outcome = await ensureKioskAdminProfile();
    expect(outcome).toEqual({ ok: true, profile: { joinCode: 'AB12CD', loginEnabled: false } });
    expect(rpcMock).toHaveBeenCalledWith('ensure_kiosk_admin_profile');
  });

  it('toggles login on and off', async () => {
    getAuthenticatedUserMock.mockResolvedValue({ id: 'admin-1' });
    rpcMock.mockResolvedValue({ data: { join_code: 'AB12CD', login_enabled: true }, error: null });
    const outcome = await setKioskLoginEnabled(true);
    expect(outcome).toEqual({ ok: true, profile: { joinCode: 'AB12CD', loginEnabled: true } });
    expect(rpcMock).toHaveBeenCalledWith('set_kiosk_login_enabled', { p_enabled: true });
  });

  it('lists the roster scoped to the signed-in admin', async () => {
    getAuthenticatedUserMock.mockResolvedValue({ id: 'admin-1' });
    rpcMock.mockResolvedValue({
      data: [
        {
          id: 's1',
          first_name: 'Efua',
          level: 'Level 300',
          password_slot: 4,
          created_at: '2026-01-01T00:00:00.000Z',
          last_authenticated_at: null,
        },
      ],
      error: null,
    });
    const outcome = await listKioskRosterStudents();
    expect(outcome).toEqual({
      ok: true,
      students: [
        {
          id: 's1',
          firstName: 'Efua',
          level: 'Level 300',
          passwordSlot: 4,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastAuthenticatedAt: null,
        },
      ],
    });
  });

  it('resets a roster student password with a slot not already issued', async () => {
    getAuthenticatedUserMock.mockResolvedValue({ id: 'admin-1' });
    rpcMock.mockResolvedValue({ data: {}, error: null });
    const outcome = await adminResetKioskStudentPassword('s1', [0, 1, 2]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.password).toMatch(/^RX30[a-z]$/);
      expect(outcome.password).not.toBe('RX30a');
      expect(outcome.password).not.toBe('RX30b');
      expect(outcome.password).not.toBe('RX30c');
    }
  });
});

describe('kiosk roster — kiosk side (anonymous, join code only)', () => {
  it('reports offline without calling Supabase', async () => {
    setOnline(false);
    expect(await checkKioskLoginStatus('AB12CD')).toEqual({ ok: false, reason: 'offline' });
    expect(await registerKioskStudentViaAdmin('AB12CD', 'Efua', 'Level 300')).toEqual({
      ok: false,
      reason: 'offline',
    });
    expect(
      await authenticateKioskStudentViaAdmin('AB12CD', 'Efua', 'Level 300', 'RX30a'),
    ).toEqual({ ok: false, reason: 'offline' });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('reports an unknown join code', async () => {
    rpcMock.mockResolvedValue({ data: [{ found: false }], error: null });
    const status = await checkKioskLoginStatus('ZZZZZZ');
    expect(status).toEqual({ ok: true, found: false });
  });

  it('reports whether logins are enabled for a known join code', async () => {
    rpcMock.mockResolvedValue({ data: [{ found: true, login_enabled: true }], error: null });
    const status = await checkKioskLoginStatus('AB12CD');
    expect(status).toEqual({ ok: true, found: true, loginEnabled: true });
  });

  it('registers a student by asking the admin for context then claiming a slot', async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === 'kiosk_registration_context') {
        return Promise.resolve({
          data: [{ found: true, login_enabled: true, name_taken: false, issued_slots: [0, 1] }],
          error: null,
        });
      }
      if (name === 'kiosk_register_student') {
        return Promise.resolve({ data: [{ student_id: 'new-student-1' }], error: null });
      }
      throw new Error(`unexpected rpc ${name}`);
    });
    const outcome = await registerKioskStudentViaAdmin('AB12CD', 'Efua', 'Level 300');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.studentId).toBe('new-student-1');
      expect(outcome.password).toMatch(/^RX30[a-z]$/);
      expect(['RX30a', 'RX30b']).not.toContain(outcome.password);
    }
  });

  it('refuses registration when the join code is unknown', async () => {
    rpcMock.mockResolvedValue({ data: [{ found: false }], error: null });
    const outcome = await registerKioskStudentViaAdmin('ZZZZZZ', 'Efua', 'Level 300');
    expect(outcome).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses registration when the admin has logins switched off', async () => {
    rpcMock.mockResolvedValue({
      data: [{ found: true, login_enabled: false, name_taken: false, issued_slots: [] }],
      error: null,
    });
    const outcome = await registerKioskStudentViaAdmin('AB12CD', 'Efua', 'Level 300');
    expect(outcome).toEqual({ ok: false, reason: 'login-disabled' });
  });

  it('refuses registration when the name is already taken', async () => {
    rpcMock.mockResolvedValue({
      data: [{ found: true, login_enabled: true, name_taken: true, issued_slots: [] }],
      error: null,
    });
    const outcome = await registerKioskStudentViaAdmin('AB12CD', 'Efua', 'Level 300');
    expect(outcome).toEqual({ ok: false, reason: 'name-taken' });
  });

  it('retries once when it loses a race for a password slot, then succeeds', async () => {
    let contextCalls = 0;
    rpcMock.mockImplementation((name: string) => {
      if (name === 'kiosk_registration_context') {
        contextCalls += 1;
        return Promise.resolve({
          data: [{ found: true, login_enabled: true, name_taken: false, issued_slots: contextCalls === 1 ? [] : [0] }],
          error: null,
        });
      }
      if (name === 'kiosk_register_student') {
        if (contextCalls === 1) {
          return Promise.resolve({
            data: null,
            error: { message: 'duplicate key value violates unique constraint "pharmatrack_kiosk_roster_students_admin_user_id_password_slot_key"' },
          });
        }
        return Promise.resolve({ data: [{ student_id: 'new-student-2' }], error: null });
      }
      throw new Error(`unexpected rpc ${name}`);
    });
    const outcome = await registerKioskStudentViaAdmin('AB12CD', 'Efua', 'Level 300');
    expect(contextCalls).toBe(2);
    expect(outcome).toEqual({ ok: true, studentId: 'new-student-2', password: expect.stringMatching(/^RX30[a-z]$/) });
  });

  it('treats a name unique-violation as name-taken, not a retryable slot race', async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === 'kiosk_registration_context') {
        return Promise.resolve({
          data: [{ found: true, login_enabled: true, name_taken: false, issued_slots: [] }],
          error: null,
        });
      }
      if (name === 'kiosk_register_student') {
        return Promise.resolve({
          data: null,
          error: { message: 'duplicate key value violates unique constraint "pharmatrack_kiosk_roster_students_admin_user_id_first_name_key_level_key"' },
        });
      }
      throw new Error(`unexpected rpc ${name}`);
    });
    const outcome = await registerKioskStudentViaAdmin('AB12CD', 'Efua', 'Level 300');
    expect(outcome).toEqual({ ok: false, reason: 'name-taken' });
  });

  it('authenticates a known student', async () => {
    rpcMock.mockResolvedValue({
      data: [{ student_id: 's1', first_name: 'Efua', level: 'Level 300' }],
      error: null,
    });
    const outcome = await authenticateKioskStudentViaAdmin('AB12CD', 'Efua', 'Level 300', 'RX30a');
    expect(outcome).toEqual({ ok: true, studentId: 's1', firstName: 'Efua', level: 'Level 300' });
  });

  it('reports invalid credentials without revealing which part was wrong', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'First name, level, or RX30 Kiosk password is incorrect.' },
    });
    const outcome = await authenticateKioskStudentViaAdmin('AB12CD', 'Efua', 'Level 300', 'wrong');
    expect(outcome).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reports when the admin has logins switched off', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'Kiosk logins are not currently open. Ask the administrator to enable them.' },
    });
    const outcome = await authenticateKioskStudentViaAdmin('AB12CD', 'Efua', 'Level 300', 'RX30a');
    expect(outcome).toEqual({ ok: false, reason: 'login-disabled' });
  });
});

describe('kiosk live activity + direct result reporting (works over any network, no LAN)', () => {
  afterEach(() => {
    try {
      localStorage.removeItem(KIOSK_JOIN_CODE_STORAGE_KEY);
    } catch {
      /* jsdom always has localStorage; guarded only for parity with the source. */
    }
  });

  it('reads the stored join code the kiosk device remembers', () => {
    expect(getStoredKioskJoinCode()).toBe('');
    localStorage.setItem(KIOSK_JOIN_CODE_STORAGE_KEY, 'AB12CD');
    expect(getStoredKioskJoinCode()).toBe('AB12CD');
  });

  it('sends a heartbeat with the join code, student id, and progress', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    await reportKioskAttemptHeartbeat({
      joinCode: 'AB12CD',
      studentId: 's1',
      examKey: 'exam-1',
      examTitle: 'Finals',
      currentQuestion: 3,
      totalQuestions: 10,
      deviceLabel: 'kiosk-1',
    });
    expect(rpcMock).toHaveBeenCalledWith('kiosk_heartbeat_attempt', {
      p_join_code: 'AB12CD',
      p_student_id: 's1',
      p_exam_key: 'exam-1',
      p_exam_title: 'Finals',
      p_current_question: 3,
      p_total_questions: 10,
      p_device_label: 'kiosk-1',
    });
  });

  it('never calls Supabase for a heartbeat while offline or with no join code', async () => {
    setOnline(false);
    await reportKioskAttemptHeartbeat({
      joinCode: 'AB12CD',
      studentId: 's1',
      examKey: 'exam-1',
      examTitle: 'Finals',
      currentQuestion: 1,
      totalQuestions: 5,
    });
    setOnline(true);
    await reportKioskAttemptHeartbeat({
      joinCode: '',
      studentId: 's1',
      examKey: 'exam-1',
      examTitle: 'Finals',
      currentQuestion: 1,
      totalQuestions: 5,
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('never throws when the heartbeat RPC itself fails', async () => {
    rpcMock.mockRejectedValue(new Error('network blip'));
    await expect(
      reportKioskAttemptHeartbeat({
        joinCode: 'AB12CD',
        studentId: 's1',
        examKey: 'exam-1',
        examTitle: 'Finals',
        currentQuestion: 1,
        totalQuestions: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it('clears live progress for a finished/abandoned attempt', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    await clearKioskAttemptProgress('AB12CD', 's1', 'exam-1');
    expect(rpcMock).toHaveBeenCalledWith('kiosk_clear_attempt_progress', {
      p_join_code: 'AB12CD',
      p_student_id: 's1',
      p_exam_key: 'exam-1',
    });
  });

  it('submits the final score straight to the cloud, independent of any LAN authority', async () => {
    rpcMock.mockResolvedValue({ data: {}, error: null });
    const outcome = await submitKioskExamResultToAdmin({
      joinCode: 'AB12CD',
      studentId: 's1',
      examKey: 'exam-1',
      examTitle: 'Finals',
      scorePercentage: 87.5,
      submittedAt: '2026-10-20T12:00:00.000Z',
      deviceLabel: 'kiosk-1',
    });
    expect(outcome).toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledWith('kiosk_submit_exam_result', {
      p_join_code: 'AB12CD',
      p_student_id: 's1',
      p_exam_key: 'exam-1',
      p_exam_title: 'Finals',
      p_score_percentage: 87.5,
      p_submitted_at: '2026-10-20T12:00:00.000Z',
      p_device_label: 'kiosk-1',
    });
  });

  it('reports offline instead of silently dropping a finished exam score', async () => {
    setOnline(false);
    const outcome = await submitKioskExamResultToAdmin({
      joinCode: 'AB12CD',
      studentId: 's1',
      examKey: 'exam-1',
      examTitle: 'Finals',
      scorePercentage: 50,
      submittedAt: '2026-10-20T12:00:00.000Z',
    });
    expect(outcome).toEqual({ ok: false, reason: 'offline' });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('surfaces a submit RPC error instead of pretending it succeeded', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'That student is not registered under this administrator.' } });
    const outcome = await submitKioskExamResultToAdmin({
      joinCode: 'AB12CD',
      studentId: 'forged-id',
      examKey: 'exam-1',
      examTitle: 'Finals',
      scorePercentage: 50,
      submittedAt: '2026-10-20T12:00:00.000Z',
    });
    expect(outcome).toEqual({
      ok: false,
      reason: 'error',
      message: 'That student is not registered under this administrator.',
    });
  });

  it("lists the admin's live kiosk attempts, mapped from the RPC's snake_case rows", async () => {
    getAuthenticatedUserMock.mockResolvedValue({ id: 'admin-1' });
    rpcMock.mockResolvedValue({
      data: [
        {
          id: 'row-1',
          student_id: 's1',
          student_first_name: 'Efua',
          student_level: 'Level 300',
          exam_key: 'exam-1',
          exam_title: 'Finals',
          current_question: 4,
          total_questions: 10,
          started_at: '2026-10-20T11:00:00.000Z',
          last_seen_at: '2026-10-20T11:05:00.000Z',
          device_label: 'kiosk-1',
        },
      ],
      error: null,
    });
    const outcome = await listKioskLiveAttempts();
    expect(outcome).toEqual({
      ok: true,
      attempts: [
        {
          id: 'row-1',
          studentId: 's1',
          studentFirstName: 'Efua',
          studentLevel: 'Level 300',
          examKey: 'exam-1',
          examTitle: 'Finals',
          currentQuestion: 4,
          totalQuestions: 10,
          startedAt: '2026-10-20T11:00:00.000Z',
          lastSeenAt: '2026-10-20T11:05:00.000Z',
          deviceLabel: 'kiosk-1',
        },
      ],
    });
    expect(rpcMock).toHaveBeenCalledWith('list_kiosk_live_attempts');
  });

  it('refuses to list live attempts while signed out', async () => {
    getAuthenticatedUserMock.mockResolvedValue(null);
    expect(await listKioskLiveAttempts()).toEqual({ ok: false, reason: 'signed-out' });
  });
});
