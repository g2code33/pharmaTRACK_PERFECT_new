/**
 * Referential integrity for semester data.
 *
 * Every archive/backup is validated with a strict relationship check: a
 * question must point at a course AND a topic that still exist, a material at a
 * live topic, and so on. Deleting a course or a topic used to remove only the
 * row itself (plus learning records), so the questions, materials, notes,
 * quizzes, plans and exam dates that hung off it were left behind as orphans.
 * The data was already invisible in the UI, but it rode along into the
 * snapshot — and the export then refused its own package with
 * "Corrupt backup: Question references a missing course or topic."
 *
 * Two users of this module:
 *   1. the reducer, so a delete cascades and orphans are never created;
 *   2. the archive/export path, so workspaces that already contain orphans
 *      (created before this fix) heal themselves instead of failing forever.
 */

import type { AppState, SemesterSnapshot } from '../types';

/** How many rows each collection lost during a prune. */
export interface OrphanReport {
  topics: number;
  slides: number;
  notes: number;
  examQuestions: number;
  quizHistory: number;
  studyPlans: number;
  examDates: number;
  learningObjectives: number;
  highlights: number;
  learningRecords: number;
}

export type PruneReport = OrphanReport & {
  courses: number;
  materials: number;
  questions: number;
  quizzes: number;
  plans: number;
  dates: number;
  objectives: number;
  total: number;
};

const EMPTY_REPORT: OrphanReport = {
  topics: 0, slides: 0, notes: 0, examQuestions: 0, quizHistory: 0,
  studyPlans: 0, examDates: 0, learningObjectives: 0, highlights: 0,
  learningRecords: 0,
};

/** True when the prune removed nothing. */
export const isCleanReport = (report: OrphanReport): boolean =>
  Object.values(report).every((n) => n === 0);

/** Human-readable summary, e.g. "3 questions, 1 material". */
export const describeOrphanReport = (report: OrphanReport): string => {
  const labels: Record<keyof OrphanReport, [string, string]> = {
    topics: ['topic', 'topics'],
    slides: ['material', 'materials'],
    notes: ['note', 'notes'],
    examQuestions: ['question', 'questions'],
    quizHistory: ['quiz record', 'quiz records'],
    studyPlans: ['study plan', 'study plans'],
    examDates: ['exam date', 'exam dates'],
    learningObjectives: ['objective', 'objectives'],
    highlights: ['highlight', 'highlights'],
    learningRecords: ['learning record', 'learning records'],
  };
  return (Object.keys(labels) as (keyof OrphanReport)[])
    .filter((k) => report[k] > 0)
    .map((k) => `${report[k]} ${labels[k][report[k] === 1 ? 0 : 1]}`)
    .join(', ');
};

const list = <T,>(value: T[] | undefined | null): T[] => (Array.isArray(value) ? value : []);

export type ReferentialState = Partial<AppState> | Partial<SemesterSnapshot>;

export interface PruneResult<T> {
  state: T;
  removed: OrphanReport;
  report: PruneReport;
  [Symbol.iterator](): Iterator<T | OrphanReport>;
}

/**
 * Drops every row whose parent no longer exists, repeatedly, so a deleted
 * course also takes its topics' materials, notes and highlights with it.
 *
 * Pure: the input object is never mutated, and collections that lose nothing
 * keep their original array reference (so React/`===` checks stay cheap).
 */
export const pruneOrphans = <T extends ReferentialState>(
  state: T,
): PruneResult<T> => {
  const removed: OrphanReport = { ...EMPTY_REPORT };
  const next: Record<string, unknown> = { ...state };

  const keep = <R,>(key: keyof OrphanReport, rows: R[] | undefined, predicate: (row: R) => boolean): R[] => {
    const source = list(rows);
    const kept = source.filter(predicate);
    if (kept.length !== source.length) {
      removed[key] += source.length - kept.length;
      next[key as string] = kept;
    }
    return kept;
  };

  const courseIds = new Set(list(state.courses).map((c) => c.id));

  // Topics first — their removal orphans everything below them.
  const topics = keep('topics', state.topics, (t) => courseIds.has(t.courseId));
  const topicIds = new Set(topics.map((t) => t.id));

  const slides = keep('slides', state.slides, (s) => topicIds.has(s.topicId));
  const slideIds = new Set(slides.map((s) => s.id));

  keep('notes', state.notes, (n) => topicIds.has(n.topicId));
  keep('examQuestions', state.examQuestions, (q) => courseIds.has(q.courseId) && topicIds.has(q.topicId));
  keep('quizHistory', state.quizHistory, (q) => courseIds.has(q.courseId));
  keep('studyPlans', state.studyPlans, (p) => courseIds.has(p.courseId));
  keep('examDates', state.examDates, (d) => courseIds.has(d.courseId));
  // A course-wide objective has no topicId; only a stale topic link is an orphan.
  keep('learningObjectives', state.learningObjectives, (o) =>
    courseIds.has(o.courseId) && (!o.topicId || topicIds.has(o.topicId)));
  keep('highlights', state.highlights, (h) =>
    topicIds.has(h.topicId) && (!h.materialId || slideIds.has(h.materialId)));
  keep('learningRecords', state.learningRecords, (r) => topicIds.has(r.topicId));

  const total = Object.values(removed).reduce((a, b) => a + b, 0);
  const report: PruneReport = {
    ...removed,
    courses: 0,
    materials: removed.slides,
    questions: removed.examQuestions,
    quizzes: removed.quizHistory,
    plans: removed.studyPlans,
    dates: removed.examDates,
    objectives: removed.learningObjectives,
    total,
  };

  const nextState = next as T;
  return {
    state: nextState,
    removed,
    report,
    *[Symbol.iterator]() {
      yield nextState;
      yield removed;
    },
  };
};

/** Convenience wrapper for callers that only need the cleaned state. */
export const withoutOrphans = <T extends ReferentialState>(state: T): T => pruneOrphans(state).state;

export const pruneOrphansState = withoutOrphans;
