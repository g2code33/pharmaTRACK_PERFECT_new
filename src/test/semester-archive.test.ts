/**
 * Tests for the Semester Completion + Local Academic Archive system.
 *
 * Covers (per the feature spec):
 *  - archive creation & metadata
 *  - full AppState capture (collections + binaries + offloaded text + index)
 *  - verification (valid → verified; corrupted/missing → failed)
 *  - failure safety (quota failure never touches the current workspace)
 *  - fresh-semester semantics (identity preserved, semester data gone)
 *  - academic progression
 *  - export → import round-trip + corruption rejection
 *  - protected restore (current workspace archived first)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => { idbStore.set(k, v); },
  del: async (k: string) => { idbStore.delete(k); },
  delMany: async (keys: string[]) => { keys.forEach((k) => idbStore.delete(k)); },
  keys: async () => [...idbStore.keys()],
  clear: async () => { idbStore.clear(); },
}));

import {
  createSemesterArchive,
  verifySemesterArchive,
  listArchives,
  loadArchive,
  loadArchivedFile,
  loadArchivedRecords,
  loadArchivedSlideText,
  deleteArchive,
  completeSemester,
  computeNextProgression,
  parseLevel,
  parseSemester,
  collectFileRefs,
  buildFreshWorkspace,
  exportBackup,
  parseBackup,
  applyWorkspaceSource,
  restoreArchive,
  hasWorkspaceContent,
} from '../utils/semesterArchive';
import { getSearchIndexRaw, setSearchIndexRaw } from '../utils/searchIndex';
import type { AppState } from '../types';

const LONG_TEXT = 'Pharmacology chapter content about cardiac glycosides. '.repeat(300); // ~15 KB

const makeState = (overrides: Partial<AppState> = {}): AppState => ({
  isLoggedIn: false,
  student: {
    id: 'u1', name: 'Ama', university: 'UCC',
    level: 'Level 300', program: 'Pharm.D', semester: '1st Semester',
    createdAt: '2024-01-01',
  },
  courses: [
    { id: 'c1', studentId: 'u1', courseCode: 'PHA301', courseName: 'Pharmacology', lecturerName: 'Dr. B', semester: '1st Semester', creditHours: 4, createdAt: '2024-01-01' },
    { id: 'c2', studentId: 'u1', courseCode: 'PHA302', courseName: 'Pharmaceutics', lecturerName: 'Dr. C', semester: '1st Semester', creditHours: 3, createdAt: '2024-01-01' },
  ],
  topics: [
    { id: 't1', courseId: 'c1', topicName: 'Cardiac Glycosides', orderIndex: 0, createdAt: '2024-01-01' },
    { id: 't2', courseId: 'c1', topicName: 'Beta Blockers', orderIndex: 1, createdAt: '2024-01-01' },
    { id: 't3', courseId: 'c2', topicName: 'Formulations', orderIndex: 0, createdAt: '2024-01-01' },
  ],
  slides: [
    { id: 's1', topicId: 't1', slideNumber: 1, title: 'Digoxin', contentText: LONG_TEXT, fileUrl: 'local:file1', fileType: 'pdf', status: 'completed', createdAt: '2024-01-02' },
    { id: 's2', topicId: 't1', slideNumber: 2, title: 'Toxicity', contentText: 'Short notes', fileUrl: 'file2', fileType: 'png', status: 'not_started', createdAt: '2024-01-03' },
    { id: 's3', topicId: 't2', slideNumber: 1, title: 'Atenolol', contentText: 'Plain text slide', status: 'in_progress', createdAt: '2024-01-04' },
    { id: 's4', topicId: 't3', slideNumber: 1, title: 'Tablets', contentText: 'Batches', status: 'not_started', createdAt: '2024-01-05' },
  ],
  learningObjectives: [
    { id: 'lo1', courseId: 'c1', topicId: 't1', objectiveText: 'Explain digoxin mechanism', status: 'mastered', createdAt: '2024-01-01' },
  ],
  examQuestions: [
    { id: 'q1', courseId: 'c1', topicId: 't1', questionText: 'Mechanism of digoxin?', questionType: 'short_answer', marksAllocation: 5, difficulty: 'medium', probability: 'high', modelAnswer: 'Na/K ATPase inhibition', tags: [], isPracticed: true, needsReview: false, isSaved: true, createdAt: '2024-01-01' },
  ],
  quizHistory: [
    { id: 'zh1', studentId: 'u1', courseId: 'c1', questionsUsed: ['q1'], answersGiven: [{ questionId: 'q1', answer: 'Na/K', isCorrect: true }], scorePercentage: 90, weakTopics: [], timeTaken: 120, completedAt: '2024-02-01' },
  ],
  studyPlans: [
    { id: 'sp1', studentId: 'u1', date: '2024-02-10', timeSlot: 'evening', courseId: 'c1', activityType: 'revision', notes: 'Ch 4', isCompleted: false },
  ],
  notes: [
    { id: 'n1', topicId: 't1', noteText: 'Digoxin: narrow therapeutic index', isAiGenerated: false, createdAt: '2024-01-06', attachedFiles: [{ id: 'af1', name: 'scan.png', type: 'image/png', data: 'data:image/png;base64,AAAA' }] },
  ],
  examDates: [
    { id: 'ed1', courseId: 'c1', examDate: '2024-05-20', examType: 'endsem', isReminderSet: true },
  ],
  activities: [
    { id: 'a1', type: 'slide_completed', description: 'Completed: Digoxin', timestamp: '2024-01-10', courseId: 'c1', topicId: 't1' },
  ],
  chatHistory: [
    { id: 'ch1', topicId: 't1', role: 'user', content: 'Explain arrhythmia risk', timestamp: '2024-01-11' },
  ],
  highlights: [
    { id: 'h1', topicId: 't1', slideIndex: 0, text: 'narrow therapeutic index', color: 'yellow', timestamp: '2024-01-12', materialId: 's1', page: 2 },
  ],
  savedInsights: [
    { id: 'si1', topicId: 't1', type: 'user', content: 'Always monitor K+', timestamp: '2024-01-13' },
  ],
  openAIKey: 'sk-test-key',
  timetables: {
    class: [{ id: 'tt1', subject: 'PHA301', date: '2024-01-15', time: '09:00', location: 'LH1', type: 'class' }],
    quiz: [], exam: [],
  },
  timetablePdf: 'data:application/pdf;base64,PDFDATA',
  ...overrides,
});

/** Populates the (mock) IndexedDB with the binaries the state references. */
const seedIdb = (state: AppState) => {
  idbStore.set('file_file1', new Blob(['%PDF-1.4 fake digoxin pdf bytes'], { type: 'application/pdf' }));
  idbStore.set('file_file2', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }));
  idbStore.set('slidetext_s1', LONG_TEXT);
};

/** jsdom's Blob has no arrayBuffer()/text(); FileReader is the portable path. */
const blobToBuffer = (blob: Blob): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
const blobToText = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
});

describe('academic progression', () => {
  it('advances semester within a level', () => {
    expect(computeNextProgression('Level 200', '1st Semester')).toEqual({ level: 'Level 200', semester: '2nd Semester' });
    expect(computeNextProgression('200', '1st')).toEqual({ level: 'Level 200', semester: '2nd Semester' });
  });

  it('advances to the next level after the final semester', () => {
    expect(computeNextProgression('Level 300', '2nd Semester')).toEqual({ level: 'Level 400', semester: '1st Semester' });
    expect(computeNextProgression('300', '2nd')).toEqual({ level: 'Level 400', semester: '1st Semester' });
  });

  it('clamps at the final level instead of inventing one', () => {
    expect(computeNextProgression('Level 600', '2nd Semester')).toEqual({ level: 'Level 600', semester: '2nd Semester' });
  });

  it('parses the mixed level/semester formats the app produces', () => {
    expect(parseLevel('Level 300')).toBe(300);
    expect(parseLevel('300')).toBe(300);
    expect(parseLevel('unknown')).toBe(0);
    expect(parseSemester('1st Semester')).toBe(1);
    expect(parseSemester('2nd')).toBe(2);
  });
});

describe('file reference collection', () => {
  it('finds both fileUrl conventions and deduplicates', () => {
    const state = makeState();
    const refs = collectFileRefs(state);
    const fileRefs = refs.filter((r) => r.kind === 'file');
    const textRefs = refs.filter((r) => r.kind === 'slidetext');
    expect(fileRefs.map((r) => r.id).sort()).toEqual(['file1', 'file2']); // 'local:' stripped
    expect(textRefs.map((r) => r.id).sort()).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('has no references for an empty workspace', () => {
    expect(collectFileRefs(makeState({ slides: [] }))).toEqual([]);
  });
});

describe('archive creation & verification', () => {
  it('creates a verified archive capturing the complete workspace', async () => {
    const state = makeState();
    seedIdb(state);
    await setSearchIndexRaw({ s1: { materialId: 's1', topicId: 't1', title: 'Digoxin', pages: [{ page: 1, text: 'deep text' }] } });

    const meta = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester', academicYear: '2026/2027' });

    expect(meta.status).toBe('verified');
    expect(meta.version).toBe(1);
    expect(meta.title).toBe('Level 300 — Semester 1');
    expect(meta.academicYear).toBe('2026/2027');
    expect(meta.level).toBe('300');
    expect(meta.semester).toBe('1');
    expect(meta.itemCount).toBeGreaterThan(10);
    expect(meta.checksum).toBeTruthy();

    const rec = await loadArchive(meta.id);
    expect(rec).not.toBeNull();
    // Every collection captured.
    expect(rec!.snapshot.courses).toHaveLength(2);
    expect(rec!.snapshot.topics).toHaveLength(3);
    expect(rec!.snapshot.slides).toHaveLength(4);
    expect(rec!.snapshot.examQuestions).toHaveLength(1);
    expect(rec!.snapshot.quizHistory).toHaveLength(1);
    expect(rec!.snapshot.notes).toHaveLength(1);
    expect(rec!.snapshot.highlights).toHaveLength(1);
    expect(rec!.snapshot.timetablePdf).toBe('data:application/pdf;base64,PDFDATA');
    expect(rec!.snapshot.student.name).toBe('Ama');
    // The per-page index was carried.
    expect(rec!.index?.s1.pages[0].text).toBe('deep text');
    // Binaries were COPIED into the archive namespace; originals untouched.
    // 2 files + 1 slide text + the search-index record (s3/s4 were never offloaded).
    expect(meta.fileCount).toBe(4);
    expect(rec!.manifest.some((m) => m.sourceKey === 'pharmatrack_search_index' && m.kind === 'record')).toBe(true);
    const pdfCopy = await idbStore.get(`semester_archive_file_${meta.id}_file1`);
    expect(pdfCopy).toBeInstanceOf(Blob);
    expect(await blobToText(pdfCopy as Blob)).toContain('digoxin');
    expect(await idbStore.get(`semester_archive_text_${meta.id}_s1`)).toBe(LONG_TEXT);
    expect(idbStore.has('file_file1')).toBe(true);
    expect(idbStore.has('slidetext_s1')).toBe(true);
  });

  it('fails verification when an archived file goes missing', async () => {
    const state = makeState();
    seedIdb(state);
    const meta = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester' });

    idbStore.delete(`semester_archive_file_${meta.id}_file1`); // simulate corruption
    await expect(verifySemesterArchive(meta.id)).rejects.toThrow(/verification failed/i);

    const rec = await loadArchive(meta.id);
    expect(rec?.meta.status).toBe('failed');
    expect(rec?.meta.error).toMatch(/missing archived record/i);
  });

  it('fails verification when the checksum no longer matches', async () => {
    const state = makeState();
    seedIdb(state);
    const meta = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester' });

    // Tamper with a copied file's content (size changes → checksum + size checks both fail).
    idbStore.set(`semester_archive_file_${meta.id}_file2`, new Blob(['different-bytes'], { type: 'image/png' }));
    await expect(verifySemesterArchive(meta.id)).rejects.toThrow(/verification failed/i);
  });

  it('lists archives newest-first and ignores file/text keys', async () => {
    const state = makeState();
    seedIdb(state);
    const a = await createSemesterArchive(state, { level: 'Level 200', semester: '1st Semester' });
    const b = await createSemesterArchive(state, { level: 'Level 200', semester: '2nd Semester' });

    // Give them distinct completion times (same-ms timestamps would tie).
    const recA = await loadArchive(a.id);
    recA!.meta = { ...recA!.meta, completedAt: '2026-01-01T00:00:00.000Z' };
    idbStore.set(`semester_archive_${a.id}`, recA);

    const list = await listArchives();
    expect(list.map((m) => m.id)).toEqual([b.id, a.id]);
    expect(list.length).toBe(2);
  });

  it('deletes an archive and all its records', async () => {
    const state = makeState();
    seedIdb(state);
    const meta = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester' });
    expect(idbStore.size).toBeGreaterThan(4);

    await deleteArchive(meta.id);
    const remaining = [...idbStore.keys()].filter((k) => k.startsWith('semester_archive'));
    expect(remaining).toEqual([]);
    // The live records survive a deleted archive.
    expect(idbStore.has('file_file1')).toBe(true);
  });
});

/**
 * Runs `fn` while every idb write to an archive key for `fileIdSuffix`
 * throws `error`. The override is ALWAYS restored, even when fn throws, so
 * the mock cannot leak into other tests.
 */
const withFailingArchiveCopy = async (fileIdSuffix: string, error: DOMException, fn: () => Promise<void>) => {
  const realSet = idbStore.set.bind(idbStore);
  idbStore.set = (k: string, v: unknown) => {
    if (k.includes('archive_') && k.endsWith(fileIdSuffix)) throw error;
    return realSet(k, v);
  };
  try {
    await fn();
  } finally {
    idbStore.set = realSet;
  }
};

describe('failure safety', () => {
  it('a quota failure mid-copy leaves the current semester completely untouched', async () => {
    const state = makeState();
    seedIdb(state);
    const before = new Map(idbStore);
    const stateBefore = localStorage.getItem('pharmatrack_state');

    // Make the copy of file_file2 blow up with a quota error.
    await withFailingArchiveCopy('_file2', new DOMException('quota', 'QuotaExceededError'), async () => {
      await expect(completeSemester(state, { nextLevel: 'Level 300', nextSemester: '2nd Semester' }))
        .rejects.toThrow(/storage is full|archive could not be completed/i);
    });

    // Live workspace: every original record still present, nothing new.
    for (const [k, v] of before) {
      expect(idbStore.get(k), `record ${k} changed`).toBe(v);
    }
    expect([...idbStore.keys()].filter((k) => k.startsWith('semester_archive'))).toEqual([]);
    // Nothing was reset or saved over the old state.
    expect(localStorage.getItem('pharmatrack_state')).toBe(stateBefore);
  });

  it('a failed archive is marked failed and cleaned up', async () => {
    const state = makeState();
    seedIdb(state);

    await withFailingArchiveCopy('_file2', new DOMException('boom', 'UnknownError'), async () => {
      await expect(createSemesterArchive(state, { level: 'Level 300', semester: '2nd Semester' }))
        .rejects.toThrow(/archive could not be completed/i);
    });

    const list = await listArchives();
    expect(list.length).toBe(0); // partial archive cleaned up
  });
});

describe('complete semester → fresh workspace', () => {
  it('archives, then resets to a genuinely fresh semester keeping identity', async () => {
    const state = makeState();
    seedIdb(state);
    await setSearchIndexRaw({ s1: { materialId: 's1', topicId: 't1', title: 'Digoxin', pages: [{ page: 1, text: 'deep' }] } });

    const { archive, fresh } = await completeSemester(state, { nextLevel: 'Level 300', nextSemester: '2nd Semester', academicYear: '2025/2026' });

    // The archive.
    expect(archive.status).toBe('verified');
    // The archive is the semester that ended, not the one that is starting.
    expect(archive.level).toBe('300');
    expect(archive.semester).toBe('1');
    expect(archive.title).toBe('Level 300 — Semester 1');
    expect(archive.academicYear).toBe('2025/2026');
    const list = await listArchives();
    expect(list).toHaveLength(1);
    const archived = await loadArchive(list[0].id);
    expect(archived!.snapshot.courses).toHaveLength(2);

    // The fresh workspace.
    expect(fresh.student?.id).toBe('u1');
    expect(fresh.student?.name).toBe('Ama');
    expect(fresh.student?.university).toBe('UCC');
    expect(fresh.student?.program).toBe('Pharm.D');
    expect(fresh.student?.level).toBe('Level 300');
    expect(fresh.student?.semester).toBe('2nd Semester');
    // v4: a fresh semester does not inherit a legacy key — API credentials are
    // provider configuration owned by the AI engine, not semester data.
    expect(fresh.openAIKey).toBe('');
    expect(fresh.courses).toEqual([]);
    expect(fresh.topics).toEqual([]);
    expect(fresh.slides).toEqual([]);
    expect(fresh.notes).toEqual([]);
    expect(fresh.examQuestions).toEqual([]);
    expect(fresh.quizHistory).toEqual([]);
    expect(fresh.studyPlans).toEqual([]);
    expect(fresh.examDates).toEqual([]);
    expect(fresh.activities).toEqual([]);
    expect(fresh.chatHistory).toEqual([]);
    expect(fresh.highlights).toEqual([]);
    expect(fresh.savedInsights).toEqual([]);
    expect(fresh.timetablePdf).toBeNull();
    expect(fresh.timetables).toEqual({ class: [], quiz: [], exam: [] });

    // The fresh state is on disk before anything else happens.
    const saved = JSON.parse(localStorage.getItem('pharmatrack_state')!);
    expect(saved.courses).toEqual([]);
    expect(saved.student.semester).toBe('2nd Semester');

    // Old workspace's IndexedDB records pruned; archive copies remain.
    expect(idbStore.has('file_file1')).toBe(false);
    expect(idbStore.has('slidetext_s1')).toBe(false);
    expect(idbStore.has(`semester_archive_file_${archive.id}_file1`)).toBe(true);
    expect(idbStore.has(`semester_archive_text_${archive.id}_s1`)).toBe(true);

    // The search index was carried into the archive and cleared live.
    expect(await getSearchIndexRaw()).toBeNull();
  });

  it('buildFreshWorkspace keeps only identity and preferences', () => {
    const state = makeState();
    const fresh = buildFreshWorkspace(state, { level: 'Level 400', semester: '1st Semester' });
    expect(fresh.student?.level).toBe('Level 400');
    expect(fresh.student?.semester).toBe('1st Semester');
    expect(fresh.courses).toEqual([]);
    // v4: a fresh semester does not inherit a legacy key — API credentials are
    // provider configuration owned by the AI engine, not semester data.
    expect(fresh.openAIKey).toBe('');
    expect(hasWorkspaceContent(fresh)).toBe(false);
    expect(hasWorkspaceContent(state)).toBe(true);
  });
});

describe('acceptance: complete semester', () => {
  it('archives every semester record, verifies, then starts a clean workspace', async () => {
    const state = makeState() as AppState & { clinicalCases: { id: string; title: string }[] };
    state.clinicalCases = [{ id: 'cc1', title: 'Digoxin toxicity case' } as unknown as (typeof state.clinicalCases)[number]];
    state.slides = [
      ...state.slides,
      {
        id: 's5', topicId: 't1', slideNumber: 3, title: 'Lecture 5 — Cardiovascular',
        contentText: 'Slide text about beta blockers',
        fileUrl: 'local:pptx1', fileType: 'png', status: 'completed', createdAt: '2024-01-06',
      },
    ];
    seedIdb(state);
    idbStore.set('file_pptx1', new Blob(['PK pptx lecture bytes'], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
    idbStore.set('slidetext_s5', 'OCR: autonomic pharmacology, full extraction from the deck');
    idbStore.set('pharmatrack_ai_conversation_conv1', {
      id: 'conv1',
      title: 'Digoxin chat',
      messages: [{ id: 'm1', role: 'assistant', content: 'Monitor potassium with digoxin.' }],
    });
    idbStore.set('pharmatrack_ai_conversations_index', [
      { id: 'conv1', title: 'Digoxin chat', messageCount: 1, createdAt: '2024-02-01', updatedAt: '2024-02-02' },
    ]);
    const secret = { nvidia: { apiKey: 'nvapi-should-stay-out-of-archive' } };
    idbStore.set('pharmatrack_ai_credentials', secret);

    const { archive, fresh } = await completeSemester(state, {
      nextLevel: 'Level 300',
      nextSemester: '2nd Semester',
      academicYear: '2025/2026',
    });

    expect(archive.status).toBe('verified');
    expect(archive.id).toMatch(/^archive_300_1_2025_2026_/);
    expect(archive.level).toBe('300');
    expect(archive.semester).toBe('1');
    expect(archive.title).toBe('Level 300 — Semester 1');
    expect(archive.academicYear).toBe('2025/2026');
    expect(archive.completedAt).toBeTruthy();

    // Fresh workspace keeps identity only.
    expect(fresh.student?.name).toBe('Ama');
    expect(fresh.student?.university).toBe('UCC');
    expect(fresh.student?.level).toBe('Level 300');
    expect(fresh.student?.semester).toBe('2nd Semester');
    expect(fresh.courses).toEqual([]);
    expect(fresh.topics).toEqual([]);
    expect(fresh.slides).toEqual([]);
    expect(fresh.notes).toEqual([]);
    expect(fresh.examQuestions).toEqual([]);
    expect(fresh.quizHistory).toEqual([]);
    expect(fresh.studyPlans).toEqual([]);
    expect(fresh.highlights).toEqual([]);
    expect(fresh.chatHistory).toEqual([]);
    expect(fresh.timetablePdf).toBeNull();
    expect(fresh.timetables).toEqual({ class: [], quiz: [], exam: [] });
    expect((fresh as { clinicalCases?: unknown }).clinicalCases).toBeUndefined();
    expect(fresh.openAIKey).toBe('');

    const saved = JSON.parse(localStorage.getItem('pharmatrack_state')!);
    expect(saved.courses).toEqual([]);
    expect(saved.student.semester).toBe('2nd Semester');

    // Live semester records are gone. Credentials are not semester data.
    expect(idbStore.has('file_file1')).toBe(false);
    expect(idbStore.has('file_pptx1')).toBe(false);
    expect(idbStore.has('slidetext_s1')).toBe(false);
    expect(idbStore.has('slidetext_s5')).toBe(false);
    expect(idbStore.has('pharmatrack_ai_conversation_conv1')).toBe(false);
    expect(idbStore.get('pharmatrack_ai_credentials')).toEqual(secret);

    // Opening the archive still reaches every item.
    const opened = await loadArchive(archive.id);
    expect(opened?.meta.status).toBe('verified');
    expect(opened!.snapshot.courses.map((c) => c.courseCode)).toEqual(['PHA301', 'PHA302']);
    expect(opened!.snapshot.notes[0].noteText).toContain('narrow therapeutic index');
    expect(opened!.snapshot.examQuestions[0].questionText).toContain('digoxin');
    expect(opened!.snapshot.quizHistory[0].scorePercentage).toBe(90);
    expect(opened!.snapshot.studyPlans[0].notes).toBe('Ch 4');
    expect(opened!.snapshot.timetables.class[0].subject).toBe('PHA301');
    expect(opened!.snapshot.timetablePdf).toContain('PDFDATA');
    expect(opened!.snapshot.highlights[0].text).toContain('narrow therapeutic index');
    expect(opened!.snapshot.chatHistory[0].content).toContain('arrhythmia');
    expect(opened!.snapshot.learningObjectives[0].objectiveText).toContain('digoxin');
    expect((opened!.snapshot as { clinicalCases?: { title: string }[] }).clinicalCases?.[0].title).toBe('Digoxin toxicity case');
    expect((opened!.snapshot as { openAIKey?: string }).openAIKey).toBeFalsy();

    expect(await blobToText((await loadArchivedFile(archive.id, 'file1')) as Blob)).toContain('%PDF');
    expect(await blobToText((await loadArchivedFile(archive.id, 'pptx1')) as Blob)).toContain('pptx lecture');
    expect(await loadArchivedSlideText(archive.id, 's1')).toContain('cardiac glycosides');
    expect(await loadArchivedSlideText(archive.id, 's5')).toContain('full extraction');

    const records = await loadArchivedRecords(archive.id);
    const chat = records.find((r) => r.sourceKey === 'pharmatrack_ai_conversation_conv1');
    expect(JSON.stringify(chat?.value)).toContain('Monitor potassium with digoxin.');
    expect(records.some((r) => r.sourceKey === 'pharmatrack_ai_credentials')).toBe(false);

    for (const [key, value] of idbStore) {
      if (!String(key).includes(archive.id)) continue;
      const dumped = JSON.stringify(value);
      expect(dumped).not.toContain('nvapi-should-stay-out-of-archive');
      expect(dumped).not.toContain('sk-test-key');
    }

    expect((await verifySemesterArchive(archive.id)).status).toBe('verified');
  });
});

describe('export & import round-trip', () => {
  it('exports an archive to a ZIP and re-imports it intact', async () => {
    const state = makeState();
    seedIdb(state);
    const meta = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester', academicYear: '2026/2027' });

    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });
    const buffer = await blobToBuffer(blob);

    const result = await parseBackup(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.kind).toBe('semester');
    const { staged } = result.parsed.kind === 'semester' ? result.parsed : ({} as never);
    expect(staged.manifest.app).toBe('pharmatrack');
    expect(staged.manifest.format).toBe('pharmatrack-semester-backup');
    expect((staged.manifest as any).formatVersion).toBe(1);
    expect(staged.manifest.source).toBe('archive');
    expect(staged.manifest.archiveId).toBe(meta.id);
    const rc = (staged.manifest as any).recordCounts;
    expect(rc.courses).toBe(2);
    expect(rc.slides).toBe(4);
    expect(rc.files).toBe(3);
    expect((staged.manifest as any).integrity.algorithm).toBe('fnv1a-32');
    expect(staged.snapshot.courses).toHaveLength(2);
    expect(staged.snapshot.notes[0].attachedFiles?.[0].data).toContain('base64');
    expect(staged.files.size).toBe(3);
    const fileEntry = staged.files.get('file1');
    expect(fileEntry?.kind).toBe('file');
    expect(await blobToText(fileEntry!.value as Blob)).toContain('digoxin');
  });

  it('exports the live workspace as the storage-full escape hatch', async () => {
    const state = makeState();
    seedIdb(state);
    const blob = await exportBackup({ kind: 'live', state });
    const result = await parseBackup(await blobToBuffer(blob));
    expect(result.ok).toBe(true);
    if (!result.ok || result.parsed.kind !== 'semester') return;
    expect(result.parsed.staged.manifest.source).toBe('live');
    expect(result.parsed.staged.files.size).toBe(3);
  });

  it('rejects a non-zip file', async () => {
    const result = await parseBackup(new TextEncoder().encode('definitely not a zip').buffer);
    expect(result.ok).toBe(false);
  });

  it('rejects a backup with a wrong file size (corruption)', async () => {
    const state = makeState();
    seedIdb(state);
    const meta = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester' });
    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });

    // Rebuild the zip with the ACTUAL file entry's content altered.
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(blob);
    const realName = Object.keys(zip.files).find((n) => n.startsWith('files/') && n.includes('file2'))!;
    zip.file(realName, new Blob(['tampered-content'], { type: 'image/png' }));
    const tampered = await zip.generateAsync({ type: 'arraybuffer' });

    const result = await parseBackup(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/wrong size|content check|checksum|corrupt/i);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('rejects unsupported backup versions', async () => {
    const state = makeState();
    seedIdb(state);
    const meta = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester' });
    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(blob);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    manifest.formatVersion = 99;
    zip.file('manifest.json', JSON.stringify(manifest));
    const future = await zip.generateAsync({ type: 'arraybuffer' });

    const result = await parseBackup(future);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unsupported backup format version 99/i);
  });
});

describe('restore (always protected)', () => {
  it('archives the current workspace before restoring, and keeps both', async () => {
    // An old semester already archived.
    const oldState = makeState({
      student: { id: 'u1', name: 'Ama', university: 'UCC', level: 'Level 200', program: 'Pharm.D', semester: '1st Semester', createdAt: '2023-01-01' },
      courses: [{ id: 'oc1', studentId: 'u1', courseCode: 'PHA201', courseName: 'Old Course', lecturerName: 'Dr. A', semester: '1st Semester', creditHours: 3, createdAt: '2023-01-01' }],
      topics: [{ id: 'ot1', courseId: 'oc1', topicName: 'Old Topic', orderIndex: 0, createdAt: '2023-01-01' }],
      slides: [{ id: 'os1', topicId: 'ot1', slideNumber: 1, title: 'Old Slide', contentText: 'old', fileUrl: 'local:file1', fileType: 'pdf', status: 'not_started', createdAt: '2023-01-02' }],
      // Keep the rest self-consistent (no dangling references to c1/t1…).
      learningObjectives: [], examQuestions: [], quizHistory: [], studyPlans: [],
      notes: [], examDates: [], activities: [], chatHistory: [], highlights: [], savedInsights: [],
    });
    seedIdb(oldState);
    const oldArchive = await createSemesterArchive(oldState, { level: 'Level 200', semester: '1st Semester', academicYear: '2025/2026' });

    // The current (newer) semester.
    const currentState = makeState();
    seedIdb(currentState);

    const { fresh, guardArchive } = await restoreArchive(currentState, oldArchive.id);

    // Current semester was protected by its own verified archive.
    expect(guardArchive).not.toBeNull();
    expect(guardArchive!.status).toBe('verified');

    // The restored workspace matches the OLD semester.
    expect(fresh.courses.map((c) => c.id)).toEqual(['oc1']);
    expect(fresh.topics.map((t) => t.id)).toEqual(['ot1']);
    expect(fresh.slides.map((s) => s.id)).toEqual(['os1']);
    expect(fresh.student?.level).toBe('Level 200');
    expect(fresh.student?.semester).toBe('1st Semester');
    // Identity continuity: same person, same id.
    expect(fresh.student?.id).toBe('u1');

    // Both archives exist now.
    const list = await listArchives();
    expect(list.map((m) => m.id).sort()).toEqual([guardArchive!.id, oldArchive.id].sort());

    // The restored binary is back in the live namespace.
    expect(idbStore.has('file_file1')).toBe(true);
  });

  it('skips the guard backup when the current workspace is empty', async () => {
    const oldState = makeState();
    seedIdb(oldState);
    const oldArchive = await createSemesterArchive(oldState, { level: 'Level 200', semester: '1st Semester' });

    const empty = makeState({
      courses: [], topics: [], slides: [], learningObjectives: [], examQuestions: [], quizHistory: [],
      studyPlans: [], notes: [], examDates: [], activities: [], chatHistory: [], highlights: [],
      savedInsights: [], timetables: { class: [], quiz: [], exam: [] }, timetablePdf: null,
    });
    const { fresh, guardArchive } = await restoreArchive(empty, oldArchive.id);
    expect(guardArchive).toBeNull();
    expect(fresh.courses).toHaveLength(2);
    expect(await listArchives()).toHaveLength(1); // only the original archive
  });

  it('refuses to restore a failed archive and changes nothing', async () => {
    const state = makeState();
    seedIdb(state);
    const meta = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester' });

    // Force it to failed by corrupting a copy.
    idbStore.delete(`semester_archive_file_${meta.id}_file1`);
    await verifySemesterArchive(meta.id).catch(() => {});

    const before = new Map(idbStore);
    await expect(restoreArchive(state, meta.id)).rejects.toThrow(/only verified archives/i);
    for (const [k, v] of before) expect(idbStore.get(k)).toBe(v);
    // No guard archive was created.
    expect((await listArchives()).map((m) => m.id)).toEqual([meta.id]);
  });

  it('applyWorkspaceSource imports staged data and preserves the current identity', async () => {
    const donor = makeState({
      student: { id: 'someone-else', name: 'Donor', university: 'Other U', level: 'Level 400', program: 'B.Pharm', semester: '2nd Semester', createdAt: '2020-01-01' },
    });
    seedIdb(donor);
    const meta = await createSemesterArchive(donor, { level: 'Level 400', semester: '2nd Semester' });
    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });
    const parsed = await parseBackup(await blobToBuffer(blob));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.parsed.kind !== 'semester') return;

    const current = makeState(); // different semester, same person id u1
    const fresh = await applyWorkspaceSource(parsed.parsed.staged, current);

    expect(fresh.courses).toHaveLength(2);
    expect(fresh.student?.id).toBe('u1');          // identity from the CURRENT student
    expect(fresh.student?.level).toBe('Level 400'); // academic position from the backup
    expect(fresh.student?.semester).toBe('2nd Semester');
    // Incoming binaries materialised in the live namespace.
    expect(idbStore.has('file_file1')).toBe(true);
    expect(JSON.parse(localStorage.getItem('pharmatrack_state')!).courses).toHaveLength(2);
  });
});
