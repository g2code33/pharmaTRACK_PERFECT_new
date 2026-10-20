import { loadEncryptedJson, saveEncryptedJson } from './secureStorage';
import type { StagedPharmaExam } from './package';

const STAGED_PACKAGE_KEY = 'pharmatrack_staged_pharmaexam_v1';

// Part of the exam-entry critical path (ExamAttemptEntry.tsx reads this
// before a student can begin), so it opts into the same IndexedDB-broken
// localStorage fallback as the rest of the examination flow.
const FALLBACK = { allowLocalStorageFallback: true } as const;

export async function stagePharmaExamPackage(staged: StagedPharmaExam): Promise<void> {
  await saveEncryptedJson(STAGED_PACKAGE_KEY, staged, FALLBACK);
}

export async function loadStagedPharmaExam(): Promise<StagedPharmaExam | null> {
  return loadEncryptedJson<StagedPharmaExam>(STAGED_PACKAGE_KEY, FALLBACK);
}

export async function clearStagedPharmaExam(): Promise<void> {
  await saveEncryptedJson(STAGED_PACKAGE_KEY, null, FALLBACK);
}
