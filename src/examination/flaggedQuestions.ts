/**
 * "Flag for review" bookmarks for a secure exam attempt.
 *
 * This is a student-side convenience only (same idea as the flag feature in
 * the shared Quick Quiz) — it never changes grading, security policy, or the
 * encrypted attempt record itself. It is kept in plain localStorage, keyed
 * by attempt id, so a flag set survives a reload/resume mid-exam but never
 * needs to travel through the encrypted secure-storage migration path.
 */

const PREFIX = 'pharmatrack.secureExam.flags.v1:';

function storageKey(attemptId: string): string {
  return `${PREFIX}${attemptId}`;
}

export function loadFlaggedQuestions(attemptId: string): Set<string> {
  if (typeof window === 'undefined' || !attemptId) return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey(attemptId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveFlaggedQuestions(attemptId: string, flagged: Set<string>): void {
  if (typeof window === 'undefined' || !attemptId) return;
  try {
    window.localStorage.setItem(storageKey(attemptId), JSON.stringify(Array.from(flagged)));
  } catch {
    /* storage full or blocked — flags simply will not survive a reload */
  }
}

export function clearFlaggedQuestions(attemptId: string): void {
  if (typeof window === 'undefined' || !attemptId) return;
  try {
    window.localStorage.removeItem(storageKey(attemptId));
  } catch {
    /* ignore */
  }
}
