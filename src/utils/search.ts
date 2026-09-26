/**
 * Global search across every kind of content in the current semester.
 *
 * Design notes:
 *  - Ranked, not just filtered. A title match must beat a body-text match, or
 *    the thing you typed the name of ends up buried under slide contents.
 *  - Multi-term AND. "beta blocker" should find a slide containing both words
 *    even if they are far apart; substring matching alone fails that.
 *  - Snippets. For long slide text, showing the matched phrase in context is
 *    the difference between a useful result and a title you can't place.
 *  - Synchronous and local. Runs against in-memory state so it works offline
 *    with no async lookup and no AI provider.
 *
 * Archived semesters and AI conversation bodies are not in AppState. They are
 * searched from a catalog that is built once (see academicSearch.ts), so this
 * function never loads a document.
 */
import type { AppState, Slide } from '../types';
import { inferMaterialKind, isPresentationSlide } from './materialKind';
import { searchDeep } from './searchIndex';
import { caseSearchText, visibleCases } from './clinicalLearning';

export type SearchCategory =
  | 'Course'
  | 'Topic'
  | 'Study Material'
  | 'Note'
  | 'Question'
  | 'Objective'
  | 'Highlight'
  | 'Page'
  | 'In document'
  | 'Quiz'
  | 'Insight'
  | 'Chat'
  | 'Case';

export type SearchScope = 'current' | 'archive';

export interface SearchResult {
  id: string;
  title: string;
  category: SearchCategory;
  link: string;
  /** Matched text in context, when the hit was in a body rather than a title. */
  snippet?: string;
  /** Higher is better. */
  score: number;
  scope?: SearchScope;
  /** 'current' or an archive id. Used by the semester filter. */
  semesterKey?: string;
  semesterLabel?: string;
  archiveId?: string;
  archiveTitle?: string;
  courseId?: string;
  courseCode?: string;
  courseName?: string;
  topicId?: string;
  topicName?: string;
  materialId?: string;
  materialTitle?: string;
  /** pdf | pptx | ppt | docx | image | text | note | question | … */
  materialType?: string;
  /** True when the hit's text came from OCR. */
  ocr?: boolean;
  /** "Slide 23" or "Page 42". */
  location?: string;
  /** "Open Slide 23", "Open Note", … */
  action?: string;
  /** ISO date, when the item has one. */
  date?: string;
}

/** Static destinations so the bar doubles as a command palette. */
const PAGES: { title: string; link: string; keywords: string }[] = [
  { title: 'Dashboard', link: '/', keywords: 'home overview what should I do now today priorities' },
  { title: 'Academic Search', link: '/search', keywords: 'find search archive global' },
  { title: 'Study Materials', link: '/materials', keywords: 'upload pdf slides documents' },
  { title: 'Material Library', link: '/library', keywords: 'files powerpoint pdf favorites tags library' },
  { title: 'Study Bank', link: '/highlights', keywords: 'highlights saved insights' },
  { title: 'My Courses', link: '/courses', keywords: 'subjects modules' },
  { title: 'Learning Objectives', link: '/objectives', keywords: 'goals outcomes' },
  { title: 'Question Bank', link: '/questions', keywords: 'exam questions practice' },
  { title: 'Quiz Mode', link: '/quiz', keywords: 'test practice mcq' },
  { title: 'Study Planner', link: '/planner', keywords: 'schedule plan revision' },
  { title: 'What Should I Study Today', link: '/learn', keywords: 'revision spaced review due weak topics learning status' },
  { title: 'Clinical Learning', link: '/clinical', keywords: 'clinical case fictional pharmacy mechanism counseling monitoring dose' },
  { title: 'My Notes', link: '/notes', keywords: 'notes writing' },
  { title: 'Analytics', link: '/analytics', keywords: 'progress stats charts performance' },
  { title: 'Offline Timetable', link: '/timetable', keywords: 'schedule classes exams' },
  { title: 'Academic Archive', link: '/archive', keywords: 'past semesters history archive' },
  { title: 'Settings', link: '/settings', keywords: 'preferences backup export sign out account' },
  { title: 'Profile', link: '/profile', keywords: 'account name level program university' },
];

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Scores a haystack against every search term.
 * Returns 0 when any term is missing, so multi-word queries behave as AND.
 */
export const scoreQueryField = (haystack: string, terms: string[], weight: number): number => {
  if (!haystack) return 0;
  const hay = norm(haystack);
  let total = 0;

  for (const term of terms) {
    const at = hay.indexOf(term);
    if (at === -1) return 0; // every term must appear somewhere in this field

    let s = weight;
    if (at === 0) s += weight * 0.5;                                   // prefix match
    else if (/\s/.test(hay[at - 1] ?? '')) s += weight * 0.25;         // word-start match
    if (hay === term) s += weight;                                     // exact match
    // Shorter fields are more specific, so a hit in them means more.
    s += Math.max(0, 20 - hay.length / 12);
    total += s;
  }
  return total;
};

/** Pulls ~140 chars around the first hit so the user can see why it matched. */
export const snippetAround = (text: string, term: string): string | undefined => {
  const at = norm(text).indexOf(term);
  if (at === -1) return undefined;
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + term.length + 90);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
};

const scoreField = scoreQueryField;
const makeSnippet = snippetAround;

const currentSemesterLabel = (state: AppState): string => {
  const student = state.student;
  if (!student) return 'Current semester';
  return [student.level, student.semester].filter(Boolean).join(' · ') || 'Current semester';
};

const clip = (text: string, n: number) => text.slice(0, n) + (text.length > n ? '…' : '');

export const searchAll = (state: AppState, rawQuery: string, limit = 20): SearchResult[] => {
  const query = norm(rawQuery);
  if (query.length < 2) return [];

  const terms = query.split(/\s+/).filter(Boolean);
  const results: SearchResult[] = [];
  const push = (r: SearchResult) => { if (r.score > 0) results.push(r); };

  // Look up a topic's course so slide/topic results can show where they live.
  const topicById = new Map(state.topics.map((t) => [t.id, t]));
  const courseById = new Map(state.courses.map((c) => [c.id, c]));
  const slideById = new Map(state.slides.map((s) => [s.id, s]));

  const place = (topicId?: string, courseId?: string) => {
    const topic = topicId ? topicById.get(topicId) : undefined;
    const course = courseById.get(courseId || topic?.courseId || '');
    return { topic, course };
  };

  for (const c of state.courses) {
    const score = Math.max(
      scoreField(c.courseCode, terms, 100),
      scoreField(c.courseName, terms, 90),
      scoreField(c.lecturerName ?? '', terms, 40),
    );
    push({
      id: `c-${c.id}`,
      title: `${c.courseCode} — ${c.courseName}`,
      category: 'Course',
      link: `/course/${c.id}`,
      score,
      courseId: c.id,
      courseCode: c.courseCode,
      courseName: c.courseName,
      materialType: 'course',
      action: 'Open course',
      date: c.createdAt || undefined,
    });
  }

  for (const t of state.topics) {
    const course = courseById.get(t.courseId);
    push({
      id: `t-${t.id}`,
      title: t.topicName,
      category: 'Topic',
      link: `/read/${t.id}`,
      snippet: course ? `in ${course.courseCode}` : undefined,
      score: scoreField(t.topicName, terms, 80),
      courseId: course?.id,
      courseCode: course?.courseCode,
      courseName: course?.courseName,
      topicId: t.id,
      topicName: t.topicName,
      materialType: 'topic',
      action: 'Open topic',
      date: t.createdAt || undefined,
    });
  }

  for (const s of state.slides) {
    // Score title and body against the combined text so a query like
    // "propranolol hypertension" still matches when the words are far apart,
    // then weight by where the terms actually landed.
    const combined = `${s.title}\n${s.contentText ?? ''}`;
    if (scoreField(combined, terms, 1) <= 0) continue;

    const titleScore = scoreField(s.title, terms, 70);
    // Body text is weighted far lower so titles always win.
    const bodyScore = titleScore > 0 ? 0 : scoreField(combined, terms, 12);
    const score = titleScore || bodyScore;
    if (score <= 0) continue;

    const topic = topicById.get(s.topicId);
    const course = topic ? courseById.get(topic.courseId) : undefined;
    const kind = inferMaterialKind(s);
    push({
      id: `s-${s.id}`,
      title: s.title,
      category: 'Study Material',
      link: `/read/${s.topicId}?slide=${Math.max(0, s.slideNumber - 1)}`,
      snippet: bodyScore > 0
        ? makeSnippet(s.contentText ?? '', terms[0])
        : topic ? `in ${topic.topicName}` : undefined,
      score,
      courseId: course?.id,
      courseCode: course?.courseCode,
      courseName: course?.courseName,
      topicId: topic?.id,
      topicName: topic?.topicName,
      materialId: s.id,
      materialTitle: s.title,
      materialType: kind === 'unknown' ? (s.fileType || 'text') : kind,
      ocr: s.ocrStatus === 'done',
      action: 'Open material',
      date: s.createdAt || undefined,
    });
  }

  for (const n of state.notes) {
    const { topic, course } = place(n.topicId);
    const score = scoreField(n.noteText, terms, 50);
    push({
      id: `n-${n.id}`,
      title: clip(n.noteText, 60),
      category: 'Note',
      link: `/notes?note=${n.id}`,
      snippet: makeSnippet(n.noteText, terms[0]),
      score,
      courseId: course?.id,
      courseCode: course?.courseCode,
      courseName: course?.courseName,
      topicId: topic?.id,
      topicName: topic?.topicName,
      materialType: 'note',
      action: 'Open Note',
      date: n.createdAt || undefined,
    });
  }

  for (const q of state.examQuestions) {
    const { topic, course } = place(q.topicId, q.courseId);
    const score = Math.max(
      scoreField(q.questionText, terms, 55),
      scoreField(q.modelAnswer ?? '', terms, 20),
      scoreField(q.explanation ?? '', terms, 20),
      scoreField(q.correctAnswer ?? '', terms, 20),
      scoreField((q.tags ?? []).join(' '), terms, 30),
    );
    push({
      id: `q-${q.id}`,
      title: clip(q.questionText, 70),
      category: 'Question',
      link: `/questions?question=${q.id}`,
      snippet: makeSnippet(q.questionText, terms[0]) || makeSnippet(q.explanation ?? q.modelAnswer ?? '', terms[0]),
      score,
      courseId: course?.id ?? q.courseId,
      courseCode: course?.courseCode,
      courseName: course?.courseName,
      topicId: topic?.id ?? q.topicId,
      topicName: topic?.topicName,
      materialType: 'question',
      action: 'Open Question',
      date: q.createdAt || undefined,
    });
  }

  for (const item of visibleCases(state)) {
    const { topic, course } = place(item.topicId, item.courseId);
    const text = caseSearchText(item);
    const score = Math.max(scoreField(item.title, terms, 60), scoreField(text, terms, 24));
    push({
      id: `case-${item.id}`,
      title: item.title,
      category: 'Case',
      link: `/clinical?case=${encodeURIComponent(item.id)}`,
      snippet: makeSnippet(item.presentation, terms[0]) || makeSnippet(text, terms[0]),
      score,
      courseId: course?.id ?? item.courseId,
      courseCode: course?.courseCode,
      courseName: course?.courseName,
      topicId: topic?.id ?? item.topicId,
      topicName: topic?.topicName,
      materialType: 'case',
      action: 'Open case',
      date: item.createdAt || undefined,
    });
  }

  for (const lo of state.learningObjectives) {
    const { topic, course } = place(lo.topicId, lo.courseId);
    push({
      id: `lo-${lo.id}`,
      title: clip(lo.objectiveText, 70),
      category: 'Objective',
      link: `/objectives?course=${lo.courseId}&objective=${lo.id}`,
      score: scoreField(lo.objectiveText, terms, 45),
      courseId: course?.id ?? lo.courseId,
      courseCode: course?.courseCode,
      courseName: course?.courseName,
      topicId: topic?.id,
      topicName: topic?.topicName,
      materialType: 'objective',
      action: 'Open objective',
      date: lo.createdAt || undefined,
    });
  }

  for (const h of state.highlights) {
    const { topic, course } = place(h.topicId);
    const params = new URLSearchParams({ slide: String(h.slideIndex), highlight: h.id });
    if (h.page) params.set('page', String(h.page));
    const slide = h.materialId ? slideById.get(h.materialId) : undefined;
    push({
      id: `h-${h.id}`,
      title: clip(h.text, 70),
      category: 'Highlight',
      link: h.topicId ? `/read/${h.topicId}?${params.toString()}` : '/highlights',
      snippet: makeSnippet(h.text, terms[0]) || (h.note ? makeSnippet(h.note, terms[0]) : undefined),
      score: Math.max(scoreField(h.text, terms, 40), scoreField(h.note ?? '', terms, 28)),
      courseId: course?.id,
      courseCode: course?.courseCode,
      courseName: course?.courseName,
      topicId: topic?.id,
      topicName: topic?.topicName,
      materialId: h.materialId,
      materialTitle: slide?.title,
      materialType: 'highlight',
      location: h.page ? `Page ${h.page}` : undefined,
      action: 'Open highlight',
      date: h.timestamp || undefined,
    });
  }

  for (const quiz of state.quizHistory ?? []) {
    const course = courseById.get(quiz.courseId);
    const weak = (quiz.weakTopics ?? [])
      .map((id) => topicById.get(id)?.topicName)
      .filter(Boolean)
      .join(' ');
    const hay = `${course?.courseCode ?? ''} ${course?.courseName ?? ''} ${quiz.scorePercentage} ${weak} quiz`;
    push({
      id: `quiz-${quiz.id}`,
      title: `${course?.courseCode || 'Quiz'} · ${quiz.scorePercentage}%`,
      category: 'Quiz',
      link: `/quiz?quiz=${quiz.id}`,
      snippet: weak ? `Weak topics: ${weak}` : makeSnippet(hay, terms[0]),
      score: scoreField(hay, terms, 34),
      courseId: course?.id ?? quiz.courseId,
      courseCode: course?.courseCode,
      courseName: course?.courseName,
      materialType: 'quiz',
      action: 'Open quiz',
      date: quiz.completedAt || undefined,
    });
  }

  for (const insight of state.savedInsights ?? []) {
    const { topic, course } = place(insight.topicId);
    push({
      id: `insight-${insight.id}`,
      title: clip(insight.content, 70),
      category: 'Insight',
      link: `/highlights?insight=${insight.id}`,
      snippet: makeSnippet(insight.content, terms[0]),
      score: scoreField(insight.content, terms, 36),
      courseId: course?.id,
      courseCode: course?.courseCode,
      courseName: course?.courseName,
      topicId: topic?.id,
      topicName: topic?.topicName,
      materialType: 'insight',
      action: 'Open insight',
      date: insight.timestamp || undefined,
    });
  }

  for (const message of state.chatHistory ?? []) {
    const { topic, course } = place(message.topicId);
    push({
      id: `chat-${message.id}`,
      title: clip(message.content, 70),
      category: 'Chat',
      link: message.topicId ? `/read/${message.topicId}` : '/ai',
      snippet: makeSnippet(message.content, terms[0]),
      score: scoreField(message.content, terms, 32),
      courseId: course?.id,
      courseCode: course?.courseCode,
      courseName: course?.courseName,
      topicId: topic?.id,
      topicName: topic?.topicName,
      materialType: 'chat',
      action: 'Open chat',
      date: message.timestamp || undefined,
    });
  }

  // Full-text hits from inside uploaded documents. state.slides only holds a
  // 2000-char preview (localStorage quota), so without this a keyword deep in
  // a lecture is unfindable even though the text was extracted at upload.
  const seenDeep = new Set<string>();
  for (const hit of searchDeep(query)) {
    // Don't repeat a document already matched on its title above.
    const key = `${hit.materialId}-${hit.page}`;
    if (seenDeep.has(key)) continue;
    seenDeep.add(key);
    const slide = slideById.get(hit.materialId);
    const unit = unitLabel(slide, hit.page);
    const topic = topicById.get(slide?.topicId || hit.topicId);
    const course = topic ? courseById.get(topic.courseId) : undefined;
    const kind = slide ? inferMaterialKind(slide) : undefined;
    push({
      id: `d-${key}`,
      title: `${hit.title} → ${unit} ${hit.page}`,
      category: 'In document',
      link: `/read/${hit.topicId}?material=${hit.materialId}&page=${hit.page}&q=${encodeURIComponent(rawQuery.trim())}`,
      snippet: hit.snippet,
      // Sits just below a title match so named things still win, but above
      // generic page shortcuts.
      score: 46 + Math.min(hit.count, 8),
      courseId: course?.id,
      courseCode: course?.courseCode,
      courseName: course?.courseName,
      topicId: topic?.id ?? hit.topicId,
      topicName: topic?.topicName,
      materialId: hit.materialId,
      materialTitle: hit.title,
      materialType: kind && kind !== 'unknown' ? kind : slide?.fileType,
      ocr: slide?.ocrStatus === 'done',
      location: `${unit} ${hit.page}`,
      action: `Open ${unit} ${hit.page}`,
      date: slide?.createdAt || undefined,
    });
  }

  for (const p of PAGES) {
    const score = Math.max(
      scoreField(p.title, terms, 35),
      scoreField(p.keywords, terms, 18),
    );
    push({
      id: `p-${p.link}`,
      title: p.title,
      category: 'Page',
      link: p.link,
      snippet: 'Go to page',
      score,
      materialType: 'page',
      action: 'Open page',
    });
  }

  const semesterLabel = currentSemesterLabel(state);
  for (const result of results) {
    if (!result.scope) result.scope = 'current';
    if (!result.semesterKey) result.semesterKey = 'current';
    if (!result.semesterLabel) result.semesterLabel = semesterLabel;
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
};

/** Slide for a presentation, Page for a PDF / Word / image. */
export function unitLabel(slide: Slide | undefined, _page: number): 'Slide' | 'Page' {
  return slide && isPresentationSlide(slide) ? 'Slide' : 'Page';
}
