/**
 * Material Library catalogue and file-kind detection.
 *
 * Presentations were stored as text with the extension removed, so the library
 * and the reader have to recognise them without that name.
 */
import { describe, it, expect } from 'vitest';
import type { AppState } from '../types';
import {
  inferMaterialKind,
  isPresentationSlide,
  shouldOpenAsPresentation,
  sniffMaterialKind,
} from '../utils/materialKind';
import { buildLibrary, filterLibrary, recentLibrary, visibleRange } from '../utils/materialLibrary';

const state = {
  isLoggedIn: false,
  student: { id: 'u1', name: 'Ama', university: 'UCC', level: '200', program: 'Pharm', semester: '2nd', createdAt: '' },
  courses: [
    { id: 'c1', studentId: 'u1', courseCode: 'PHM214', courseName: 'Pharmacology', lecturerName: '', semester: '1st', creditHours: 3, createdAt: '' },
  ],
  topics: [{ id: 't1', courseId: 'c1', topicName: 'Beta blockers', orderIndex: 0, createdAt: '' }],
  slides: [
    {
      id: 'deck',
      topicId: 't1',
      slideNumber: 1,
      title: 'Beta blockers',
      contentText: '--- Slide 1 ---\nPropranolol',
      fileType: 'text',
      status: 'not_started',
      createdAt: '2026-01-10T00:00:00.000Z',
      fileSize: 2_400_000,
      pageCount: 40,
      ocrStatus: 'not_needed',
      favorite: true,
      tags: ['cardio'],
      lastOpenedAt: '2026-03-02T00:00:00.000Z',
      lastPosition: 23,
    },
    {
      id: 'notes',
      topicId: 't1',
      slideNumber: 2,
      title: 'Tutorial notes',
      contentText: 'A short note.',
      fileType: 'pdf',
      materialKind: 'pdf',
      status: 'not_started',
      createdAt: '2026-02-01T00:00:00.000Z',
      fileSize: 80_000,
      pageCount: 4,
      ocrStatus: 'done',
      favorite: false,
      tags: [],
      lastOpenedAt: '2026-03-01T00:00:00.000Z',
      lastPosition: 2,
    },
  ],
  notes: [],
  examQuestions: [],
  learningObjectives: [],
  highlights: [],
  quizHistory: [],
  studyPlans: [],
  examDates: [],
  activities: [],
  chatHistory: [],
  savedInsights: [],
  openAIKey: '',
  timetables: { class: [], quiz: [], exam: [] },
  timetablePdf: null,
} as unknown as AppState;

describe('material kind', () => {
  it('treats extracted slide text as a presentation even without a .pptx name', () => {
    const slide = state.slides[0];
    expect(inferMaterialKind(slide)).toBe('pptx');
    expect(isPresentationSlide(slide)).toBe(true);
    expect(shouldOpenAsPresentation(slide, null)).toBe(true);
  });

  it('does not treat a Word file as slides', () => {
    expect(isPresentationSlide({ title: 'Essay', fileType: 'text', contentText: 'Hello', materialKind: 'docx' })).toBe(false);
    expect(shouldOpenAsPresentation({ title: 'Essay', fileType: 'text', contentText: 'Hello' }, 'docx')).toBe(false);
  });

  it('sniffs pdf, pptx and legacy PowerPoint without reading the whole file', () => {
    expect(sniffMaterialKind(new TextEncoder().encode('%PDF-1.7'))).toBe('pdf');

    const pptx = new Uint8Array(80);
    pptx.set([0x50, 0x4b, 0x03, 0x04], 0);
    pptx.set(new TextEncoder().encode('ppt/presentation.xml'), 10);
    expect(sniffMaterialKind(pptx)).toBe('pptx');

    const word = new Uint8Array(80);
    word.set([0x50, 0x4b, 0x03, 0x04], 0);
    word.set(new TextEncoder().encode('word/document.xml'), 10);
    expect(sniffMaterialKind(word)).toBe('docx');

    const ole = new Uint8Array(64);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
    ole.set(new TextEncoder().encode('PowerPoint'), 16);
    expect(sniffMaterialKind(ole)).toBe('ppt');
    expect(shouldOpenAsPresentation({ title: 'Lecture', fileType: 'text', contentText: '' }, 'ppt')).toBe(true);
  });
});

describe('material library catalogue', () => {
  const items = buildLibrary(state);

  it('shows the fields a student needs to find a file', () => {
    const deck = items.find((item) => item.id === 'deck')!;
    expect(deck.title).toBe('Beta blockers');
    expect(deck.courseCode).toBe('PHM214');
    expect(deck.topicName).toBe('Beta blockers');
    expect(deck.semester).toBe('1st');
    expect(deck.typeLabel).toBe('PowerPoint');
    expect(deck.fileSize).toBe(2_400_000);
    expect(deck.pageCount).toBe(40);
    expect(deck.ocrStatus).toBe('not_needed');
    expect(deck.lastPosition).toBe(23);
    expect(deck.favorite).toBe(true);
    expect(deck.tags).toEqual(['cardio']);
    expect(deck.openLink).toBe('/read/t1?material=deck&page=23');
    expect(deck.positionUnit).toBe('Slide');
  });

  it('filters favorites, course, and a multi-word search', () => {
    expect(filterLibrary(items, {
      query: 'beta cardio',
      kind: 'all',
      courseId: 'c1',
      semester: '',
      favoritesOnly: true,
      recentOnly: false,
      sort: 'title',
    }).map((item) => item.id)).toEqual(['deck']);
    expect(filterLibrary(items, {
      query: '',
      kind: 'pdf',
      courseId: '',
      semester: '1st',
      favoritesOnly: false,
      recentOnly: false,
      sort: 'uploaded',
    }).map((item) => item.id)).toEqual(['notes']);
  });

  it('sorts recently opened and keeps a short recent strip', () => {
    const recent = filterLibrary(items, {
      query: '',
      kind: 'all',
      courseId: '',
      semester: '',
      favoritesOnly: false,
      recentOnly: true,
      sort: 'recent',
    });
    expect(recent.map((item) => item.id)).toEqual(['deck', 'notes']);
    expect(recentLibrary(items, 1)).toHaveLength(1);
    expect(recentLibrary(items, 1)[0].id).toBe('deck');
  });

  it('windows a long list instead of painting every row', () => {
    const range = visibleRange(200, 1680, 640, 168);
    expect(range.end - range.start).toBeLessThan(20);
    expect(range.start).toBeGreaterThan(0);
    expect(range.end).toBeLessThan(200);
  });
});
