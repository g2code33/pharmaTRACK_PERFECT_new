/**
 * Kiosk roster — student accounts referenced through the administrator's own
 * PharmaTrack (Supabase) account, instead of living only on whichever single
 * device a student happened to register on.
 *
 * A kiosk device is NEVER signed into Supabase. It only ever knows a short
 * join code the administrator shares — every function here that a kiosk
 * calls is an anonymous, narrowly-scoped RPC (see
 * supabase/kiosk-admin-roster.sql). The administrator's side calls the
 * normal authenticated RPCs, exactly like the rest of this app's account
 * features (requires a signed-in PharmaTrack account + internet; nothing
 * about taking the exam itself depends on this).
 *
 * Password generation still happens on the device asking for one (admin or
 * kiosk), reusing the exact same tested `randomUnusedKioskPassword()`
 * algorithm already used by the fully offline kiosk — the server's only job
 * is to atomically claim the chosen slot (a database UNIQUE constraint,
 * not a client-side promise) and store a salted hash of it.
 */
import { supabase } from '../utils/supabase';
import { checkCloudAccess, type AuthGateResult } from '../utils/requireAuth';
import { randomUnusedKioskPassword } from './crypto';

export type CloudAccessFailure = Extract<AuthGateResult, { ok: false }>;

/**
 * The single source of truth for where the kiosk device remembers which
 * administrator join code it is connected to (set by KioskEntry.tsx at
 * login/registration time). Exported so any other kiosk-side module — e.g.
 * the exam-taking screen reporting live progress/results straight to the
 * cloud — reads the exact same value without duplicating the literal key.
 */
export const KIOSK_JOIN_CODE_STORAGE_KEY = 'pharmatrack:kiosk-admin-join-code';

export interface KioskAdminProfile {
  joinCode: string;
  loginEnabled: boolean;
}

export interface KioskRosterStudent {
  id: string;
  firstName: string;
  level: string;
  passwordSlot: number;
  createdAt: string;
  lastAuthenticatedAt: string | null;
}

function toAdminProfile(row: Record<string, unknown>): KioskAdminProfile {
  return {
    joinCode: String(row.join_code ?? ''),
    loginEnabled: Boolean(row.login_enabled),
  };
}

function toRosterStudent(row: Record<string, unknown>): KioskRosterStudent {
  return {
    id: String(row.id ?? ''),
    firstName: String(row.first_name ?? ''),
    level: String(row.level ?? ''),
    passwordSlot: Number(row.password_slot ?? 0),
    createdAt: String(row.created_at ?? ''),
    lastAuthenticatedAt: (row.last_authenticated_at as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Administrator side — requires a signed-in PharmaTrack account.
// ---------------------------------------------------------------------------

export type AdminProfileOutcome = { ok: true; profile: KioskAdminProfile } | CloudAccessFailure;

/** Creates this admin's kiosk profile (and join code) on first use. */
export async function ensureKioskAdminProfile(): Promise<AdminProfileOutcome> {
  const access = await checkCloudAccess();
  if (!access.ok) return access;
  const { data, error } = await supabase.rpc('ensure_kiosk_admin_profile');
  if (error || !data) throw new Error(error?.message || 'Could not set up the kiosk join code.');
  return { ok: true, profile: toAdminProfile(data as Record<string, unknown>) };
}

export async function setKioskLoginEnabled(enabled: boolean): Promise<AdminProfileOutcome> {
  const access = await checkCloudAccess();
  if (!access.ok) return access;
  const { data, error } = await supabase.rpc('set_kiosk_login_enabled', { p_enabled: enabled });
  if (error || !data) throw new Error(error?.message || 'Could not change the kiosk login setting.');
  return { ok: true, profile: toAdminProfile(data as Record<string, unknown>) };
}

export async function regenerateKioskJoinCode(): Promise<AdminProfileOutcome> {
  const access = await checkCloudAccess();
  if (!access.ok) return access;
  const { data, error } = await supabase.rpc('regenerate_kiosk_join_code');
  if (error || !data) throw new Error(error?.message || 'Could not generate a new join code.');
  return { ok: true, profile: toAdminProfile(data as Record<string, unknown>) };
}

export type RosterOutcome = { ok: true; students: KioskRosterStudent[] } | CloudAccessFailure;

export async function listKioskRosterStudents(): Promise<RosterOutcome> {
  const access = await checkCloudAccess();
  if (!access.ok) return access;
  const { data, error } = await supabase.rpc('list_kiosk_roster_students');
  if (error) throw new Error(error.message || 'Could not load the kiosk roster.');
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return { ok: true, students: rows.map(toRosterStudent) };
}

export type ResetPasswordOutcome = { ok: true; password: string } | CloudAccessFailure;

/** Issues a fresh RX30 password for an existing roster student. */
export async function adminResetKioskStudentPassword(
  studentId: string,
  issuedSlots: readonly number[],
): Promise<ResetPasswordOutcome> {
  const access = await checkCloudAccess();
  if (!access.ok) return access;
  const { password, slot } = randomUnusedKioskPassword(issuedSlots);
  const { error } = await supabase.rpc('admin_reset_kiosk_student_password', {
    p_student_id: studentId,
    p_new_slot: slot,
    p_new_password_hash_input: password,
  });
  if (error) throw new Error(error.message || 'Could not reset that student\u2019s password.');
  return { ok: true, password };
}

// ---------------------------------------------------------------------------
// Kiosk side — no Supabase account, only a join code. Every call below is
// anonymous and must stay that way: a kiosk device never authenticates to
// Supabase at all.
// ---------------------------------------------------------------------------

export type KioskLoginStatus =
  | { ok: true; found: true; loginEnabled: boolean }
  | { ok: true; found: false }
  | { ok: false; reason: 'offline' };

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function registrationContext(
  joinCode: string,
  firstName: string,
  level: string,
): Promise<{ found: boolean; loginEnabled: boolean; nameTaken: boolean; issuedSlots: number[] }> {
  const { data, error } = await supabase.rpc('kiosk_registration_context', {
    p_join_code: joinCode,
    p_first_name: firstName,
    p_level: level,
  });
  if (error) throw new Error(error.message || 'Could not reach the administrator.');
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  return {
    found: Boolean(row?.found),
    loginEnabled: Boolean(row?.login_enabled),
    nameTaken: Boolean(row?.name_taken),
    issuedSlots: ((row?.issued_slots as number[] | null) ?? []).map(Number),
  };
}

/** Whether a join code is live right now — used to greet/guide the student before they fill in anything else. */
export async function checkKioskLoginStatus(joinCode: string): Promise<KioskLoginStatus> {
  if (isOffline()) return { ok: false, reason: 'offline' };
  // name_taken is irrelevant here; a name no real student would ever type
  // keeps this call from affecting (or caring about) the real roster.
  const context = await registrationContext(joinCode, '__pharmatrack_status_probe__', 'Level 100');
  if (!context.found) return { ok: true, found: false };
  return { ok: true, found: true, loginEnabled: context.loginEnabled };
}

export type RegisterKioskStudentOutcome =
  | { ok: true; studentId: string; password: string }
  | { ok: false; reason: 'offline' }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'login-disabled' }
  | { ok: false; reason: 'name-taken' }
  | { ok: false; reason: 'error'; message: string };

const MAX_SLOT_RACE_RETRIES = 5;

/**
 * Registers a new kiosk student under the given admin join code. Retries a
 * handful of times if a concurrent registration happens to claim the same
 * randomly-chosen password slot first — the database's UNIQUE constraint is
 * the real guard, this is just "ask for a different slot and try again".
 */
export async function registerKioskStudentViaAdmin(
  joinCode: string,
  firstName: string,
  level: string,
): Promise<RegisterKioskStudentOutcome> {
  if (isOffline()) return { ok: false, reason: 'offline' };

  for (let attempt = 0; attempt < MAX_SLOT_RACE_RETRIES; attempt += 1) {
    const context = await registrationContext(joinCode, firstName, level);
    if (!context.found) return { ok: false, reason: 'not-found' };
    if (!context.loginEnabled) return { ok: false, reason: 'login-disabled' };
    if (context.nameTaken) return { ok: false, reason: 'name-taken' };

    const { password, slot } = randomUnusedKioskPassword(context.issuedSlots);
    const { data, error } = await supabase.rpc('kiosk_register_student', {
      p_join_code: joinCode,
      p_first_name: firstName,
      p_level: level,
      p_password_slot: slot,
      p_password: password,
    });
    if (!error) {
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      const studentId = String(row?.student_id ?? '');
      if (studentId) return { ok: true, studentId, password };
    }
    const message = error?.message || '';
    // A unique-violation on the slot (lost the race to another device) is
    // the one case worth retrying; a unique-violation on the name means
    // someone else just registered that exact name/level first.
    if (/duplicate key|unique constraint/i.test(message) && /password_slot/i.test(message)) {
      continue;
    }
    if (/duplicate key|unique constraint/i.test(message)) {
      return { ok: false, reason: 'name-taken' };
    }
    return { ok: false, reason: 'error', message: message || 'Registration failed.' };
  }
  return { ok: false, reason: 'error', message: 'Could not claim a kiosk password slot. Please try again.' };
}

export type AuthenticateKioskStudentOutcome =
  | { ok: true; studentId: string; firstName: string; level: string }
  | { ok: false; reason: 'offline' }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'login-disabled' }
  | { ok: false; reason: 'error'; message: string };

export async function authenticateKioskStudentViaAdmin(
  joinCode: string,
  firstName: string,
  level: string,
  password: string,
): Promise<AuthenticateKioskStudentOutcome> {
  if (isOffline()) return { ok: false, reason: 'offline' };

  const { data, error } = await supabase.rpc('kiosk_authenticate_student', {
    p_join_code: joinCode,
    p_first_name: firstName,
    p_level: level,
    p_password: password,
  });
  if (error) {
    if (/not currently open/i.test(error.message || '')) return { ok: false, reason: 'login-disabled' };
    if (/incorrect/i.test(error.message || '')) return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'error', message: error.message || 'Could not log in.' };
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  const studentId = String(row?.student_id ?? '');
  if (!studentId) return { ok: false, reason: 'invalid' };
  return {
    ok: true,
    studentId,
    firstName: String(row?.first_name ?? firstName),
    level: String(row?.level ?? level),
  };
}

// ---------------------------------------------------------------------------
// Kiosk-side LIVE ACTIVITY + RESULT reporting — direct to the cloud,
// independent of any LAN authority connection to the admin's device. This is
// what lets the Examination Control Center see an exam in progress, and
// receive its final score, even when the student's device is on a totally
// different network (mobile data, a different building, home Wi-Fi, etc.).
// Every call here is best-effort and silently a no-op when offline or the
// join code is missing — it must never block or interrupt the exam itself,
// which keeps working fully offline regardless of whether any of this
// succeeds (see supabase/kiosk-exam-activity.sql).
// ---------------------------------------------------------------------------

/** Reads the join code the kiosk device is currently connected to, if any. */
export function getStoredKioskJoinCode(): string {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem(KIOSK_JOIN_CODE_STORAGE_KEY)) || '';
  } catch {
    return '';
  }
}

/** Best-effort "this student is on question X of Y" heartbeat. Never throws. */
export async function reportKioskAttemptHeartbeat(params: {
  joinCode: string;
  studentId: string;
  examKey: string;
  examTitle: string;
  currentQuestion: number;
  totalQuestions: number;
  deviceLabel?: string;
}): Promise<void> {
  if (!params.joinCode || !params.studentId || isOffline()) return;
  try {
    await supabase.rpc('kiosk_heartbeat_attempt', {
      p_join_code: params.joinCode,
      p_student_id: params.studentId,
      p_exam_key: params.examKey,
      p_exam_title: params.examTitle,
      p_current_question: params.currentQuestion,
      p_total_questions: params.totalQuestions,
      p_device_label: params.deviceLabel ?? null,
    });
  } catch {
    // Live visibility is a convenience, not the system of record — never
    // let a flaky connection interrupt the exam itself.
  }
}

/** Best-effort "this attempt is no longer in progress" clear. Never throws. */
export async function clearKioskAttemptProgress(
  joinCode: string,
  studentId: string,
  examKey: string,
): Promise<void> {
  if (!joinCode || !studentId || isOffline()) return;
  try {
    await supabase.rpc('kiosk_clear_attempt_progress', {
      p_join_code: joinCode,
      p_student_id: studentId,
      p_exam_key: examKey,
    });
  } catch {
    // Best-effort only; a stale live row simply ages out on its own.
  }
}

export type SubmitKioskResultOutcome =
  | { ok: true }
  | { ok: false; reason: 'offline' | 'missing-identity' }
  | { ok: false; reason: 'error'; message: string };

/**
 * Pushes the final score straight from the kiosk device to the cloud, so the
 * administrator receives it even if their device never shared a LAN with
 * this student's device. Distinct from pushKioskResultsToCloud() in
 * resultsCloudSync.ts (which relays an ADMIN's own already-local results) —
 * this is the kiosk device reporting its own result directly.
 */
export async function submitKioskExamResultToAdmin(params: {
  joinCode: string;
  studentId: string;
  examKey: string;
  examTitle: string;
  scorePercentage: number;
  submittedAt: string;
  deviceLabel?: string;
}): Promise<SubmitKioskResultOutcome> {
  if (!params.joinCode || !params.studentId) return { ok: false, reason: 'missing-identity' };
  if (isOffline()) return { ok: false, reason: 'offline' };
  const { error } = await supabase.rpc('kiosk_submit_exam_result', {
    p_join_code: params.joinCode,
    p_student_id: params.studentId,
    p_exam_key: params.examKey,
    p_exam_title: params.examTitle,
    p_score_percentage: Math.max(0, Math.min(100, params.scorePercentage)),
    p_submitted_at: params.submittedAt,
    p_device_label: params.deviceLabel ?? null,
  });
  if (error) return { ok: false, reason: 'error', message: error.message || 'Could not report this result.' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Administrator side — live attempts reported directly by kiosk devices,
// over the internet, independent of LAN proximity.
// ---------------------------------------------------------------------------

export interface KioskLiveAttempt {
  id: string;
  studentId: string;
  studentFirstName: string;
  studentLevel: string;
  examKey: string;
  examTitle: string;
  currentQuestion: number;
  totalQuestions: number;
  startedAt: string;
  lastSeenAt: string;
  deviceLabel: string | null;
}

export type LiveAttemptsOutcome = { ok: true; attempts: KioskLiveAttempt[] } | CloudAccessFailure;

/** All of this admin's in-progress kiosk attempts, reported live from any network. */
export async function listKioskLiveAttempts(): Promise<LiveAttemptsOutcome> {
  const access = await checkCloudAccess();
  if (!access.ok) return access;
  const { data, error } = await supabase.rpc('list_kiosk_live_attempts');
  if (error) throw new Error(error.message || 'Could not load live kiosk activity.');
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return {
    ok: true,
    attempts: rows.map((row) => ({
      id: String(row.id ?? ''),
      studentId: String(row.student_id ?? ''),
      studentFirstName: String(row.student_first_name ?? ''),
      studentLevel: String(row.student_level ?? ''),
      examKey: String(row.exam_key ?? ''),
      examTitle: String(row.exam_title ?? ''),
      currentQuestion: Number(row.current_question ?? 0),
      totalQuestions: Number(row.total_questions ?? 0),
      startedAt: String(row.started_at ?? ''),
      lastSeenAt: String(row.last_seen_at ?? ''),
      deviceLabel: (row.device_label as string | null) ?? null,
    })),
  };
}
