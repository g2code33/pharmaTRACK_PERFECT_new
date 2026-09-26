/**
 * Local learning engine.
 *
 * Status, revision history, and the daily study list are computed from data
 * already on the device: topic records, quizzes, missed questions, exams, and
 * study plans. Nothing here calls an AI provider.
 *
 * A future AI layer should read `learningSnapshot()` instead of inventing its
 * own picture of what the student has mastered.
 */
import type {
  AppState,
  LearningSettings,
  LearningStatus,
  QuizHistory,
  RevisionEvent,
  TopicLearningRecord,
} from '../types';

export const DEFAULT_INTERVALS = [1, 3, 7, 14, 30] as const;

export const DEFAULT_LEARNING_SETTINGS: LearningSettings = {
  intervals: [...DEFAULT_INTERVALS],
};

export const LEARNING_STATUSES: LearningStatus[] = [
  'not_started',
  'learning',
  'reviewed',
  'mastered',
  'needs_revision',
];

export const STATUS_LABEL: Record<LearningStatus, string> = {
  not_started: 'Not Started',
  learning: 'Learning',
  reviewed: 'Reviewed',
  mastered: 'Mastered',
  needs_revision: 'Needs Revision',
};

export type PriorityReason = 'overdue' | 'weak' | 'upcoming_exam' | 'unfinished_plan' | 'reinforce';

export const PRIORITY_LABEL: Record<PriorityReason, string> = {
  overdue: 'Overdue revision',
  weak: 'Weak topics',
  upcoming_exam: 'Upcoming exams',
  unfinished_plan: 'Unfinished study plans',
  reinforce: 'Needs reinforcement',
};

export interface TopicStats {
  attempted: number;
  correct: number;
  missed: number;
  /** null when the topic has never been quizzed. */
  accuracy: number | null;
  lastQuizAt?: string;
}

export interface TopicProgressView {
  topicId: string;
  topicName: string;
  courseId: string;
  courseCode: string;
  courseName: string;
  status: LearningStatus;
  confidence: number;
  importance: number;
  accuracy: number | null;
  attempted: number;
  missed: number;
  lastStudiedAt?: string;
  lastReviewedAt?: string;
  nextReviewAt?: string;
  intervalDays?: number;
  overdue: boolean;
  history: RevisionEvent[];
}

export interface StudyPriority {
  id: string;
  topicId?: string;
  courseId?: string;
  title: string;
  reason: PriorityReason;
  detail: string;
  score: number;
  href: string;
  dueAt?: string;
}

export interface LearningTopicSnapshot {
  topicId: string;
  topicName: string;
  courseId: string;
  courseCode: string;
  status: LearningStatus;
  confidence: number;
  importance: number;
  lastStudiedAt?: string;
  lastReviewedAt?: string;
  nextReviewAt?: string;
  quizAccuracy: number | null;
  questionsAttempted: number;
  missedQuestions: number;
  revisionCount: number;
  overdue: boolean;
}

export interface LearningSnapshot {
  generatedAt: string;
  intervals: number[];
  topics: LearningTopicSnapshot[];
  dueToday: Array<{ topicId?: string; reason: PriorityReason; title: string; detail: string }>;
}

const HISTORY_CAP = 40;
const EXAM_HORIZON_DAYS = 21;
const REINFORCE_DAYS = 3;

const dayKey = (iso: string): string => iso.slice(0, 10);

const dayNumber = (iso: string): number => {
  const [y, m, d] = dayKey(iso).split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return NaN;
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
};

export function daysBetween(fromIso: string, toIso: string): number {
  const a = dayNumber(fromIso);
  const b = dayNumber(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return b - a;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function sanitizeIntervals(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [];
  const days = raw
    .map((n) => (typeof n === 'number' ? n : parseInt(String(n), 10)))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 365)
    .slice(0, 8);
  return days.length ? days : [...DEFAULT_INTERVALS];
}

export function intervalsOf(state: Pick<AppState, 'learningSettings'> | { learningSettings?: LearningSettings }): number[] {
  return sanitizeIntervals(state.learningSettings?.intervals);
}

export function recordsOf(state: { learningRecords?: TopicLearningRecord[] | null }): TopicLearningRecord[] {
  return Array.isArray(state.learningRecords) ? state.learningRecords : [];
}

export function recordFor(state: { learningRecords?: TopicLearningRecord[] | null }, topicId: string): TopicLearningRecord | undefined {
  return recordsOf(state).find((r) => r.topicId === topicId);
}

function clamp15(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, Math.round(n)));
}

function blankRecord(topicId: string, at: string): TopicLearningRecord {
  return {
    topicId,
    status: 'not_started',
    confidence: 3,
    importance: 3,
    intervalIndex: -1,
    history: [],
    updatedAt: at,
  };
}

function pushHistory(record: TopicLearningRecord, event: RevisionEvent): RevisionEvent[] {
  return [event, ...record.history].slice(0, HISTORY_CAP);
}

function replaceRecord(records: TopicLearningRecord[], next: TopicLearningRecord): TopicLearningRecord[] {
  const rest = records.filter((r) => r.topicId !== next.topicId);
  return [...rest, next];
}

export function topicStats(state: AppState, topicId: string): TopicStats {
  let attempted = 0;
  let correct = 0;
  let missed = 0;
  let lastQuizAt: string | undefined;
  const seenMiss = new Set<string>();
  for (const quiz of state.quizHistory ?? []) {
    for (const answer of quiz.answersGiven ?? []) {
      const question = state.examQuestions.find((q) => q.id === answer.questionId);
      if (!question || question.topicId !== topicId) continue;
      attempted++;
      if (answer.isCorrect) correct++;
      else {
        missed++;
        seenMiss.add(answer.questionId);
      }
      if (!lastQuizAt || quiz.completedAt > lastQuizAt) lastQuizAt = quiz.completedAt;
    }
  }
  for (const question of state.examQuestions) {
    if (question.topicId === topicId && question.needsReview && !seenMiss.has(question.id)) missed++;
  }
  return {
    attempted,
    correct,
    missed,
    accuracy: attempted === 0 ? null : Math.round((correct / attempted) * 100),
    lastQuizAt,
  };
}

function isOverdue(record: TopicLearningRecord | undefined, now: string): boolean {
  if (!record?.nextReviewAt || record.status === 'not_started') return false;
  return dayKey(record.nextReviewAt) <= dayKey(now);
}

export function topicProgress(state: AppState, topicId: string, now = new Date().toISOString()): TopicProgressView | null {
  const topic = state.topics.find((t) => t.id === topicId);
  if (!topic) return null;
  const course = state.courses.find((c) => c.id === topic.courseId);
  const record = recordFor(state, topicId);
  const stats = topicStats(state, topicId);
  const intervals = intervalsOf(state);
  const index = record?.intervalIndex ?? -1;
  return {
    topicId,
    topicName: topic.topicName,
    courseId: topic.courseId,
    courseCode: course?.courseCode || '',
    courseName: course?.courseName || '',
    status: record?.status ?? 'not_started',
    confidence: record?.confidence ?? 3,
    importance: record?.importance ?? 3,
    accuracy: stats.accuracy,
    attempted: stats.attempted,
    missed: stats.missed,
    lastStudiedAt: record?.lastStudiedAt,
    lastReviewedAt: record?.lastReviewedAt,
    nextReviewAt: record?.nextReviewAt,
    intervalDays: index >= 0 ? intervals[Math.min(index, intervals.length - 1)] : undefined,
    overdue: isOverdue(record, now),
    history: record?.history ?? [],
  };
}

type Outcome = 'pass' | 'fail';

function outcomeFromSignals(accuracy: number | null, missed: number, confidence: number): Outcome {
  if (confidence <= 2) return 'fail';
  if (accuracy !== null && accuracy < 60) return 'fail';
  if (missed >= 2 && (accuracy === null || accuracy < 80)) return 'fail';
  return 'pass';
}

function schedule(
  prev: TopicLearningRecord,
  outcome: Outcome,
  at: string,
  intervals: number[],
  event: RevisionEvent,
  statusOverride?: LearningStatus,
): TopicLearningRecord {
  const gaps = intervals.length ? intervals : [...DEFAULT_INTERVALS];
  const stepped = outcome === 'pass'
    ? Math.min(Math.max(prev.intervalIndex, -1) + 1, gaps.length - 1)
    : 0;
  const nextIndex = statusOverride === 'mastered' && outcome === 'pass' ? gaps.length - 1 : stepped;
  const days = gaps[nextIndex];
  let status: LearningStatus = statusOverride
    ?? (outcome === 'fail'
      ? 'needs_revision'
      : prev.status === 'mastered' || nextIndex === gaps.length - 1
        ? 'mastered'
        : 'reviewed');
  if (outcome === 'fail') status = 'needs_revision';
  if (statusOverride === 'mastered' && outcome === 'pass') status = 'mastered';
  return {
    ...prev,
    status,
    intervalIndex: nextIndex,
    lastReviewedAt: at,
    nextReviewAt: outcome === 'fail' ? at : addDays(at, days),
    history: pushHistory(prev, { ...event, status, note: event.note ?? (outcome === 'fail' ? `Needs revision · retry in ${gaps[0]} day${gaps[0] === 1 ? '' : 's'}` : `Next review in ${days} day${days === 1 ? '' : 's'}`) }),
    updatedAt: at,
  };
}

function requireTopic(state: AppState, topicId: string): boolean {
  return state.topics.some((t) => t.id === topicId);
}

export function setTopicStatus(state: AppState, topicId: string, status: LearningStatus, at = new Date().toISOString()): TopicLearningRecord[] {
  if (!requireTopic(state, topicId)) return recordsOf(state);
  const intervals = intervalsOf(state);
  const prev = recordFor(state, topicId) ?? blankRecord(topicId, at);
  if (status === 'not_started') {
    return replaceRecord(recordsOf(state), {
      ...prev,
      status,
      nextReviewAt: undefined,
      intervalIndex: -1,
      history: pushHistory(prev, { id: `${topicId}-status-${prev.history.length}-${at}`, at, kind: 'status', status, note: STATUS_LABEL[status] }),
      updatedAt: at,
    });
  }
  if (status === 'needs_revision') {
    return replaceRecord(recordsOf(state), schedule(prev, 'fail', at, intervals, {
      id: `${topicId}-status-${prev.history.length}-${at}`,
      at,
      kind: 'status',
      note: STATUS_LABEL[status],
    }, 'needs_revision'));
  }
  if (status === 'learning') {
    const nextReviewAt = prev.nextReviewAt && dayKey(prev.nextReviewAt) > dayKey(at)
      ? prev.nextReviewAt
      : addDays(at, intervals[0]);
    return replaceRecord(recordsOf(state), {
      ...prev,
      status,
      intervalIndex: Math.max(prev.intervalIndex, 0),
      nextReviewAt,
      history: pushHistory(prev, { id: `${topicId}-status-${prev.history.length}-${at}`, at, kind: 'status', status, note: STATUS_LABEL[status] }),
      updatedAt: at,
    });
  }
  const stats = topicStats(state, topicId);
  const outcome = status === 'mastered' ? 'pass' : outcomeFromSignals(stats.accuracy, stats.missed, prev.confidence);
  return replaceRecord(recordsOf(state), schedule(prev, outcome, at, intervals, {
    id: `${topicId}-status-${prev.history.length}-${at}`,
    at,
    kind: 'status',
    note: STATUS_LABEL[status],
  }, status === 'mastered' || status === 'reviewed' ? status : undefined));
}

export function setTopicConfidence(state: AppState, topicId: string, confidence: number, at = new Date().toISOString()): TopicLearningRecord[] {
  if (!requireTopic(state, topicId)) return recordsOf(state);
  const prev = recordFor(state, topicId) ?? blankRecord(topicId, at);
  const next = clamp15(confidence, 3);
  if (prev.confidence === next && recordFor(state, topicId)) return recordsOf(state);
  return replaceRecord(recordsOf(state), { ...prev, confidence: next, updatedAt: at });
}

export function setTopicImportance(state: AppState, topicId: string, importance: number, at = new Date().toISOString()): TopicLearningRecord[] {
  if (!requireTopic(state, topicId)) return recordsOf(state);
  const prev = recordFor(state, topicId) ?? blankRecord(topicId, at);
  const next = clamp15(importance, 3);
  if (prev.importance === next && recordFor(state, topicId)) return recordsOf(state);
  return replaceRecord(recordsOf(state), { ...prev, importance: next, updatedAt: at });
}

/** Opening a topic counts as study, once per calendar day. Does not advance the interval. */
export function markStudied(state: AppState, topicId: string, at = new Date().toISOString()): TopicLearningRecord[] {
  if (!requireTopic(state, topicId)) return recordsOf(state);
  const records = recordsOf(state);
  const prev = records.find((r) => r.topicId === topicId);
  if (prev?.lastStudiedAt && dayKey(prev.lastStudiedAt) === dayKey(at)) return records;
  const intervals = intervalsOf(state);
  const base = prev ?? blankRecord(topicId, at);
  const status: LearningStatus = base.status === 'not_started' ? 'learning' : base.status;
  const nextReviewAt = base.nextReviewAt ?? addDays(at, intervals[0]);
  const intervalIndex = base.intervalIndex >= 0 ? base.intervalIndex : 0;
  return replaceRecord(records, {
    ...base,
    status,
    lastStudiedAt: at,
    nextReviewAt,
    intervalIndex,
    history: pushHistory(base, {
      id: `${topicId}-studied-${base.history.length}-${at}`,
      at,
      kind: 'studied',
      status,
      note: 'Studied',
    }),
    updatedAt: at,
  });
}

/** A deliberate review. Advances the interval only when quiz results and confidence agree. */
export function markReviewed(state: AppState, topicId: string, at = new Date().toISOString()): TopicLearningRecord[] {
  if (!requireTopic(state, topicId)) return recordsOf(state);
  const intervals = intervalsOf(state);
  const prev = recordFor(state, topicId) ?? blankRecord(topicId, at);
  const stats = topicStats(state, topicId);
  const outcome = outcomeFromSignals(stats.accuracy, stats.missed, prev.confidence);
  return replaceRecord(recordsOf(state), schedule({ ...prev, lastStudiedAt: prev.lastStudiedAt ?? at }, outcome, at, intervals, {
    id: `${topicId}-reviewed-${prev.history.length}-${at}`,
    at,
    kind: 'reviewed',
    confidence: prev.confidence,
    scorePercentage: stats.accuracy ?? undefined,
    missed: stats.missed,
  }));
}

export function applyQuiz(state: AppState, quiz: QuizHistory, at = quiz.completedAt): TopicLearningRecord[] {
  const byTopic = new Map<string, { attempted: number; correct: number; missed: number }>();
  for (const answer of quiz.answersGiven ?? []) {
    const question = state.examQuestions.find((q) => q.id === answer.questionId);
    const topicId = question?.topicId;
    if (!topicId || !requireTopic(state, topicId)) continue;
    const row = byTopic.get(topicId) ?? { attempted: 0, correct: 0, missed: 0 };
    row.attempted++;
    if (answer.isCorrect) row.correct++;
    else row.missed++;
    byTopic.set(topicId, row);
  }
  for (const topicId of quiz.weakTopics ?? []) {
    if (!requireTopic(state, topicId) || byTopic.has(topicId)) continue;
    byTopic.set(topicId, { attempted: 0, correct: 0, missed: 1 });
  }
  let records = recordsOf(state);
  const intervals = intervalsOf(state);
  for (const [topicId, row] of byTopic) {
    const prev = records.find((r) => r.topicId === topicId) ?? blankRecord(topicId, at);
    if (prev.history.some((event) => event.quizId === quiz.id)) continue;
    const accuracy = row.attempted > 0 ? Math.round((row.correct / row.attempted) * 100) : 0;
    const outcome = outcomeFromSignals(accuracy, row.missed, prev.confidence);
    const next = schedule(
      { ...prev, lastStudiedAt: prev.lastStudiedAt ?? at },
      outcome,
      at,
      intervals,
      {
        id: `${topicId}-quiz-${quiz.id}`,
        at,
        kind: 'quiz',
        quizId: quiz.id,
        scorePercentage: accuracy,
        missed: row.missed,
        confidence: prev.confidence,
        note: `Quiz ${accuracy}%${row.missed ? ` · ${row.missed} missed` : ''}`,
      },
    );
    records = replaceRecord(records, next);
  }
  return records;
}

export function setIntervals(intervals: unknown): LearningSettings {
  return { intervals: sanitizeIntervals(intervals) };
}

function importanceBoost(importance: number, daysUntilExam: number | null): number {
  const examBoost = daysUntilExam !== null && daysUntilExam <= 7 ? 2 : daysUntilExam !== null && daysUntilExam <= EXAM_HORIZON_DAYS ? 1 : 0;
  return importance + examBoost;
}

export function dailyPriorities(state: AppState, now = new Date().toISOString()): StudyPriority[] {
  const items: StudyPriority[] = [];
  const today = dayKey(now);

  for (const plan of state.studyPlans ?? []) {
    if (plan.isCompleted || !plan.date) continue;
    if (dayKey(plan.date) > today) continue;
    const course = state.courses.find((c) => c.id === plan.courseId);
    const late = Math.max(0, daysBetween(plan.date, now));
    items.push({
      id: `plan-${plan.id}`,
      courseId: plan.courseId,
      title: plan.notes?.trim() || `${course?.courseCode || 'Study'} · ${plan.activityType}`,
      reason: 'unfinished_plan',
      detail: late > 0 ? `Planned ${plan.date} · ${late} day${late === 1 ? '' : 's'} overdue` : `Planned for today · ${plan.timeSlot || plan.activityType}`,
      score: 60 + late * 4,
      href: '/planner',
      dueAt: plan.date,
    });
  }

  for (const exam of state.examDates ?? []) {
    if (!exam.examDate) continue;
    const until = daysBetween(now, exam.examDate);
    if (until < 0 || until > EXAM_HORIZON_DAYS) continue;
    const course = state.courses.find((c) => c.id === exam.courseId);
    const topics = state.topics.filter((t) => t.courseId === exam.courseId);
    const open = topics.filter((t) => (recordFor(state, t.id)?.status ?? 'not_started') !== 'mastered');
    const targets = open.length ? open : topics;
    if (targets.length === 0) {
      items.push({
        id: `exam-${exam.id}`,
        courseId: exam.courseId,
        title: `${course?.courseCode || 'Exam'} · ${exam.examType}`,
        reason: 'upcoming_exam',
        detail: until === 0 ? 'Exam today' : `Exam in ${until} day${until === 1 ? '' : 's'}`,
        score: 80 + (EXAM_HORIZON_DAYS - until) * 2,
        href: course ? `/course/${course.id}` : '/learn',
        dueAt: exam.examDate,
      });
      continue;
    }
    for (const topic of targets) {
      const record = recordFor(state, topic.id);
      const weight = importanceBoost(record?.importance ?? 3, until);
      items.push({
        id: `exam-${exam.id}-${topic.id}`,
        topicId: topic.id,
        courseId: topic.courseId,
        title: topic.topicName,
        reason: 'upcoming_exam',
        detail: `${course?.courseCode || 'Course'} ${exam.examType} in ${until} day${until === 1 ? '' : 's'} · ${STATUS_LABEL[record?.status ?? 'not_started']}`,
        score: 78 + (EXAM_HORIZON_DAYS - until) * 2 + weight * 3,
        href: `/learn?topic=${topic.id}`,
        dueAt: exam.examDate,
      });
    }
  }

  for (const topic of state.topics) {
    const record = recordFor(state, topic.id);
    const stats = topicStats(state, topic.id);
    const course = state.courses.find((c) => c.id === topic.courseId);
    const importance = record?.importance ?? 3;
    const status = record?.status ?? 'not_started';
    if (isOverdue(record, now)) {
      const late = Math.max(0, daysBetween(record!.nextReviewAt!, now));
      items.push({
        id: `overdue-${topic.id}`,
        topicId: topic.id,
        courseId: topic.courseId,
        title: topic.topicName,
        reason: 'overdue',
        detail: `${course?.courseCode || ''} · due ${dayKey(record!.nextReviewAt!)} · ${STATUS_LABEL[status]}`.replace(' · ·', ' ·'),
        score: 100 + late * 6 + importance * 4 + stats.missed * 2,
        href: `/learn?topic=${topic.id}`,
        dueAt: record!.nextReviewAt,
      });
    }
    const weak = status === 'needs_revision' || (stats.accuracy !== null && stats.accuracy < 60) || stats.missed >= 2;
    if (weak) {
      items.push({
        id: `weak-${topic.id}`,
        topicId: topic.id,
        courseId: topic.courseId,
        title: topic.topicName,
        reason: 'weak',
        detail: [
          course?.courseCode,
          stats.accuracy === null ? 'flagged for review' : `${stats.accuracy}% quiz accuracy`,
          stats.missed ? `${stats.missed} missed` : '',
        ].filter(Boolean).join(' · '),
        score: 70 + (stats.accuracy === null ? 15 : (100 - stats.accuracy) / 2) + stats.missed * 3 + importance * 3,
        href: `/quiz?course=${topic.courseId}`,
      });
    }
    if (
      status === 'learning'
      && record?.lastStudiedAt
      && daysBetween(record.lastStudiedAt, now) >= 0
      && daysBetween(record.lastStudiedAt, now) <= REINFORCE_DAYS
      && !isOverdue(record, now)
    ) {
      items.push({
        id: `reinforce-${topic.id}`,
        topicId: topic.id,
        courseId: topic.courseId,
        title: topic.topicName,
        reason: 'reinforce',
        detail: `${course?.courseCode || 'Topic'} · studied ${dayKey(record.lastStudiedAt)} · review ${record.nextReviewAt ? dayKey(record.nextReviewAt) : 'soon'}`,
        score: 40 + importance * 4,
        href: `/read/${topic.id}`,
      });
    }
  }

  return items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

/** Structured picture of the learning loop. No provider, no prompt. */
export function learningSnapshot(state: AppState, now = new Date().toISOString()): LearningSnapshot {
  const topics = state.topics.map((topic) => {
    const view = topicProgress(state, topic.id, now);
    return {
      topicId: topic.id,
      topicName: topic.topicName,
      courseId: topic.courseId,
      courseCode: view?.courseCode || '',
      status: view?.status ?? 'not_started',
      confidence: view?.confidence ?? 3,
      importance: view?.importance ?? 3,
      lastStudiedAt: view?.lastStudiedAt,
      lastReviewedAt: view?.lastReviewedAt,
      nextReviewAt: view?.nextReviewAt,
      quizAccuracy: view?.accuracy ?? null,
      questionsAttempted: view?.attempted ?? 0,
      missedQuestions: view?.missed ?? 0,
      revisionCount: (view?.history ?? []).filter((event) => event.kind === 'reviewed' || event.kind === 'quiz').length,
      overdue: view?.overdue ?? false,
    };
  });
  return {
    generatedAt: now,
    intervals: intervalsOf(state),
    topics,
    dueToday: dailyPriorities(state, now).map((item) => ({
      topicId: item.topicId,
      reason: item.reason,
      title: item.title,
      detail: item.detail,
    })),
  };
}
