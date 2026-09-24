import * as idb from 'idb-keyval';
import { loadEncryptedJson, saveEncryptedJson } from './secureStorage';
import {
  EXAMINATION_SCHEMA_VERSION,
  emptyExaminationState,
  type ExaminationState,
  type StudentAttempt,
} from './types';
import { timerFromLegacyAttempt } from './timer';

export const EXAMINATION_STATE_KEY = 'pharmatrack_examination_state_v1';

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeAttempt(value: unknown): StudentAttempt {
  const attempt = value as StudentAttempt;
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
      attempt.submissionState || (attempt.status === 'SUBMITTED' ? 'SUBMITTED' : 'NOT_SUBMITTED'),
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
    versions: arrayOrEmpty(value.versions),
    sessions: arrayOrEmpty(value.sessions),
    students: arrayOrEmpty(value.students),
    attempts: arrayOrEmpty<unknown>(value.attempts).map(normalizeAttempt),
    answers: arrayOrEmpty(value.answers),
    securityEvents: arrayOrEmpty(value.securityEvents),
    adminActions: arrayOrEmpty(value.adminActions),
    deviceSessions: arrayOrEmpty(value.deviceSessions),
    syncEvents: arrayOrEmpty(value.syncEvents),
    recoveryStates: arrayOrEmpty(value.recoveryStates),
    importedPackageKeys: arrayOrEmpty(value.importedPackageKeys),
  };
}

export async function loadExaminationState(): Promise<ExaminationState> {
  try {
    return normalizeExaminationState(
      await loadEncryptedJson<ExaminationState>(EXAMINATION_STATE_KEY),
    );
  } catch (error) {
    // Recovery code must return an empty in-memory state rather than crashing
    // the academic app when IndexedDB is unavailable.
    console.error('Examination storage could not be read:', error);
    return emptyExaminationState();
  }
}

export async function saveExaminationState(state: ExaminationState): Promise<boolean> {
  try {
    await saveEncryptedJson(EXAMINATION_STATE_KEY, normalizeExaminationState(state));
    return true;
  } catch (error) {
    console.error('Examination storage could not be written:', error);
    return false;
  }
}

export async function clearExaminationState(): Promise<boolean> {
  try {
    await idb.del(EXAMINATION_STATE_KEY);
    return true;
  } catch (error) {
    console.error('Examination storage could not be cleared:', error);
    return false;
  }
}
