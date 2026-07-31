/**
 * Global search across every kind of content in the app.
 *
 * Design notes:
 *  - Ranked, not just filtered. A title match must beat a body-text match, or
 *    the thing you typed the name of ends up buried under slide contents.
 *  - Multi-term AND. "beta blocker" should find a slide containing both words
 *    even if they are far apart; substring matching alone fails that.
 *  - Snippets. For long slide text, showing the matched phrase in context is
 *    the difference between a useful result and a title you can't place.
 *  - Synchronous and local. Runs against in-memory state so it works offline
 *    with no async lookup, which is the whole point of this app.
 */
import type { AppState } from '../types';

export type SearchCategory =
  | 'Course'
  | 'Topic'
  | 'Study Material'
  | 'Note'
  | 'Question'
  | 'Objective'
  | 'Highlight'
  | 'Page';

export interface SearchResult {
  id: string;
  title: string;
  category: SearchCategory;
  link: string;
  /** Matched text in context, when the hit was in a body rather than a title. */
  snippet?: string;
  /** Higher is better. */
  score: number;
}

/** Static destinations so the bar doubles as a command palette. */
const PAGES: { title: string; link: string; keywords: string }[] = [
  { title: 'Dashboard', link: '/', keywords: 'home overview' },
  { title: 'Study Materials', link: '/materials', keywords: 'upload pdf slides documents' },
  { title: 'Study Bank', link: '/highlights', keywords: 'highlights saved insights' },
  { title: 'My Courses', link: '/courses', keywords: 'subjects modules' },
  { title: 'Learning Objectives', link: '/objectives', keywords: 'goals outcomes' },
  { title: 'Question Bank', link: '/questions', keywords: 'exam questions practice' },
  { title: 'Quiz Mode', link: '/quiz', keywords: 'test practice mcq' },
  { title: 'Study Planner', link: '/planner', keywords: 'schedule plan revision' },
  { title: 'My Notes', link: '/notes', keywords: 'notes writing' },
  { title: 'Analytics', link: '/analytics', keywords: 'progress stats charts performance' },
  { title: 'Offline Timetable', link: '/timetable', keywords: 'schedule classes exams' },
  { title: 'Settings', link: '/settings', keywords: 'preferences backup export sign out account' },
  { title: 'Profile', link: '/profile', keywords: 'account name level program university' },
];

const norm = (s: string) => s.toLowerCase().trim();

/**
 * Scores a haystack against every search term.
 * Returns 0 when any term is missing, so multi-word queries behave as AND.
 */
const scoreField = (haystack: string, terms: string[], weight: number): number => {
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
const makeSnippet = (text: string, term: string): string | undefined => {
  const at = norm(text).indexOf(term);
  if (at === -1) return undefined;
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + term.length + 90);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
};

export const searchAll = (state: AppState, rawQuery: string, limit = 20): SearchResult[] => {
  const query = norm(rawQuery);
  if (query.length < 2) return [];

  const terms = query.split(/\s+/).filter(Boolean);
  const results: SearchResult[] = [];
  const push = (r: SearchResult) => { if (r.score > 0) results.push(r); };

  // Look up a topic's course so slide/topic results can show where they live.
  const topicById = new Map(state.topics.map((t) => [t.id, t]));
  const courseById = new Map(state.courses.map((c) => [c.id, c]));

  for (const c of state.courses) {
    const score = Math.max(
      scoreField(c.courseCode, terms, 100),
      scoreField(c.courseName, terms, 90),
      scoreField(c.lecturerName ?? '', terms, 40),
    );
    push({ id: `c-${c.id}`, title: `${c.courseCode} — ${c.courseName}`, category: 'Course', link: `/course/${c.id}`, score });
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
    push({
      id: `s-${s.id}`,
      title: s.title,
      category: 'Study Material',
      link: `/read/${s.topicId}?slide=${Math.max(0, s.slideNumber - 1)}`,
      snippet: bodyScore > 0
        ? makeSnippet(s.contentText ?? '', terms[0])
        : topic ? `in ${topic.topicName}` : undefined,
      score,
    });
  }

  for (const n of state.notes) {
    const score = scoreField(n.noteText, terms, 50);
    push({
      id: `n-${n.id}`,
      title: n.noteText.slice(0, 60) + (n.noteText.length > 60 ? '…' : ''),
      category: 'Note',
      link: '/notes',
      snippet: makeSnippet(n.noteText, terms[0]),
      score,
    });
  }

  for (const q of state.examQuestions) {
    const score = Math.max(
      scoreField(q.questionText, terms, 55),
      scoreField(q.modelAnswer ?? '', terms, 20),
      scoreField((q.tags ?? []).join(' '), terms, 30),
    );
    push({
      id: `q-${q.id}`,
      title: q.questionText.slice(0, 70) + (q.questionText.length > 70 ? '…' : ''),
      category: 'Question',
      link: '/questions',
      snippet: makeSnippet(q.questionText, terms[0]),
      score,
    });
  }

  for (const lo of state.learningObjectives) {
    push({
      id: `lo-${lo.id}`,
      title: lo.objectiveText.slice(0, 70) + (lo.objectiveText.length > 70 ? '…' : ''),
      category: 'Objective',
      link: '/objectives',
      score: scoreField(lo.objectiveText, terms, 45),
    });
  }

  for (const h of state.highlights) {
    push({
      id: `h-${h.id}`,
      title: h.text.slice(0, 70) + (h.text.length > 70 ? '…' : ''),
      category: 'Highlight',
      link: '/highlights',
      snippet: makeSnippet(h.text, terms[0]),
      score: scoreField(h.text, terms, 40),
    });
  }

  for (const p of PAGES) {
    const score = Math.max(
      scoreField(p.title, terms, 35),
      scoreField(p.keywords, terms, 18),
    );
    push({ id: `p-${p.link}`, title: p.title, category: 'Page', link: p.link, snippet: 'Go to page', score });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
};
