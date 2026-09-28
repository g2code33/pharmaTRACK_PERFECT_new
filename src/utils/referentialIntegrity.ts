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

  const report: PruneReport = {
    courses: 0,
    topics: droppedTopics,
    slides: droppedSlides,
    materials: droppedSlides,
    notes: droppedNotes,
    questions: droppedQuestions,
    examQuestions: droppedQuestions,
    quizzes: droppedQuizzes,
    quizHistory: droppedQuizzes,
    plans: droppedPlans,
    studyPlans: droppedPlans,
    dates: droppedDates,
    examDates: droppedDates,
    highlights: droppedHighlights,
    learningRecords: droppedRecords,
    learningObjectives: droppedObjectives,
    objectives: droppedObjectives,
    total: totalDropped,
  };

  const nextState: T = {
    ...state,
    ...(state.topics !== undefined ? { topics } : {}),
    ...(state.slides !== undefined ? { slides } : {}),
    ...(state.notes !== undefined ? { notes } : {}),
    ...(state.examQuestions !== undefined ? { examQuestions } : {}),
    ...(state.quizHistory !== undefined ? { quizHistory } : {}),
    ...(state.studyPlans !== undefined ? { studyPlans } : {}),
    ...(state.examDates !== undefined ? { examDates } : {}),
    ...(state.highlights !== undefined ? { highlights } : {}),
    ...(state.learningRecords !== undefined ? { learningRecords } : {}),
    ...(state.learningObjectives !== undefined ? { learningObjectives } : {}),
  };

  return {
    state: nextState,
    report,
    *[Symbol.iterator]() {
      yield nextState;
      yield report;
    },
  };
}

export function pruneOrphansState<T extends ReferentialState>(state: T): T {
  return pruneOrphans(state).state;
}
