<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> e50e3ed8136a08a77a9d402f75c7d99518a56bfe
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

<<<<<<< HEAD
  return { state: next as T, removed };
};

/** Convenience wrapper for callers that only need the cleaned state. */
export const withoutOrphans = <T extends Partial<AppState>>(state: T): T => pruneOrphans(state).state;
=======
import type {
  AppState,
  SemesterSnapshot,
  Course,
  Topic,
  Slide,
  Note,
  ExamQuestion,
  QuizHistory,
  StudyPlan,
  ExamDate,
  Highlight,
  TopicLearningRecord,
  LearningObjective,
} from '../types';

export interface PruneReport {
  courses: number;
  topics: number;
  slides: number;
  materials: number; // alias for slides
  notes: number;
  questions: number; // alias for examQuestions
  examQuestions: number;
  quizzes: number; // alias for quizHistory
  quizHistory: number;
  plans: number; // alias for studyPlans
  studyPlans: number;
  dates: number; // alias for examDates
  examDates: number;
  highlights: number;
  learningRecords: number;
  learningObjectives: number;
  objectives: number; // alias for learningObjectives
  total: number;
}

export type ReferentialState = Partial<AppState> | Partial<SemesterSnapshot>;

export interface PruneResult<T> {
  state: T;
  report: PruneReport;
  [Symbol.iterator](): Iterator<T | PruneReport>;
}

/**
 * Pure, cascading prune of orphaned academic records:
 *   courses -> topics -> materials / notes / questions / quizzes / plans / dates / highlights / learning records
 *
 * Rules:
 * - A topic must reference a valid course.
 * - Materials (slides) and notes must reference a valid topic.
 * - Exam questions must reference both a valid course and a valid topic.
 * - Quiz history, study plans, and exam dates must reference a valid course.
 * - Highlights referencing a materialId must reference an existing slide.
 * - Learning records must reference a valid topic.
 * - Course-wide learning objectives without a topicId are preserved as long as their courseId is valid.
 * - Collections that require no changes preserve their exact array identity (===).
 */
export function pruneOrphans<T extends ReferentialState>(state: T): PruneResult<T> {
  const currentCourses = (state.courses as Course[]) || [];
  const courseIds = new Set(currentCourses.map((c) => c.id));

  // 1. Topics
  const rawTopics = (state.topics as Topic[]) || [];
  const validTopics = rawTopics.filter((t) => courseIds.has(t.courseId));
  const droppedTopics = rawTopics.length - validTopics.length;
  const topics = droppedTopics > 0 ? validTopics : rawTopics;
  const topicIds = new Set(topics.map((t) => t.id));

  // 2. Slides (Materials)
  const rawSlides = (state.slides as Slide[]) || [];
  const validSlides = rawSlides.filter((s) => topicIds.has(s.topicId));
  const droppedSlides = rawSlides.length - validSlides.length;
  const slides = droppedSlides > 0 ? validSlides : rawSlides;
  const slideIds = new Set(slides.map((s) => s.id));

  // 3. Notes
  const rawNotes = (state.notes as Note[]) || [];
  const validNotes = rawNotes.filter((n) => topicIds.has(n.topicId));
  const droppedNotes = rawNotes.length - validNotes.length;
  const notes = droppedNotes > 0 ? validNotes : rawNotes;

  // 4. Exam Questions (must reference valid course AND valid topic)
  const rawQuestions = (state.examQuestions as ExamQuestion[]) || [];
  const validQuestions = rawQuestions.filter((q) => courseIds.has(q.courseId) && topicIds.has(q.topicId));
  const droppedQuestions = rawQuestions.length - validQuestions.length;
  const examQuestions = droppedQuestions > 0 ? validQuestions : rawQuestions;

  // 5. Quiz History
  const rawQuizzes = (state.quizHistory as QuizHistory[]) || [];
  const validQuizzes = rawQuizzes.filter((q) => courseIds.has(q.courseId));
  const droppedQuizzes = rawQuizzes.length - validQuizzes.length;
  const quizHistory = droppedQuizzes > 0 ? validQuizzes : rawQuizzes;

  // 6. Study Plans
  const rawPlans = (state.studyPlans as StudyPlan[]) || [];
  const validPlans = rawPlans.filter((p) => courseIds.has(p.courseId));
  const droppedPlans = rawPlans.length - validPlans.length;
  const studyPlans = droppedPlans > 0 ? validPlans : rawPlans;

  // 7. Exam Dates
  const rawDates = (state.examDates as ExamDate[]) || [];
  const validDates = rawDates.filter((d) => courseIds.has(d.courseId));
  const droppedDates = rawDates.length - validDates.length;
  const examDates = droppedDates > 0 ? validDates : rawDates;

  // 8. Highlights (materialId must point to an existing slide if provided)
  const rawHighlights = (state.highlights as Highlight[]) || [];
  const validHighlights = rawHighlights.filter((h) => !h.materialId || slideIds.has(h.materialId));
  const droppedHighlights = rawHighlights.length - validHighlights.length;
  const highlights = droppedHighlights > 0 ? validHighlights : rawHighlights;

  // 9. Learning Records
  const rawRecords = (state.learningRecords as TopicLearningRecord[]) || [];
  const validRecords = rawRecords.filter((r) => topicIds.has(r.topicId));
  const droppedRecords = rawRecords.length - validRecords.length;
  const learningRecords = state.learningRecords
    ? (droppedRecords > 0 ? validRecords : state.learningRecords)
    : undefined;

  // 10. Learning Objectives
  // Course-wide objectives with no topicId are correctly kept as long as their courseId is valid.
  const rawObjectives = (state.learningObjectives as LearningObjective[]) || [];
  const validObjectives = rawObjectives.filter((o) => {
    if (o.courseId && !courseIds.has(o.courseId)) return false;
    if (o.topicId && !topicIds.has(o.topicId)) return false;
    return true;
  });
  const droppedObjectives = rawObjectives.length - validObjectives.length;
  const learningObjectives = droppedObjectives > 0 ? validObjectives : rawObjectives;

  const totalDropped =
    droppedTopics +
    droppedSlides +
    droppedNotes +
    droppedQuestions +
    droppedQuizzes +
    droppedPlans +
    droppedDates +
    droppedHighlights +
    droppedRecords +
    droppedObjectives;

=======
  const total = Object.values(removed).reduce((a, b) => a + b, 0);
>>>>>>> e50e3ed8136a08a77a9d402f75c7d99518a56bfe
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

<<<<<<< HEAD
export function pruneOrphansState<T extends ReferentialState>(state: T): T {
  return pruneOrphans(state).state;
}
>>>>>>> 6fce4951938648dcb8aecfdf31349c75899937e8
=======
/** Convenience wrapper for callers that only need the cleaned state. */
export const withoutOrphans = <T extends ReferentialState>(state: T): T => pruneOrphans(state).state;

export const pruneOrphansState = withoutOrphans;
>>>>>>> e50e3ed8136a08a77a9d402f75c7d99518a56bfe
