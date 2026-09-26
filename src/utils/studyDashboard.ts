/**
 * Local study dashboard and timetable intelligence.
 *
 * "What should I do now?" is computed from classes, plans, exams, materials,
 * and learning records already on the device. Nothing here calls a provider.
 */
import type { AppState, Course, ExamQuestion, Slide, StudyPlan, TimetableItem, Topic } from '../types';
import { STATUS_LABEL, topicProgress } from './learningEngine';
import { bankAnalytics } from './questionBank';

export type Urgency = 'red' | 'orange' | 'yellow';
export type TimetableCategory = 'class' | 'quiz' | 'exam';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const PREP_WINDOW_MINUTES = 36 * 60;
const SOON_MINUTES = 3 * 60;
const QUIZ_BATCH = 20;
const WEAK_ACCURACY = 70;

export interface NowAction {
  id: string;
  urgency: Urgency;
  title: string;
  detail: string;
  href: string;
}

export interface PrepLink {
  id: string;
  label: string;
  href: string;
  done?: boolean;
  detail?: string;
}

export interface ClassSession {
  id: string;
  category: TimetableCategory;
  subject: string;
  location: string;
  whenLabel: string;
  startsAt?: string;
  minutesUntil: number | null;
  courseId?: string;
  courseCode?: string;
  courseName?: string;
  topicId?: string;
  match: 'linked' | 'name' | 'none';
  topics: PrepLink[];
  materials: PrepLink[];
  plans: PrepLink[];
  exams: PrepLink[];
  tasks: PrepLink[];
}

export interface DashboardStats {
  studyMinutes: number;
  topicsCompleted: number;
  topicsRemaining: number;
  quizAccuracy: number | null;
  revisionDue: number;
  needsRevision: number;
  nextExamLabel: string;
  nextExamDays: number | null;
  semesterProgress: number;
}

export interface StudyBrief {
  now: NowAction[];
  overdue: PrepLink[];
  weakTopics: PrepLink[];
  unfinishedPlans: PrepLink[];
  upcomingExams: PrepLink[];
  recentMaterials: PrepLink[];
  todayClasses: ClassSession[];
  tomorrowClasses: ClassSession[];
  nextClass: ClassSession | null;
  quizAccuracy: number | null;
  recentScores: number[];
  stats: DashboardStats;
}

function norm(value: string): string {
  return value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function weekdayIndex(value: string): number | null {
  const token = norm(value).split(' ')[0] || '';
  if (token.length < 3) return null;
  const index = WEEKDAYS.findIndex((day) => day === token || day.startsWith(token));
  return index >= 0 ? index : null;
}

function weekdayName(index: number): string {
  if (index < 0 || index > 6) return '';
  const day = WEEKDAYS[index];
  return day.charAt(0).toUpperCase() + day.slice(1);
}

function parseIsoDate(value: string): { y: number; m: number; d: number } | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]) - 1;
  const d = Number(match[3]);
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  return { y, m, d };
}

function parseClock(value: string): { hour: number; minute: number } | null {
  const match = value.trim().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (!meridiem && hour > 23) return null;
  return { hour, minute };
}

function firstClock(value: string): { hour: number; minute: number } | null {
  if (!value || /^\d{4}-\d{2}-\d{2}/.test(value.trim())) return null;
  return parseClock(value);
}

function localDate(y: number, m: number, d: number, hour = 0, minute = 0): Date {
  return new Date(y, m, d, hour, minute, 0, 0);
}

function dateKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

function calendarDays(from: Date, to: Date): number {
  const a = localDate(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = localDate(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

function slotMinutes(slot: string): number | null {
  const parts = slot.split(/\s+-\s+|\s+to\s+/i);
  if (parts.length < 2) return null;
  const start = parseClock(parts[0]);
  const end = parseClock(parts[1]);
  if (!start || !end) return null;
  const a = start.hour * 60 + start.minute;
  let b = end.hour * 60 + end.minute;
  if (b <= a) b += 12 * 60;
  const minutes = b - a;
  return minutes > 0 && minutes <= 12 * 60 ? minutes : null;
}

function buckets(state: AppState): { item: TimetableItem; category: TimetableCategory }[] {
  const tables = state.timetables ?? { class: [], quiz: [], exam: [] };
  return (['class', 'quiz', 'exam'] as const).flatMap((category) =>
    (tables[category] ?? []).map((item) => ({ item, category }))
  );
}

function courseScore(course: Course, subject: string): number {
  const name = norm(course.courseName);
  const code = norm(course.courseCode);
  const text = norm(subject);
  if (!text) return 0;
  if (code && text === code) return 100;
  if (name && text === name) return 95;
  if (code && code.length >= 3 && text.includes(code)) return 80;
  if (name && name.length >= 4 && text.includes(name)) return 75;
  if (name && text.length >= 4 && name.includes(text)) return 70;
  const tokens = text.split(' ').filter((token) => token.length >= 4);
  const nameTokens = new Set(name.split(' '));
  const overlap = tokens.filter((token) => nameTokens.has(token)).length;
  if (overlap >= 2) return 60 + overlap;
  if (overlap === 1 && tokens.length === 1) return 65;
  return 0;
}

function matchCourse(state: AppState, item: TimetableItem): { course?: Course; topic?: Topic; match: ClassSession['match'] } {
  if (item.courseId) {
    const linked = state.courses.find((course) => course.id === item.courseId);
    if (linked) {
      const topic = item.topicId ? state.topics.find((row) => row.id === item.topicId && row.courseId === linked.id) : undefined;
      return { course: linked, topic, match: 'linked' };
    }
  }
  const subject = item.subject || '';
  const topicHit = state.topics.find((topic) => norm(topic.topicName) === norm(subject) && norm(subject).length >= 4);
  const ranked = state.courses
    .map((course) => ({ course, score: courseScore(course, subject) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.course.courseName.localeCompare(b.course.courseName));
  const best = ranked[0];
  const unique = best && (ranked.length === 1 || best.score >= 90 || best.score - ranked[1].score >= 10);
  if (topicHit && (!unique || best.score < 95)) {
    const course = state.courses.find((row) => row.id === topicHit.courseId);
    return { course, topic: topicHit, match: course ? 'name' : 'none' };
  }
  if (unique) {
    const topic = item.topicId ? state.topics.find((row) => row.id === item.topicId) : topicHit;
    return { course: best.course, topic, match: 'name' };
  }
  return { match: 'none' };
}

function nextStart(item: TimetableItem, now: Date): Date | null {
  const clock = firstClock(item.time) || firstClock(item.date) || { hour: 8, minute: 0 };
  const dated = parseIsoDate(item.date || '');
  if (dated) return localDate(dated.y, dated.m, dated.d, clock.hour, clock.minute);
  const weekday = weekdayIndex(item.date || '') ?? weekdayIndex(item.subject || '');
  if (weekday === null) return null;
  const today = localDate(now.getFullYear(), now.getMonth(), now.getDate(), clock.hour, clock.minute);
  let delta = (weekday - now.getDay() + 7) % 7;
  if (delta === 0 && today.getTime() + 30 * 60 * 1000 < now.getTime()) delta = 7;
  const next = new Date(today);
  next.setDate(today.getDate() + delta);
  return next;
}

function whenLabel(item: TimetableItem, start: Date | null): string {
  const time = (item.time || '').trim();
  if (start) {
    const day = weekdayName(start.getDay());
    return time ? `${day} ${time}` : day;
  }
  const weekday = weekdayIndex(item.date || '');
  if (weekday !== null) return time ? `${weekdayName(weekday)} ${time}` : weekdayName(weekday);
  return [item.date, time].filter(Boolean).join(' ');
}

function courseTopics(state: AppState, courseId: string, leadId?: string): Topic[] {
  return state.topics
    .filter((topic) => topic.courseId === courseId)
    .sort((a, b) => {
      if (a.id === leadId) return -1;
      if (b.id === leadId) return 1;
      return a.orderIndex - b.orderIndex || a.topicName.localeCompare(b.topicName);
    });
}

function materialHref(slide: Slide): string {
  return `/read/${slide.topicId}?material=${slide.id}`;
}

export function describeSession(
  state: AppState,
  item: TimetableItem,
  category: TimetableCategory,
  now = new Date(),
): ClassSession {
  const start = nextStart(item, now);
  const matched = matchCourse(state, item);
  const course = matched.course;
  const topics = course ? courseTopics(state, course.id, matched.topic?.id) : [];
  const topicIds = new Set(topics.map((topic) => topic.id));
  const slides = state.slides.filter((slide) => topicIds.has(slide.topicId));
  const unfinishedSlides = slides.filter((slide) => slide.status !== 'completed');
  const plans = (state.studyPlans ?? []).filter((plan) => course && plan.courseId === course.id);
  const exams = examsForCourse(state, course?.id, now);
  const tasks = preparationTasks(state, item, category, course, topics, unfinishedSlides, plans, start, now);

  return {
    id: item.id,
    category,
    subject: item.subject || 'Class',
    location: item.location || '',
    whenLabel: whenLabel(item, start),
    startsAt: start?.toISOString(),
    minutesUntil: start ? Math.round((start.getTime() - now.getTime()) / 60_000) : null,
    courseId: course?.id,
    courseCode: course?.courseCode,
    courseName: course?.courseName,
    topicId: matched.topic?.id,
    match: matched.match,
    topics: topics.slice(0, 8).map((topic) => {
      const view = topicProgress(state, topic.id, now.toISOString());
      return {
        id: topic.id,
        label: topic.topicName,
        href: `/learn?topic=${topic.id}`,
        detail: view ? STATUS_LABEL[view.status] : 'Not Started',
        done: view?.status === 'mastered',
      };
    }),
    materials: [...unfinishedSlides, ...slides.filter((slide) => slide.status === 'completed')]
      .slice(0, 6)
      .map((slide) => ({
        id: slide.id,
        label: slide.title || slide.originalName || 'Material',
        href: materialHref(slide),
        done: slide.status === 'completed',
        detail: slide.status === 'completed' ? 'Done' : 'Not finished',
      })),
    plans: plans.filter((plan) => !plan.isCompleted).slice(0, 4).map((plan) => ({
      id: plan.id,
      label: plan.notes?.trim() || plan.activityType,
      href: '/planner',
      detail: plan.date,
      done: false,
    })),
    exams,
    tasks,
  };
}

function examsForCourse(state: AppState, courseId: string | undefined, now: Date): PrepLink[] {
  if (!courseId) return [];
  const links: PrepLink[] = [];
  for (const exam of state.examDates ?? []) {
    if (exam.courseId !== courseId || !exam.examDate) continue;
    const dated = parseIsoDate(exam.examDate);
    if (!dated) continue;
    const when = localDate(dated.y, dated.m, dated.d);
    const days = calendarDays(now, when);
    if (days < 0) continue;
    links.push({
      id: exam.id,
      label: `${exam.examType} in ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`}`,
      href: `/course/${courseId}`,
      detail: dateKey(when),
    });
  }
  return links.sort((a, b) => (a.detail || '').localeCompare(b.detail || ''));
}

function preparationTasks(
  state: AppState,
  item: TimetableItem,
  category: TimetableCategory,
  course: Course | undefined,
  topics: Topic[],
  unfinished: Slide[],
  plans: StudyPlan[],
  start: Date | null,
  now: Date,
): PrepLink[] {
  if (!course) {
    return [{
      id: `${item.id}-link`,
      label: `Link ${item.subject || 'this class'} to a course`,
      href: '/timetable',
      detail: 'Preparation stays empty until the class knows its course.',
    }];
  }
  const tasks: PrepLink[] = [];
  for (const slide of unfinished.slice(0, 3)) {
    tasks.push({
      id: `slide-${slide.id}`,
      label: `Review ${slide.title || slide.originalName || 'lecture slides'}`,
      href: materialHref(slide),
      detail: 'Unfinished material',
    });
  }
  for (const topic of topics) {
    const view = topicProgress(state, topic.id, now.toISOString());
    if (!view || view.status === 'mastered') continue;
    const urgent = view.overdue || view.status === 'needs_revision';
    tasks.push({
      id: `topic-${topic.id}`,
      label: urgent ? `Revise ${topic.topicName} before class` : `Preview ${topic.topicName}`,
      href: `/learn?topic=${topic.id}`,
      detail: STATUS_LABEL[view.status],
    });
    if (tasks.filter((task) => task.id.startsWith('topic-')).length >= 2) break;
  }
  const classDay = start ? dateKey(start) : dateKey(now);
  for (const plan of plans.filter((plan) => !plan.isCompleted).slice(0, 2)) {
    if (plan.date && plan.date > classDay) continue;
    tasks.push({
      id: `plan-${plan.id}`,
      label: `Finish ${plan.notes?.trim() || plan.activityType}`,
      href: '/planner',
      detail: plan.date,
    });
  }
  if (category === 'quiz' || category === 'exam') {
    tasks.push({
      id: `${item.id}-practice`,
      label: `Practice questions for ${course.courseName}`,
      href: `/quiz?mode=course&course=${course.id}`,
    });
  }
  if (tasks.length === 0) {
    tasks.push({
      id: `${item.id}-add`,
      label: unfinished.length === 0 && topics.length > 0 ? `Slides for ${course.courseName} are finished` : `Add lecture slides for ${course.courseName}`,
      href: unfinished.length === 0 && topics.length > 0 ? `/course/${course.id}` : '/materials',
      done: unfinished.length === 0 && topics.length > 0,
    });
  }
  return tasks.slice(0, 6);
}

export function sessionsFor(state: AppState, now = new Date()): ClassSession[] {
  return buckets(state)
    .map(({ item, category }) => describeSession(state, item, category, now))
    .sort((a, b) => {
      if (a.minutesUntil === null) return 1;
      if (b.minutesUntil === null) return -1;
      return a.minutesUntil - b.minutesUntil;
    });
}

function isTomorrow(session: ClassSession, now: Date): boolean {
  if (!session.startsAt) return false;
  return calendarDays(now, new Date(session.startsAt)) === 1;
}

function isToday(session: ClassSession, now: Date): boolean {
  if (!session.startsAt) return false;
  return calendarDays(now, new Date(session.startsAt)) === 0;
}

function topicRows(state: AppState, now: Date) {
  return state.topics.map((topic) => {
    const view = topicProgress(state, topic.id, now.toISOString());
    const questions = state.examQuestions.filter((question) => question.topicId === topic.id);
    return { topic, view, questions };
  });
}

function quizHref(topic: Topic, questions: ExamQuestion[]): string {
  const mcq = questions.filter((question) => question.questionType === 'mcq').length;
  const count = Math.min(QUIZ_BATCH, mcq || questions.length || 10);
  const type = mcq > 0 ? '&type=mcq' : '';
  return `/quiz?mode=topic&course=${topic.courseId}&topic=${topic.id}${type}&count=${count}`;
}

function quizTitle(topicName: string, questions: ExamQuestion[]): string {
  const mcq = questions.filter((question) => question.questionType === 'mcq').length;
  const count = Math.min(QUIZ_BATCH, mcq || questions.length);
  if (count <= 0) return `Practice ${topicName}`;
  return `Complete ${count} ${topicName} ${mcq > 0 ? 'MCQs' : 'questions'}`;
}

export function studyBrief(state: AppState, now = new Date()): StudyBrief {
  const rows = topicRows(state, now);
  const sessions = sessionsFor(state, now);
  const upcoming = sessions.filter((session) => session.minutesUntil !== null && session.minutesUntil >= -30);
  const nextClass = upcoming[0] ?? null;
  const todayClasses = sessions.filter((session) => isToday(session, now));
  const tomorrowClasses = sessions.filter((session) => isTomorrow(session, now));
  const actions: NowAction[] = [];
  const seenTopics = new Set<string>();

  const overdue = rows
    .filter((row) => row.view?.overdue)
    .sort((a, b) => (b.view?.importance ?? 0) - (a.view?.importance ?? 0) || a.topic.topicName.localeCompare(b.topic.topicName));
  for (const row of overdue) {
    seenTopics.add(row.topic.id);
    actions.push({
      id: `revise-${row.topic.id}`,
      urgency: 'red',
      title: `Revise ${row.topic.topicName}`,
      detail: `${row.view?.courseCode || 'Topic'} · overdue revision`,
      href: `/learn?topic=${row.topic.id}`,
    });
  }

  for (const session of upcoming) {
    if (session.minutesUntil === null || session.minutesUntil > SOON_MINUTES) continue;
    const open = session.tasks.find((task) => !task.done);
    if (!open) continue;
    actions.push({
      id: `prep-${session.id}`,
      urgency: 'red',
      title: `Prepare for ${session.courseName || session.subject}`,
      detail: `${session.whenLabel}${session.location ? ` · ${session.location}` : ''} · ${open.label}`,
      href: open.href,
    });
  }

  for (const exam of state.examDates ?? []) {
    const dated = exam.examDate ? parseIsoDate(exam.examDate) : null;
    if (!dated) continue;
    const days = calendarDays(now, localDate(dated.y, dated.m, dated.d));
    if (days < 0 || days > 1) continue;
    const course = state.courses.find((row) => row.id === exam.courseId);
    actions.push({
      id: `exam-${exam.id}`,
      urgency: 'red',
      title: `${course?.courseName || 'Exam'} ${exam.examType} ${days === 0 ? 'today' : 'tomorrow'}`,
      detail: 'Exam countdown',
      href: course ? `/course/${course.id}` : '/learn',
    });
  }

  for (const plan of state.studyPlans ?? []) {
    if (plan.isCompleted || !plan.date) continue;
    if (plan.date > dateKey(now)) continue;
    const course = state.courses.find((row) => row.id === plan.courseId);
    actions.push({
      id: `plan-${plan.id}`,
      urgency: 'orange',
      title: plan.notes?.trim() || `Finish ${plan.activityType}`,
      detail: `${course?.courseCode || 'Plan'} · ${plan.date}${plan.date < dateKey(now) ? ' · overdue' : ''}`,
      href: '/planner',
    });
  }

  const weak = rows.filter((row) => {
    const accuracy = row.view?.accuracy;
    const missed = row.view?.missed ?? 0;
    return row.view?.status === 'needs_revision'
      || (accuracy !== null && accuracy !== undefined && accuracy < WEAK_ACCURACY)
      || missed >= 2
      || row.questions.some((question) => question.needsReview);
  }).sort((a, b) => (a.view?.accuracy ?? 0) - (b.view?.accuracy ?? 0));

  for (const row of weak) {
    if (seenTopics.has(row.topic.id)) continue;
    seenTopics.add(row.topic.id);
    actions.push({
      id: `quiz-${row.topic.id}`,
      urgency: 'orange',
      title: quizTitle(row.topic.topicName, row.questions),
      detail: row.view?.accuracy === null || row.view?.accuracy === undefined
        ? 'Marked for review'
        : `${row.view.accuracy}% quiz accuracy`,
      href: quizHref(row.topic, row.questions),
    });
  }

  for (const session of tomorrowClasses) {
    const unfinished = session.materials.filter((material) => !material.done).length;
    const material = session.materials.find((item) => !item.done) || session.materials[0];
    actions.push({
      id: `tomorrow-${session.id}`,
      urgency: 'yellow',
      title: session.materials.length ? "Review tomorrow's lecture slides" : `Preview tomorrow's ${session.subject} class`,
      detail: [session.whenLabel, session.courseName || session.subject, unfinished ? `${unfinished} unfinished` : ''].filter(Boolean).join(' · '),
      href: material?.href || (session.courseId ? `/course/${session.courseId}` : '/timetable'),
    });
  }

  const rank: Record<Urgency, number> = { red: 0, orange: 1, yellow: 2 };
  const nowActions = actions
    .sort((a, b) => rank[a.urgency] - rank[b.urgency] || a.title.localeCompare(b.title))
    .slice(0, 6);

  const analytics = bankAnalytics(state);
  const studyMinutes = recordedMinutes(state);
  const mastered = rows.filter((row) => row.view?.status === 'mastered').length;
  const nextExam = nearestExam(state, now);

  return {
    now: nowActions,
    overdue: overdue.map((row) => ({
      id: row.topic.id,
      label: row.topic.topicName,
      href: `/learn?topic=${row.topic.id}`,
      detail: row.view?.courseCode,
    })),
    weakTopics: weak.map((row) => ({
      id: row.topic.id,
      label: row.topic.topicName,
      href: quizHref(row.topic, row.questions),
      detail: row.view?.accuracy === null || row.view?.accuracy === undefined ? 'No score yet' : `${row.view.accuracy}%`,
    })),
    unfinishedPlans: (state.studyPlans ?? []).filter((plan) => !plan.isCompleted).map((plan) => ({
      id: plan.id,
      label: plan.notes?.trim() || plan.activityType,
      href: '/planner',
      detail: plan.date,
    })),
    upcomingExams: upcomingExamLinks(state, now),
    recentMaterials: recentMaterials(state),
    todayClasses,
    tomorrowClasses,
    nextClass,
    quizAccuracy: analytics.totals.accuracy,
    recentScores: (state.quizHistory ?? []).slice(-5).map((quiz) => quiz.scorePercentage),
    stats: {
      studyMinutes,
      topicsCompleted: mastered,
      topicsRemaining: Math.max(0, state.topics.length - mastered),
      quizAccuracy: analytics.totals.accuracy,
      revisionDue: overdue.length,
      needsRevision: rows.filter((row) => row.view?.status === 'needs_revision').length,
      nextExamLabel: nextExam?.label || 'No exam dated',
      nextExamDays: nextExam?.days ?? null,
      semesterProgress: semesterProgress(state),
    },
  };
}

function recordedMinutes(state: AppState): number {
  let minutes = 0;
  for (const quiz of state.quizHistory ?? []) {
    if (quiz.timeTaken > 0) minutes += quiz.timeTaken / 60;
  }
  for (const plan of state.studyPlans ?? []) {
    if (!plan.isCompleted) continue;
    const slot = slotMinutes(plan.timeSlot || '');
    if (slot) minutes += slot;
  }
  return Math.round(minutes);
}

function semesterProgress(state: AppState): number {
  if (state.courses.length === 0) return 0;
  const scores = state.courses.map((course) => {
    const topics = state.topics.filter((topic) => topic.courseId === course.id);
    const slides = state.slides.filter((slide) => topics.some((topic) => topic.id === slide.topicId));
    if (slides.length === 0) return 0;
    return Math.round((slides.filter((slide) => slide.status === 'completed').length / slides.length) * 100);
  });
  return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function nearestExam(state: AppState, now: Date): { label: string; days: number } | null {
  const options: { label: string; days: number }[] = [];
  for (const exam of state.examDates ?? []) {
    const dated = exam.examDate ? parseIsoDate(exam.examDate) : null;
    if (!dated) continue;
    const days = calendarDays(now, localDate(dated.y, dated.m, dated.d));
    if (days < 0) continue;
    const course = state.courses.find((row) => row.id === exam.courseId);
    options.push({ label: `${course?.courseCode || exam.examType} · ${days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days} days`}`, days });
  }
  for (const { item, category } of buckets(state)) {
    if (category !== 'exam') continue;
    const start = nextStart(item, now);
    if (!start) continue;
    const days = calendarDays(now, start);
    if (days < 0) continue;
    options.push({ label: `${item.subject || 'Exam'} · ${days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days} days`}`, days });
  }
  options.sort((a, b) => a.days - b.days || a.label.localeCompare(b.label));
  return options[0] ?? null;
}

function upcomingExamLinks(state: AppState, now: Date): PrepLink[] {
  const links: PrepLink[] = [];
  for (const exam of state.examDates ?? []) {
    const dated = exam.examDate ? parseIsoDate(exam.examDate) : null;
    if (!dated) continue;
    const days = calendarDays(now, localDate(dated.y, dated.m, dated.d));
    if (days < 0 || days > 60) continue;
    const course = state.courses.find((row) => row.id === exam.courseId);
    links.push({
      id: exam.id,
      label: `${course?.courseCode || 'Exam'} ${exam.examType}`,
      href: course ? `/course/${course.id}` : '/learn',
      detail: days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days} days`,
    });
  }
  return links.sort((a, b) => (a.detail || '').localeCompare(b.detail || '')).slice(0, 4);
}

function recentMaterials(state: AppState): PrepLink[] {
  return [...state.slides]
    .sort((a, b) => (b.lastOpenedAt || b.createdAt || '').localeCompare(a.lastOpenedAt || a.createdAt || ''))
    .slice(0, 4)
    .map((slide) => {
      const topic = state.topics.find((row) => row.id === slide.topicId);
      const course = state.courses.find((row) => row.id === topic?.courseId);
      return {
        id: slide.id,
        label: slide.title || slide.originalName || 'Material',
        href: materialHref(slide),
        detail: [course?.courseCode, topic?.topicName].filter(Boolean).join(' · '),
        done: slide.status === 'completed',
      };
    });
}

export function formatStudyTime(minutes: number): string {
  if (minutes <= 0) return '0m';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}
