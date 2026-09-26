/**
 * Dashboard priorities and timetable preparation are local. No provider.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AppState, ExamQuestion, Slide } from '../types';
import { initialState } from '../utils/storage';
import { describeSession, formatStudyTime, studyBrief } from '../utils/studyDashboard';

const NOW = new Date(2026, 8, 24, 8, 0, 0);

function question(id: string, topicId: string): ExamQuestion {
  return {
    id, courseId: 'c1', topicId, questionText: `Q ${id}`, questionType: 'mcq',
    marksAllocation: 1, difficulty: 'medium', probability: 'medium', modelAnswer: '',
    tags: [], isPracticed: false, needsReview: false, isSaved: false, createdAt: NOW.toISOString(),
    options: ['A', 'B'], correctOption: 0,
  };
}

function slide(partial: Partial<Slide> & Pick<Slide, 'id' | 'topicId' | 'title'>): Slide {
  return {
    slideNumber: 1, contentText: '', status: 'not_started', createdAt: NOW.toISOString(), ...partial,
  };
}

function state(partial: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    courses: [{
      id: 'c1', studentId: 'u1', courseCode: 'PHA201', courseName: 'Pharmacology',
      lecturerName: '', semester: '1', creditHours: 3, createdAt: NOW.toISOString(),
    }],
    topics: [
      { id: 'auto', courseId: 'c1', topicName: 'Autonomic Pharmacology', orderIndex: 0, createdAt: NOW.toISOString() },
      { id: 'cardio', courseId: 'c1', topicName: 'Cardiovascular drugs', orderIndex: 1, createdAt: NOW.toISOString() },
      { id: 'done', courseId: 'c1', topicName: 'Finished topic', orderIndex: 2, createdAt: NOW.toISOString() },
    ],
    ...partial,
  };
}

describe('study dashboard', () => {
  it('answers what to do now from revision, weak quizzes, and tomorrow’s class', () => {
    const questions = Array.from({ length: 20 }, (_, i) => question(`q${i}`, 'cardio'));
    const current = state({
      examQuestions: questions,
      slides: [slide({ id: 's1', topicId: 'auto', title: 'Friday lecture', status: 'not_started' })],
      learningRecords: [{
        topicId: 'auto', status: 'learning', confidence: 3, importance: 4, intervalIndex: 0,
        nextReviewAt: '2026-09-20T00:00:00.000Z', history: [], updatedAt: NOW.toISOString(),
      }, {
        topicId: 'done', status: 'mastered', confidence: 4, importance: 2, intervalIndex: 4,
        history: [], updatedAt: NOW.toISOString(),
      }],
      quizHistory: [{
        id: 'z1', studentId: 'u1', courseId: 'c1', questionsUsed: ['q0'],
        answersGiven: [
          { questionId: 'q0', answer: '0', isCorrect: true },
          { questionId: 'q0', answer: '1', isCorrect: false },
          { questionId: 'q0', answer: '1', isCorrect: false },
        ],
        scorePercentage: 33, weakTopics: ['cardio'], timeTaken: 1800, completedAt: NOW.toISOString(),
      }],
      studyPlans: [{
        id: 'p1', studentId: 'u1', date: '2026-09-20', timeSlot: '09:00 - 11:00', courseId: 'c1',
        activityType: 'study', notes: 'Past block', isCompleted: true,
      }],
      examDates: [{ id: 'e1', courseId: 'c1', examDate: '2026-09-27', examType: 'midsem', isReminderSet: false }],
      timetables: {
        class: [{ id: 'class1', subject: 'Pharmacology', date: 'Friday', time: '10:00', location: 'LT1', type: 'class' }],
        quiz: [],
        exam: [],
      },
    });

    const brief = studyBrief(current, NOW);
    expect(brief.now.map((item) => item.urgency)).toEqual(['red', 'orange', 'yellow']);
    expect(brief.now[0].title).toBe('Revise Autonomic Pharmacology');
    expect(brief.now[1].title).toBe('Complete 20 Cardiovascular drugs MCQs');
    expect(brief.now[1].href).toContain('topic=cardio');
    expect(brief.now[1].href).toContain('count=20');
    expect(brief.now[2].title).toBe("Review tomorrow's lecture slides");
    expect(brief.overdue.map((item) => item.label)).toContain('Autonomic Pharmacology');
    expect(brief.weakTopics.map((item) => item.label)).toContain('Cardiovascular drugs');
    expect(brief.stats.topicsCompleted).toBe(1);
    expect(brief.stats.topicsRemaining).toBe(2);
    expect(brief.stats.revisionDue).toBe(1);
    expect(brief.stats.studyMinutes).toBe(150);
    expect(formatStudyTime(150)).toBe('2h 30m');
    expect(brief.stats.nextExamDays).toBe(3);
    expect(brief.stats.quizAccuracy).toBe(33);
    expect(brief.nextClass?.whenLabel).toBe('Friday 10:00');
    expect(brief.nextClass?.courseName).toBe('Pharmacology');
  });

  it('connects a class to topics, materials, plans, and unfinished preparation', () => {
    const current = state({
      slides: [
        slide({ id: 's1', topicId: 'auto', title: 'Autonomic slides', status: 'not_started' }),
        slide({ id: 's2', topicId: 'cardio', title: 'Heart slides', status: 'completed' }),
      ],
      studyPlans: [{
        id: 'p1', studentId: 'u1', date: '2026-09-25', timeSlot: '08:00 - 09:00', courseId: 'c1',
        activityType: 'study', notes: 'Read the handout', isCompleted: false,
      }],
      examDates: [{ id: 'e1', courseId: 'c1', examDate: '2026-10-01', examType: 'endsem', isReminderSet: true }],
      timetables: {
        class: [{ id: 'mon', subject: 'Pharmacology', date: 'Monday', time: '10:00', location: 'LT1', type: 'class' }],
        quiz: [], exam: [],
      },
    });
    const session = describeSession(current, current.timetables.class[0], 'class', NOW);
    expect(session.whenLabel).toBe('Monday 10:00');
    expect(session.match).toBe('name');
    expect(session.topics.map((topic) => topic.label)).toEqual(expect.arrayContaining(['Autonomic Pharmacology', 'Cardiovascular drugs']));
    expect(session.materials.map((item) => item.label)).toContain('Autonomic slides');
    expect(session.plans.map((item) => item.label)).toContain('Read the handout');
    expect(session.exams[0].label).toMatch(/endsem/);
    expect(session.tasks.some((task) => task.label.includes('Autonomic slides') && !task.done)).toBe(true);
    expect(session.tasks.some((task) => /before class|Preview/.test(task.label))).toBe(true);
  });

  it('uses an explicit course link and does not guess when names collide', () => {
    const current = state({
      courses: [
        { id: 'c1', studentId: 'u1', courseCode: 'PHA201', courseName: 'Pharmacology', lecturerName: '', semester: '1', creditHours: 3, createdAt: NOW.toISOString() },
        { id: 'c2', studentId: 'u1', courseCode: 'PHA301', courseName: 'Clinical Pharmacology', lecturerName: '', semester: '1', creditHours: 3, createdAt: NOW.toISOString() },
      ],
      timetables: {
        class: [
          { id: 'linked', subject: 'Misc', date: 'Monday', time: '09:00', location: '', type: 'class', courseId: 'c2' },
          { id: 'fuzzy', subject: 'Pharm', date: 'Tuesday', time: '09:00', location: '', type: 'class' },
        ],
        quiz: [], exam: [],
      },
    });
    const linked = describeSession(current, current.timetables.class[0], 'class', NOW);
    expect(linked.match).toBe('linked');
    expect(linked.courseId).toBe('c2');
    const fuzzy = describeSession(current, current.timetables.class[1], 'class', NOW);
    expect(fuzzy.match).toBe('none');
    expect(fuzzy.tasks[0].label).toMatch(/Link/);
  });

  it('stays offline', () => {
    const source = readFileSync('src/utils/studyDashboard.ts', 'utf8');
    expect(source).not.toMatch(/from ['"]\.\.\/ai/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(readFileSync('src/pages/Dashboard.tsx', 'utf8')).toContain('What should I do now?');
    expect(readFileSync('src/components/ClassPrepCard.tsx', 'utf8')).toContain('Preparation tasks');
    expect(readFileSync('src/pages/Timetable.tsx', 'utf8')).toContain('ClassPrepCard');
    expect(readFileSync('src/context/AppContext.tsx', 'utf8')).toContain('UPDATE_TIMETABLE_ITEM');
  });
});
