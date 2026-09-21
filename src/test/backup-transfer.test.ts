/**
 * Tests for the portable semester backup system:
 *  - .pharmatrack export (real binaries, OCR/offloaded text, manifest, integrity)
 *  - degree bundle (Export All Academic Data)
 *  - import on a fresh device (into the Academic Archive — the safe default)
 *  - collision handling (same id / same position → keep, copy, replace)
 *  - restore as current workspace (with automatic verified safety backup)
 *  - corruption & validation failures (never partially imported)
 *  - storage-failure safety (interrupted imports leave everything untouched)
 *  - legacy-format backward compatibility
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';
import {
  createSemesterArchive,
  listArchives,
  loadArchive,
  loadArchivedFile,
  loadArchivedSlideText,
  deleteArchive,
  exportBackup,
  exportDegreeBackup,
  parseBackup,
  importBackupIntoArchive,
  importBackupAsWorkspace,
  findCollidingArchives,
  stagedSummary,
  semesterBackupFileName,
  degreeBackupFileName,
  checksumOf,
  hasWorkspaceContent,
  APP_VERSION,
} from '../utils/semesterArchive';
import type { AppState } from '../types';

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => { idbStore.set(k, v); },
  del: async (k: string) => { idbStore.delete(k); },
  delMany: async (keys: string[]) => { keys.forEach((k) => idbStore.delete(k)); },
  keys: async () => [...idbStore.keys()],
  clear: async () => { idbStore.clear(); },
}));

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
    { id: 't2', courseId: 'c2', topicName: 'Formulations', orderIndex: 0, createdAt: '2024-01-01' },
  ],
  slides: [
    { id: 's1', topicId: 't1', slideNumber: 1, title: 'Digoxin', contentText: LONG_TEXT, fileUrl: 'local:file1', fileType: 'pdf', status: 'completed', createdAt: '2024-01-02' },
    { id: 's2', topicId: 't2', slideNumber: 1, title: 'O/W emulsions', contentText: 'Short', fileUrl: 'file2', fileType: 'png', status: 'not_started', createdAt: '2024-01-03' },
  ],
  learningObjectives: [{ id: 'lo1', courseId: 'c1', topicId: 't1', objectiveText: 'Explain digoxin mechanism', status: 'partial', createdAt: '2024-01-01' }],
  examQuestions: [
    { id: 'q1', courseId: 'c1', topicId: 't1', questionText: 'Mechanism?', questionType: 'short_answer', marksAllocation: 5, difficulty: 'medium', probability: 'high', modelAnswer: 'Na/K ATPase inhibition', tags: [], isPracticed: true, needsReview: false, isSaved: true, createdAt: '2024-01-01' },
  ],
  quizHistory: [
    { id: 'zh1', studentId: 'u1', courseId: 'c1', questionsUsed: ['q1'], answersGiven: [], scorePercentage: 90, weakTopics: [], timeTaken: 120, completedAt: '2024-02-01' },
  ],
  studyPlans: [{ id: 'sp1', studentId: 'u1', date: '2024-02-10', timeSlot: 'evening', courseId: 'c1', activityType: 'revision', notes: 'Ch 4', isCompleted: false }],
  notes: [
    { id: 'n1', topicId: 't1', noteText: 'Digoxin: narrow therapeutic index', isAiGenerated: false, createdAt: '2024-01-06', attachedFiles: [{ id: 'af1', name: 'scan.png', type: 'image/png', data: 'data:image/png;base64,AAAA' }] },
  ],
  examDates: [{ id: 'ed1', courseId: 'c1', examDate: '2024-05-20', examType: 'endsem', isReminderSet: true }],
  activities: [{ id: 'a1', type: 'slide_completed', description: 'Completed: Digoxin', timestamp: '2024-01-10', courseId: 'c1', topicId: 't1' }],
  chatHistory: [{ id: 'ch1', topicId: 't1', role: 'user', content: 'Explain arrhythmia risk', timestamp: '2024-01-11' }],
  highlights: [{ id: 'h1', topicId: 't1', slideIndex: 0, text: 'narrow therapeutic index', color: 'yellow', timestamp: '2024-01-12', materialId: 's1', page: 2 }],
  savedInsights: [{ id: 'si1', topicId: 't1', type: 'user', content: 'Always monitor K+', timestamp: '2024-01-13' }],
  openAIKey: '',
  timetables: { class: [{ id: 'tt1', subject: 'PHA301', date: '2024-01-15', time: '09:00', location: 'LH1', type: 'class' }], quiz: [], exam: [] },
  timetablePdf: null,
  ...overrides,
});

const PDF_BYTES = new Blob(['%PDF-1.4 fake digoxin pdf'], { type: 'application/pdf' });
const PPTX_BYTES = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
const DOCX_BYTES = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9])], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
const PNG_BYTES = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });

const seedIdb = (state: AppState) => {
  for (const slide of state.slides) {
    const fid = (slide.fileUrl || '').replace(/^local:/, '');
    if (!fid) continue;
    const blob = fid === 'file1' ? PDF_BYTES : fid === 'file2' ? PNG_BYTES : fid === 'file3' ? PPTX_BYTES : fid === 'file4' ? DOCX_BYTES : new Blob(['x']);
    idbStore.set(`file_${fid}`, blob);
  }
  idbStore.set('slidetext_s1', LONG_TEXT);
};

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

const zipEntry = (zip: JSZip, name: string) => zip.file(name);

describe('backup filenames', () => {
  it('produces the PharmaTRACK-specific, sanitized names', () => {
    expect(semesterBackupFileName('Level 200', '2nd Semester', '2025/2026')).toBe('PharmaTRACK_Level-200_Semester-2_2025-2026.pharmatrack');
    expect(semesterBackupFileName('300', '1st', '2026/2027', '2026-09-21')).toBe('PharmaTRACK_Level-300_Semester-1_2026-2027_2026-09-21.pharmatrack');
    const d = degreeBackupFileName(new Date('2026-09-21T10:00:00Z'));
    expect(d).toMatch(/^PharmaTRACK_Full-Academic-Record_\d{4}-\d{2}-\d{2}\.pharmatrack$/);
  });
});

describe('export — a real portable data package', () => {
  it('packages the ACTUAL binaries, offloaded text, material metadata and manifest', async () => {
    const state = makeState();
    seedIdb(state);
    const meta = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester', academicYear: '2026/2027' });

    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });
    const zip = await JSZip.loadAsync(await blobToBuffer(blob));

    // The actual PDF, byte for byte.
    const pdfEntry = zipEntry(zip, 'files/file1.pdf');
    expect(pdfEntry).toBeTruthy();
    expect(await blobToText(await pdfEntry!.async('blob'))).toBe(await blobToText(PDF_BYTES));
    // Material metadata ties the file back to its slide.
    const matMeta = JSON.parse(await zipEntry(zip, 'materials/file1.json')!.async('string'));
    expect(matMeta.fileId).toBe('file1');
    expect(matMeta.slideId).toBe('s1');
    expect(matMeta.materialTitle).toBe('Digoxin');
    // Offloaded slide text (the large text that left localStorage) is verbatim.
    expect(await zipEntry(zip, 'text/s1.txt')!.async('string')).toBe(LONG_TEXT);
    // Per-collection JSONs.
    const courses = JSON.parse(await zipEntry(zip, 'semester/courses.json')!.async('string'));
    expect(courses).toHaveLength(2);
    const student = JSON.parse(await zipEntry(zip, 'semester/student.json')!.async('string'));
    expect(student.id).toBe('u1');
    expect(zipEntry(zip, 'semester/timetable.json')).toBeTruthy();
    expect(zipEntry(zip, 'metadata/checksums.json')).toBeTruthy();

    // The versioned manifest.
    const manifest = JSON.parse(await zipEntry(zip, 'manifest.json')!.async('string'));
    expect(manifest.app).toBe('pharmatrack');
    expect(manifest.format).toBe('pharmatrack-semester-backup');
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.appVersion).toBe(APP_VERSION);
    expect(manifest.archiveId).toBe(meta.id);
    expect(manifest.level).toBe('300');
    expect(manifest.semester).toBe('1');
    expect(manifest.recordCounts.courses).toBe(2);
    expect(manifest.recordCounts.slides).toBe(2);
    expect(manifest.recordCounts.files).toBe(3); // pdf + png + slide text
    expect(manifest.integrity.algorithm).toBe('fnv1a-32');
    expect(manifest.integrity.checksum).toBeTruthy();
    expect(manifest.totalBytes).toBeGreaterThan(10_000);

    // And the package passes its own validation.
    const result = await parseBackup(await blobToBuffer(blob));
    expect(result.ok).toBe(true);
  });

  it('gives PPTX, DOCX and image files their real extensions', async () => {
    const state = makeState({
      slides: [
        { id: 's1', topicId: 't1', slideNumber: 1, title: 'Deck', contentText: '', fileUrl: 'local:file3', fileType: 'pptx' as never, status: 'not_started', createdAt: '2024-01-02' },
        { id: 's2', topicId: 't2', slideNumber: 1, title: 'Doc', contentText: '', fileUrl: 'local:file4', fileType: 'docx' as never, status: 'not_started', createdAt: '2024-01-03' },
      ],
    });
    idbStore.set('file_file3', PPTX_BYTES);
    idbStore.set('file_file4', DOCX_BYTES);
    const meta = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester' });
    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });
    const zip = await JSZip.loadAsync(await blobToBuffer(blob));
    expect(zipEntry(zip, 'files/file3.pptx')).toBeTruthy();
    expect(zipEntry(zip, 'files/file4.docx')).toBeTruthy();
    expect(zipEntry(zip, 'materials/file3.json')).toBeTruthy();
  });

  it('exports the LIVE workspace (storage-full escape hatch)', async () => {
    const state = makeState();
    seedIdb(state);
    const blob = await exportBackup({ kind: 'live', state });
    const result = await parseBackup(await blobToBuffer(blob));
    expect(result.ok).toBe(true);
    if (!result.ok || result.parsed.kind !== 'semester') return;
    expect(result.parsed.staged.manifest.source).toBe('live');
    expect(result.parsed.staged.snapshot.courses).toHaveLength(2);
    expect(result.parsed.staged.files.size).toBe(3);
  });
});

describe('Export All Academic Data (degree bundle)', () => {
  it('bundles every completed semester and each entry imports', async () => {
    const state = makeState();
    seedIdb(state);
    const a = await createSemesterArchive(state, { level: 'Level 200', semester: '1st Semester', academicYear: '2025/2026' });
    const b = await createSemesterArchive(state, { level: 'Level 200', semester: '2nd Semester', academicYear: '2025/2026' });

    const blob = await exportDegreeBackup();
    const result = await parseBackup(await blobToBuffer(blob));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.kind).toBe('degree');
    if (result.parsed.kind !== 'degree') return;
    expect(result.parsed.degree.semesters).toHaveLength(2);
    expect(result.parsed.degree.semesters.map((s) => (s.manifest as any).archiveId).sort()).toEqual([a.id, b.id].sort());
  });

  it('refuses to export when there is nothing to export', async () => {
    await expect(exportDegreeBackup()).rejects.toThrow(/no completed semesters/i);
  });
});

describe('import on a fresh device → Academic Archive', () => {
  it('reconstructs the full semester, binaries and text included', async () => {
    // Device A.
    const deviceA = makeState();
    seedIdb(deviceA);
    const meta = await createSemesterArchive(deviceA, { level: 'Level 200', semester: '1st Semester', academicYear: '2025/2026' });
    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });

    // Device B — completely fresh.
    idbStore.clear();
    localStorage.clear();
    const buffer = await blobToBuffer(blob);
    const result = await parseBackup(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok || result.parsed.kind !== 'semester') return;
    const staged = result.parsed.staged;

    const imported = await importBackupIntoArchive(staged, 'archive');
    expect(imported.status).toBe('verified');
    expect(imported.id).toBe(meta.id);

    const list = await listArchives();
    expect(list).toHaveLength(1);
    const rec = await loadArchive(imported.id);
    expect(rec!.snapshot.courses).toHaveLength(2);
    expect(rec!.snapshot.notes).toHaveLength(1);
    expect(rec!.snapshot.highlights).toHaveLength(1);
    // The actual PDF survived the trip, byte for byte.
    const pdf = await loadArchivedFile(imported.id, 'file1');
    expect(await blobToText(pdf as Blob)).toBe(await blobToText(PDF_BYTES));
    // The offloaded slide text survived the trip too.
    expect(await loadArchivedSlideText(imported.id, 's1')).toBe(LONG_TEXT);
    // Summary for the UI.
    const sum = stagedSummary(staged);
    expect(sum.title).toBe('Level 200 — Semester 1');
    expect(sum.counts.courses).toBe(2);
    expect(sum.integrityVerified).toBe(true);
  });

  it('gives live (unarchived) exports a fresh archive id on import', async () => {
    const state = makeState();
    seedIdb(state);
    const blob = await exportBackup({ kind: 'live', state });
    const result = await parseBackup(await blobToBuffer(blob));
    if (!result.ok || result.parsed.kind !== 'semester') throw new Error('parse failed');
    const imported = await importBackupIntoArchive(result.parsed.staged, 'archive');
    expect(imported.id).toMatch(/^archive_300_1_/);
    expect(imported.status).toBe('verified');
    expect((await listArchives())).toHaveLength(1);
  });
});

describe('collision handling — never silently overwrite', () => {
  it('detects a same-archive-id collision and offers copy/replace', async () => {
    const state = makeState();
    seedIdb(state);
    const meta = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester' });
    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });
    const result = await parseBackup(await blobToBuffer(blob));
    if (!result.ok || result.parsed.kind !== 'semester') throw new Error('parse failed');
    const staged = result.parsed.staged;

    const col = await findCollidingArchives(staged);
    expect(col.byId?.id).toBe(meta.id);

    // Import as copy → both exist, different ids, second is marked (Copy).
    const copy = await importBackupIntoArchive(staged, 'copy');
    expect(copy.id).not.toBe(meta.id);
    expect(copy.title).toContain('(Copy)');
    expect((await listArchives())).toHaveLength(2);
    expect(await loadArchive(copy.id)).not.toBeNull();
    expect(await loadArchive(meta.id)).not.toBeNull();
  });

  it('replace mode overwrites the existing archive in place', async () => {
    const state = makeState();
    seedIdb(state);
    const meta = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester' });
    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });
    const result = await parseBackup(await blobToBuffer(blob));
    if (!result.ok || result.parsed.kind !== 'semester') throw new Error('parse failed');
    const staged = result.parsed.staged;

    // A NEWER export of the same semester (different, self-consistent data).
    const newer = makeState({
      courses: [
        { id: 'cx', studentId: 'u1', courseCode: 'PHA999', courseName: 'Updated', lecturerName: 'Dr. X', semester: '1st Semester', creditHours: 4, createdAt: '2024-01-01' },
      ],
      topics: [{ id: 'tx', courseId: 'cx', topicName: 'New Topic', orderIndex: 0, createdAt: '2024-01-01' }],
      slides: [{ id: 'sx', topicId: 'tx', slideNumber: 1, title: 'New Slide', contentText: 'new', status: 'not_started', createdAt: '2024-01-02' }],
      learningObjectives: [], examQuestions: [], quizHistory: [], studyPlans: [],
      notes: [], examDates: [], activities: [], chatHistory: [], highlights: [], savedInsights: [],
    });
    const newerBlob = await exportBackup({ kind: 'live', state: newer });
    const newerResult = await parseBackup(await blobToBuffer(newerBlob));
    if (!newerResult.ok || newerResult.parsed.kind !== 'semester') throw new Error('parse2 failed');

    const replaced = await importBackupIntoArchive(newerResult.parsed.staged, 'replace', meta.id);
    expect(replaced.id).toBe(meta.id);
    const list = await listArchives();
    expect(list).toHaveLength(1);
    expect((await loadArchive(meta.id))!.snapshot.courses.map((c) => c.id)).toEqual(['cx']);
  });

  it('detects a same-position collision (same level/semester/year, different id)', async () => {
    const state = makeState();
    seedIdb(state);
    const a = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester', academicYear: '2025/2026' });
    const b = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester', academicYear: '2025/2026' });
    const blob = await exportBackup({ kind: 'archive', archiveId: b.id });
    // Simulate receiving b's backup on a device that already has a (different)
    // archive of the same level/semester/year.
    await deleteArchive(b.id);
    const result = await parseBackup(await blobToBuffer(blob));
    if (!result.ok || result.parsed.kind !== 'semester') throw new Error('parse failed');
    const col = await findCollidingArchives(result.parsed.staged);
    expect(col.byId).toBeNull();
    expect(col.byPosition?.id).toBe(a.id);
  });
});

describe('restore as current workspace (protected)', () => {
  it('restores onto a fresh device with no guard needed', async () => {
    const state = makeState();
    seedIdb(state);
    const meta = await createSemesterArchive(state, { level: 'Level 200', semester: '1st Semester' });
    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });
    const result = await parseBackup(await blobToBuffer(blob));
    if (!result.ok || result.parsed.kind !== 'semester') throw new Error('parse failed');

    idbStore.clear();
    localStorage.clear();
    const freshState = makeState({ courses: [], topics: [], slides: [], notes: [], examQuestions: [], quizHistory: [], studyPlans: [], examDates: [], activities: [], chatHistory: [], highlights: [], savedInsights: [], learningObjectives: [], timetables: { class: [], quiz: [], exam: [] } });
    expect(hasWorkspaceContent(freshState)).toBe(false);

    const { fresh, guardArchive } = await importBackupAsWorkspace(result.parsed.staged, freshState);
    expect(guardArchive).toBeNull();
    expect(fresh.courses).toHaveLength(2);
    expect(idbStore.has('file_file1')).toBe(true);
    expect(idbStore.has('slidetext_s1')).toBe(true);
    expect((await listArchives())).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('pharmatrack_state')!).courses).toHaveLength(2);
  });

  it('auto-archives the current semester first (verified) and keeps both', async () => {
    // The imported (older) semester.
    const oldState = makeState({
      student: { id: 'u1', name: 'Ama', university: 'UCC', level: 'Level 200', program: 'Pharm.D', semester: '1st Semester', createdAt: '2023-01-01' },
      courses: [{ id: 'oc', studentId: 'u1', courseCode: 'PHA201', courseName: 'Old', lecturerName: 'Dr. A', semester: '1st Semester', creditHours: 3, createdAt: '2023-01-01' }],
      topics: [{ id: 'ot', courseId: 'oc', topicName: 'Old Topic', orderIndex: 0, createdAt: '2023-01-01' }],
      slides: [{ id: 'os', topicId: 'ot', slideNumber: 1, title: 'Old Slide', contentText: 'old', fileUrl: 'local:file1', fileType: 'pdf', status: 'not_started', createdAt: '2023-01-02' }],
      learningObjectives: [], examQuestions: [], quizHistory: [], studyPlans: [], notes: [], examDates: [], activities: [], chatHistory: [], highlights: [], savedInsights: [],
    });
    idbStore.set('file_file1', PDF_BYTES);
    const oldBlob = await exportBackup({ kind: 'live', state: oldState });
    const oldResult = await parseBackup(await blobToBuffer(oldBlob));
    if (!oldResult.ok || oldResult.parsed.kind !== 'semester') throw new Error('parse failed');

    // The current (newer) semester on this device.
    const current = makeState();
    seedIdb(current);

    const { fresh, guardArchive } = await importBackupAsWorkspace(oldResult.parsed.staged, current);
    expect(guardArchive).not.toBeNull();
    expect(guardArchive!.status).toBe('verified');
    expect(guardArchive!.title).toContain('(auto-backup before import)');

    // The workspace is now the imported semester…
    expect(fresh.courses.map((c) => c.id)).toEqual(['oc']);
    expect(fresh.student?.level).toBe('Level 200');
    // …with the CURRENT student's identity preserved.
    expect(fresh.student?.id).toBe('u1');
    // …and the previous current semester is safe as the guard archive
    // (the imported semester is the live workspace, not an archive).
    const list = await listArchives();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(guardArchive!.id);
  });

  it('a quota failure during the safety backup leaves EVERYTHING untouched', async () => {
    const state = makeState();
    seedIdb(state);
    const meta = await createSemesterArchive(state, { level: 'Level 200', semester: '1st Semester' });
    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });
    const result = await parseBackup(await blobToBuffer(blob));
    if (!result.ok || result.parsed.kind !== 'semester') throw new Error('parse failed');

    const current = makeState();
    seedIdb(current);
    const before = new Map(idbStore);
    const stateBefore = localStorage.getItem('pharmatrack_state');

    const realSet = idbStore.set.bind(idbStore);
    idbStore.set = (k: string, v: unknown) => {
      if (k.includes('archive_') && k.endsWith('_file2')) throw new DOMException('quota', 'QuotaExceededError');
      return realSet(k, v);
    };
    let threw = false;
    try {
      await importBackupAsWorkspace(result.parsed.staged, current);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(Error);
    }
    idbStore.set = realSet;
    expect(threw).toBe(true);

    for (const [k, v] of before) expect(idbStore.get(k), `record ${k} changed`).toBe(v);
    expect([...idbStore.keys()].filter((k) => k.startsWith('semester_archive') && !k.startsWith('semester_archive_file_') && !k.startsWith('semester_archive_text_')).length).toBe(1); // only the pre-existing archive
    expect(localStorage.getItem('pharmatrack_state')).toBe(stateBefore);
  });
});

describe('storage failure during Import into Academic Archive', () => {
  it('an interrupted import leaves no partial archive and touches nothing else', async () => {
    // Device A archives a semester and exports it.
    const deviceA = makeState();
    seedIdb(deviceA);
    const meta = await createSemesterArchive(deviceA, { level: 'Level 200', semester: '1st Semester' });
    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });
    const result = await parseBackup(await blobToBuffer(blob));
    if (!result.ok || result.parsed.kind !== 'semester') throw new Error('parse failed');

    // Device B: a fresh install with its own active (uncompleted) semester.
    idbStore.clear();
    localStorage.clear();
    const current = makeState();
    seedIdb(current);
    localStorage.setItem('pharmatrack_state', JSON.stringify(current));
    const before = new Map(idbStore);
    const stateBefore = localStorage.getItem('pharmatrack_state');

    // The copy of the first file blows up (quota / disk error).
    const realSet = idbStore.set.bind(idbStore);
    idbStore.set = (k: string, v: unknown) => {
      if (k.includes('archive_') && k.endsWith('_file1')) throw new DOMException('boom', 'QuotaExceededError');
      return realSet(k, v);
    };
    await expect(importBackupIntoArchive(result.parsed.staged, 'archive')).rejects.toThrow(/could not be imported/i);
    idbStore.set = realSet;

    // The live workspace is byte-for-byte untouched…
    for (const [k, v] of before) expect(idbStore.get(k), `record ${k} changed`).toBe(v);
    expect(localStorage.getItem('pharmatrack_state')).toBe(stateBefore);
    // …and the interrupted import left zero traces (no partial/failed archive litter).
    expect([...idbStore.keys()].filter((k) => k.startsWith('semester_archive'))).toEqual([]);
    expect((await listArchives())).toHaveLength(0);
    void meta;
  });
});

describe('validation — corrupted & invalid backups are rejected', () => {
  const seed = async () => {
    const state = makeState();
    seedIdb(state);
    const meta = await createSemesterArchive(state, { level: 'Level 300', semester: '1st Semester' });
    const blob = await exportBackup({ kind: 'archive', archiveId: meta.id });
    return { meta, blob };
  };

  it('rejects a non-zip file', async () => {
    const result = await parseBackup(new TextEncoder().encode('definitely not a zip').buffer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not a valid backup/i);
    expect(result.diagnostics).toBeTruthy();
  });

  it('rejects a zip whose manifest is not valid JSON', async () => {
    const { blob } = await seed();
    const zip = await JSZip.loadAsync(await blobToBuffer(blob));
    zip.file('manifest.json', '{ broken');
    const out = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parseBackup(out);
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown format string', async () => {
    const { blob } = await seed();
    const zip = await JSZip.loadAsync(await blobToBuffer(blob));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    manifest.format = 'pharmatrack-vibes-backup';
    zip.file('manifest.json', JSON.stringify(manifest));
    const out = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parseBackup(out);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unrecognised backup format/i);
  });

  it('rejects a backup from a different app', async () => {
    const { blob } = await seed();
    const zip = await JSZip.loadAsync(await blobToBuffer(blob));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    manifest.app = 'otherapp';
    zip.file('manifest.json', JSON.stringify(manifest));
    const out = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parseBackup(out);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not a pharmatrack backup/i);
  });

  it('rejects an unsupported format version (future)', async () => {
    const { blob } = await seed();
    const zip = await JSZip.loadAsync(await blobToBuffer(blob));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    manifest.formatVersion = 99;
    zip.file('manifest.json', JSON.stringify(manifest));
    const out = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parseBackup(out);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unsupported backup format version 99/i);
  });

  it('rejects a missing required collection', async () => {
    const { blob } = await seed();
    const zip = await JSZip.loadAsync(await blobToBuffer(blob));
    zip.remove('semester/notes.json');
    const out = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parseBackup(out);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/missing semester\/notes\.json/i);
  });

  it('rejects a declared file that is missing from the package', async () => {
    const { blob } = await seed();
    const zip = await JSZip.loadAsync(await blobToBuffer(blob));
    zip.remove('files/file1.pdf');
    const out = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parseBackup(out);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/missing entry/i);
  });

  it('rejects an undeclared extra entry (tampered package)', async () => {
    const { blob } = await seed();
    const zip = await JSZip.loadAsync(await blobToBuffer(blob));
    zip.file('files/evil.txt', 'surprise');
    const out = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parseBackup(out);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/undeclared entry/i);
  });

  it('rejects tampered file content (size or content-hash mismatch)', async () => {
    const { blob } = await seed();
    const zip = await JSZip.loadAsync(await blobToBuffer(blob));
    const realName = Object.keys(zip.files).find((n) => n.startsWith('files/') && n.includes('file2'))!;
    zip.file(realName, new Blob(['tampered'], { type: 'image/png' }));
    const out = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parseBackup(out);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/wrong size|content check|checksum/i);
  });

  it('rejects a mismatched record count (manifest vs actual)', async () => {
    const { blob } = await seed();
    const zip = await JSZip.loadAsync(await blobToBuffer(blob));
    const courses = JSON.parse(await zip.file('semester/courses.json')!.async('string'));
    courses.push({ ...courses[0], id: 'c-extra', courseCode: 'EXTRA1' });
    zip.file('semester/courses.json', JSON.stringify(courses));
    const out = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parseBackup(out);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/declares 2 courses|failed its content check|wrong size|checksum/i);
  });

  it('rejects broken relationships (slide referencing a deleted topic)', async () => {
    const { blob } = await seed();
    const zip = await JSZip.loadAsync(await blobToBuffer(blob));
    const topics = JSON.parse(await zip.file('semester/topics.json')!.async('string'));
    const remaining = topics.filter((t: { id: string }) => t.id !== 't1');
    zip.file('semester/topics.json', JSON.stringify(remaining));
    const out = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parseBackup(out);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/missing topic|content check|checksum/i);
  });
});

describe('legacy format compatibility (pre-v1 exports still import)', () => {
  it('imports a hand-built legacy `semester-backup` package', async () => {
    // Device A built the legacy zip exactly the old exporter did.
    const zip = new JSZip();
    const courses = [{ id: 'c1', studentId: 'u1', courseCode: 'PHA201', courseName: 'Legacy', lecturerName: 'Dr. L', semester: '1st Semester', creditHours: 3, createdAt: '2023-01-01' }];
    const topics = [{ id: 't1', courseId: 'c1', topicName: 'Legacy Topic', orderIndex: 0, createdAt: '2023-01-01' }];
    const slides = [{ id: 's1', topicId: 't1', slideNumber: 1, title: 'Legacy Slide', contentText: 'legacy', fileUrl: 'local:file1', fileType: 'pdf', status: 'not_started', createdAt: '2023-01-02' }];
    const fileBytes = new Blob(['%PDF legacy'], { type: 'application/pdf' });

    const files = [
      { name: 'files/file1', size: fileBytes.size, type: 'application/pdf' },
      { name: 'slideText/s1.txt', size: new TextEncoder().encode('legacy-text').length, type: 'text/plain' },
    ];
    const manifest = {
      app: 'pharmatrack',
      format: 'semester-backup',
      backupVersion: 1,
      created: '2023-08-01T00:00:00.000Z',
      source: 'archive',
      archiveId: 'archive_200_1_2023_2024_legacy01',
      title: 'Level 200 — Semester 1',
      level: '200',
      semester: '1',
      academicYear: '2023/2024',
      completedAt: '2023-08-01T00:00:00.000Z',
      checksum: '',
      itemCount: 4,
      fileCount: 2,
      totalBytes: fileBytes.size + new TextEncoder().encode('legacy-text').length,
      counts: { courses: 1, topics: 1, slides: 1, notes: 0, questions: 0, quizzes: 0 },
      files,
    };
    manifest.checksum = checksumOf(JSON.stringify({
      counts: { itemCount: manifest.itemCount, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes },
      files: files.map((f) => [f.name, f.size, f.type]).sort(),
    }));

    zip.file('manifest.json', JSON.stringify(manifest));
    zip.file('semester.json', JSON.stringify({ student: { id: 'u1', name: 'Ama', university: 'UCC', level: 'Level 200', program: 'Pharm.D', semester: '1st Semester', createdAt: '2023-01-01' } }));
    zip.file('courses.json', JSON.stringify(courses));
    zip.file('topics.json', JSON.stringify(topics));
    zip.file('slides.json', JSON.stringify(slides));
    zip.file('objectives.json', JSON.stringify([]));
    zip.file('notes.json', JSON.stringify([]));
    zip.file('questions.json', JSON.stringify([]));
    zip.file('quizzes.json', JSON.stringify([]));
    zip.file('studyPlans.json', JSON.stringify([]));
    zip.file('examDates.json', JSON.stringify([]));
    zip.file('activities.json', JSON.stringify([]));
    zip.file('chatHistory.json', JSON.stringify([]));
    zip.file('highlights.json', JSON.stringify([]));
    zip.file('insights.json', JSON.stringify([]));
    zip.file('timetable.json', JSON.stringify({ timetables: { class: [], quiz: [], exam: [] }, timetablePdf: null }));
    zip.file('files/file1', fileBytes);
    zip.file('slideText/s1.txt', 'legacy-text');

    const buffer = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parseBackup(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.kind).toBe('semester');
    if (result.parsed.kind !== 'semester') return;
    const staged = result.parsed.staged;
    expect((staged.manifest as any).format).toBe('semester-backup');
    expect(staged.snapshot.courses).toHaveLength(1);
    expect(staged.files.get('file1')?.kind).toBe('file');
    expect(staged.files.get('s1')?.value).toBe('legacy-text');

    // …and it can be installed into the archive.
    const imported = await importBackupIntoArchive(staged, 'archive');
    expect(imported.status).toBe('verified');
    expect(await loadArchivedFile(imported.id, 'file1')).toBeInstanceOf(Blob);
    expect(await loadArchivedSlideText(imported.id, 's1')).toBe('legacy-text');
  });

  it('rejects a legacy package with a tampered payload', async () => {
    const zip = new JSZip();
    const fileBytes = new Blob(['%PDF legacy'], { type: 'application/pdf' });
    const files = [{ name: 'files/file1', size: fileBytes.size, type: 'application/pdf' }];
    const manifest = {
      app: 'pharmatrack', format: 'semester-backup', backupVersion: 1,
      created: '2023-08-01T00:00:00.000Z', source: 'archive',
      archiveId: 'archive_200_1_2023_2024_legacy02', title: 'Level 200 — Semester 1',
      level: '200', semester: '1', completedAt: '2023-08-01T00:00:00.000Z',
      checksum: '', itemCount: 3, fileCount: 1, totalBytes: fileBytes.size,
      counts: { courses: 1, topics: 1, slides: 1, notes: 0, questions: 0, quizzes: 0 },
      files,
    };
    manifest.checksum = checksumOf(JSON.stringify({
      counts: { itemCount: 3, fileCount: 1, totalBytes: fileBytes.size },
      files: files.map((f) => [f.name, f.size, f.type]).sort(),
    }));
    zip.file('manifest.json', JSON.stringify(manifest));
    zip.file('semester.json', JSON.stringify({ student: { id: 'u1', name: 'Ama', university: 'UCC', level: 'Level 200', program: 'Pharm.D', semester: '1st Semester', createdAt: '2023-01-01' } }));
    zip.file('courses.json', JSON.stringify([{ id: 'c1', studentId: 'u1', courseCode: 'PHA201', courseName: 'Legacy', lecturerName: 'Dr. L', semester: '1st Semester', creditHours: 3, createdAt: '2023-01-01' }]));
    zip.file('topics.json', JSON.stringify([{ id: 't1', courseId: 'c1', topicName: 'T', orderIndex: 0, createdAt: '2023-01-01' }]));
    zip.file('slides.json', JSON.stringify([]));
    zip.file('objectives.json', JSON.stringify([]));
    zip.file('notes.json', JSON.stringify([]));
    zip.file('questions.json', JSON.stringify([]));
    zip.file('quizzes.json', JSON.stringify([]));
    zip.file('studyPlans.json', JSON.stringify([]));
    zip.file('examDates.json', JSON.stringify([]));
    zip.file('activities.json', JSON.stringify([]));
    zip.file('chatHistory.json', JSON.stringify([]));
    zip.file('highlights.json', JSON.stringify([]));
    zip.file('insights.json', JSON.stringify([]));
    zip.file('timetable.json', JSON.stringify({ timetables: { class: [], quiz: [], exam: [] }, timetablePdf: null }));
    // The declared size is for fileBytes, but we ship different bytes.
    zip.file('files/file1', new Blob(['tampered!'], { type: 'application/pdf' }));

    const result = await parseBackup(await zip.generateAsync({ type: 'arraybuffer' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/wrong size|checksum/i);
  });
});

describe('archive lifecycle guarantees', () => {
  it('multiple semesters coexist; opening any previous one is independent', async () => {
    const base = makeState();
    idbStore.set('file_file1', PDF_BYTES);
    const s1 = await createSemesterArchive(base, { level: 'Level 200', semester: '1st Semester', academicYear: '2025/2026' });
    const s2 = await createSemesterArchive(base, { level: 'Level 200', semester: '2nd Semester', academicYear: '2025/2026' });
    const s3 = await createSemesterArchive(base, { level: 'Level 300', semester: '1st Semester', academicYear: '2026/2027' });

    // Give each a distinct completion time (same-ms timestamps would tie).
    for (const [id, at] of [[s1.id, '2025-08-01T00:00:00.000Z'], [s2.id, '2026-01-10T00:00:00.000Z'], [s3.id, '2026-08-01T00:00:00.000Z']] as const) {
      const rec = (await loadArchive(id))!;
      rec.meta = { ...rec.meta, completedAt: at };
      idbStore.set(`semester_archive_${id}`, rec);
    }

    const list = await listArchives();
    expect(list.map((m) => m.id)).toEqual([s3.id, s2.id, s1.id]); // newest first, all present

    // Each archive is still fully openable after the others were created.
    for (const id of [s1.id, s2.id, s3.id]) {
      const rec = await loadArchive(id);
      expect(rec).not.toBeNull();
      expect(rec!.snapshot.courses).toHaveLength(2);
      expect(await loadArchivedFile(id, 'file1')).toBeInstanceOf(Blob);
    }

    // Deleting one never touches the others.
    await deleteArchive(s2.id);
    const after = await listArchives();
    expect(after.map((m) => m.id)).toEqual([s3.id, s1.id]);
    expect(await loadArchive(s1.id)).not.toBeNull();
    expect(await loadArchive(s3.id)).not.toBeNull();
  });
});
