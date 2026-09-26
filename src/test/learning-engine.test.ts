/**
 * Spaced revision is local. These tests never touch a provider.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AppState, QuizHistory } from '../types';
import { initialState } from '../utils/storage';
import {
  DEFAULT_INTERVALS,
  applyQuiz,
  dailyPriorities,
  daysBetween,
  learningSnapshot,
  markReviewed,
  markStudied,
  setIntervals,
  setTopicImportance,
  setTopicStatus,
  topicProgress,
} from '../utils/learningEngine';

const NOW = '2026-04-01T09:00:00.000Z';

function state(partial: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    topics: [
      { id: 't1', courseId: 'c1', topicName: 'Hypertension', orderIndex: 0, createdAt: NOW },
      { id: 't2', courseId: 'c1', topicName: 'Heart failure', orderIndex: 1, createdAt: NOW },
    ],
    courses: [{
      id: 'c1', studentId: 'u1', courseCode: 'PHA301', courseName: 'Clinical', lecturerName: '', semester: '1', creditHours: 3, createdAt: NOW,
    }],
    ...partial,
  };
}

describe('learning engine', () => {
  it('stores every status locally on the topic record', () => {
    let current = state();
    for (const status of ['learning', 'reviewed', 'mastered', 'needs_revision', 'not_started'] as const) {
      current = { ...current, learningRecords: setTopicStatus(current, 't1', status, NOW) };
      expect(topicProgress(current, 't1', NOW)?.status).toBe(status);
    }
    expect(current.learningRecords?.[0].topicId).toBe('t1');
  });

  it('walks the default intervals 1, 3, 7, 14, 30', () => {
    let current = state();
    current = { ...current, learningRecords: markStudied(current, 't1', NOW) };
    expect(topicProgress(current, 't1', NOW)?.nextReviewAt?.slice(0, 10)).toBe('2026-04-02');

    // Study uses the first gap. Each successful review steps to the next.
    const gaps = [3, 7, 14, 30, 30];
    let at = '2026-04-02T09:00:00.000Z';
    for (const gap of gaps) {
      current = { ...current, learningRecords: markReviewed(current, 't1', at) };
      const next = topicProgress(current, 't1', at)?.nextReviewAt;
      expect(next).toBeTruthy();
      expect(daysBetween(at, next!)).toBe(gap);
      at = next!;
    }
    expect(DEFAULT_INTERVALS).toEqual([1, 3, 7, 14, 30]);
  });

  it('uses a custom interval list', () => {
    const current = state({ learningSettings: setIntervals([2, 9]) });
    const records = markStudied(current, 't1', NOW);
    expect(topicProgress({ ...current, learningRecords: records }, 't1', NOW)?.nextReviewAt?.slice(0, 10)).toBe('2026-04-03');
  });

  it('sends a poor quiz to needs revision and lists it today', () => {
    const quiz: QuizHistory = {
      id: 'qz1',
      studentId: 'u1',
      courseId: 'c1',
      questionsUsed: ['q1'],
      answersGiven: [{ questionId: 'q1', answer: 'b', isCorrect: false }],
      scorePercentage: 0,
      weakTopics: ['t1'],
      timeTaken: 10,
      completedAt: NOW,
    };
    const current = state({
      examQuestions: [{
        id: 'q1', courseId: 'c1', topicId: 't1', questionText: 'First-line drug?', questionType: 'mcq',
        marksAllocation: 1, difficulty: 'easy', probability: 'high', modelAnswer: 'a', tags: [],
        isPracticed: false, needsReview: false, isSaved: false, createdAt: NOW, options: ['a', 'b'], correctOption: 0,
      }],
    });
    const records = applyQuiz(current, quiz);
    const view = topicProgress({ ...current, learningRecords: records, quizHistory: [quiz] }, 't1', NOW);
    expect(view?.status).toBe('needs_revision');
    expect(view?.missed).toBe(1);
    expect(view?.accuracy).toBe(0);
    expect(view?.attempted).toBe(1);
    const due = dailyPriorities({ ...current, learningRecords: records, quizHistory: [quiz] }, NOW);
    expect(due.some((item) => item.topicId === 't1' && item.reason === 'overdue')).toBe(true);
    expect(due.some((item) => item.topicId === 't1' && item.reason === 'weak')).toBe(true);
  });

  it('advances a strong quiz and keeps the history', () => {
    const quiz: QuizHistory = {
      id: 'qz2',
      studentId: 'u1',
      courseId: 'c1',
      questionsUsed: ['q1', 'q2'],
      answersGiven: [
        { questionId: 'q1', answer: 'a', isCorrect: true },
        { questionId: 'q2', answer: 'a', isCorrect: true },
      ],
      scorePercentage: 100,
      weakTopics: [],
      timeTaken: 20,
      completedAt: NOW,
    };
    const questions = [1, 2].map((n) => ({
      id: `q${n}`, courseId: 'c1', topicId: 't1', questionText: `Q${n}`, questionType: 'mcq' as const,
      marksAllocation: 1, difficulty: 'easy' as const, probability: 'high' as const, modelAnswer: 'a', tags: [],
      isPracticed: false, needsReview: false, isSaved: false, createdAt: NOW,
    }));
    const current = state({ examQuestions: questions });
    const records = applyQuiz(current, quiz);
    const view = topicProgress({ ...current, learningRecords: records, quizHistory: [quiz] }, 't1', NOW);
    expect(view?.status).toBe('reviewed');
    expect(view?.accuracy).toBe(100);
    expect(view?.history[0].kind).toBe('quiz');
    expect(view?.nextReviewAt?.slice(0, 10)).toBe('2026-04-02');
  });

  it('ranks a more important overdue topic first', () => {
    let current = state();
    current = { ...current, learningRecords: markStudied(current, 't1', '2026-03-01T00:00:00.000Z') };
    current = { ...current, learningRecords: markStudied(current, 't2', '2026-03-01T00:00:00.000Z') };
    current = { ...current, learningRecords: setTopicImportance(current, 't2', 5, NOW) };
    current = { ...current, learningRecords: setTopicImportance(current, 't1', 1, NOW) };
    const overdue = dailyPriorities(current, NOW).filter((item) => item.reason === 'overdue');
    expect(overdue[0].topicId).toBe('t2');
  });

  it('lists an upcoming exam, an unfinished plan, and a topic that still needs reinforcement', () => {
    let current = state({
      examDates: [{ id: 'e1', courseId: 'c1', examDate: '2026-04-10', examType: 'midsem', isReminderSet: false }],
      studyPlans: [{
        id: 'p1', studentId: 'u1', date: '2026-04-01', timeSlot: '18:00', courseId: 'c1',
        activityType: 'revision', notes: 'Finish ACE inhibitor notes', isCompleted: false,
      }],
    });
    current = { ...current, learningRecords: markStudied(current, 't2', NOW) };
    const items = dailyPriorities(current, NOW);
    expect(items.some((item) => item.reason === 'upcoming_exam' && item.topicId === 't1')).toBe(true);
    expect(items.some((item) => item.reason === 'unfinished_plan' && item.title.includes('ACE inhibitor'))).toBe(true);
    expect(items.some((item) => item.reason === 'reinforce' && item.topicId === 't2')).toBe(true);
  });

  it('does not restudy the same topic twice in one day', () => {
    const current = state();
    const once = markStudied(current, 't1', NOW);
    const twice = markStudied({ ...current, learningRecords: once }, 't1', '2026-04-01T18:00:00.000Z');
    expect(twice).toBe(once);
  });

  it('exposes a structured snapshot and does not call an AI provider', () => {
    const current = state();
    const snap = learningSnapshot({ ...current, learningRecords: setTopicStatus(current, 't1', 'learning', NOW) }, NOW);
    expect(snap.intervals).toEqual([1, 3, 7, 14, 30]);
    expect(snap.topics.find((t) => t.topicId === 't1')).toMatchObject({
      status: 'learning',
      quizAccuracy: null,
      questionsAttempted: 0,
      missedQuestions: 0,
    });
    const source = readFileSync('src/utils/learningEngine.ts', 'utf8');
    expect(source).not.toMatch(/from ['"][^'"]*ai/);
    expect(source).toContain('learningSnapshot');
  });
});
