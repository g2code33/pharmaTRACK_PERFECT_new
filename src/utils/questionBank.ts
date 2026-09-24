/**
 * Local question bank.
 *
 * Performance, attempt history, and quiz pools are computed from questions and
 * quiz history already on the device. Nothing here calls an AI provider.
 *
 * Attempt history lives in quiz history, not a second copy on the question, so
 * older quizzes still count and the two stores cannot drift.
 *
 * A future generator should read `questionBankSnapshot()` and
 * `buildGenerationRequest()`. Manual and imported questions are complete
 * without that generator.
 */
import type {
  AppState,
  ExamQuestion,
  GenerationKind,
  QuestionOrigin,
  QuestionSourceRef,
  QuizHistory,
  QuizMode,
} from '../types';
import { daysBetween, recordFor } from './learningEngine';
import { inferMaterialKind } from './materialKind';

export const WEAK_ACCURACY = 70;

export const QUIZ_MODES: { id: QuizMode; label: string; hint: string }[] = [
  { id: 'topic', label: 'Topic quiz', hint: 'Questions from one topic.' },
  { id: 'course', label: 'Course quiz', hint: 'Every topic in one course.' },
  { id: 'weak', label: 'Weak-topic quiz', hint: 'Topics under 70%, missed questions, and anything marked for review.' },
  { id: 'revision', label: 'Revision quiz', hint: 'Missed questions and topics that are due for revision.' },
  { id: 'mixed', label: 'Mixed quiz', hint: 'A mix from the whole bank. Course is optional.' },
  { id: 'timed', label: 'Timed quiz', hint: 'A mixed pool with the clock running.' },
];

export const TYPE_LABEL: Record<ExamQuestion['questionType'], string> = {
  mcq: 'MCQ',
  short_answer: 'Short answer',
  structured: 'Structured',
  essay: 'Essay',
  case_study: 'Case study',
};

export const DIFFICULTY_LABEL: Record<ExamQuestion['difficulty'], string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

const TYPE_ORDER: ExamQuestion['questionType'][] = ['mcq', 'short_answer', 'structured', 'essay', 'case_study'];
const DIFFICULTY_ORDER: ExamQuestion['difficulty'][] = ['easy', 'medium', 'hard'];

export function isQuizMode(value: string): value is QuizMode {
  return QUIZ_MODES.some((mode) => mode.id === value);
}

export function sourceOf(question: ExamQuestion): QuestionSourceRef {
  if (question.source?.origin) return question.source;
  if (question.isImported || question.tags?.includes('imported')) {
    return { origin: 'imported', label: 'Imported JSON' };
  }
  return { origin: 'manual', label: 'Manual' };
}

export function sourceLabel(question: ExamQuestion): string {
  const source = sourceOf(question);
  if (source.label) return source.label;
  if (source.origin === 'ai' && source.from) return `Generated from ${source.from}`;
  if (source.origin === 'imported') return 'Imported';
  if (source.origin === 'pdf') return 'PDF';
  if (source.origin === 'slide') return 'Slide';
  if (source.origin === 'objective') return 'Learning objective';
  return 'Manual';
}

export function correctAnswerText(question: ExamQuestion): string {
  if (question.correctAnswer?.trim()) return question.correctAnswer.trim();
  if (question.questionType === 'mcq' && question.options && question.correctOption !== undefined) {
    return question.options[question.correctOption] || '';
  }
  return '';
}

export function explanationText(question: ExamQuestion): string {
  return (question.explanation || question.modelAnswer || '').trim();
}

export function semesterOf(state: Pick<AppState, 'courses'>, question: ExamQuestion): string {
  if (question.semester?.trim()) return question.semester.trim();
  const course = state.courses.find((item) => item.id === question.courseId);
  return course?.semester?.trim() || 'Unspecified';
}

export function gradeAnswer(question: ExamQuestion, raw: string): boolean {
  const answer = (raw || '').trim();
  if (question.questionType === 'mcq' && question.options?.length) {
    const index = parseInt(answer, 10);
    if (question.correctOption !== undefined && !Number.isNaN(index)) return index === question.correctOption;
    const expected = correctAnswerText(question).toLowerCase();
    if (!expected) return false;
    if (answer.toLowerCase() === expected) return true;
    const matched = question.options.findIndex((option) => option.trim().toLowerCase() === answer.toLowerCase());
    return question.correctOption !== undefined && matched === question.correctOption;
  }
  const expected = (question.correctAnswer || '').trim();
  if (expected) return answer.toLowerCase() === expected.toLowerCase();
  // Older short answers had no stored key. A non-empty response still counts.
  return answer.length > 0;
}

export function displayAnswer(question: ExamQuestion | undefined, raw: string): string {
  const answer = raw ?? '';
  if (!question) return answer.trim() || 'No answer';
  if (question.questionType === 'mcq' && question.options?.length) {
    const index = parseInt(answer, 10);
    if (!Number.isNaN(index) && question.options[index]) {
      return `${String.fromCharCode(65 + index)}. ${question.options[index]}`;
    }
  }
  return answer.trim() || 'No answer';
}

export interface QuestionAttempt {
  quizId: string;
  at: string;
  answer: string;
  isCorrect: boolean;
}

export interface QuestionPerformance {
  questionId: string;
  attempts: number;
  correct: number;
  incorrect: number;
  accuracy: number | null;
  lastAttempted?: string;
  improvement: number | null;
  weak: boolean;
  history: QuestionAttempt[];
}

export interface PerformanceBucket {
  id: string;
  label: string;
  attempts: number;
  correct: number;
  incorrect: number;
  accuracy: number | null;
  improvement: number | null;
  questionCount: number;
}

export interface CoursePerformance extends PerformanceBucket {
  topics: PerformanceBucket[];
}

export interface QuestionBankAnalytics {
  byCourse: CoursePerformance[];
  byTopic: PerformanceBucket[];
  byDifficulty: PerformanceBucket[];
  byType: PerformanceBucket[];
  bySemester: PerformanceBucket[];
  weakAreas: PerformanceBucket[];
  totals: {
    attempts: number;
    correct: number;
    incorrect: number;
    accuracy: number | null;
    questions: number;
    unattempted: number;
  };
}

export interface QuizSelection {
  mode: QuizMode;
  courseId?: string;
  topicId?: string;
  questionTypes?: string[];
  difficulty?: string;
  semester?: string;
  now?: string;
}

export interface QuizReviewItem {
  questionId: string;
  questionText: string;
  correct: boolean;
  yourAnswer: string;
  correctAnswer: string;
  explanation: string;
  topicId?: string;
  topicName?: string;
  missing: boolean;
}

export interface QuizReview {
  mistakes: QuizReviewItem[];
  items: QuizReviewItem[];
  weakTopics: { id: string; name: string; courseCode: string }[];
  recommendation: string;
}

export interface QuestionGenerationRequest {
  sourceKind: GenerationKind;
  courseId?: string;
  topicId?: string;
  materialId?: string;
  page?: number;
  objectiveId?: string;
  count?: number;
  difficulty?: ExamQuestion['difficulty'];
  questionType?: ExamQuestion['questionType'];
}

export interface QuestionGenerationTarget {
  kind: GenerationKind;
  label: string;
  courseId?: string;
  topicId?: string;
  materialId?: string;
  page?: number;
  objectiveId?: string;
}

interface Hit {
  questionId: string;
  at: string;
  correct: boolean;
  answer: string;
  quizId: string;
}

function percent(correct: number, attempts: number): number | null {
  if (attempts <= 0) return null;
  return Math.round((correct / attempts) * 100);
}

export function improvementFrom(flags: boolean[]): number | null {
  if (flags.length < 2) return null;
  const mid = Math.floor(flags.length / 2);
  const rate = (slice: boolean[]) => Math.round((slice.filter(Boolean).length / slice.length) * 100);
  return rate(flags.slice(mid)) - rate(flags.slice(0, mid));
}

function hitsOf(state: Pick<AppState, 'quizHistory'>): Hit[] {
  const hits: Hit[] = [];
  for (const quiz of state.quizHistory ?? []) {
    for (const answer of quiz.answersGiven ?? []) {
      hits.push({
        questionId: answer.questionId,
        at: quiz.completedAt,
        correct: answer.isCorrect,
        answer: answer.answer,
        quizId: quiz.id,
      });
    }
  }
  hits.sort((a, b) => a.at.localeCompare(b.at) || a.quizId.localeCompare(b.quizId));
  return hits;
}

function performanceFrom(question: ExamQuestion, hits: Hit[]): QuestionPerformance {
  const history = hits.map((hit) => ({
    quizId: hit.quizId,
    at: hit.at,
    answer: hit.answer,
    isCorrect: hit.correct,
  }));
  const correct = history.filter((item) => item.isCorrect).length;
  const accuracy = percent(correct, history.length);
  const last = history[history.length - 1];
  const weak = question.needsReview
    || (last ? !last.isCorrect : false)
    || (accuracy !== null && accuracy < WEAK_ACCURACY);
  return {
    questionId: question.id,
    attempts: history.length,
    correct,
    incorrect: history.length - correct,
    accuracy,
    lastAttempted: last?.at,
    improvement: improvementFrom(history.map((item) => item.isCorrect)),
    weak,
    history,
  };
}

export function allQuestionPerformance(state: Pick<AppState, 'examQuestions' | 'quizHistory'>): Map<string, QuestionPerformance> {
  const grouped = new Map<string, Hit[]>();
  for (const hit of hitsOf(state)) {
    const list = grouped.get(hit.questionId) ?? [];
    list.push(hit);
    grouped.set(hit.questionId, list);
  }
  const map = new Map<string, QuestionPerformance>();
  for (const question of state.examQuestions) {
    map.set(question.id, performanceFrom(question, grouped.get(question.id) ?? []));
  }
  return map;
}

export function questionPerformance(state: Pick<AppState, 'examQuestions' | 'quizHistory'>, questionId: string): QuestionPerformance {
  const question = state.examQuestions.find((item) => item.id === questionId);
  const hits = hitsOf(state).filter((hit) => hit.questionId === questionId);
  if (!question) {
    return {
      questionId,
      attempts: hits.length,
      correct: hits.filter((hit) => hit.correct).length,
      incorrect: hits.filter((hit) => !hit.correct).length,
      accuracy: percent(hits.filter((hit) => hit.correct).length, hits.length),
      lastAttempted: hits[hits.length - 1]?.at,
      improvement: improvementFrom(hits.map((hit) => hit.correct)),
      weak: hits.some((hit) => !hit.correct),
      history: hits.map((hit) => ({ quizId: hit.quizId, at: hit.at, answer: hit.answer, isCorrect: hit.correct })),
    };
  }
  return performanceFrom(question, hits);
}

export function attemptHistory(state: Pick<AppState, 'examQuestions' | 'quizHistory'>, questionId: string): QuestionAttempt[] {
  return questionPerformance(state, questionId).history;
}

interface BucketDraft {
  id: string;
  label: string;
  flags: boolean[];
  questions: Set<string>;
}

function draft(id: string, label: string): BucketDraft {
  return { id, label, flags: [], questions: new Set() };
}

function finishBucket(row: BucketDraft): PerformanceBucket {
  const correct = row.flags.filter(Boolean).length;
  return {
    id: row.id,
    label: row.label,
    attempts: row.flags.length,
    correct,
    incorrect: row.flags.length - correct,
    accuracy: percent(correct, row.flags.length),
    improvement: improvementFrom(row.flags),
    questionCount: row.questions.size,
  };
}

export function bankAnalytics(state: AppState): QuestionBankAnalytics {
  const hits = hitsOf(state);
  const byId = new Map(state.examQuestions.map((question) => [question.id, question]));
  const courses = new Map<string, BucketDraft & { topics: Map<string, BucketDraft> }>();
  const topics = new Map<string, BucketDraft>();
  const difficulties = new Map<string, BucketDraft>();
  const types = new Map<string, BucketDraft>();
  const semesters = new Map<string, BucketDraft>();

  const ensure = (map: Map<string, BucketDraft>, id: string, label: string) => {
    const row = map.get(id) ?? draft(id, label);
    map.set(id, row);
    return row;
  };

  for (const hit of hits) {
    const question = byId.get(hit.questionId);
    if (!question) continue;
    const course = state.courses.find((item) => item.id === question.courseId);
    const topic = state.topics.find((item) => item.id === question.topicId);
    const courseId = question.courseId || 'unknown';
    const courseRow = courses.get(courseId) ?? { ...draft(courseId, course?.courseName || 'Unknown course'), topics: new Map() };
    courses.set(courseId, courseRow);
    courseRow.flags.push(hit.correct);
    courseRow.questions.add(question.id);

    const topicId = question.topicId || 'unknown';
    const topicRow = courseRow.topics.get(topicId) ?? draft(topicId, topic?.topicName || 'Unknown topic');
    courseRow.topics.set(topicId, topicRow);
    topicRow.flags.push(hit.correct);
    topicRow.questions.add(question.id);

    const flatTopic = ensure(topics, topicId, topic?.topicName || 'Unknown topic');
    flatTopic.flags.push(hit.correct);
    flatTopic.questions.add(question.id);

    const difficulty = ensure(difficulties, question.difficulty, DIFFICULTY_LABEL[question.difficulty] || question.difficulty);
    difficulty.flags.push(hit.correct);
    difficulty.questions.add(question.id);

    const type = ensure(types, question.questionType, TYPE_LABEL[question.questionType] || question.questionType);
    type.flags.push(hit.correct);
    type.questions.add(question.id);

    const semester = semesterOf(state, question);
    const semesterRow = ensure(semesters, semester, semester);
    semesterRow.flags.push(hit.correct);
    semesterRow.questions.add(question.id);
  }

  const byTopic = [...topics.values()].map(finishBucket).filter((row) => row.attempts > 0)
    .sort((a, b) => (a.accuracy ?? 0) - (b.accuracy ?? 0) || a.label.localeCompare(b.label));
  const byCourse = [...courses.values()].map((row) => ({
    ...finishBucket(row),
    topics: [...row.topics.values()].map(finishBucket).filter((topic) => topic.attempts > 0)
      .sort((a, b) => (a.accuracy ?? 0) - (b.accuracy ?? 0) || a.label.localeCompare(b.label)),
  })).filter((row) => row.attempts > 0)
    .sort((a, b) => a.label.localeCompare(b.label));

  const order = (rows: PerformanceBucket[], keys: string[]) => rows.sort((a, b) => keys.indexOf(a.id) - keys.indexOf(b.id));

  const attemptedIds = new Set(hits.map((hit) => hit.questionId));
  const correct = hits.filter((hit) => byId.has(hit.questionId) && hit.correct).length;
  const knownHits = hits.filter((hit) => byId.has(hit.questionId));

  return {
    byCourse,
    byTopic,
    byDifficulty: order([...difficulties.values()].map(finishBucket), DIFFICULTY_ORDER),
    byType: order([...types.values()].map(finishBucket), TYPE_ORDER),
    bySemester: [...semesters.values()].map(finishBucket).sort((a, b) => a.label.localeCompare(b.label)),
    weakAreas: byTopic.filter((row) => row.accuracy !== null && row.accuracy < WEAK_ACCURACY),
    totals: {
      attempts: knownHits.length,
      correct,
      incorrect: knownHits.length - correct,
      accuracy: percent(correct, knownHits.length),
      questions: state.examQuestions.length,
      unattempted: state.examQuestions.filter((question) => !attemptedIds.has(question.id)).length,
    },
  };
}

function lastAttemptMap(state: Pick<AppState, 'quizHistory'>): Map<string, boolean> {
  const map = new Map<string, { at: string; correct: boolean }>();
  for (const quiz of state.quizHistory ?? []) {
    for (const answer of quiz.answersGiven ?? []) {
      const prev = map.get(answer.questionId);
      if (!prev || quiz.completedAt >= prev.at) map.set(answer.questionId, { at: quiz.completedAt, correct: answer.isCorrect });
    }
  }
  return new Map([...map.entries()].map(([id, row]) => [id, row.correct]));
}

function topicAccuracyMap(state: AppState): Map<string, number | null> {
  const totals = new Map<string, { correct: number; attempts: number }>();
  for (const quiz of state.quizHistory ?? []) {
    for (const answer of quiz.answersGiven ?? []) {
      const question = state.examQuestions.find((item) => item.id === answer.questionId);
      if (!question?.topicId) continue;
      const row = totals.get(question.topicId) ?? { correct: 0, attempts: 0 };
      row.attempts += 1;
      if (answer.isCorrect) row.correct += 1;
      totals.set(question.topicId, row);
    }
  }
  return new Map([...totals.entries()].map(([id, row]) => [id, percent(row.correct, row.attempts)]));
}

function topicNeedsRevision(state: AppState, topicId: string, now: string): boolean {
  const record = recordFor(state, topicId);
  if (!record || record.status === 'not_started') return false;
  if (record.status === 'needs_revision') return true;
  return Boolean(record.nextReviewAt) && daysBetween(record.nextReviewAt!, now) >= 0;
}

export function isWeakQuestion(state: AppState, question: ExamQuestion, now = new Date().toISOString()): boolean {
  if (question.needsReview) return true;
  const last = lastAttemptMap(state).get(question.id);
  if (last === false) return true;
  if (question.topicId && topicNeedsRevision(state, question.topicId, now) && recordFor(state, question.topicId)?.status === 'needs_revision') {
    return true;
  }
  const accuracy = question.topicId ? topicAccuracyMap(state).get(question.topicId) : undefined;
  return accuracy !== undefined && accuracy !== null && accuracy < WEAK_ACCURACY;
}

export function isRevisionQuestion(state: AppState, question: ExamQuestion, now = new Date().toISOString()): boolean {
  if (question.needsReview) return true;
  if (lastAttemptMap(state).get(question.id) === false) return true;
  return Boolean(question.topicId) && topicNeedsRevision(state, question.topicId, now);
}

export function questionsForQuiz(state: AppState, selection: QuizSelection): ExamQuestion[] {
  if (selection.mode === 'topic' && !selection.topicId) return [];
  if (selection.mode === 'course' && !selection.courseId) return [];
  const now = selection.now || new Date().toISOString();
  let list = state.examQuestions.slice();
  if (selection.courseId) list = list.filter((question) => question.courseId === selection.courseId);
  if (selection.topicId && selection.mode !== 'course') {
    list = list.filter((question) => question.topicId === selection.topicId);
  }
  if (selection.mode === 'weak') list = list.filter((question) => isWeakQuestion(state, question, now));
  if (selection.mode === 'revision') list = list.filter((question) => isRevisionQuestion(state, question, now));
  if (selection.questionTypes && selection.questionTypes.length > 0) {
    list = list.filter((question) => selection.questionTypes!.includes(question.questionType));
  }
  if (selection.difficulty && selection.difficulty !== 'mixed') {
    list = list.filter((question) => question.difficulty === selection.difficulty);
  }
  if (selection.semester) list = list.filter((question) => semesterOf(state, question) === selection.semester);
  return list;
}

export function quizReview(
  state: AppState,
  history: QuizHistory,
  questions: ExamQuestion[] = state.examQuestions,
): QuizReview {
  const pool = new Map<string, ExamQuestion>();
  for (const question of [...state.examQuestions, ...questions]) pool.set(question.id, question);
  const items: QuizReviewItem[] = (history.answersGiven ?? []).map((answer) => {
    const question = pool.get(answer.questionId);
    const topic = question ? state.topics.find((item) => item.id === question.topicId) : undefined;
    return {
      questionId: answer.questionId,
      questionText: question?.questionText || 'This question is no longer in the bank',
      correct: answer.isCorrect,
      yourAnswer: displayAnswer(question, answer.answer),
      correctAnswer: question ? correctAnswerText(question) : '',
      explanation: question ? explanationText(question) : '',
      topicId: question?.topicId,
      topicName: topic?.topicName,
      missing: !question,
    };
  });
  const mistakes = items.filter((item) => !item.correct);
  const topicIds = new Set<string>([
    ...(history.weakTopics ?? []).filter(Boolean),
    ...mistakes.map((item) => item.topicId).filter((id): id is string => Boolean(id)),
  ]);
  const weakTopics = [...topicIds].map((id) => {
    const topic = state.topics.find((item) => item.id === id);
    if (!topic) return null;
    const course = state.courses.find((item) => item.id === topic.courseId);
    return { id, name: topic.topicName, courseCode: course?.courseCode || '' };
  }).filter((item): item is { id: string; name: string; courseCode: string } => Boolean(item));

  const recommendation = mistakes.length === 0
    ? 'No mistakes. Keep the next review on your usual interval.'
    : 'Revise the weak topics, then take a revision quiz. Study Today will schedule the ones that are due.';

  return { mistakes, items, weakTopics, recommendation };
}

export function flagAttemptedQuestions(questions: ExamQuestion[], history: QuizHistory): ExamQuestion[] {
  const latest = new Map<string, boolean>();
  for (const answer of history.answersGiven ?? []) latest.set(answer.questionId, answer.isCorrect);
  if (latest.size === 0) return questions;
  return questions.map((question) => {
    const correct = latest.get(question.id);
    if (correct === undefined) return question;
    return { ...question, isPracticed: true, needsReview: !correct };
  });
}

export function createQuestion(input: {
  id: string;
  courseId: string;
  topicId: string;
  semester?: string;
  questionText: string;
  questionType: ExamQuestion['questionType'];
  difficulty?: ExamQuestion['difficulty'];
  options?: string[];
  correctOption?: number;
  correctAnswer?: string;
  explanation?: string;
  source?: QuestionSourceRef;
  tags?: string[];
  isImported?: boolean;
  createdAt?: string;
}): ExamQuestion {
  const options = input.options?.map((option) => option.trim());
  const correctAnswer = input.correctAnswer?.trim()
    || (input.questionType === 'mcq' && options && input.correctOption !== undefined ? options[input.correctOption] || '' : '');
  return {
    id: input.id,
    courseId: input.courseId,
    topicId: input.topicId,
    semester: input.semester?.trim() || undefined,
    questionText: input.questionText.trim(),
    questionType: input.questionType,
    marksAllocation: 1,
    difficulty: input.difficulty || 'medium',
    probability: 'medium',
    modelAnswer: input.explanation?.trim() || '',
    explanation: input.explanation?.trim() || '',
    correctAnswer: correctAnswer || undefined,
    source: input.source,
    tags: input.tags ?? (input.isImported ? ['imported'] : ['manual']),
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: input.createdAt || new Date().toISOString(),
    isImported: input.isImported,
    options: input.questionType === 'mcq' ? options : undefined,
    correctOption: input.questionType === 'mcq' ? input.correctOption : undefined,
  };
}

export function buildGenerationRequest(
  state: AppState,
  input: QuestionGenerationRequest,
): { ok: true; request: QuestionGenerationRequest; label: string } | { ok: false; reason: string } {
  const request: QuestionGenerationRequest = { ...input };
  if (input.sourceKind === 'course') {
    const course = state.courses.find((item) => item.id === input.courseId);
    if (!course) return { ok: false, reason: 'Choose a course.' };
    return { ok: true, request, label: course.courseName };
  }
  if (input.sourceKind === 'topic') {
    const topic = state.topics.find((item) => item.id === input.topicId);
    if (!topic) return { ok: false, reason: 'Choose a topic.' };
    request.courseId = request.courseId || topic.courseId;
    return { ok: true, request, label: topic.topicName };
  }
  if (input.sourceKind === 'pdf' || input.sourceKind === 'slide') {
    const material = state.slides.find((item) => item.id === input.materialId);
    if (!material) return { ok: false, reason: 'Choose a file.' };
    const kind = inferMaterialKind(material);
    if (input.sourceKind === 'pdf' && kind !== 'pdf') return { ok: false, reason: 'That file is not a PDF.' };
    if (input.sourceKind === 'slide' && kind !== 'ppt' && kind !== 'pptx') return { ok: false, reason: 'That file is not a presentation.' };
    const topic = state.topics.find((item) => item.id === material.topicId);
    request.topicId = request.topicId || material.topicId;
    request.courseId = request.courseId || topic?.courseId;
    if (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1)) {
      return { ok: false, reason: 'Page or slide number must be 1 or more.' };
    }
    const place = input.page ? ` · ${input.sourceKind === 'pdf' ? 'page' : 'slide'} ${input.page}` : '';
    return { ok: true, request, label: `${material.title || material.originalName || 'Material'}${place}` };
  }
  const objective = state.learningObjectives.find((item) => item.id === input.objectiveId);
  if (!objective) return { ok: false, reason: 'Choose a learning objective.' };
  request.courseId = request.courseId || objective.courseId;
  request.topicId = request.topicId || objective.topicId;
  return { ok: true, request, label: objective.objectiveText };
}

/** Stamp a future generator's result so it joins the same bank. Does not call a provider. */
export function withGenerationSource(question: ExamQuestion, request: QuestionGenerationRequest, label?: string): ExamQuestion {
  return {
    ...question,
    courseId: request.courseId || question.courseId,
    topicId: request.topicId || question.topicId,
    source: {
      origin: 'ai',
      from: request.sourceKind,
      label: label || `Generated from ${request.sourceKind}`,
      materialId: request.materialId,
      page: request.page,
      objectiveId: request.objectiveId,
    },
  };
}

function generationTargets(state: AppState): QuestionGenerationTarget[] {
  const targets: QuestionGenerationTarget[] = [];
  for (const course of state.courses) {
    targets.push({ kind: 'course', label: course.courseName, courseId: course.id });
  }
  for (const topic of state.topics) {
    targets.push({ kind: 'topic', label: topic.topicName, courseId: topic.courseId, topicId: topic.id });
  }
  for (const slide of state.slides) {
    const kind = inferMaterialKind(slide);
    const topic = state.topics.find((item) => item.id === slide.topicId);
    if (kind === 'pdf') {
      targets.push({
        kind: 'pdf',
        label: slide.title || slide.originalName || 'PDF',
        courseId: topic?.courseId,
        topicId: slide.topicId,
        materialId: slide.id,
      });
    }
    if (kind === 'ppt' || kind === 'pptx') {
      targets.push({
        kind: 'slide',
        label: slide.title || slide.originalName || 'Presentation',
        courseId: topic?.courseId,
        topicId: slide.topicId,
        materialId: slide.id,
        page: slide.lastPosition,
      });
    }
  }
  for (const objective of state.learningObjectives) {
    targets.push({
      kind: 'objective',
      label: objective.objectiveText,
      courseId: objective.courseId,
      topicId: objective.topicId,
      objectiveId: objective.id,
    });
  }
  return targets;
}

export interface QuestionBankSnapshot {
  generatedAt: string;
  offline: true;
  provider: null;
  generatedRequired: false;
  questions: Array<{
    id: string;
    courseId: string;
    topicId: string;
    semester: string;
    difficulty: ExamQuestion['difficulty'];
    questionType: ExamQuestion['questionType'];
    source: QuestionSourceRef;
    correctAnswer: string;
    explanation: string;
    createdAt: string;
    performance: QuestionPerformance;
  }>;
  analytics: QuestionBankAnalytics;
  sources: Record<QuestionOrigin, number>;
  generation: {
    kinds: GenerationKind[];
    targets: QuestionGenerationTarget[];
  };
}

export function questionBankSnapshot(state: AppState, at = new Date().toISOString()): QuestionBankSnapshot {
  const performance = allQuestionPerformance(state);
  const sources: Record<QuestionOrigin, number> = { manual: 0, imported: 0, ai: 0, pdf: 0, slide: 0, objective: 0 };
  const questions = state.examQuestions.map((question) => {
    const source = sourceOf(question);
    sources[source.origin] += 1;
    return {
      id: question.id,
      courseId: question.courseId,
      topicId: question.topicId,
      semester: semesterOf(state, question),
      difficulty: question.difficulty,
      questionType: question.questionType,
      source,
      correctAnswer: correctAnswerText(question),
      explanation: explanationText(question),
      createdAt: question.createdAt,
      performance: performance.get(question.id) ?? questionPerformance(state, question.id),
    };
  });
  return {
    generatedAt: at,
    offline: true,
    provider: null,
    generatedRequired: false,
    questions,
    analytics: bankAnalytics(state),
    sources,
    generation: {
      kinds: ['course', 'topic', 'pdf', 'slide', 'objective'],
      targets: generationTargets(state),
    },
  };
}
