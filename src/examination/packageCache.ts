import { loadEncryptedJson, saveEncryptedJson } from './secureStorage';
import type { StagedPharmaExam } from './package';

const STAGED_PACKAGE_KEY = 'pharmatrack_staged_pharmaexam_v1';

export async function stagePharmaExamPackage(staged: StagedPharmaExam): Promise<void> {
  await saveEncryptedJson(STAGED_PACKAGE_KEY, staged);
}

export async function loadStagedPharmaExam(): Promise<StagedPharmaExam | null> {
  return loadEncryptedJson<StagedPharmaExam>(STAGED_PACKAGE_KEY);
}

export async function clearStagedPharmaExam(): Promise<void> {
  await saveEncryptedJson(STAGED_PACKAGE_KEY, null);
}
