import * as idb from '../utils/idbStore';
import { loadEncryptedJson, saveEncryptedJson } from './secureStorage';
import {
  EXAMINATION_SCHEMA_VERSION,
  emptyExaminationState,
  DEFAULT_RESULT_DETAILS,
  type ExaminationState,
  type ExamVersion,
  type StudentAttempt,
  type ExamResultReleaseRecord,
  type ResultReleaseAuditRecord,
} from './types';
import { timerFromLegacyAttempt } from './timer';

export const EXAMINATION_STATE_KEY = 'pharmatrack_examination_state_v1';

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function migrateSecurity<T extends { security: StudentAttempt['settingsSnapshot']['security'] }>(value: T): T {
  const security = value.security;
  return {
    ...value,
    security: {
      ...security,
      fullLockdown: security.fullLockdown ?? security.lockdown ?? false,
      manualExitPolicy:
        security.manualExitPolicy ?? (security.restrictExit === false ? 'ALLOW_FREE_EXIT' : 'ADMIN_AUTH_REQUIRED'),
    },
  };
}

function normalizeAttempt(value: unknown): StudentAttempt {
  const raw = value as StudentAttempt;
  const rawSnapshot = raw.settingsSnapshot || ({} as any);
  const attempt = {
    ...raw,
    settingsSnapshot: {
      ...rawSnapshot,
      security: migrateSecurity({ security: rawSnapshot.security }).security,
      resultVisibilityPolicy: rawSnapshot.resultVisibilityPolicy || 'IMMEDIATE',
      resultDetails: { ...DEFAULT_RESULT_DETAILS, ...(rawSnapshot.resultDetails || {}) },
    },
  } as StudentAttempt;
  const timerState =
    attempt.timerState ||
    timerFromLegacyAttempt(
      attempt.startedAt,
      attempt.deadlineAt,
      attempt.settingsSnapshot?.availability?.durationMinutes || 60,
    );
  return {
    ...attempt,
    timerState,
    securityState: attempt.securityState || 'NORMAL',
    synchronizationState: attempt.synchronizationState || 'LOCAL_ONLY',
    saveStatus: attempt.saveStatus || 'SAVED',
    submissionState:
      attempt.submissionState ||
      (attempt.status === 'SUBMITTING'
        ? 'SUBMITTING'
        : attempt.status === 'SUBMITTED' || attempt.status === 'KIOSK_RELEASED'
          ? 'SUBMITTED'
          : 'NOT_SUBMITTED'),
    kioskLifecycle:
      attempt.kioskLifecycle ||
      (attempt.status === 'SUBMITTING'
        ? 'SUBMITTING'
        : attempt.status === 'KIOSK_RELEASED'
          ? 'RELEASED'
          : attempt.status === 'SUBMITTED'
            ? 'SUBMITTED'
            : 'ACTIVE'),
    ownershipGeneration: attempt.ownershipGeneration || 1,
    currentQuestionId: attempt.currentQuestionId || attempt.questionOrder?.[0],
  };
}

/**
 * Exam records live outside the normal semester AppState. This keeps old
 * workspaces and practice Quiz history readable, and lets examination recovery
 * continue even when a normal academic save is malformed.
 */
export function normalizeExaminationState(raw: unknown): ExaminationState {
  const base = emptyExaminationState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const value = raw as Partial<ExaminationState> & { schemaVersion?: number };
  return {
    ...base,
    schemaVersion: EXAMINATION_SCHEMA_VERSION,
    exams: arrayOrEmpty(value.exams),
    versions: arrayOrEmpty<ExamVersion>(value.versions).map((version) => ({
      ...version,
      security: migrateSecurity({ security: version.security }).security,
      resultVisibilityPolicy: version.resultVisibilityPolicy || 'IMMEDIATE',
      resultDetails: { ...DEFAULT_RESULT_DETAILS, ...(version.resultDetails || {}) },
    })),
    sessions: arrayOrEmpty(value.sessions),
    students: arrayOrEmpty(value.students),
    attempts: arrayOrEmpty<unknown>(value.attempts).map(normalizeAttempt),
    answers: arrayOrEmpty(value.answers),
    securityEvents: arrayOrEmpty(value.securityEvents),
    adminActions: arrayOrEmpty(value.adminActions),
    deviceSessions: arrayOrEmpty(value.deviceSessions),
    syncEvents: arrayOrEmpty(value.syncEvents),
    recoveryStates: arrayOrEmpty(value.recoveryStates),
    results: arrayOrEmpty(value.results),
    authorities: arrayOrEmpty(value.authorities),
    authorityLeases: arrayOrEmpty(value.authorityLeases),
    replicationSnapshots: arrayOrEmpty(value.replicationSnapshots),
    importedPackageKeys: arrayOrEmpty(value.importedPackageKeys),
    resultReleases: arrayOrEmpty<ExamResultReleaseRecord>(value.resultReleases),
    resultReleaseAudits: arrayOrEmpty<ResultReleaseAuditRecord>(value.resultReleaseAudits),
    issuedKioskPasswordSlots: arrayOrEmpty<number>(value.issuedKioskPasswordSlots),
  };
}

// `ExaminationRepository.open()` deliberately re-reads from storage on every
// call instead of sharing one singleton (several tests rely on that to
// simulate "another device" reading the same persisted store). That is
// exactly right when the underlying store works — but on a device where the
// local database is unreliable (a wedged IndexedDB connection is a known
// failure mode on some platforms; see utils/idbStore.ts), a read failure
// right after a successful-looking registration would otherwise make the
// student that was just registered vanish the moment the kiosk opens a new
// repository instance to log in, even though nothing was actually wrong
// with what the student typed. Keeping the last known-good state in memory
// means that, for the lifetime of this page, register-then-login keeps
// working even when the persistent store cannot be read or written at all
// — only surviving an actual page reload still requires real storage.
let memoryStateCache: ExaminationState | null = null;

export async function loadExaminationState(): Promise<ExaminationState> {
  try {
    const loaded = normalizeExaminationState(
      await loadEncryptedJson<ExaminationState>(EXAMINATION_STATE_KEY),
    );
    memoryStateCache = loaded;
    return loaded;
  } catch (error) {
    // Recovery code must return a usable in-memory state rather than
    // crashing the academic app when IndexedDB is unavailable. Falling back
    // to the last state this page session actually saw (instead of always
    // an empty one) is what keeps a registration made moments earlier from
    // silently disappearing when the next screen re-opens the repository.
    console.error('Examination storage could not be read:', error);
    return memoryStateCache
      ? normalizeExaminationState(memoryStateCache)
      : emptyExaminationState();
  }
}

export async function saveExaminationState(state: ExaminationState): Promise<boolean> {
  const normalized = normalizeExaminationState(state);
  // Mirror into memory BEFORE attempting the real write: a student record
  // that was just added must be visible to the very next read in this page
  // session even if the persistent write below fails outright.
  memoryStateCache = normalized;
  try {
    await saveEncryptedJson(EXAMINATION_STATE_KEY, normalized);
    return true;
  } catch (error) {
    console.error('Examination storage could not be written:', error);
    return false;
  }
}

export async function clearExaminationState(): Promise<boolean> {
  memoryStateCache = null;
  try {
    await idb.del(EXAMINATION_STATE_KEY);
    return true;
  } catch (error) {
    console.error('Examination storage could not be cleared:', error);
    return false;
  }
}
