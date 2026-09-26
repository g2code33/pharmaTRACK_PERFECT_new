/**
 * Question bank analytics and quiz modes are local. These tests never call a provider.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AppState, ExamQuestion, QuizHistory } from '../types';
import { initialState } from '../utils/storage';
import {
  attemptHistory,
  bankAnalytics,
  buildGenerationRequest,
  createQuestion,
  flagAttemptedQuestions,
  gradeAnswer,
  questionBankSnapshot,
  questionPerformance,
  questionsForQuiz,
  quizReview,
  sourceOf,
  withGenerationSource,
} from '../utils/questionBank';

const NOW = '2026-04-01T09:00:00.000Z';

function question(partial: Partial<ExamQuestion> & Pick<ExamQuestion, 'id' | 'topicId' | 'questionText'>): ExamQuestion {
  return {
    courseId: 'c1',
    questionType: 'mcq',
    marksAllocation: 1,
    difficulty: 'medium',
    probability: 'medium',
    modelAnswer: '',
    tags: [],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: NOW,
    options: ['A', 'B', 'C', 'D'],
    correctOption: 0,
    ...partial,
  };
}

function state(partial: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    courses: [{
      id: 'c1', studentId: 'u1', courseCode: 'PHA201', courseName: 'Pharmacology',
      lecturerName: '', semester: 'Year 2', creditHours: 3, createdAt: NOW,
    }],
    topics: [
      { id: 'auto', courseId: 'c1', topicName: 'Autonomic drugs', orderIndex: 0, createdAt: NOW },
      { id: 'cardio', courseId: 'c1', topicName: 'Cardiovascular drugs', orderIndex: 1, createdAt: NOW },
      { id: 'due', courseId: 'c1', topicName: 'Due topic', orderIndex: 2, createdAt: NOW },
      { id: 'later', courseId: 'c1', topicName: 'Later topic', orderIndex: 3, createdAt: NOW },
    ],
    ...partial,
  };
}

function answers(questionId: string, flags: boolean[], at: string): QuizHistory['answersGiven'] {
  return flags.map((isCorrect) => ({ questionId, answer: isCorrect ? '0' : '1', isCorrect }));
}

describe('question bank', () => {
  it('keeps manual and imported questions complete without a generator', () => {
    const manual = createQuestion({
      id: 'm1', courseId: 'c1', topicId: 'auto', questionText: 'Name a muscarinic agonist.',
      questionType: 'short_answer', correctAnswer: 'Pilocarpine', explanation: 'Direct agonist.',
      source: { origin: 'manual', label: 'Manual' },
    });
    const imported = question({
      id: 'i1', topicId: 'auto', questionText: 'Old import', tags: ['imported'], isImported: true,
    });
    expect(sourceOf(manual).origin).toBe('manual');
    expect(sourceOf(imported)).toEqual({ origin: 'imported', label: 'Imported JSON' });
    expect(manual.explanation).toBe('Direct agonist.');
    expect(gradeAnswer(manual, 'pilocarpine')).toBe(true);
    expect(gradeAnswer(manual, '')).toBe(false);
    const legacy = question({ id: 'leg', topicId: 'auto', questionText: 'Explain.', questionType: 'short_answer', options: undefined, correctOption: undefined });
    expect(gradeAnswer(legacy, 'any notes')).toBe(true);
    expect(gradeAnswer(legacy, '  ')).toBe(false);
  });

  it('tracks attempts, accuracy, last attempt, and improvement from quiz history', () => {
    const q = question({ id: 'q1', topicId: 'auto', questionText: 'Atropine receptor?' });
    const current = state({
      examQuestions: [q],
      quizHistory: [
        { id: 'z1', studentId: 'u1', courseId: 'c1', questionsUsed: ['q1'], answersGiven: [{ questionId: 'q1', answer: '1', isCorrect: false }], scorePercentage: 0, weakTopics: ['auto'], timeTaken: 0, completedAt: '2026-03-01T09:00:00.000Z' },
        { id: 'z2', studentId: 'u1', courseId: 'c1', questionsUsed: ['q1'], answersGiven: [{ questionId: 'q1', answer: '0', isCorrect: true }], scorePercentage: 100, weakTopics: [], timeTaken: 0, completedAt: '2026-03-20T09:00:00.000Z' },
      ],
    });
    const perf = questionPerformance(current, 'q1');
    expect(perf.attempts).toBe(2);
    expect(perf.correct).toBe(1);
    expect(perf.incorrect).toBe(1);
    expect(perf.accuracy).toBe(50);
    expect(perf.lastAttempted).toBe('2026-03-20T09:00:00.000Z');
    expect(perf.improvement).toBe(100);
    expect(attemptHistory(current, 'q1').map((item) => item.isCorrect)).toEqual([false, true]);
    const flagged = flagAttemptedQuestions([q], current.quizHistory[1]);
    expect(flagged[0].needsReview).toBe(false);
    expect(flagged[0].isPracticed).toBe(true);
    expect(flagAttemptedQuestions(flagged, current.quizHistory[0])[0].needsReview).toBe(true);
  });

  it('reports the pharmacology example by course, topic, difficulty, type, and semester', () => {
    const auto = question({ id: 'auto-q', topicId: 'auto', questionText: 'Autonomic', difficulty: 'easy', questionType: 'mcq' });
    const cardio = question({ id: 'card-q', topicId: 'cardio', questionText: 'Cardio', difficulty: 'hard', questionType: 'short_answer', options: undefined, correctOption: undefined, correctAnswer: 'Digoxin' });
    const moved = question({ id: 'sem-q', topicId: 'later', questionText: 'Old semester', semester: 'Year 1', difficulty: 'medium', questionType: 'essay' });
    const autoFlags = [...Array(15).fill(true), ...Array(13).fill(false)];
    const cardioFlags = [...Array(3).fill(false), ...Array(13).fill(true)];
    const current = state({
      examQuestions: [auto, cardio, moved],
      quizHistory: [
        {
          id: 'batch', studentId: 'u1', courseId: 'c1', questionsUsed: ['auto-q', 'card-q', 'sem-q'],
          answersGiven: [
            ...answers('auto-q', autoFlags, NOW),
            ...answers('card-q', cardioFlags, NOW),
            { questionId: 'sem-q', answer: '', isCorrect: false },
          ],
          scorePercentage: 50, weakTopics: ['auto'], timeTaken: 0, completedAt: NOW,
        },
      ],
    });
    const analytics = bankAnalytics(current);
    const course = analytics.byCourse.find((row) => row.label === 'Pharmacology');
    expect(course?.topics.find((topic) => topic.label === 'Autonomic drugs')?.accuracy).toBe(54);
    expect(course?.topics.find((topic) => topic.label === 'Cardiovascular drugs')?.accuracy).toBe(81);
    expect(analytics.byTopic.find((topic) => topic.label === 'Autonomic drugs')?.accuracy).toBe(54);
    expect(analytics.byDifficulty.find((row) => row.id === 'easy')?.accuracy).toBe(54);
    expect(analytics.byDifficulty.find((row) => row.id === 'hard')?.accuracy).toBe(81);
    expect(analytics.byType.find((row) => row.id === 'mcq')?.accuracy).toBe(54);
    expect(analytics.byType.find((row) => row.id === 'short_answer')?.accuracy).toBe(81);
    expect(analytics.bySemester.find((row) => row.label === 'Year 2')?.attempts).toBe(28 + 16);
    expect(analytics.bySemester.find((row) => row.label === 'Year 1')?.attempts).toBe(1);
    expect(analytics.weakAreas.map((row) => row.label)).toContain('Autonomic drugs');
    expect(analytics.weakAreas.map((row) => row.label)).not.toContain('Cardiovascular drugs');
  });

  it('selects topic, course, weak, revision, mixed, and timed pools', () => {
    const auto = question({ id: 'auto-q', topicId: 'auto', questionText: 'Autonomic' });
    const autoSpare = question({ id: 'auto-2', topicId: 'auto', questionText: 'Spare autonomic' });
    const cardio = question({ id: 'card-q', topicId: 'cardio', questionText: 'Cardio' });
    const due = question({ id: 'due-q', topicId: 'due', questionText: 'Due' });
    const later = question({ id: 'later-q', topicId: 'later', questionText: 'Later' });
    const current = state({
      examQuestions: [auto, autoSpare, cardio, due, later],
      quizHistory: [{
        id: 'batch', studentId: 'u1', courseId: 'c1', questionsUsed: ['auto-q', 'card-q'],
        answersGiven: [
          ...answers('auto-q', [...Array(1).fill(true), ...Array(2).fill(false)], NOW),
          ...answers('card-q', [true, true, true, true], NOW),
        ],
        scorePercentage: 40, weakTopics: ['auto'], timeTaken: 0, completedAt: NOW,
      }],
      learningRecords: [
        { topicId: 'due', status: 'learning', confidence: 3, importance: 3, intervalIndex: 0, nextReviewAt: '2026-03-01T00:00:00.000Z', history: [], updatedAt: NOW },
        { topicId: 'later', status: 'learning', confidence: 3, importance: 3, intervalIndex: 0, nextReviewAt: '2026-05-01T00:00:00.000Z', history: [], updatedAt: NOW },
      ],
    });

    expect(questionsForQuiz(current, { mode: 'topic' }).map((q) => q.id)).toEqual([]);
    expect(questionsForQuiz(current, { mode: 'topic', topicId: 'auto' }).map((q) => q.id)).toEqual(['auto-q', 'auto-2']);
    expect(questionsForQuiz(current, { mode: 'course' }).map((q) => q.id)).toEqual([]);
    expect(questionsForQuiz(current, { mode: 'course', courseId: 'c1', topicId: 'auto' }).map((q) => q.id)).toEqual(['auto-q', 'auto-2', 'card-q', 'due-q', 'later-q']);
    const weak = questionsForQuiz(current, { mode: 'weak', now: NOW }).map((q) => q.id);
    expect(weak).toContain('auto-q');
    expect(weak).toContain('auto-2');
    expect(weak).not.toContain('card-q');
    expect(weak).not.toContain('due-q');
    const revision = questionsForQuiz(current, { mode: 'revision', now: NOW }).map((q) => q.id);
    expect(revision).toEqual(expect.arrayContaining(['auto-q', 'due-q']));
    expect(revision).not.toContain('later-q');
    expect(revision).not.toContain('card-q');
    expect(questionsForQuiz(current, { mode: 'mixed' })).toHaveLength(5);
    expect(questionsForQuiz(current, { mode: 'timed', courseId: 'c1', topicId: 'cardio' }).map((q) => q.id)).toEqual(['card-q']);
  });

  it('explains mistakes and recommends revision after a quiz', () => {
    const q = question({
      id: 'q1', topicId: 'auto', questionText: 'Mechanism of atropine?',
      options: ['Blocks muscarinic receptors', 'Activates nicotinic receptors'],
      correctOption: 0, explanation: 'Atropine is a competitive muscarinic antagonist.',
    });
    const history: QuizHistory = {
      id: 'z1', studentId: 'u1', courseId: 'c1', questionsUsed: ['q1'],
      answersGiven: [{ questionId: 'q1', answer: '1', isCorrect: false }],
      scorePercentage: 0, weakTopics: ['auto'], timeTaken: 12, completedAt: NOW, mode: 'topic',
    };
    const review = quizReview(state({ examQuestions: [q] }), history);
    expect(review.mistakes).toHaveLength(1);
    expect(review.mistakes[0].yourAnswer).toContain('Activates nicotinic receptors');
    expect(review.mistakes[0].correctAnswer).toBe('Blocks muscarinic receptors');
    expect(review.mistakes[0].explanation).toContain('muscarinic antagonist');
    expect(review.weakTopics[0]).toMatchObject({ id: 'auto', name: 'Autonomic drugs', courseCode: 'PHA201' });
    expect(review.recommendation).toMatch(/revision/i);
  });

  it('structures a future generator without making generated questions required', () => {
    const manual = question({ id: 'm1', topicId: 'auto', questionText: 'Typed by hand', source: { origin: 'manual', label: 'Manual' } });
    const current = state({
      examQuestions: [manual],
      slides: [{
        id: 'pdf1', topicId: 'auto', slideNumber: 1, title: 'Autonomic notes.pdf', contentText: '',
        status: 'not_started', createdAt: NOW, materialKind: 'pdf',
      }],
      learningObjectives: [{
        id: 'lo1', courseId: 'c1', topicId: 'auto', objectiveText: 'List cholinergic agonists', status: 'partial', createdAt: NOW,
      }],
    });
    const snapshot = questionBankSnapshot(current, NOW);
    expect(snapshot.offline).toBe(true);
    expect(snapshot.provider).toBeNull();
    expect(snapshot.generatedRequired).toBe(false);
    expect(snapshot.sources.manual).toBe(1);
    expect(snapshot.sources.ai).toBe(0);
    expect(snapshot.generation.kinds).toEqual(['course', 'topic', 'pdf', 'slide', 'objective']);
    expect(snapshot.questions[0].semester).toBe('Year 2');
    expect(snapshot.questions[0].performance.attempts).toBe(0);

    const pdf = buildGenerationRequest(current, { sourceKind: 'pdf', materialId: 'pdf1', page: 4 });
    expect(pdf.ok).toBe(true);
    if (pdf.ok) expect(pdf.label).toContain('page 4');
    expect(buildGenerationRequest(current, { sourceKind: 'pdf', materialId: 'missing' }).ok).toBe(false);
    expect(buildGenerationRequest(current, { sourceKind: 'slide', materialId: 'pdf1' }).ok).toBe(false);
    const objective = buildGenerationRequest(current, { sourceKind: 'objective', objectiveId: 'lo1' });
    expect(objective.ok).toBe(true);

    const generated = withGenerationSource(manual, { sourceKind: 'pdf', materialId: 'pdf1', page: 4, courseId: 'c1', topicId: 'auto' }, 'Generated from Autonomic notes');
    const mixed = questionsForQuiz({ ...current, examQuestions: [manual, generated] }, { mode: 'mixed' });
    expect(mixed.map((item) => item.id)).toEqual(['m1', 'm1']);
    expect(sourceOf(mixed[0]).origin).toBe('manual');
    expect(sourceOf(generated).origin).toBe('ai');
    expect(generated.source?.from).toBe('pdf');

    const engine = readFileSync('src/utils/questionBank.ts', 'utf8');
    expect(engine).not.toMatch(/from ['"]\.\.\/ai/);
    expect(engine).not.toMatch(/\bfetch\(/);
    const quiz = readFileSync('src/pages/Quiz.tsx', 'utf8');
    expect(quiz).toContain('Weak-topic quiz');
    expect(quiz).toContain('Revision quiz');
    expect(quiz).not.toContain('Generate some questions first');
    const bank = readFileSync('src/pages/QuestionBank.tsx', 'utf8');
    expect(bank).toContain('Import JSON Bank');
    expect(bank).toContain('Add question');
    const ctx = readFileSync('src/context/AppContext.tsx', 'utf8');
    expect(ctx.indexOf('flagAttemptedQuestions')).toBeGreaterThan(-1);
    expect(ctx.indexOf('flagAttemptedQuestions')).toBeLessThan(ctx.indexOf('applyQuiz(next'));
  });
});
