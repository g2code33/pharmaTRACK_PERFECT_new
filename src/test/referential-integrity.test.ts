<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> e50e3ed8136a08a77a9d402f75c7d99518a56bfe
/**
 * Regression tests for: "Export failed — The generated backup failed its own
 * integrity check: Corrupt backup: Question references a missing course or
 * topic."
 *
 * Root cause: deleting a course/topic did not cascade, so its questions (and
 * materials, notes, quizzes, plans, exam dates, highlights) stayed in the
 * workspace as orphans, got archived, and then failed the relationship check
 * that every export runs against its own package.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
<<<<<<< HEAD
=======
import { describe, it, expect, vi, beforeEach } from 'vitest';
>>>>>>> 6fce4951938648dcb8aecfdf31349c75899937e8
=======
>>>>>>> e50e3ed8136a08a77a9d402f75c7d99518a56bfe

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => { idbStore.set(k, v); },
  del: async (k: string) => { idbStore.delete(k); },
  delMany: async (keys: string[]) => { keys.forEach((k) => idbStore.delete(k)); },
  keys: async () => [...idbStore.keys()],
  clear: async () => { idbStore.clear(); },
}));

<<<<<<< HEAD
<<<<<<< HEAD
import { pruneOrphans, describeOrphanReport, isCleanReport } from '../utils/referentialIntegrity';
=======
import { pruneOrphans } from '../utils/referentialIntegrity';
import { appReducer } from '../context/AppContext';
>>>>>>> 6fce4951938648dcb8aecfdf31349c75899937e8
=======
import { pruneOrphans, describeOrphanReport, isCleanReport } from '../utils/referentialIntegrity';
>>>>>>> e50e3ed8136a08a77a9d402f75c7d99518a56bfe
import {
  buildSnapshot,
  createSemesterArchive,
  verifySemesterArchive,
  exportBackup,
  parseBackup,
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> e50e3ed8136a08a77a9d402f75c7d99518a56bfe
  loadArchive,
} from '../utils/semesterArchive';
import type { AppState, ExamQuestion } from '../types';

const question = (id: string, courseId: string, topicId: string): ExamQuestion => ({
  id, courseId, topicId,
  questionText: `Question ${id}?`,
  questionType: 'short_answer',
  marksAllocation: 5,
  difficulty: 'medium',
  probability: 'high',
  modelAnswer: 'Answer',
<<<<<<< HEAD
=======
  itemCountOf,
  ARCHIVE_KEY_PREFIX,
  ARCHIVE_VERSION,
  type ArchiveRecord,
} from '../utils/semesterArchive';
import { initialState } from '../utils/storage';
import type {
  AppState,
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
  SemesterSnapshot,
} from '../types';

const now = new Date().toISOString();

const sampleCourse1: Course = {
  id: 'c1',
  studentId: 'stud1',
  courseCode: 'PHA101',
  courseName: 'Pharmacology',
  lecturerName: 'Dr. Smith',
  semester: '2',
  creditHours: 3,
  createdAt: now,
};

const sampleCourse2: Course = {
  id: 'c2',
  studentId: 'stud1',
  courseCode: 'PHA102',
  courseName: 'Pharmaceutics',
  lecturerName: 'Dr. Jones',
  semester: '2',
  creditHours: 3,
  createdAt: now,
};

const sampleTopic1: Topic = {
  id: 't1',
  courseId: 'c1',
  topicName: 'Adrenergic Agonists',
  orderIndex: 0,
  createdAt: now,
};

const sampleTopic2: Topic = {
  id: 't2',
  courseId: 'c1',
  topicName: 'Cholinergic Antagonists',
  orderIndex: 1,
  createdAt: now,
};

const sampleTopic3: Topic = {
  id: 't3',
  courseId: 'c2',
  topicName: 'Tablet Formulation',
  orderIndex: 0,
  createdAt: now,
};

const sampleSlide1: Slide = {
  id: 's1',
  topicId: 't1',
  slideNumber: 1,
  title: 'Lecture 1 Slides',
  contentText: 'Slide text',
  fileType: 'pdf',
  status: 'completed',
  createdAt: now,
};

const sampleSlide2: Slide = {
  id: 's2',
  topicId: 't2',
  slideNumber: 1,
  title: 'Lecture 2 Slides',
  contentText: 'Slide text',
  fileType: 'pdf',
  status: 'completed',
  createdAt: now,
};

const sampleSlide3: Slide = {
  id: 's3',
  topicId: 't3',
  slideNumber: 1,
  title: 'Lecture 3 Slides',
  contentText: 'Slide text',
  fileType: 'pdf',
  status: 'completed',
  createdAt: now,
};

const sampleNote1: Note = {
  id: 'n1',
  topicId: 't1',
  noteText: 'Adrenaline Notes',
  isAiGenerated: false,
  createdAt: now,
};

const sampleNote2: Note = {
  id: 'n2',
  topicId: 't3',
  noteText: 'Excipients Notes',
  isAiGenerated: false,
  createdAt: now,
};

const sampleQuestion1: ExamQuestion = {
  id: 'q1',
  courseId: 'c1',
  topicId: 't1',
  questionText: 'What is adrenaline?',
  questionType: 'mcq',
  marksAllocation: 2,
  difficulty: 'medium',
  probability: 'high',
  modelAnswer: 'A hormone and neurotransmitter',
  correctOption: 0,
>>>>>>> 6fce4951938648dcb8aecfdf31349c75899937e8
=======
>>>>>>> e50e3ed8136a08a77a9d402f75c7d99518a56bfe
  tags: [],
  isPracticed: false,
  needsReview: false,
  isSaved: false,
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> e50e3ed8136a08a77a9d402f75c7d99518a56bfe
  createdAt: '2024-01-01',
});

const makeState = (overrides: Partial<AppState> = {}): AppState => ({
  isLoggedIn: false,
  student: {
    id: 'u1', name: 'Ama', university: 'UCC',
    level: 'Level 200', program: 'Pharm.D', semester: '2nd Semester',
    createdAt: '2024-01-01',
  },
  courses: [
    { id: 'c1', studentId: 'u1', courseCode: 'PHA201', courseName: 'Pharmacology', lecturerName: 'Dr. B', semester: '2nd Semester', creditHours: 4, createdAt: '2024-01-01' },
  ],
  topics: [
    { id: 't1', courseId: 'c1', topicName: 'Diuretics', orderIndex: 0, createdAt: '2024-01-01' },
  ],
  slides: [
    { id: 's1', topicId: 't1', slideNumber: 1, title: 'Loop diuretics', contentText: 'Furosemide', status: 'completed', createdAt: '2024-01-02' },
  ],
  learningObjectives: [],
  examQuestions: [question('q1', 'c1', 't1')],
  quizHistory: [],
  studyPlans: [],
  notes: [],
  examDates: [],
  activities: [],
  chatHistory: [],
  highlights: [],
  savedInsights: [],
  openAIKey: '',
  timetables: { class: [], quiz: [], exam: [] },
  timetablePdf: null,
  ...overrides,
});

/** A workspace that already contains the orphans this bug used to create. */
const orphanedState = (): AppState =>
  makeState({
    examQuestions: [
      question('q1', 'c1', 't1'),      // healthy
      question('q2', 'c-gone', 't1'),  // course deleted
      question('q3', 'c1', 't-gone'),  // topic deleted
    ],
    notes: [
      { id: 'n1', topicId: 't1', noteText: 'ok', isAiGenerated: false, createdAt: '2024-01-03' },
      { id: 'n2', topicId: 't-gone', noteText: 'orphan', isAiGenerated: false, createdAt: '2024-01-03' },
    ],
    quizHistory: [
      { id: 'z1', studentId: 'u1', courseId: 'c-gone', questionsUsed: ['q2'], answersGiven: [], scorePercentage: 50, weakTopics: [], timeTaken: 60, completedAt: '2024-02-01' },
    ],
    examDates: [{ id: 'ed1', courseId: 'c-gone', examDate: '2024-05-20', examType: 'endsem', isReminderSet: false }],
    highlights: [
      { id: 'h1', topicId: 't1', slideIndex: 0, text: 'ok', color: 'yellow', timestamp: '2024-01-04', materialId: 's1' },
      { id: 'h2', topicId: 't1', slideIndex: 0, text: 'orphan', color: 'yellow', timestamp: '2024-01-04', materialId: 's-gone' },
    ],
  });

const blobToBuffer = (blob: Blob): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
});

describe('pruneOrphans', () => {
  it('drops rows whose parent is gone and keeps the healthy ones', () => {
    const { state, removed } = pruneOrphans(orphanedState());
    expect(state.examQuestions.map((q) => q.id)).toEqual(['q1']);
    expect(state.notes.map((n) => n.id)).toEqual(['n1']);
    expect(state.quizHistory).toHaveLength(0);
    expect(state.examDates).toHaveLength(0);
    expect(state.highlights.map((h) => h.id)).toEqual(['h1']);
    expect(removed.examQuestions).toBe(2);
    expect(isCleanReport(removed)).toBe(false);
    expect(describeOrphanReport(removed)).toContain('2 questions');
  });

  it('cascades: removing a course also removes its topics and their children', () => {
    const base = makeState();
    const { state } = pruneOrphans({ ...base, courses: [] });
    expect(state.topics).toHaveLength(0);
    expect(state.slides).toHaveLength(0);
    expect(state.examQuestions).toHaveLength(0);
  });

  it('keeps course-wide objectives that legitimately have no topic', () => {
    const base = makeState({
      learningObjectives: [
        { id: 'lo1', courseId: 'c1', objectiveText: 'Course-wide', status: 'partial', createdAt: '2024-01-01' },
        { id: 'lo2', courseId: 'c1', topicId: 't-gone', objectiveText: 'Orphan', status: 'partial', createdAt: '2024-01-01' },
      ],
    });
    const { state } = pruneOrphans(base);
    expect(state.learningObjectives.map((o) => o.id)).toEqual(['lo1']);
  });

  it('is a no-op on clean data and never mutates the input', () => {
    const base = makeState();
    const { state, removed } = pruneOrphans(base);
    expect(isCleanReport(removed)).toBe(true);
    expect(state.examQuestions).toBe(base.examQuestions);
  });
});

describe('snapshot + export never ship orphans', () => {
  it('buildSnapshot drops orphaned questions', () => {
    const snapshot = buildSnapshot(orphanedState());
    expect(snapshot.examQuestions.map((q) => q.id)).toEqual(['q1']);
  });

  it('exports an archive that already contains orphans, and it passes its own integrity check', async () => {
    const meta = await createSemesterArchive(orphanedState(), { level: '200', semester: '2', academicYear: '2025/2026' });
    expect((await verifySemesterArchive(meta.id)).status).toBe('verified');

    // Simulate a pre-fix archive: inject orphans straight into the stored snapshot.
    const rec = (await loadArchive(meta.id))!;
    rec.snapshot.examQuestions = [...rec.snapshot.examQuestions, question('q9', 'c-gone', 't-gone')];
    idbStore.set(`semester_archive_${meta.id}`, rec);

    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });
    const parsed = await parseBackup(await blobToBuffer(blob));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.parsed.kind === 'semester') {
      expect(parsed.parsed.staged.snapshot.examQuestions.map((q) => q.id)).toEqual(['q1']);
    }
  });

  it('exports the live workspace even when it holds orphans', async () => {
    const blob = await exportBackup({ kind: 'live', state: orphanedState() });
    const parsed = await parseBackup(await blobToBuffer(blob));
    expect(parsed.ok).toBe(true);
<<<<<<< HEAD
=======
  createdAt: now,
};

const sampleQuestion2: ExamQuestion = {
  id: 'q2',
  courseId: 'c2',
  topicId: 't3',
  questionText: 'What is a binder?',
  questionType: 'mcq',
  marksAllocation: 2,
  difficulty: 'easy',
  probability: 'high',
  modelAnswer: 'An excipient that holds tablets together',
  correctOption: 1,
  tags: [],
  isPracticed: false,
  needsReview: false,
  isSaved: false,
  createdAt: now,
};

const sampleQuiz1: QuizHistory = {
  id: 'quiz1',
  studentId: 'stud1',
  courseId: 'c1',
  questionsUsed: ['q1'],
  answersGiven: [{ questionId: 'q1', answer: 'A', isCorrect: true }],
  scorePercentage: 100,
  weakTopics: [],
  timeTaken: 60,
  completedAt: now,
};

const samplePlan1: StudyPlan = {
  id: 'plan1',
  studentId: 'stud1',
  courseId: 'c1',
  date: now,
  timeSlot: '10:00 - 11:00',
  activityType: 'study',
  notes: 'Revision Plan',
  isCompleted: false,
};

const sampleExamDate1: ExamDate = {
  id: 'ed1',
  courseId: 'c1',
  examDate: now,
  examType: 'midsem',
  isReminderSet: true,
};

const sampleHighlight1: Highlight = {
  id: 'h1',
  topicId: 't1',
  materialId: 's1',
  slideIndex: 0,
  text: 'Important drug',
  color: '#FFB703',
  timestamp: now,
};

const sampleHighlight2: Highlight = {
  id: 'h2',
  topicId: 't3',
  materialId: 's3',
  slideIndex: 0,
  text: 'Important formulation',
  color: '#FFB703',
  timestamp: now,
};

const sampleLearningRecord1: TopicLearningRecord = {
  topicId: 't1',
  status: 'reviewed',
  confidence: 4,
  importance: 3,
  intervalIndex: 0,
  history: [],
  updatedAt: now,
};

const sampleCourseObjective: LearningObjective = {
  id: 'obj1',
  courseId: 'c1',
  topicId: undefined,
  objectiveText: 'Master general pharmacology concepts',
  status: 'not_covered',
  createdAt: now,
};

const sampleTopicObjective: LearningObjective = {
  id: 'obj2',
  courseId: 'c1',
  topicId: 't1',
  objectiveText: 'Understand alpha and beta receptors',
  status: 'mastered',
  createdAt: now,
};

const createPopulatedState = (): AppState => ({
  ...initialState,
  student: {
    id: 'stud1',
    name: 'Student 1',
    university: 'Pharmacy School',
    level: '200',
    program: 'Doctor of Pharmacy',
    semester: '2',
    createdAt: now,
  },
  courses: [sampleCourse1, sampleCourse2],
  topics: [sampleTopic1, sampleTopic2, sampleTopic3],
  slides: [sampleSlide1, sampleSlide2, sampleSlide3],
  notes: [sampleNote1, sampleNote2],
  examQuestions: [sampleQuestion1, sampleQuestion2],
  quizHistory: [sampleQuiz1],
  studyPlans: [samplePlan1],
  examDates: [sampleExamDate1],
  highlights: [sampleHighlight1, sampleHighlight2],
  learningRecords: [sampleLearningRecord1],
  learningObjectives: [sampleCourseObjective, sampleTopicObjective],
});

describe('Referential Integrity & Cascading Pruning', () => {
  beforeEach(() => {
    idbStore.clear();
  });

  it('1. cascades course deletion through topics, slides, notes, questions, quizzes, plans, dates, highlights, and learning records', () => {
    const state = createPopulatedState();
    // Simulate removing course 1 (c1)
    const { state: pruned, report } = pruneOrphans({
      ...state,
      courses: [sampleCourse2], // only c2 remains
    });

    expect(pruned.courses).toEqual([sampleCourse2]);
    // Topics belonging to c1 (t1, t2) dropped, t3 kept
    expect(pruned.topics).toEqual([sampleTopic3]);
    // Slides s1, s2 belong to t1, t2 -> dropped. s3 kept
    expect(pruned.slides).toEqual([sampleSlide3]);
    // Notes n1 belongs to t1 -> dropped. n2 kept
    expect(pruned.notes).toEqual([sampleNote2]);
    // Questions q1 belongs to c1/t1 -> dropped. q2 kept
    expect(pruned.examQuestions).toEqual([sampleQuestion2]);
    // Quiz quiz1 belongs to c1 -> dropped
    expect(pruned.quizHistory).toEqual([]);
    // Plan plan1 belongs to c1 -> dropped
    expect(pruned.studyPlans).toEqual([]);
    // Exam date ed1 belongs to c1 -> dropped
    expect(pruned.examDates).toEqual([]);
    // Highlight h1 belongs to s1 -> dropped. h2 kept
    expect(pruned.highlights).toEqual([sampleHighlight2]);
    // Learning record for t1 -> dropped
    expect(pruned.learningRecords).toEqual([]);
    // Objectives: course objective obj1 and topic objective obj2 both belong to c1 -> dropped
    expect(pruned.learningObjectives).toEqual([]);

    expect(report.topics).toBe(2);
    expect(report.slides).toBe(2);
    expect(report.notes).toBe(1);
    expect(report.questions).toBe(1);
    expect(report.quizzes).toBe(1);
    expect(report.plans).toBe(1);
    expect(report.dates).toBe(1);
    expect(report.highlights).toBe(1);
    expect(report.learningRecords).toBe(1);
    expect(report.learningObjectives).toBe(2);
    expect(report.total).toBe(13);
  });

  it('2. cascades topic deletion while correctly keeping course-wide objectives with no topicId', () => {
    const state = createPopulatedState();
    // Simulate removing topic 1 (t1) only
    const { state: pruned, report } = pruneOrphans({
      ...state,
      topics: [sampleTopic2, sampleTopic3], // t1 removed
    });

    // Courses untouched
    expect(pruned.courses).toEqual([sampleCourse1, sampleCourse2]);
    // s1 dropped because t1 was dropped; s2 and s3 kept
    expect(pruned.slides).toEqual([sampleSlide2, sampleSlide3]);
    // n1 dropped (belonged to t1)
    expect(pruned.notes).toEqual([sampleNote2]);
    // q1 dropped (belonged to t1)
    expect(pruned.examQuestions).toEqual([sampleQuestion2]);
    // h1 dropped (belonged to s1 which was dropped)
    expect(pruned.highlights).toEqual([sampleHighlight2]);
    // learning record for t1 dropped
    expect(pruned.learningRecords).toEqual([]);
    // COURSE-WIDE OBJECTIVE (obj1 has courseId: c1, topicId: undefined) IS KEPT!
    expect(pruned.learningObjectives).toContainEqual(sampleCourseObjective);
    // Topic-specific objective obj2 (topicId: t1) is dropped
    expect(pruned.learningObjectives).not.toContainEqual(sampleTopicObjective);

    expect(report.slides).toBe(1);
    expect(report.notes).toBe(1);
    expect(report.questions).toBe(1);
    expect(report.highlights).toBe(1);
    expect(report.learningRecords).toBe(1);
    expect(report.learningObjectives).toBe(1);
  });

  it('3. cascades slide deletion to drop dangling highlights', () => {
    const state = createPopulatedState();
    // Slide 1 removed
    const { state: pruned, report } = pruneOrphans({
      ...state,
      slides: [sampleSlide2, sampleSlide3],
    });

    // Highlight 1 pointed to s1 -> dropped; Highlight 2 pointed to s3 -> kept
    expect(pruned.highlights).toEqual([sampleHighlight2]);
    expect(report.highlights).toBe(1);
    expect(report.total).toBe(1);
  });

  it('4. preserves array identity for collections that require no changes', () => {
    const state = createPopulatedState();
    // Remove an unrelated slide
    const { state: pruned } = pruneOrphans({
      ...state,
      slides: [sampleSlide1, sampleSlide2], // dropped s3
    });

    // Courses and topics did not change at all -> exact reference equality
    expect(pruned.courses).toBe(state.courses);
    expect(pruned.topics).toBe(state.topics);
    expect(pruned.notes).toBe(state.notes);
    expect(pruned.examQuestions).toBe(state.examQuestions);
    expect(pruned.quizHistory).toBe(state.quizHistory);
    expect(pruned.studyPlans).toBe(state.studyPlans);
    expect(pruned.examDates).toBe(state.examDates);
  });

  it('5. cascades properly in AppContext reducer actions (DELETE_COURSE, DELETE_TOPIC, DELETE_SLIDE)', () => {
    let state = createPopulatedState();

    // 1. DELETE_TOPIC t1: should cascade to slide s1, note n1, question q1, highlight h1
    state = appReducer(state, { type: 'DELETE_TOPIC', payload: 't1' });
    expect(state.topics.find((t) => t.id === 't1')).toBeUndefined();
    expect(state.slides.find((s) => s.id === 's1')).toBeUndefined();
    expect(state.notes.find((n) => n.id === 'n1')).toBeUndefined();
    expect(state.examQuestions.find((q) => q.id === 'q1')).toBeUndefined();
    expect(state.highlights.find((h) => h.id === 'h1')).toBeUndefined();
    expect(state.learningObjectives.find((o) => o.id === 'obj1')).toBeDefined(); // course objective remains

    // 2. DELETE_SLIDE s3: should cascade to highlight h2
    state = appReducer(state, { type: 'DELETE_SLIDE', payload: 's3' });
    expect(state.slides.find((s) => s.id === 's3')).toBeUndefined();
    expect(state.highlights.find((h) => h.id === 'h2')).toBeUndefined();

    // 3. DELETE_COURSE c2: should cascade to topic t3, note n2, question q2
    state = appReducer(state, { type: 'DELETE_COURSE', payload: 'c2' });
    expect(state.courses.find((c) => c.id === 'c2')).toBeUndefined();
    expect(state.topics.find((t) => t.id === 't3')).toBeUndefined();
    expect(state.notes.find((n) => n.id === 'n2')).toBeUndefined();
    expect(state.examQuestions.find((q) => q.id === 'q2')).toBeUndefined();
  });

  it('6. buildSnapshot prunes orphans so createSemesterArchive and verifySemesterArchive succeed with matching counts', async () => {
    const rawState = createPopulatedState();
    // Intentionally inject orphaned records into state (simulate legacy un-pruned state)
    const orphanQuestion: ExamQuestion = {
      id: 'orphan-q',
      courseId: 'non-existent-course',
      topicId: 'non-existent-topic',
      questionText: 'Ghost question?',
      questionType: 'mcq',
      marksAllocation: 1,
      difficulty: 'easy',
      probability: 'low',
      modelAnswer: 'None',
      correctOption: 0,
      tags: [],
      isPracticed: false,
      needsReview: false,
      isSaved: false,
      createdAt: now,
    };
    const orphanSlide: Slide = {
      id: 'orphan-slide',
      topicId: 'ghost-topic',
      slideNumber: 99,
      title: 'Ghost Slide',
      contentText: 'Ghost',
      fileType: 'pdf',
      status: 'not_started',
      createdAt: now,
    };

    const dirtyState: AppState = {
      ...rawState,
      examQuestions: [...rawState.examQuestions, orphanQuestion],
      slides: [...rawState.slides, orphanSlide],
    };

    // buildSnapshot prunes the orphans
    const snapshot = buildSnapshot(dirtyState);
    expect(snapshot.examQuestions.find((q) => q.id === 'orphan-q')).toBeUndefined();
    expect(snapshot.slides.find((s) => s.id === 'orphan-slide')).toBeUndefined();

    // Archive creation uses snapshot-derived itemCount and counts, so verification succeeds
    const meta = await createSemesterArchive(dirtyState, {
      level: '200',
      semester: '2',
      title: 'Level 200 — Semester 2',
    });

    expect(meta.status).toBe('verified');
    const verified = await verifySemesterArchive(meta.id);
    expect(verified.status).toBe('verified');
    expect(verified.itemCount).toBe(itemCountOf(snapshot));
  });

  it('7. self-heals legacy archives on export: an archive with an injected orphan question exports and passes parseBackup', async () => {
    const baseState = createPopulatedState();
    const cleanSnapshot = buildSnapshot(baseState);

    // Create an archive that contains an orphaned question directly in its stored snapshot
    // (reproducing the exact user bug shown in the image where an existing archive had a question referencing a missing course/topic)
    const orphanQuestion: ExamQuestion = {
      id: 'legacy-orphan-q',
      courseId: 'deleted-course-id',
      topicId: 'deleted-topic-id',
      questionText: 'Where do I belong?',
      questionType: 'mcq',
      marksAllocation: 2,
      difficulty: 'medium',
      probability: 'high',
      modelAnswer: 'Lost',
      correctOption: 0,
      tags: [],
      isPracticed: false,
      needsReview: false,
      isSaved: false,
      createdAt: now,
    };

    const corruptedSnapshot: SemesterSnapshot = {
      ...cleanSnapshot,
      examQuestions: [...cleanSnapshot.examQuestions, orphanQuestion],
    };

    const archiveId = 'archive_200_2_2025_2026_legacy';
    const legacyMeta = {
      id: archiveId,
      level: '200',
      semester: '2',
      title: 'Level 200 — Semester 2',
      academicYear: '2025/2026',
      completedAt: now,
      createdAt: now,
      status: 'verified' as const,
      version: ARCHIVE_VERSION,
      itemCount: 15,
      fileCount: 0,
      totalBytes: 0,
    };

    const storedRecord: ArchiveRecord = {
      meta: legacyMeta,
      snapshot: corruptedSnapshot,
      index: null,
      manifest: [],
    };

    // Store directly in IndexedDB
    await (await import('idb-keyval')).set(`${ARCHIVE_KEY_PREFIX}${archiveId}`, storedRecord);

    // Export the archive
    const zipBlob = await exportBackup({ kind: 'archive', archiveId });
    expect(zipBlob.size).toBeGreaterThan(0);

    const blobToBuffer = (blob: Blob): Promise<ArrayBuffer> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
      });

    // Verify the resulting ZIP file passes parseBackup integrity checks!
    const buffer = await blobToBuffer(zipBlob);
    const parseResult = await parseBackup(buffer);

    expect(parseResult.ok).toBe(true);
    if (parseResult.ok && parseResult.parsed.kind === 'semester') {
      expect(parseResult.parsed.staged.manifest.title).toBe('Level 200 — Semester 2');
      // The exported snapshot must not contain the orphan question
      const exportedQuestions = parseResult.parsed.staged.snapshot.examQuestions;
      expect(exportedQuestions.find((q) => q.id === 'legacy-orphan-q')).toBeUndefined();
    }

    // Verify stored archive was NOT mutated
    const originalInDb = (await (await import('idb-keyval')).get<ArchiveRecord>(`${ARCHIVE_KEY_PREFIX}${archiveId}`))!;
    expect(originalInDb.snapshot.examQuestions.find((q) => q.id === 'legacy-orphan-q')).toBeDefined();
>>>>>>> 6fce4951938648dcb8aecfdf31349c75899937e8
=======
>>>>>>> e50e3ed8136a08a77a9d402f75c7d99518a56bfe
  });
});
