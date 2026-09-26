/**
 * Compact search catalog for archived semesters.
 *
 * listArchives() loads every archive record just to read its metadata. This
 * does not. Archive ids come from IndexedDB keys. A record is loaded only
 * when that archive is missing from the catalog, and only its snapshot and
 * page-text index are kept — never the uploaded binaries. Later searches
 * run against the catalog already in memory.
 */
import * as idb from 'idb-keyval';
import type { AppState, Slide } from '../types';
import type { ArchiveRecord } from './semesterArchive';
import { loadArchive } from './semesterArchive';
import { inferMaterialKind, isPresentationSlide } from './materialKind';
import { scoreQueryField, snippetAround, type SearchResult } from './search';
import { bumpSearchIndex } from './searchNotify';

const CATALOG_KEY = 'pharmatrack_archive_search_catalog';
const ARCHIVE_PREFIX = 'semester_archive_';
const FILE_PREFIX = 'semester_archive_file_';
const TEXT_PREFIX = 'semester_archive_text_';
const RECORD_PREFIX = 'semester_archive_record_';

interface CatalogStamp {
  id: string;
  checksum?: string;
  completedAt: string;
}

interface CatalogField {
  text: string;
  weight: number;
}

interface CatalogEntry {
  id: string;
  fields: CatalogField[];
  /** Text used only to build the snippet. */
  snippetText: string;
  /** Fixed score band for in-document hits, matching live deep search. */
  deep?: boolean;
  result: Omit<SearchResult, 'score' | 'snippet'>;
}

interface CatalogFile {
  version: 1;
  stamps: CatalogStamp[];
  entries: CatalogEntry[];
}

let entries: CatalogEntry[] = [];
let stamps: CatalogStamp[] = [];
let ready = false;
let inflight: Promise<void> | null = null;
let archiveLoads = 0;
let postings: Map<string, number[]> | null = null;

const isMetaKey = (key: string): boolean =>
  key.startsWith(ARCHIVE_PREFIX) &&
  !key.startsWith(FILE_PREFIX) &&
  !key.startsWith(TEXT_PREFIX) &&
  !key.startsWith(RECORD_PREFIX);

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** Head of the page, plus unique later words so a keyword past the cap still matches. */
const searchableText = (text: string): string => {
  if (text.length <= 8000) return text;
  const head = text.slice(0, 8000);
  const extra = text.slice(8000).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return `${head}\n${[...new Set(extra)].slice(0, 400).join(' ')}`;
};

const unitOf = (slide: Slide | undefined): 'Slide' | 'Page' =>
  (slide && isPresentationSlide(slide) ? 'Slide' : 'Page');

const kindOf = (slide: Slide | undefined): string | undefined => {
  if (!slide) return undefined;
  const kind = inferMaterialKind(slide);
  return kind === 'unknown' ? (slide.fileType || 'text') : kind;
};

function entry(partial: Omit<CatalogEntry, 'fields' | 'snippetText'> & { fields: CatalogField[]; snippetText: string }): CatalogEntry {
  return partial;
}

export function entriesFromArchive(record: ArchiveRecord): CatalogEntry[] {
  const snap = record.snapshot as unknown as AppState;
  const archiveId = record.meta.id;
  const semesterLabel = record.meta.title || 'Archived semester';
  const base = {
    scope: 'archive' as const,
    semesterKey: archiveId,
    semesterLabel,
    archiveId,
    archiveTitle: semesterLabel,
  };
  const courses = snap.courses ?? [];
  const topics = snap.topics ?? [];
  const slides = snap.slides ?? [];
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const slideById = new Map(slides.map((s) => [s.id, s]));
  const place = (topicId?: string, courseId?: string) => {
    const topic = topicId ? topicById.get(topicId) : undefined;
    const course = courseById.get(courseId || topic?.courseId || '');
    return { topic, course };
  };
  const out: CatalogEntry[] = [];
  const link = (focus: string, page?: number) => {
    // Keep the colon readable. focus is `kind:id`; the viewer decodes either form.
    const pagePart = page ? `&page=${page}` : '';
    return `/archive/${archiveId}?focus=${focus}${pagePart}`;
  };

  for (const course of courses) {
    out.push(entry({
      id: `arch-${archiveId}-c-${course.id}`,
      fields: [
        { text: course.courseCode, weight: 100 },
        { text: course.courseName, weight: 90 },
        { text: course.lecturerName ?? '', weight: 40 },
      ],
      snippetText: course.courseName,
      result: {
        ...base,
        id: `arch-${archiveId}-c-${course.id}`,
        title: `${course.courseCode} — ${course.courseName}`,
        category: 'Course',
        link: link(`course:${course.id}`),
        courseId: course.id,
        courseCode: course.courseCode,
        courseName: course.courseName,
        materialType: 'course',
        action: 'Open course',
        date: course.createdAt || record.meta.completedAt,
      },
    }));
  }

  for (const topic of topics) {
    const course = courseById.get(topic.courseId);
    out.push(entry({
      id: `arch-${archiveId}-t-${topic.id}`,
      fields: [{ text: topic.topicName, weight: 80 }],
      snippetText: course ? `in ${course.courseCode}` : topic.topicName,
      result: {
        ...base,
        id: `arch-${archiveId}-t-${topic.id}`,
        title: topic.topicName,
        category: 'Topic',
        link: link(`topic:${topic.id}`),
        courseId: course?.id,
        courseCode: course?.courseCode,
        courseName: course?.courseName,
        topicId: topic.id,
        topicName: topic.topicName,
        materialType: 'topic',
        action: 'Open topic',
        date: topic.createdAt || record.meta.completedAt,
      },
    }));
  }

  for (const slide of slides) {
    const { topic, course } = place(slide.topicId);
    const kind = kindOf(slide);
    out.push(entry({
      id: `arch-${archiveId}-s-${slide.id}`,
      fields: [
        { text: slide.title, weight: 70 },
        { text: `${slide.title}\n${slide.contentText ?? ''}`, weight: 12 },
      ],
      snippetText: slide.contentText || slide.title,
      result: {
        ...base,
        id: `arch-${archiveId}-s-${slide.id}`,
        title: slide.title,
        category: 'Study Material',
        link: link(`slide:${slide.id}`),
        courseId: course?.id,
        courseCode: course?.courseCode,
        courseName: course?.courseName,
        topicId: topic?.id,
        topicName: topic?.topicName,
        materialId: slide.id,
        materialTitle: slide.title,
        materialType: kind,
        ocr: slide.ocrStatus === 'done',
        action: 'Open material',
        date: slide.createdAt || record.meta.completedAt,
      },
    }));
  }

  for (const doc of Object.values(record.index ?? {})) {
    const slide = slideById.get(doc.materialId);
    const { topic, course } = place(slide?.topicId || doc.topicId);
    const unit = unitOf(slide);
    const kind = kindOf(slide);
    for (const page of doc.pages) {
      if (!page.text?.trim()) continue;
      const text = searchableText(page.text);
      const id = `arch-${archiveId}-d-${doc.materialId}-${page.page}`;
      out.push(entry({
        id,
        deep: true,
        fields: [{ text, weight: 1 }],
        snippetText: text,
        result: {
          ...base,
          id,
          title: `${doc.title} → ${unit} ${page.page}`,
          category: 'In document',
          link: link(`slide:${doc.materialId}`, page.page),
          courseId: course?.id,
          courseCode: course?.courseCode,
          courseName: course?.courseName,
          topicId: topic?.id ?? doc.topicId,
          topicName: topic?.topicName,
          materialId: doc.materialId,
          materialTitle: doc.title,
          materialType: kind,
          ocr: slide?.ocrStatus === 'done',
          location: `${unit} ${page.page}`,
          action: `Open ${unit} ${page.page}`,
          date: slide?.createdAt || record.meta.completedAt,
        },
      }));
    }
  }

  for (const note of snap.notes ?? []) {
    const { topic, course } = place(note.topicId);
    out.push(entry({
      id: `arch-${archiveId}-n-${note.id}`,
      fields: [{ text: note.noteText, weight: 50 }],
      snippetText: note.noteText,
      result: {
        ...base,
        id: `arch-${archiveId}-n-${note.id}`,
        title: clip(note.noteText, 60),
        category: 'Note',
        link: link(`note:${note.id}`),
        courseId: course?.id,
        courseCode: course?.courseCode,
        courseName: course?.courseName,
        topicId: topic?.id,
        topicName: topic?.topicName,
        materialType: 'note',
        action: 'Open Note',
        date: note.createdAt || record.meta.completedAt,
      },
    }));
  }

  for (const question of snap.examQuestions ?? []) {
    const { topic, course } = place(question.topicId, question.courseId);
    out.push(entry({
      id: `arch-${archiveId}-q-${question.id}`,
      fields: [
        { text: question.questionText, weight: 55 },
        { text: question.modelAnswer ?? '', weight: 20 },
        { text: (question.tags ?? []).join(' '), weight: 30 },
      ],
      snippetText: question.questionText,
      result: {
        ...base,
        id: `arch-${archiveId}-q-${question.id}`,
        title: clip(question.questionText, 70),
        category: 'Question',
        link: link(`question:${question.id}`),
        courseId: course?.id ?? question.courseId,
        courseCode: course?.courseCode,
        courseName: course?.courseName,
        topicId: topic?.id ?? question.topicId,
        topicName: topic?.topicName,
        materialType: 'question',
        action: 'Open Question',
        date: question.createdAt || record.meta.completedAt,
      },
    }));
  }

  for (const objective of snap.learningObjectives ?? []) {
    const { topic, course } = place(objective.topicId, objective.courseId);
    out.push(entry({
      id: `arch-${archiveId}-lo-${objective.id}`,
      fields: [{ text: objective.objectiveText, weight: 45 }],
      snippetText: objective.objectiveText,
      result: {
        ...base,
        id: `arch-${archiveId}-lo-${objective.id}`,
        title: clip(objective.objectiveText, 70),
        category: 'Objective',
        link: link(`objective:${objective.id}`),
        courseId: course?.id ?? objective.courseId,
        courseCode: course?.courseCode,
        courseName: course?.courseName,
        topicId: topic?.id,
        topicName: topic?.topicName,
        materialType: 'objective',
        action: 'Open objective',
        date: objective.createdAt || record.meta.completedAt,
      },
    }));
  }

  for (const highlight of snap.highlights ?? []) {
    const { topic, course } = place(highlight.topicId);
    out.push(entry({
      id: `arch-${archiveId}-h-${highlight.id}`,
      fields: [
        { text: highlight.text, weight: 40 },
        { text: highlight.note ?? '', weight: 28 },
      ],
      snippetText: highlight.text,
      result: {
        ...base,
        id: `arch-${archiveId}-h-${highlight.id}`,
        title: clip(highlight.text, 70),
        category: 'Highlight',
        link: link(`highlight:${highlight.id}`),
        courseId: course?.id,
        courseCode: course?.courseCode,
        courseName: course?.courseName,
        topicId: topic?.id,
        topicName: topic?.topicName,
        materialType: 'highlight',
        location: highlight.page ? `Page ${highlight.page}` : undefined,
        action: 'Open highlight',
        date: highlight.timestamp || record.meta.completedAt,
      },
    }));
  }

  for (const quiz of snap.quizHistory ?? []) {
    const course = courseById.get(quiz.courseId);
    const weak = (quiz.weakTopics ?? []).map((id) => topicById.get(id)?.topicName).filter(Boolean).join(' ');
    const hay = `${course?.courseCode ?? ''} ${course?.courseName ?? ''} ${quiz.scorePercentage} ${weak} quiz`;
    out.push(entry({
      id: `arch-${archiveId}-quiz-${quiz.id}`,
      fields: [{ text: hay, weight: 34 }],
      snippetText: weak ? `Weak topics: ${weak}` : hay,
      result: {
        ...base,
        id: `arch-${archiveId}-quiz-${quiz.id}`,
        title: `${course?.courseCode || 'Quiz'} · ${quiz.scorePercentage}%`,
        category: 'Quiz',
        link: link(`quiz:${quiz.id}`),
        courseId: course?.id ?? quiz.courseId,
        courseCode: course?.courseCode,
        courseName: course?.courseName,
        materialType: 'quiz',
        action: 'Open quiz',
        date: quiz.completedAt || record.meta.completedAt,
      },
    }));
  }

  for (const insight of snap.savedInsights ?? []) {
    const { topic, course } = place(insight.topicId);
    out.push(entry({
      id: `arch-${archiveId}-insight-${insight.id}`,
      fields: [{ text: insight.content, weight: 36 }],
      snippetText: insight.content,
      result: {
        ...base,
        id: `arch-${archiveId}-insight-${insight.id}`,
        title: clip(insight.content, 70),
        category: 'Insight',
        link: link(`insight:${insight.id}`),
        courseId: course?.id,
        courseCode: course?.courseCode,
        courseName: course?.courseName,
        topicId: topic?.id,
        topicName: topic?.topicName,
        materialType: 'insight',
        action: 'Open insight',
        date: insight.timestamp || record.meta.completedAt,
      },
    }));
  }

  for (const message of snap.chatHistory ?? []) {
    const { topic, course } = place(message.topicId);
    out.push(entry({
      id: `arch-${archiveId}-chat-${message.id}`,
      fields: [{ text: message.content, weight: 32 }],
      snippetText: message.content,
      result: {
        ...base,
        id: `arch-${archiveId}-chat-${message.id}`,
        title: clip(message.content, 70),
        category: 'Chat',
        link: link(`chat:${message.id}`),
        courseId: course?.id,
        courseCode: course?.courseCode,
        courseName: course?.courseName,
        topicId: topic?.id,
        topicName: topic?.topicName,
        materialType: 'chat',
        action: 'Open chat',
        date: message.timestamp || record.meta.completedAt,
      },
    }));
  }

  return out;
}

async function conversationEntries(record: ArchiveRecord): Promise<CatalogEntry[]> {
  const archiveId = record.meta.id;
  const semesterLabel = record.meta.title || 'Archived semester';
  const out: CatalogEntry[] = [];
  for (const item of record.manifest ?? []) {
    if (item.kind !== 'record' || !item.sourceKey.startsWith('pharmatrack_ai_conversation_')) continue;
    let value: { id?: string; title?: string; messages?: { content?: string }[]; topicId?: string; courseId?: string; updatedAt?: string } | null = null;
    try {
      value = (await idb.get(item.archiveKey)) ?? null;
    } catch {
      value = null;
    }
    if (!value || typeof value !== 'object') continue;
    const text = (value.messages ?? []).map((m) => m.content || '').filter(Boolean).join('\n');
    if (!text.trim()) continue;
    const id = `arch-${archiveId}-aichat-${value.id || item.sourceKey}`;
    out.push(entry({
      id,
      fields: [
        { text: value.title || '', weight: 40 },
        { text: searchableText(text), weight: 32 },
      ],
      snippetText: text,
      result: {
        id,
        title: value.title || 'AI conversation',
        category: 'Chat',
        link: `/archive/${archiveId}?focus=aichat:${value.id || ''}`,
        scope: 'archive',
        semesterKey: archiveId,
        semesterLabel,
        archiveId,
        archiveTitle: semesterLabel,
        courseId: value.courseId,
        topicId: value.topicId,
        materialType: 'chat',
        action: 'Open conversation',
        date: value.updatedAt || record.meta.completedAt,
      },
    }));
  }
  return out;
}

function rebuildPostings(): void {
  const map = new Map<string, number[]>();
  entries.forEach((item, index) => {
    const hay = item.fields.map((f) => f.text).join('\n').toLowerCase();
    const seen = new Set<string>();
    for (let i = 0; i <= hay.length - 3; i++) {
      const gram = hay.slice(i, i + 3);
      if (seen.has(gram)) continue;
      seen.add(gram);
      const list = map.get(gram);
      if (list) list.push(index);
      else map.set(gram, [index]);
    }
  });
  postings = map;
}

function adopt(file: CatalogFile): void {
  entries = file.entries ?? [];
  stamps = file.stamps ?? [];
  ready = true;
  rebuildPostings();
  bumpSearchIndex();
}

async function persist(): Promise<void> {
  const file: CatalogFile = { version: 1, stamps, entries };
  try {
    await idb.set(CATALOG_KEY, file);
  } catch (err) {
    console.error('Could not save the archive search catalog:', err);
  }
}

export async function ensureArchiveCatalog(force = false): Promise<void> {
  if (ready && !force) return;
  if (inflight && !force) return inflight;
  const run = (async () => {
    let keys: string[];
    try {
      keys = await idb.keys<string>();
    } catch (err) {
      // IndexedDB can be unavailable (private mode, or a test environment).
      // Search still works against the current semester already in memory.
      console.error('Could not build the archive search catalog:', err);
      return;
    }
    const ids = keys.filter(isMetaKey).map((key) => key.slice(ARCHIVE_PREFIX.length));
    let cached: CatalogFile | null = null;
    if (!force) {
      try { cached = (await idb.get<CatalogFile>(CATALOG_KEY)) ?? null; } catch { cached = null; }
    }
    const cachedIds = new Set((cached?.stamps ?? []).map((s) => s.id));
    const same = !!cached && ids.length === cached.stamps.length && ids.every((id) => cachedIds.has(id));
    if (same && cached) {
      adopt(cached);
      return;
    }

    const kept = force || !cached ? [] : cached.entries.filter((e) => e.result.archiveId && ids.includes(e.result.archiveId));
    const have = new Set(force || !cached ? [] : cached.stamps.map((s) => s.id));
    const nextEntries = force ? [] : [...kept];
    const nextStamps: CatalogStamp[] = [];

    for (const id of ids) {
      if (!force && have.has(id) && cached) {
        const stamp = cached.stamps.find((s) => s.id === id);
        if (stamp) nextStamps.push(stamp);
        continue;
      }
      archiveLoads++;
      const record = await loadArchive(id);
      if (!record?.snapshot) continue;
      nextEntries.push(...entriesFromArchive(record), ...(await conversationEntries(record)));
      nextStamps.push({ id, checksum: record.meta.checksum, completedAt: record.meta.completedAt });
    }

    entries = nextEntries;
    stamps = nextStamps;
    ready = true;
    rebuildPostings();
    await persist();
    bumpSearchIndex();
  })().finally(() => { inflight = null; });
  inflight = run;
  return run;
}

export function rebuildArchiveCatalog(): Promise<void> {
  ready = false;
  return ensureArchiveCatalog(true);
}

export function archiveCatalogStatus(): { ready: boolean; archives: number; entries: number } {
  return { ready, archives: stamps.length, entries: entries.length };
}

export interface ArchiveFacet {
  id: string;
  title: string;
}

export function archiveFacets(): {
  archives: ArchiveFacet[];
  courses: { id: string; code: string; name: string; archiveId: string; semesterLabel?: string }[];
  topics: { id: string; name: string; courseId?: string; archiveId: string }[];
} {
  const archives = stamps.map((s) => ({
    id: s.id,
    title: entries.find((e) => e.result.archiveId === s.id)?.result.semesterLabel || s.id,
  }));
  const courses: { id: string; code: string; name: string; archiveId: string; semesterLabel?: string }[] = [];
  const topics: { id: string; name: string; courseId?: string; archiveId: string }[] = [];
  const seenC = new Set<string>();
  const seenT = new Set<string>();
  for (const item of entries) {
    const r = item.result;
    if (r.category === 'Course' && r.courseId && r.archiveId && !seenC.has(r.courseId)) {
      seenC.add(r.courseId);
      courses.push({
        id: r.courseId,
        code: r.courseCode || '',
        name: r.courseName || r.title,
        archiveId: r.archiveId,
        semesterLabel: r.semesterLabel,
      });
    }
    if (r.category === 'Topic' && r.topicId && r.archiveId && !seenT.has(r.topicId)) {
      seenT.add(r.topicId);
      topics.push({ id: r.topicId, name: r.topicName || r.title, courseId: r.courseId, archiveId: r.archiveId });
    }
  }
  return { archives, courses, topics };
}

const termCount = (text: string, term: string): number => {
  const hay = text.toLowerCase();
  let count = 0;
  let from = 0;
  let at = hay.indexOf(term, from);
  while (at !== -1 && count < 50) {
    count++;
    from = at + term.length;
    at = hay.indexOf(term, from);
  }
  return count;
};

export function searchArchiveCatalog(rawQuery: string, limit = 30): SearchResult[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < 2 || entries.length === 0) return [];
  const terms = query.split(/\s+/).filter(Boolean);
  const index = postings ?? new Map<string, number[]>();

  let candidates: Set<number> | null = null;
  let scanAll = false;
  for (const term of terms) {
    if (term.length < 3) {
      scanAll = true;
      continue;
    }
    const lists: number[][] = [];
    for (let i = 0; i <= term.length - 3; i++) {
      const list = index.get(term.slice(i, i + 3));
      if (!list) return [];
      lists.push(list);
    }
    lists.sort((a, b) => a.length - b.length);
    let acc = new Set(lists[0]);
    for (let i = 1; i < lists.length; i++) {
      const next = new Set<number>();
      for (const n of lists[i]) if (acc.has(n)) next.add(n);
      acc = next;
      if (acc.size === 0) break;
    }
    if (acc.size === 0) return [];
    if (!candidates) candidates = acc;
    else {
      const next = new Set<number>();
      for (const n of acc) if (candidates.has(n)) next.add(n);
      candidates = next;
      if (candidates.size === 0) return [];
    }
  }

  const indexes = !candidates || (scanAll && terms.every((t) => t.length < 3))
    ? entries.map((_, i) => i)
    : [...candidates];

  const hits: SearchResult[] = [];
  for (const i of indexes) {
    const item = entries[i];
    if (!item) continue;
    let score = 0;
    for (const field of item.fields) {
      score = Math.max(score, scoreQueryField(field.text, terms, field.weight));
    }
    if (score <= 0) continue;
    if (item.deep) score = 46 + Math.min(termCount(item.snippetText, terms[0]), 8);
    hits.push({
      ...item.result,
      score,
      snippet: item.deep
        ? (snippetAround(item.snippetText, terms[0]) ?? item.result.location)
        : (item.result.category === 'Topic' ? item.snippetText : snippetAround(item.snippetText, terms[0])),
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function __resetArchiveCatalog(): void {
  entries = [];
  stamps = [];
  ready = false;
  inflight = null;
  archiveLoads = 0;
  postings = null;
}

export function __archiveLoadCount(): number {
  return archiveLoads;
}
