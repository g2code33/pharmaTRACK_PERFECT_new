/**
 * Local attempt bookkeeping for shared quick quizzes.
 *
 * Shared between the quiz itself and the course page that lists a course's
 * topics, so both agree on what "in progress" and "already done" mean. Keys
 * must match exactly, which is why the hashing lives here rather than being
 * repeated in each page.
 */
import type { QuickQuizPack } from './quickQuizShare';

export const SHARED_QUICK_COURSE_ID = 'shared-quick-quizzes';

const PAUSE_PREFIX = 'pharmatrack.quickQuiz.pause.v1:';
/** Score of a finished topic, keyed by the link it was opened from. */
const RESULT_PREFIX = 'pharmatrack.quickCourse.result.v1:';
/** Maps a course entry back to the pack it loaded, so progress can be found. */
const ENTRY_KEY_PREFIX = 'pharmatrack.quickCourse.key.v1:';

export type PausedQuickQuizState = {
  version: 1;
  /** 'auto' is a background autosave; 'paused' means the student tapped Pause. */
  reason?: 'auto' | 'paused';
  savedAt: string;
  packKey: string;
  answers: Record<string, string>;
  currentIndex: number;
  timeRemainingSeconds: number | null;
  timeExpired: boolean;
};

export type QuickCourseResult = {
  version: 1;
  percent: number;
  correct: number;
  total: number;
  completedAt: string;
};

function readJson<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — progress display simply degrades */
  }
}

/** Stable, dependency-free 32-bit FNV-1a, rendered base 36. */
export function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Identifies a pack by its content, so the same shared quiz resumes whether it
 * arrived as a short link, an offline link, or a re-share of the same pack.
 */
export function quickQuizPackKey(pack: QuickQuizPack): string {
  return hashString(
    JSON.stringify({
      title: pack.title,
      questions: pack.questions.map((q) => [
        q.questionText,
        q.questionType,
        q.options,
        q.correctOption,
        q.correctAnswer,
        q.explanation,
      ]),
    }),
  );
}

export const sharedQuickTopicId = (key: string) => `shared-quick-topic-${key}`;
export const sharedQuickQuestionId = (key: string, index: number) =>
  `shared-quick-question-${key}-${index + 1}`;

const pauseKey = (key: string): string => `${PAUSE_PREFIX}${key}`;

export function loadPausedQuickQuiz(key: string): PausedQuickQuizState | null {
  const parsed = readJson<PausedQuickQuizState>(pauseKey(key));
  return parsed?.version === 1 && parsed.packKey === key ? parsed : null;
}

export function savePausedQuickQuiz(payload: PausedQuickQuizState): void {
  writeJson(pauseKey(payload.packKey), payload);
}

export function removePausedQuickQuiz(key?: string): void {
  if (!key || typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(pauseKey(key));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Course progress
// ---------------------------------------------------------------------------

/**
 * Identifies one topic inside a shared course link. Short-code topics are
 * identified by their code; offline topics by a hash of their inline pack, so
 * the same topic keeps its progress across reopenings of the course link.
 */
export function quickCourseEntryKey(entry: { code?: string; pack?: string }): string {
  if (entry.code) return `c:${entry.code}`;
  if (entry.pack) return `p:${hashString(entry.pack)}`;
  return '';
}

export function loadQuickCourseResult(entryKey: string): QuickCourseResult | null {
  if (!entryKey) return null;
  const parsed = readJson<QuickCourseResult>(`${RESULT_PREFIX}${entryKey}`);
  return parsed?.version === 1 ? parsed : null;
}

export function saveQuickCourseResult(
  entryKey: string,
  result: Omit<QuickCourseResult, 'version'>,
): void {
  if (!entryKey) return;
  writeJson(`${RESULT_PREFIX}${entryKey}`, { version: 1, ...result } satisfies QuickCourseResult);
}

/**
 * Remembers which pack a course entry opened. The course page only holds links,
 * not questions, so this is how it can tell that a topic has an attempt in
 * progress without downloading every topic.
 */
export function rememberQuickCourseEntryPack(entryKey: string, packKey: string): void {
  if (!entryKey || !packKey || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${ENTRY_KEY_PREFIX}${entryKey}`, packKey);
  } catch {
    /* ignore */
  }
}

export function quickCourseEntryPackKey(entryKey: string): string | null {
  if (!entryKey || typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(`${ENTRY_KEY_PREFIX}${entryKey}`);
  } catch {
    return null;
  }
}

export type QuickCourseEntryProgress =
  | { status: 'not-started' }
  | { status: 'in-progress'; answered: number; savedAt: string }
  | { status: 'done'; percent: number; correct: number; total: number; completedAt: string };

/** What the course page shows next to a topic. */
export function quickCourseEntryProgress(entryKey: string): QuickCourseEntryProgress {
  const result = loadQuickCourseResult(entryKey);
  if (result) {
    return {
      status: 'done',
      percent: result.percent,
      correct: result.correct,
      total: result.total,
      completedAt: result.completedAt,
    };
  }
  const packKey = quickCourseEntryPackKey(entryKey);
  const paused = packKey ? loadPausedQuickQuiz(packKey) : null;
  if (paused) {
    const answered = Object.values(paused.answers || {}).filter(
      (answer) => (answer || '').trim().length > 0,
    ).length;
    return { status: 'in-progress', answered, savedAt: paused.savedAt };
  }
  return { status: 'not-started' };
}
