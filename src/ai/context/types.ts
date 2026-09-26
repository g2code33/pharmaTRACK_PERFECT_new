/**
 * PharmaTRACK AI Engine — context types.
 *
 * `AppStateLike` is a *structural* view of the app state: the context builder
 * declares only the fields it actually reads. That keeps the AI layer
 * independent of the app's type graph (no import cycle, no giant bundle) and
 * makes the builder trivially testable with a handful of objects.
 */
import type { AIConversation } from '../types';

export type { AIContextBlock, AIContextBundle, AIContextKind, AIContextSource } from '../types';

export interface StateStudentLike {
  level?: string;
  semester?: string;
  program?: string;
}

export interface StateCourseLike {
  id: string;
  courseCode?: string;
  courseName: string;
}

export interface StateTopicLike {
  id: string;
  courseId: string;
  topicName: string;
}

export interface StateSlideLike {
  id: string;
  topicId: string;
  title: string;
  contentText?: string;
  slideNumber?: number;
  /** pptx | pdf | docx | image | text | unknown. Used to label retrieval hits. */
  materialKind?: string;
}

export interface StateObjectiveLike {
  id: string;
  courseId: string;
  topicId?: string;
  objectiveText: string;
  status: string;
}

export interface StateNoteLike {
  id: string;
  topicId: string;
  noteText: string;
  createdAt?: string;
}

export interface StateQuizLike {
  courseId: string;
  /** Percentage score (QuizHistory.scorePercentage). */
  scorePercentage: number;
  completedAt?: string;
  /** Topics the quiz flagged as weak — prime revision context. */
  weakTopics?: string[];
  answersGiven?: { isCorrect: boolean }[];
}

export interface StatePlanLike {
  courseId: string;
  date: string;
  timeSlot?: string;
  notes?: string;
  activityType: string;
  isCompleted?: boolean;
}

/** A question from the bank. Only the ones the user selected are ever sent. */
export interface StateQuestionLike {
  id: string;
  courseId?: string;
  topicId?: string;
  questionText: string;
  difficulty?: string;
  questionType?: string;
  correctAnswer?: string;
  modelAnswer?: string;
  explanation?: string;
}

/** The slice of AppState the context builder reads. */
export interface AppStateLike {
  student?: StateStudentLike | null;
  courses: StateCourseLike[];
  topics: StateTopicLike[];
  slides: StateSlideLike[];
  learningObjectives: StateObjectiveLike[];
  notes: StateNoteLike[];
  quizHistory: StateQuizLike[];
  studyPlans: StatePlanLike[];
  /** Question bank entries; optional so older state shapes still build. */
  examQuestions?: StateQuestionLike[];
}

/**
 * A retrieved passage. Every field that identifies *where it came from* is
 * carried through the whole pipeline so a response can be cited precisely and
 * the UI can link straight back to the page or slide.
 */
export interface RetrievalHit {
  /** Conversation/material label shown in the source line. */
  label: string;
  text: string;
  materialId?: string;
  page?: number;
  slide?: number;
  score: number;
  semester?: string;
  courseId?: string;
  courseCode?: string;
  courseName?: string;
  topicId?: string;
  topicName?: string;
  materialTitle?: string;
}

/** Everything a caller can ask the builder to include. */
export interface ContextSelection {
  topicId?: string;
  courseId?: string;
  /** The material (Slide record) the student is looking at. */
  materialId?: string;
  /** 1-based page in a PDF (or the "page" a text material was split into). */
  page?: number;
  /** 1-based slide in a PPT/PPTX. */
  slide?: number;
  /** Text the user actually selected in the reader. */
  selection?: string;
  /** Question the user is asking (used to pick retrieval hits). */
  question?: string;
  /** Include the student's own notes for this topic. */
  includeNotes?: boolean;
  /** Include learning objectives for the course/topic. */
  includeObjectives?: boolean;
  /** Include recent quiz performance for this course/topic. */
  includePerformance?: boolean;
  /** Include the study plan entries touching this course. */
  includePlan?: boolean;
  /** Bank questions the user picked. Only these are sent, never the whole bank. */
  questionIds?: string[];
  /** Include bank questions for the topic when none were picked explicitly. */
  includeQuestions?: boolean;
  /** Include this conversation's own history (default: last few turns). */
  includeHistory?: boolean;
  historyTurns?: number;
  /** Retrieval hits (from ai/retrieval.ts) to fold in. */
  retrieval?: RetrievalHit[];
  /** Hard budget for the whole bundle. */
  budgetTokens?: number;
  /** Material text itself, when the caller already has it loaded. */
  materialText?: {
    label: string;
    text: string;
    page?: number;
    slide?: number;
    /** Text of just the page/slide in focus, if known. */
    focusText?: string;
  };
  conversation?: AIConversation;
}

export interface ContextRequestHooks {
  /** Injected so the builder stays pure and testable. */
  loadMaterialText?: (slideId: string) => Promise<string | null>;
  conversation?: AIConversation;
}

