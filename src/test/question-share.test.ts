/**
 * Question Bank sharing: export a course/topic as a "PharmaTRACK question
 * pack" and import one another student sends you. All offline, no network.
 */
import { describe, it, expect } from 'vitest';
import type { AppState, Course, ExamQuestion, Topic } from '../types';
import { initialState } from '../utils/storage';
import {
  QUESTION_PACK_FORMAT,
  buildCourseQuestionPack,
  buildImportPlan,
  buildTopicQuestionPack,
  parseSharedQuestions,
} from '../utils/questionShare';

const NOW = '2026-04-01T09:00:00.000Z';

function course(partial: Partial<Course> & Pick<Course, 'id' | 'courseCode' | 'courseName'>): Course {
  return { studentId: 's1', lecturerName: '', semester: '1', creditHours: 3, createdAt: NOW, ...partial };
}

function topic(partial: Partial<Topic> & Pick<Topic, 'id' | 'courseId' | 'topicName'>): Topic {
  return { orderIndex: 0, createdAt: NOW, ...partial };
}

function question(partial: Partial<ExamQuestion> & Pick<ExamQuestion, 'id' | 'topicId' | 'courseId' | 'questionText'>): ExamQuestion {
  return {
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

function stateWith(courses: Course[], topics: Topic[], examQuestions: ExamQuestion[]): AppState {
  return { ...initialState, courses, topics, examQuestions };
}

describe('buildTopicQuestionPack / buildCourseQuestionPack', () => {
  const c1 = course({ id: 'c1', courseCode: 'PHM301', courseName: 'Hospital Pharmacy' });
  const t1 = topic({ id: 't1', courseId: 'c1', topicName: 'Inventory control' });
  const t2 = topic({ id: 't2', courseId: 'c1', topicName: 'Dispensing' });
  const q1 = question({ id: 'q1', courseId: 'c1', topicId: 't1', questionText: 'Q1', options: ['A', 'B'], correctOption: 1 });
  const q2 = question({ id: 'q2', courseId: 'c1', topicId: 't2', questionText: 'Q2', options: ['X', 'Y'], correctOption: 0 });
  const state = stateWith([c1], [t1, t2], [q1, q2]);

  it('exports a single topic as a one-group pack', () => {
    const pack = buildTopicQuestionPack(state, 't1');
    expect(pack).not.toBeNull();
    expect(pack!.format).toBe(QUESTION_PACK_FORMAT);
    expect(pack!.topic?.name).toBe('Inventory control');
    expect(pack!.questionCount).toBe(1);
    expect(pack!.topics).toHaveLength(1);
    expect(pack!.topics[0].questions[0].questionText).toBe('Q1');
  });

  it('exports a whole course grouped by every topic that has questions', () => {
    const pack = buildCourseQuestionPack(state, 'c1');
    expect(pack).not.toBeNull();
    expect(pack!.topic).toBeUndefined();
    expect(pack!.questionCount).toBe(2);
    expect(pack!.topics.map((g) => g.topicName).sort()).toEqual(['Dispensing', 'Inventory control']);
  });

  it('returns null when there is nothing to export', () => {
    const empty = stateWith([c1], [t1], []);
    expect(buildTopicQuestionPack(empty, 't1')).toBeNull();
    expect(buildCourseQuestionPack(empty, 'c1')).toBeNull();
  });
});

describe('parseSharedQuestions', () => {
  it('parses a PharmaTRACK pack with multiple topic groups', () => {
    const raw = JSON.stringify({
      format: QUESTION_PACK_FORMAT,
      version: 1,
      course: { code: 'PHM301', name: 'Hospital Pharmacy' },
      topics: [
        { topicName: 'Inventory control', questions: [{ questionText: 'Q1', questionType: 'mcq', difficulty: 'medium', options: ['A', 'B'], correctOption: 0 }] },
        { topicName: 'Dispensing', questions: [{ questionText: 'Q2', questionType: 'mcq', difficulty: 'hard', options: ['X', 'Y'], correctOption: 1 }] },
      ],
    });
    const groups = parseSharedQuestions(raw);
    expect(groups).toHaveLength(2);
    expect(groups[0].topicName).toBe('Inventory control');
    expect(groups[1].questions[0].questionText).toBe('Q2');
  });

  it('still parses the old flat JSON array this app has always accepted', () => {
    const raw = JSON.stringify([
      { question_text: 'What is X?', question_type: 'multiple_choice', choices: ['A', 'B', 'C'], correct_answer: 1, explanation: 'Because.' },
    ]);
    const groups = parseSharedQuestions(raw);
    expect(groups).toHaveLength(1);
    expect(groups[0].topicName).toBeUndefined();
    expect(groups[0].questions[0]).toMatchObject({ questionText: 'What is X?', questionType: 'mcq', correctOption: 1 });
  });

  it('rejects invalid JSON with a friendly message', () => {
    expect(() => parseSharedQuestions('{not json')).toThrow(/not valid JSON/);
  });

  it('rejects a recognisable-but-empty payload', () => {
    expect(() => parseSharedQuestions('[]')).toThrow(/no questions/);
  });

  it('rejects something that is neither shape', () => {
    expect(() => parseSharedQuestions('{"hello":"world"}')).toThrow(/Unrecognised file/);
  });
});

describe('buildImportPlan', () => {
  const c1 = course({ id: 'c1', courseCode: 'PHM301', courseName: 'Hospital Pharmacy' });
  const existingTopic = topic({ id: 't1', courseId: 'c1', topicName: 'Inventory control' });
  const state = stateWith([c1], [existingTopic], []);

  it('drops every question into the target topic when scope is a single topic, ignoring group names', () => {
    const plan = buildImportPlan(state, [
      { topicName: 'Some other topic', questions: [{ questionText: 'Q1', questionType: 'mcq', difficulty: 'easy', options: ['A', 'B'], correctOption: 0 }] },
    ], { courseId: 'c1', topicId: 't1' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('expected ok');
    expect(plan.newTopics).toHaveLength(0);
    expect(plan.questions).toHaveLength(1);
    expect(plan.questions[0].topicId).toBe('t1');
    expect(plan.questions[0].tags).toContain('shared');
  });

  it('matches an existing topic by name (case-insensitive) at course scope', () => {
    const plan = buildImportPlan(state, [
      { topicName: 'inventory CONTROL', questions: [{ questionText: 'Q1', questionType: 'mcq', difficulty: 'easy', options: ['A', 'B'], correctOption: 0 }] },
    ], { courseId: 'c1' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('expected ok');
    expect(plan.newTopics).toHaveLength(0);
    expect(plan.questions[0].topicId).toBe('t1');
  });

  it('creates a new topic at course scope when no existing topic matches the name', () => {
    const plan = buildImportPlan(state, [
      { topicName: 'Brand new topic', questions: [{ questionText: 'Q1', questionType: 'mcq', difficulty: 'easy', options: ['A', 'B'], correctOption: 0 }] },
    ], { courseId: 'c1' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('expected ok');
    expect(plan.newTopics).toHaveLength(1);
    expect(plan.newTopics[0].topicName).toBe('Brand new topic');
    expect(plan.questions[0].topicId).toBe(plan.newTopics[0].id);
  });

  it('fails clearly when the target course does not exist', () => {
    const plan = buildImportPlan(state, [{ questions: [{ questionText: 'Q1', questionType: 'mcq', difficulty: 'easy', options: ['A', 'B'], correctOption: 0 }] }], { courseId: 'missing' });
    expect(plan.ok).toBe(false);
  });

  it('fails clearly when nothing parses to a real question', () => {
    const plan = buildImportPlan(state, [{ questions: [] }], { courseId: 'c1' });
    expect(plan.ok).toBe(false);
  });
});
