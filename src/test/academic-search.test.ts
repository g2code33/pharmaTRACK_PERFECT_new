/**
 * Phase 5: one offline academic search across the current semester, archived
 * semesters, and saved AI chats. Catalogs are built once. Ordinary search
 * never calls an AI provider and never lists every archive record per query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => { idbStore.set(k, v); },
  del: async (k: string) => { idbStore.delete(k); },
  keys: async () => [...idbStore.keys()],
}));

import { searchAcademic } from '../utils/academicSearch';
import { ensureArchiveCatalog, __resetArchiveCatalog, __archiveLoadCount } from '../utils/archiveCatalog';
import { ensureConversationIndex, __resetConversationIndex } from '../utils/conversationSearch';
import { __resetIndex } from '../utils/searchIndex';
import * as archives from '../utils/semesterArchive';
import type { AppState } from '../types';

const live = {
  isLoggedIn: false,
  student: null,
  courses: [{
    id: 'c1',
    courseCode: 'PHA301',
    courseName: 'Clinical Pharmacy',
    lecturerName: 'Dr Mensah',
    creditHours: 3,
    createdAt: '2025-09-01T00:00:00.000Z',
  }],
  topics: [{ id: 't1', courseId: 'c1', topicName: 'Hypertension', orderIndex: 0, createdAt: '2025-09-02T00:00:00.000Z' }],
  slides: [{
    id: 's1',
    topicId: 't1',
    slideNumber: 1,
    title: 'Hypertension lecture',
    contentText: '--- Slide 1 ---\nBlood pressure targets.',
    fileType: 'pptx',
    materialKind: 'pptx',
    status: 'not_started',
    createdAt: '2025-09-03T00:00:00.000Z',
  }],
  notes: [{
    id: 'n1',
    topicId: 't1',
    noteText: 'Amlodipine is a dihydropyridine calcium channel blocker.',
    createdAt: '2025-01-15T00:00:00.000Z',
  }],
  examQuestions: [{
    id: 'q1',
    courseId: 'c1',
    topicId: 't1',
    questionText: 'Which drug is first-line for uncomplicated hypertension?',
    questionType: 'mcq',
    difficulty: 'medium',
    marksAllocation: 2,
    createdAt: '2025-06-01T00:00:00.000Z',
  }],
  learningObjectives: [{
    id: 'lo1',
    courseId: 'c1',
    topicId: 't1',
    objectiveText: 'Explain the stepped approach to hypertension.',
    status: 'partial',
    createdAt: '2025-09-04T00:00:00.000Z',
  }],
  quizHistory: [{
    id: 'quiz1',
    courseId: 'c1',
    scorePercentage: 72,
    completedAt: '2025-08-01T00:00:00.000Z',
    questionsUsed: ['q1'],
    weakTopics: ['t1'],
  }],
  highlights: [{
    id: 'h1',
    topicId: 't1',
    materialId: 's1',
    text: 'Target clinic blood pressure below 140/90.',
    page: 4,
    timestamp: '2025-09-05T00:00:00.000Z',
  }],
  savedInsights: [{
    id: 'ins1',
    topicId: 't1',
    type: 'summary',
    content: 'Saved insight: monitor serum potassium with ACE inhibitors.',
    timestamp: '2025-09-06T00:00:00.000Z',
  }],
  chatHistory: [{
    id: 'chat1',
    topicId: 't1',
    role: 'assistant',
    content: 'Live chat: start with lifestyle advice before adding a second agent.',
    timestamp: '2025-09-07T00:00:00.000Z',
  }],
  studyPlans: [],
  examDates: [],
  activities: [],
  openAIKey: '',
  timetables: { class: [], quiz: [], exam: [] },
  timetablePdf: null,
} as unknown as AppState;

function seedArchive() {
  idbStore.set('semester_archive_arch1', {
    meta: {
      id: 'arch1',
      title: 'Level 200 — Semester 1',
      level: '200',
      semester: '1',
      academicYear: '2024/2025',
      completedAt: '2025-06-30T00:00:00.000Z',
      createdAt: '2025-06-30T00:00:00.000Z',
      status: 'verified',
      version: 1,
      itemCount: 3,
      fileCount: 0,
      totalBytes: 0,
      checksum: 'abc',
    },
    snapshot: {
      courses: [{
        id: 'ac1',
        courseCode: 'PHA201',
        courseName: 'Physical Pharmaceutics',
        createdAt: '2024-09-01T00:00:00.000Z',
      }],
      topics: [{
        id: 'at1',
        courseId: 'ac1',
        topicName: 'Emulsions',
        orderIndex: 0,
        createdAt: '2024-09-02T00:00:00.000Z',
      }],
      slides: [{
        id: 'as1',
        topicId: 'at1',
        slideNumber: 1,
        title: 'Emulsion lecture',
        fileType: 'pdf',
        materialKind: 'pdf',
        createdAt: '2024-10-01T00:00:00.000Z',
      }],
      notes: [{
        id: 'an1',
        topicId: 'at1',
        noteText: 'Archived note: emulsions are thermodynamically unstable.',
        createdAt: '2024-11-01T00:00:00.000Z',
      }],
      examQuestions: [],
      learningObjectives: [],
      highlights: [],
      quizHistory: [],
      savedInsights: [],
      chatHistory: [],
    },
    index: {
      as1: {
        materialId: 'as1',
        topicId: 'at1',
        title: 'Emulsion lecture',
        pages: [{ page: 42, text: 'Depyrogenation of glassware was covered in the archived lecture.' }],
      },
    },
    manifest: [],
  });
}

function seedConversation() {
  idbStore.set('pharmatrack_ai_conversations_index', [{
    id: 'conv1',
    title: 'Digoxin monitoring',
    createdAt: '2025-10-01T00:00:00.000Z',
    updatedAt: '2025-10-02T00:00:00.000Z',
    messageCount: 1,
    courseId: 'c1',
    topicId: 't1',
    materialId: 's1',
  }]);
  idbStore.set('pharmatrack_ai_conversation_conv1', {
    id: 'conv1',
    title: 'Digoxin monitoring',
    createdAt: '2025-10-01T00:00:00.000Z',
    updatedAt: '2025-10-02T00:00:00.000Z',
    courseId: 'c1',
    topicId: 't1',
    materialId: 's1',
    messages: [{ id: 'm1', role: 'assistant', content: 'Watch the narrow therapeutic index of digoxin.', timestamp: '2025-10-02T00:00:00.000Z' }],
  });
}

beforeEach(() => {
  idbStore.clear();
  __resetArchiveCatalog();
  __resetConversationIndex();
  __resetIndex();
});

describe('academic search', () => {
  it('finds current notes, questions, quizzes, insights and chats without an AI call', async () => {
    const hits = searchAcademic(live, 'hypertension');
    const categories = new Set(hits.map((h) => h.category));
    expect(categories.has('Course') || hits.some((h) => h.title.includes('Hypertension'))).toBe(true);
    expect(hits.some((h) => h.category === 'Question' && h.link === '/questions?question=q1')).toBe(true);
    expect(hits.some((h) => h.category === 'Study Material' && h.link === '/read/t1?slide=0')).toBe(true);
    expect(searchAcademic(live, 'amlodipine').some((h) => h.category === 'Note' && h.link === '/notes?note=n1')).toBe(true);
    expect(searchAcademic(live, 'potassium').some((h) => h.category === 'Insight' && h.link === '/highlights?insight=ins1')).toBe(true);
    expect(searchAcademic(live, 'lifestyle').some((h) => h.category === 'Chat' && h.link.startsWith('/read/t1'))).toBe(true);
    expect(searchAcademic(live, '72').some((h) => h.category === 'Quiz' && h.link === '/quiz?quiz=quiz1')).toBe(true);
    expect(searchAcademic(live, 'stepped').some((h) => h.category === 'Objective' && h.link.includes('objective=lo1'))).toBe(true);
  });

  it('keeps in-document titles and page links', async () => {
    const { indexDocument, loadSearchIndex } = await import('../utils/searchIndex');
    await loadSearchIndex();
    await indexDocument({
      materialId: 's1',
      topicId: 't1',
      title: 'Hypertension lecture',
      pages: [{ page: 23, text: 'Propranolol is used when a beta blocker is required.' }],
    });
    const hit = searchAcademic(live, 'propranolol').find((r) => r.category === 'In document');
    expect(hit?.title).toBe('Hypertension lecture → Slide 23');
    expect(hit?.action).toBe('Open Slide 23');
    expect(hit?.link).toContain('/read/t1?');
    expect(hit?.link).toContain('material=s1');
    expect(hit?.link).toContain('page=23');
    expect(hit?.link).toContain('q=propranolol');
  });

  it('filters by type, course, date and current/archive scope', async () => {
    seedArchive();
    await ensureArchiveCatalog();
    const notes = searchAcademic(live, 'amlodipine', { materialType: 'note' });
    expect(notes.every((h) => h.category === 'Note')).toBe(true);
    expect(notes.length).toBeGreaterThan(0);

    const questions = searchAcademic(live, 'hypertension', { materialType: 'question' });
    expect(questions.every((h) => h.category === 'Question')).toBe(true);

    const dated = searchAcademic(live, 'hypertension', { dateFrom: '2025-05-01', dateTo: '2025-07-01' });
    expect(dated.some((h) => h.id.includes('q1'))).toBe(true);
    expect(dated.some((h) => h.link === '/notes?note=n1')).toBe(false);

    const currentOnly = searchAcademic(live, 'emulsion', { scope: 'current' });
    expect(currentOnly).toEqual([]);
    const archived = searchAcademic(live, 'emulsion', { scope: 'archive' });
    expect(archived.some((h) => h.scope === 'archive' && h.link.includes('/archive/arch1?focus=note:an1'))).toBe(true);
    expect(archived.every((h) => h.scope === 'archive')).toBe(true);

    const byCourse = searchAcademic(live, 'hypertension', { courseId: 'missing' });
    expect(byCourse).toEqual([]);
  });

  it('opens an archived page from the catalog without listing archives on each search', async () => {
    const list = vi.spyOn(archives, 'listArchives');
    seedArchive();
    await ensureArchiveCatalog();
    const loads = __archiveLoadCount();
    expect(loads).toBe(1);
    expect(list).not.toHaveBeenCalled();

    const first = searchArchiveHit();
    expect(first?.title).toBe('Emulsion lecture → Page 42');
    expect(first?.location).toBe('Page 42');
    expect(first?.action).toBe('Open Page 42');
    expect(first?.link).toBe('/archive/arch1?focus=slide:as1&page=42');
    expect(first?.courseCode).toBe('PHA201');
    expect(first?.snippet).toContain('Depyrogenation');

    searchAcademic(live, 'depyrogenation');
    expect(__archiveLoadCount()).toBe(loads);
    expect(list).not.toHaveBeenCalled();

    await ensureArchiveCatalog();
    expect(__archiveLoadCount()).toBe(loads);
    list.mockRestore();
  });

  it('links a saved AI conversation and keeps course, topic and material', async () => {
    seedConversation();
    await ensureConversationIndex();
    const hit = searchAcademic(live, 'digoxin').find((h) => h.id === 'conv-conv1');
    expect(hit?.category).toBe('Chat');
    expect(hit?.action).toBe('Open conversation');
    expect(hit?.link).toContain('/ai?');
    expect(hit?.link).toContain('conversation=conv1');
    expect(hit?.link).toContain('course=c1');
    expect(hit?.link).toContain('topic=t1');
    expect(hit?.link).toContain('material=s1');
    expect(hit?.snippet?.toLowerCase()).toContain('digoxin');

    await ensureConversationIndex();
    const stored = idbStore.get('pharmatrack_conversation_search') as { entries: unknown[] };
    expect(stored.entries).toHaveLength(1);
  });

  it('ignores queries shorter than two characters', () => {
    expect(searchAcademic(live, 'a')).toEqual([]);
  });
});

function searchArchiveHit() {
  return searchAcademic(live, 'depyrogenation').find((h) => h.category === 'In document' && h.scope === 'archive');
}
