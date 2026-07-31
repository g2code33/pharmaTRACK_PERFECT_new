/**
 * Tests for global search.
 *
 * The old implementation was a flat `includes()` filter with no ranking, so a
 * course you typed the exact code of could rank below an unrelated slide that
 * happened to mention it. It also only covered 5 content types.
 */
import { describe, it, expect } from 'vitest';
import { searchAll } from '../utils/search';
import type { AppState } from '../types';

const state = {
  isLoggedIn: false,
  student: null,
  courses: [
    { id: 'c1', studentId: 'u1', courseCode: 'PHM214', courseName: 'Pharmacology', lecturerName: 'Dr Mensah', semester: '1st', creditHours: 3, createdAt: '' },
    { id: 'c2', studentId: 'u1', courseCode: 'PHM220', courseName: 'Pharmaceutics', lecturerName: 'Dr Owusu', semester: '1st', creditHours: 3, createdAt: '' },
  ],
  topics: [{ id: 't1', courseId: 'c1', topicName: 'Beta blockers', orderIndex: 0, createdAt: '' }],
  slides: [
    { id: 's1', topicId: 't1', slideNumber: 1, title: 'Slide 1', contentText: 'Propranolol is a non-selective beta blocker used in hypertension.', status: 'not_started', createdAt: '' },
    { id: 's2', topicId: 't1', slideNumber: 2, title: 'Adrenergic receptors', contentText: 'Alpha and beta receptor subtypes.', status: 'not_started', createdAt: '' },
  ],
  notes: [{ id: 'n1', topicId: 't1', noteText: 'Remember contraindications for asthma patients', isAiGenerated: false, createdAt: '' }],
  examQuestions: [{ id: 'q1', courseId: 'c1', topicId: 't1', questionText: 'Explain the mechanism of propranolol', questionType: 'essay', marksAllocation: 10, difficulty: 'medium', probability: 'high', modelAnswer: '', tags: ['cardio'], isPracticed: false, needsReview: false, isSaved: false, createdAt: '' }],
  learningObjectives: [{ id: 'lo1', courseId: 'c1', objectiveText: 'Describe adrenergic pharmacology', status: 'not_covered', createdAt: '' }],
  highlights: [{ id: 'h1', topicId: 't1', slideIndex: 0, text: 'first-pass metabolism', color: 'yellow', timestamp: '' }],
  quizHistory: [], studyPlans: [], examDates: [], activities: [], chatHistory: [],
  savedInsights: [], openAIKey: '', timetables: { class: [], quiz: [], exam: [] }, timetablePdf: null,
} as unknown as AppState;

describe('global search', () => {
  it('ignores queries that are too short', () => {
    expect(searchAll(state, 'p')).toEqual([]);
  });

  it('finds a course by its code', () => {
    const [top] = searchAll(state, 'PHM214');
    expect(top.category).toBe('Course');
    expect(top.link).toBe('/course/c1');
  });

  it('ranks a title match above a body-text match', () => {
    // "Adrenergic receptors" is a slide TITLE; the objective only mentions it
    // in body text. The title must win.
    const results = searchAll(state, 'adrenergic');
    expect(results[0].title).toBe('Adrenergic receptors');
  });

  it('searches inside slide content and returns a snippet', () => {
    const hit = searchAll(state, 'hypertension').find(r => r.category === 'Study Material');
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain('hypertension');
  });

  it('treats multiple words as AND', () => {
    // Both words appear in s1's content; the phrase itself does not.
    const hits = searchAll(state, 'propranolol hypertension');
    expect(hits.some(r => r.id === 's-s1')).toBe(true);
    // A word that appears nowhere should eliminate the result.
    expect(searchAll(state, 'propranolol zzzz').some(r => r.id === 's-s1')).toBe(false);
  });

  it('covers notes, questions, objectives and highlights', () => {
    expect(searchAll(state, 'asthma')[0].category).toBe('Note');
    expect(searchAll(state, 'mechanism')[0].category).toBe('Question');
    expect(searchAll(state, 'describe')[0].category).toBe('Objective');
    expect(searchAll(state, 'first-pass')[0].category).toBe('Highlight');
  });

  it('works as a command palette for app pages', () => {
    const hit = searchAll(state, 'analytics').find(r => r.category === 'Page');
    expect(hit?.link).toBe('/analytics');
  });

  it('builds slide links that open the right slide', () => {
    const hit = searchAll(state, 'hypertension').find(r => r.category === 'Study Material');
    // slideNumber 1 -> index 0
    expect(hit!.link).toBe('/read/t1?slide=0');
  });

  it('is case insensitive', () => {
    expect(searchAll(state, 'PHARMACOLOGY').length).toBeGreaterThan(0);
    expect(searchAll(state, 'pharmacology').length).toBeGreaterThan(0);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchAll(state, 'zzzzzzzz')).toEqual([]);
  });
});
