/**
 * Question Bank sharing — export a course or a topic as a "PharmaTRACK
 * Question Pack" (.json), and import one another student sends you.
 *
 * The pack always groups questions by topic name (even a single-topic
 * export is a one-entry group) so a whole-course pack can be dropped into
 * another student's course and land in the right topics automatically —
 * creating any topic that doesn't exist there yet — while a single-topic
 * pack imported at the topic level just adds straight into that topic.
 *
 * Also accepts the older flat `[{ question_text, choices, correct_answer }]`
 * array this app has always supported, so nothing that worked before stops
 * working.
 */
import { v4 as uuidv4 } from 'uuid';
import type { AppState, ExamQuestion, Topic } from '../types';
import { createQuestion } from './questionBank';

export const QUESTION_PACK_FORMAT = 'pharmatrack-question-pack';
export const QUESTION_PACK_VERSION = 1;

const ALLOWED_TYPES: ExamQuestion['questionType'][] = ['mcq', 'short_answer', 'structured', 'essay', 'case_study'];
const ALLOWED_DIFFICULTY: ExamQuestion['difficulty'][] = ['easy', 'medium', 'hard'];

export interface SharedQuestion {
  questionText: string;
  questionType: ExamQuestion['questionType'];
  difficulty: ExamQuestion['difficulty'];
  options?: string[];
  correctOption?: number;
  correctAnswer?: string;
  explanation?: string;
  semester?: string;
  tags?: string[];
}

export interface SharedTopicGroup {
  topicName: string;
  questions: SharedQuestion[];
}

export interface QuestionPack {
  format: typeof QUESTION_PACK_FORMAT;
  version: number;
  exportedAt: string;
  course: { code: string; name: string; semester?: string };
  /** Present only when exported from a single topic. */
  topic?: { name: string };
  questionCount: number;
  topics: SharedTopicGroup[];
}

const toShared = (q: ExamQuestion): SharedQuestion => ({
  questionText: q.questionText,
  questionType: q.questionType,
  difficulty: q.difficulty,
  options: q.options,
  correctOption: q.correctOption,
  correctAnswer: q.correctAnswer,
  explanation: q.explanation || q.modelAnswer || undefined,
  semester: q.semester,
  tags: q.tags?.filter((t) => t !== 'imported' && t !== 'manual' && t !== 'shared'),
});

/** Builds a whole-course pack: every topic in the course that has questions, each its own group. */
export function buildCourseQuestionPack(state: AppState, courseId: string): QuestionPack | null {
  const course = state.courses.find((c) => c.id === courseId);
  if (!course) return null;
  const topics = state.topics.filter((t) => t.courseId === courseId);
  const groups: SharedTopicGroup[] = topics
    .map((topic) => ({
      topicName: topic.topicName,
      questions: state.examQuestions.filter((q) => q.topicId === topic.id).map(toShared),
    }))
    .filter((g) => g.questions.length > 0);
  const questionCount = groups.reduce((sum, g) => sum + g.questions.length, 0);
  if (!questionCount) return null;
  return {
    format: QUESTION_PACK_FORMAT,
    version: QUESTION_PACK_VERSION,
    exportedAt: new Date().toISOString(),
    course: { code: course.courseCode, name: course.courseName, semester: course.semester },
    questionCount,
    topics: groups,
  };
}

/** Builds a single-topic pack. */
export function buildTopicQuestionPack(state: AppState, topicId: string): QuestionPack | null {
  const topic = state.topics.find((t) => t.id === topicId);
  if (!topic) return null;
  const course = state.courses.find((c) => c.id === topic.courseId);
  if (!course) return null;
  const questions = state.examQuestions.filter((q) => q.topicId === topicId).map(toShared);
  if (!questions.length) return null;
  return {
    format: QUESTION_PACK_FORMAT,
    version: QUESTION_PACK_VERSION,
    exportedAt: new Date().toISOString(),
    course: { code: course.courseCode, name: course.courseName, semester: course.semester },
    topic: { name: topic.topicName },
    questionCount: questions.length,
    topics: [{ topicName: topic.topicName, questions }],
  };
}

const safeFilePart = (s: string) => (s.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'questions');

/** Triggers a browser download of a pack as `pharmatrack_<course>[_<topic>]_<n>q.json`. */
export function downloadQuestionPack(pack: QuestionPack): void {
  const namePart = pack.topic ? `${pack.course.code}_${pack.topic.name}` : pack.course.code;
  const filename = `pharmatrack_${safeFilePart(namePart)}_${pack.questionCount}q.json`;
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ParsedImportGroup {
  /** Absent when the source had no topic info — caller must supply a target topic. */
  topicName?: string;
  questions: SharedQuestion[];
}

function normalizeQuestion(q: any): SharedQuestion {
  // PharmaTRACK's own shape (from a pack, or a hand-written file using it).
  if (q && typeof q === 'object' && typeof q.questionText === 'string' && (q.options || q.correctAnswer)) {
    return {
      questionText: q.questionText,
      questionType: ALLOWED_TYPES.includes(q.questionType) ? q.questionType : 'mcq',
      difficulty: ALLOWED_DIFFICULTY.includes(q.difficulty) ? q.difficulty : 'medium',
      options: Array.isArray(q.options) ? q.options : undefined,
      correctOption: typeof q.correctOption === 'number' ? q.correctOption : undefined,
      correctAnswer: typeof q.correctAnswer === 'string' ? q.correctAnswer : undefined,
      explanation: typeof q.explanation === 'string' ? q.explanation : undefined,
      semester: typeof q.semester === 'string' ? q.semester : undefined,
      tags: Array.isArray(q.tags) ? q.tags : undefined,
    };
  }
  // Legacy flat-array shape this app has always accepted from "Import JSON Bank".
  if (!q || !q.question_text || !q.choices || q.correct_answer === undefined) {
    throw new Error('Missing required fields in one or more questions.');
  }
  const rawType = q.question_type === 'multiple_choice' ? 'mcq' : q.question_type || 'mcq';
  return {
    questionText: q.question_text,
    questionType: ALLOWED_TYPES.includes(rawType) ? rawType : 'mcq',
    difficulty: ALLOWED_DIFFICULTY.includes(q.difficulty) ? q.difficulty : 'medium',
    options: q.choices,
    correctOption: Number(q.correct_answer),
    explanation: q.explanation || '',
    semester: typeof q.semester === 'string' && q.semester.trim() ? q.semester : undefined,
  };
}

/**
 * Accepts a PharmaTRACK question pack (object with `topics`/`questions`) or
 * the older plain JSON array. Throws with a message fit to show the user.
 */
export function parseSharedQuestions(raw: string): ParsedImportGroup[] {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('That is not valid JSON. Paste the file exactly as it was exported.');
  }

  if (Array.isArray(data)) {
    if (!data.length) throw new Error('This file has no questions in it.');
    return [{ questions: data.map(normalizeQuestion) }];
  }

  if (data && typeof data === 'object') {
    if (Array.isArray(data.topics)) {
      const groups = data.topics.map((g: any) => ({
        topicName: typeof g?.topicName === 'string' ? g.topicName : undefined,
        questions: Array.isArray(g?.questions) ? g.questions.map(normalizeQuestion) : [],
      })).filter((g: ParsedImportGroup) => g.questions.length > 0);
      if (!groups.length) throw new Error('This file has no questions in it.');
      return groups;
    }
    if (Array.isArray(data.questions)) {
      if (!data.questions.length) throw new Error('This file has no questions in it.');
      return [{ topicName: data.topic?.name, questions: data.questions.map(normalizeQuestion) }];
    }
  }

  throw new Error('Unrecognised file. Expected a PharmaTRACK question pack (.json) or a JSON array of questions.');
}

export type ImportPlan =
  | { ok: true; newTopics: Topic[]; questions: ExamQuestion[] }
  | { ok: false; reason: string };

/**
 * Turns parsed groups into concrete Topic/ExamQuestion records to dispatch.
 * `target.topicId` set => every question (topic names ignored) goes into
 * that one topic. Left unset => each group's topic name is matched to an
 * existing topic in the course (case-insensitive) or a new one is created —
 * this is what lets a whole-course pack "create" topics on the receiving end.
 */
export function buildImportPlan(
  state: AppState,
  groups: ParsedImportGroup[],
  target: { courseId: string; topicId?: string },
): ImportPlan {
  const course = state.courses.find((c) => c.id === target.courseId);
  if (!course) return { ok: false, reason: 'Course not found.' };
  if (target.topicId && !state.topics.some((t) => t.id === target.topicId)) {
    return { ok: false, reason: 'Topic not found.' };
  }

  const existingTopicsForCourse = state.topics.filter((t) => t.courseId === target.courseId);
  const newTopics: Topic[] = [];
  const questions: ExamQuestion[] = [];

  for (const group of groups) {
    if (!group.questions.length) continue;
    let topicId = target.topicId;
    if (!topicId) {
      const name = group.topicName?.trim() || 'Imported';
      const match = existingTopicsForCourse.find((t) => t.topicName.trim().toLowerCase() === name.toLowerCase())
        || newTopics.find((t) => t.topicName.trim().toLowerCase() === name.toLowerCase());
      if (match) {
        topicId = match.id;
      } else {
        const created: Topic = {
          id: uuidv4(),
          courseId: target.courseId,
          topicName: name,
          orderIndex: existingTopicsForCourse.length + newTopics.length,
          createdAt: new Date().toISOString(),
        };
        newTopics.push(created);
        topicId = created.id;
      }
    }
    for (const sq of group.questions) {
      questions.push(createQuestion({
        id: uuidv4(),
        courseId: target.courseId,
        topicId,
        semester: sq.semester || course.semester,
        questionText: sq.questionText,
        questionType: sq.questionType,
        difficulty: sq.difficulty,
        options: sq.options,
        correctOption: sq.correctOption,
        correctAnswer: sq.correctAnswer,
        explanation: sq.explanation,
        source: { origin: 'imported', label: 'Shared by another PharmaTRACK user' },
        tags: ['imported', 'shared', ...(sq.tags || [])],
        isImported: true,
      }));
    }
  }

  if (!questions.length) return { ok: false, reason: 'No valid questions found in this file.' };
  return { ok: true, newTopics, questions };
}
