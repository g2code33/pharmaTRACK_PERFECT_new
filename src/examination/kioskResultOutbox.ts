import { loadEncryptedJson, saveEncryptedJson } from './secureStorage';
import { submitKioskExamResultToAdmin } from './kioskRoster';

/**
 * Durable, locally-queued kiosk results waiting to reach the admin's cloud
 * account. Exists for exactly one scenario: a student finishes an exam while
 * this device is offline (or Supabase is briefly unreachable). The exam
 * result itself is already safely written to this device's own encrypted
 * storage the moment the attempt closes — that part never depended on the
 * network — but without this queue, the one attempt to notify the admin's
 * cloud account happened once, at submit time, and was silently dropped if
 * it failed. The student would have to find a working internet connection
 * and manually re-trigger something, which never happens in practice; the
 * admin just never sees the score. This file makes that push eventually
 * consistent instead: queue it once, then keep retrying on every
 * reconnection until Supabase actually accepts it, with zero action from
 * the student or admin.
 */

const OUTBOX_KEY = 'pharmatrack_kiosk_result_outbox_v1';
// Part of the exam-entry/submit critical path, so it opts into the same
// IndexedDB-broken localStorage fallback as the rest of the examination
// flow (see secureStorage.ts).
const FALLBACK = { allowLocalStorageFallback: true } as const;

export interface QueuedKioskResult {
  joinCode: string;
  studentId: string;
  examKey: string;
  examTitle: string;
  scorePercentage: number;
  submittedAt: string;
  deviceLabel?: string;
  /** When this entry was first queued — kept for diagnostics only. */
  queuedAt: string;
  /** How many flush attempts have failed for this entry so far. */
  attempts: number;
}

function entryKey(entry: Pick<QueuedKioskResult, 'studentId' | 'examKey'>): string {
  return `${entry.studentId}:${entry.examKey}`;
}

async function readQueue(): Promise<QueuedKioskResult[]> {
  try {
    return (await loadEncryptedJson<QueuedKioskResult[]>(OUTBOX_KEY, FALLBACK)) ?? [];
  } catch {
    // Treat an unreadable queue as empty rather than throwing — losing a
    // retry queue is far better than blocking exam submission entirely.
    return [];
  }
}

async function writeQueue(queue: QueuedKioskResult[]): Promise<void> {
  try {
    await saveEncryptedJson(OUTBOX_KEY, queue, FALLBACK);
  } catch {
    // Best-effort: if even this can't be saved, the in-memory `flushing`
    // cycle below still has the entry for the rest of this page session.
  }
}

/** Adds (or refreshes) a pending result so it keeps being retried until it lands. */
export async function queueKioskExamResultForRetry(
  params: Omit<QueuedKioskResult, 'queuedAt' | 'attempts'>,
): Promise<void> {
  const queue = await readQueue();
  const key = entryKey(params);
  const existingIndex = queue.findIndex((item) => entryKey(item) === key);
  const entry: QueuedKioskResult = {
    ...params,
    queuedAt: existingIndex >= 0 ? queue[existingIndex].queuedAt : new Date().toISOString(),
    attempts: existingIndex >= 0 ? queue[existingIndex].attempts : 0,
  };
  if (existingIndex >= 0) {
    queue[existingIndex] = entry;
  } else {
    queue.push(entry);
  }
  await writeQueue(queue);
}

/** True while a result for this student/exam is still waiting to reach the admin. */
export async function hasQueuedKioskResult(studentId: string, examKey: string): Promise<boolean> {
  const queue = await readQueue();
  return queue.some((item) => entryKey(item) === entryKey({ studentId, examKey }));
}

let flushing: Promise<void> | null = null;

/** Retries every queued result once; entries that succeed are removed, failures stay queued. */
export async function flushKioskResultOutbox(): Promise<void> {
  // Coalesce overlapping calls (an 'online' event and a timer tick landing
  // at the same moment, say) into a single in-flight flush instead of
  // racing two writers over the same queue.
  if (flushing) return flushing;
  flushing = (async () => {
    const queue = await readQueue();
    if (queue.length === 0) return;
    const remaining: QueuedKioskResult[] = [];
    for (const entry of queue) {
      try {
        const outcome = await submitKioskExamResultToAdmin(entry);
        if (!outcome.ok) {
          remaining.push({ ...entry, attempts: entry.attempts + 1 });
        }
      } catch {
        remaining.push({ ...entry, attempts: entry.attempts + 1 });
      }
    }
    if (remaining.length !== queue.length || remaining.some((entry, index) => entry.attempts !== queue[index]?.attempts)) {
      await writeQueue(remaining);
    }
  })();
  try {
    await flushing;
  } finally {
    flushing = null;
  }
}

export interface SubmitOrQueueParams {
  joinCode: string;
  studentId: string;
  examKey: string;
  examTitle: string;
  scorePercentage: number;
  submittedAt: string;
  deviceLabel?: string;
}

/**
 * The single call site the UI should use: tries to reach the admin's cloud
 * account immediately (today's instant-report behavior when the device is
 * online), and on ANY failure — offline, a dropped connection, a transient
 * Supabase error — falls back to queuing the result so it is never silently
 * lost. Never throws: a cloud report is always a convenience on top of the
 * already-durable local result, never a condition for the exam to "count".
 */
export async function submitOrQueueKioskExamResult(params: SubmitOrQueueParams): Promise<void> {
  try {
    const outcome = await submitKioskExamResultToAdmin(params);
    if (outcome.ok) return;
  } catch {
    // fall through to queueing below
  }
  await queueKioskExamResultForRetry(params);
}

function isBrowserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

// Auto-flush wiring — mirrors the exact pattern already used for account
// sync's own offline queue (src/account/sync.ts): try once on load if we
// appear to be online, then again every time the browser tells us
// connectivity just came back, plus a periodic safety-net sweep for the
// "reports online but actually isn't yet" case a single 'online' event can
// miss.
if (typeof window !== 'undefined') {
  if (isBrowserOnline()) {
    void flushKioskResultOutbox();
  }
  window.addEventListener('online', () => {
    void flushKioskResultOutbox();
  });
  window.setInterval(() => {
    if (isBrowserOnline()) void flushKioskResultOutbox();
  }, 45_000);
}
