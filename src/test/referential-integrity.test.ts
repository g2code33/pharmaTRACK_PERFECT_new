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

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => { idbStore.set(k, v); },
  del: async (k: string) => { idbStore.delete(k); },
  delMany: async (keys: string[]) => { keys.forEach((k) => idbStore.delete(k)); },
  keys: async () => [...idbStore.keys()],
  clear: async () => { idbStore.clear(); },
}));

import { pruneOrphans, describeOrphanReport, isCleanReport } from '../utils/referentialIntegrity';
import {
  buildSnapshot,
  createSemesterArchive,
  verifySemesterArchive,
  exportBackup,
  parseBackup,
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
  tags: [],
  isPracticed: false,
  needsReview: false,
  isSaved: false,
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
  timetables: { class: [], quiz: [], exam: [] },
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
  });
});
