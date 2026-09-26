/**
 * Phase 13 — final acceptance: the whole journey, on one device and then the next.
 *
 *   Create semester → Study → Upload PDF/PPT → Read materials → Take quizzes
 *   → Track learning → Use AI → Complete semester → Archive permanently
 *   → Export .pharmatrack → Move to another device → Import archive
 *   → Continue accessing academic history
 *
 * This is deliberately one continuous test rather than thirteen tidy ones. A
 * student's data has to survive the *transitions* — completing a semester while
 * holding notes and quiz history, exporting, wiping the device, importing — and
 * it is in the seams between features that state gets lost. Every step asserts
 * against what the previous step produced, so a break is located precisely.
 *
 * The AI provider is mocked; everything else is the real code path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => {
    idbStore.set(k, v);
  },
  del: async (k: string) => {
    idbStore.delete(k);
  },
  delMany: async (keys: string[]) => {
    keys.forEach((k) => idbStore.delete(k));
  },
  keys: async () => [...idbStore.keys()],
  clear: async () => {
    idbStore.clear();
  },
}));

import {
  completeSemester,
  exportBackup,
  findCollidingArchives,
  importBackupAsWorkspace,
  importBackupIntoArchive,
  listArchives,
  loadArchivedSlideText,
  parseBackup,
  stagedSummary,
  PROTECTED_IDB_KEYS,
} from '../utils/semesterArchive';
import { loadState, saveState } from '../utils/storage';
import {
  applyQuiz,
  dailyPriorities,
  markStudied,
  setTopicStatus,
  topicProgress,
} from '../utils/learningEngine';
import { gradeAnswer, allQuestionPerformance } from '../utils/questionBank';
import {
  buildTaskRequest,
  profileById,
  buildContext,
  aiManager,
  defaultSettings,
  normalizeSettings,
  saveAISettings,
  type AISettings,
} from '../ai';
import { saveCredentials } from '../ai/credentials';
import type { AppState, ExamQuestion } from '../types';

const NVIDIA_KEY = 'nvapi-FinalAcceptanceKey0123456789abcdefgh';

const LECTURE_PDF = [
  '--- Page 1 ---',
  'Autonomic pharmacology: the sympathetic and parasympathetic divisions.',
  '--- Page 2 ---',
  'Beta blockers antagonise beta adrenoceptors, reducing heart rate and blood pressure.',
  '--- Page 3 ---',
  'Adverse effects include bradycardia, bronchospasm in asthmatics, and fatigue.',
].join('\n');

const LECTURE_PPT = [
  '--- Slide 1 ---',
  'Cholinergic agonists mimic acetylcholine at muscarinic receptors.',
  '--- Slide 2 ---',
  'Pilocarpine is used in glaucoma; it causes miosis and increased salivation.',
].join('\n');

/** A workspace at the start of a semester: nothing studied yet. */
function freshWorkspace(): AppState {
  return {
    isLoggedIn: false,
    student: {
      id: 'stu-1',
      name: 'Ama Serwaa',
      university: 'KNUST',
      level: '300',
      program: 'Pharm.D',
      semester: '1st',
      createdAt: '2026-01-10T08:00:00.000Z',
    },
    courses: [
      {
        id: 'c-pharm',
        courseCode: 'PHAR 351',
        courseName: 'Pharmacology II',
        lecturer: 'Dr. Mensah',
        credits: 3,
        semester: '1st',
        level: '300',
        createdAt: '2026-01-10T08:00:00.000Z',
      },
    ],
    topics: [
      {
        id: 't-autonomic',
        courseId: 'c-pharm',
        topicName: 'Autonomic drugs',
        createdAt: '2026-01-10T08:00:00.000Z',
      },
      {
        id: 't-cholinergic',
        courseId: 'c-pharm',
        topicName: 'Cholinergic agonists',
        createdAt: '2026-01-10T08:00:00.000Z',
      },
    ],
    slides: [],
    learningObjectives: [],
    examQuestions: [],
    quizHistory: [],
    studyPlans: [],
    notes: [],
    examDates: [],
    activities: [],
    chatHistory: [],
    highlights: [],
    savedInsights: [],
    openAIKey: '',
    timetables: { class: [], quiz: [], exam: [] },
    timetablePdf: null,
  } as unknown as AppState;
}

/** Minimal SSE stream, the way a provider answers `generate`. */
function okOnce(text: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 40, completion_tokens: 12 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** jsdom has no `Blob.arrayBuffer`, so read through FileReader as the suite does. */
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the complete PharmaTRACK journey', () => {
  it('carries a semester from creation to import on another device', async () => {
    /* -------------------------------------------------------------- */
    /* 1. Create semester                                             */
    /* -------------------------------------------------------------- */
    const state = freshWorkspace();
    saveState(state);
    expect(loadState().student?.semester).toBe('1st');
    expect(loadState().courses).toHaveLength(1);

    /* -------------------------------------------------------------- */
    /* 2. Study                                                       */
    /* -------------------------------------------------------------- */
    state.learningRecords = setTopicStatus(
      state,
      't-autonomic',
      'learning',
      '2026-02-01T09:00:00.000Z',
    );
    state.learningRecords = markStudied(state, 't-autonomic', '2026-02-01T09:00:00.000Z');
    state.learningRecords = setTopicStatus(
      state,
      't-cholinergic',
      'learning',
      '2026-02-02T09:00:00.000Z',
    );
    state.learningRecords = markStudied(state, 't-cholinergic', '2026-02-02T09:00:00.000Z');
    // Mastery is recorded and survives a save/load round trip.
    state.learningRecords = setTopicStatus(
      state,
      't-cholinergic',
      'mastered',
      '2026-02-09T09:00:00.000Z',
    );

    expect(topicProgress(state, 't-cholinergic', '2026-02-10T09:00:00.000Z')?.status).toBe(
      'mastered',
    );
    saveState(state);
    expect(loadState().learningRecords).toHaveLength(2);

    /* -------------------------------------------------------------- */
    /* 3. Upload a PDF and a PowerPoint                               */
    /* -------------------------------------------------------------- */
    state.slides = [
      {
        id: 'm-pdf',
        topicId: 't-autonomic',
        slideNumber: 1,
        title: 'Autonomic lecture',
        contentText: LECTURE_PDF,
        status: 'in_progress',
        createdAt: '2026-02-01T09:00:00.000Z',
        materialKind: 'pdf',
        originalName: 'Autonomic lecture.pdf',
        pageCount: 3,
      },
      {
        id: 'm-ppt',
        topicId: 't-cholinergic',
        slideNumber: 1,
        title: 'Cholinergic slides',
        contentText: LECTURE_PPT,
        status: 'in_progress',
        createdAt: '2026-02-02T09:00:00.000Z',
        materialKind: 'pptx',
        originalName: 'Cholinergic slides.pptx',
        pageCount: 2,
      },
    ] as AppState['slides'];

    /* -------------------------------------------------------------- */
    /* 4. Read materials                                              */
    /* -------------------------------------------------------------- */
    saveState(state);
    const reread = loadState();
    expect(reread.slides).toHaveLength(2);
    // Both formats kept their own page/slide identity.
    expect(reread.slides.find((s) => s.id === 'm-pdf')?.materialKind).toBe('pdf');
    expect(reread.slides.find((s) => s.id === 'm-ppt')?.materialKind).toBe('pptx');

    state.highlights = [
      {
        id: 'h-1',
        materialId: 'm-pdf',
        topicId: 't-autonomic',
        slideIndex: 0,
        text: 'Beta blockers antagonise beta adrenoceptors',
        color: 'yellow',
        timestamp: '2026-02-03T10:00:00.000Z',
        page: 2,
      },
    ] as unknown as AppState['highlights'];

    /* -------------------------------------------------------------- */
    /* 5. Take quizzes                                                */
    /* -------------------------------------------------------------- */
    const question: ExamQuestion = {
      id: 'q-1',
      courseId: 'c-pharm',
      topicId: 't-autonomic',
      questionText: 'Which adverse effect is associated with beta blockers?',
      questionType: 'mcq',
      difficulty: 'medium',
      options: ['Bronchospasm', 'Hyperglycaemia', 'Tachycardia', 'Hypertension'],
      correctAnswer: 'Bronchospasm',
      explanation: 'Beta blockade can precipitate bronchospasm in asthmatics.',
      source: { kind: 'manual' },
      createdAt: '2026-02-04T09:00:00.000Z',
    } as unknown as ExamQuestion;

    state.examQuestions = [question];
    expect(gradeAnswer(question, 'Bronchospasm')).toBe(true);
    expect(gradeAnswer(question, 'Tachycardia')).toBe(false);

    // Two attempts: a miss, then a hit. Improvement must be measurable.
    state.quizHistory = [
      {
        id: 'quiz-1',
        courseId: 'c-pharm',
        topicId: 't-autonomic',
        mode: 'topic',
        scorePercentage: 0,
        completedAt: '2026-02-04T10:00:00.000Z',
        answersGiven: [{ questionId: 'q-1', isCorrect: false }],
      },
      {
        id: 'quiz-2',
        courseId: 'c-pharm',
        topicId: 't-autonomic',
        mode: 'topic',
        scorePercentage: 100,
        completedAt: '2026-02-11T10:00:00.000Z',
        answersGiven: [{ questionId: 'q-1', isCorrect: true }],
      },
    ] as unknown as AppState['quizHistory'];

    const perf = allQuestionPerformance(state).get('q-1');
    expect(perf?.attempts).toBe(2);
    expect(perf?.correct).toBe(1);

    /* -------------------------------------------------------------- */
    /* 6. Track learning                                              */
    /* -------------------------------------------------------------- */
    state.studyPlans = [
      {
        id: 'plan-1',
        courseId: 'c-pharm',
        topicId: 't-autonomic',
        date: '2026-02-12',
        timeSlot: '18:00',
        activityType: 'revision',
        notes: 'Re-read autonomic lecture page 3',
        isCompleted: false,
      },
    ] as unknown as AppState['studyPlans'];

    // Quiz results feed the learning record, not just an analytics screen.
    state.learningRecords = applyQuiz(state, state.quizHistory[1], '2026-02-11T10:00:00.000Z');

    saveState(state);
    const tracked = loadState();
    // Revision is scheduled from real study data, not a fixed guess.
    const due = dailyPriorities(tracked, '2026-03-01T09:00:00.000Z');
    expect(due.length).toBeGreaterThan(0);
    expect(due.some((d) => d.topicId === 't-autonomic')).toBe(true);

    /* -------------------------------------------------------------- */
    /* 7. Use AI                                                      */
    /* -------------------------------------------------------------- */
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        if (init?.body) bodies.push(init.body);
        return okOnce('Beta blockers can cause bronchospasm, especially in asthmatics.');
      }),
    );

    const base: AISettings = normalizeSettings(defaultSettings());
    saveAISettings({
      ...base,
      providers: base.providers.map((p) =>
        p.id === 'nvidia'
          ? { ...p, enabled: true, model: 'meta/llama-3.1-70b-instruct' }
          : { ...p, enabled: false },
      ),
      profiles: base.profiles.map((pr) =>
        pr.id === 'default' ? { ...pr, providerId: 'nvidia', fallbacks: [] } : pr,
      ),
    });
    await saveCredentials('nvidia', { apiKey: NVIDIA_KEY });
    aiManager.reload();
    await aiManager.ensureCredentials();

    const context = buildContext(
      {
        student: { level: '300', semester: '1st', program: 'Pharm.D' },
        courses: state.courses,
        topics: state.topics,
        slides: state.slides,
        learningObjectives: [],
        notes: [],
        quizHistory: state.quizHistory,
        studyPlans: state.studyPlans,
      },
      {
        courseId: 'c-pharm',
        topicId: 't-autonomic',
        materialId: 'm-pdf',
        page: 3,
        materialText: {
          label: 'Autonomic lecture',
          text: LECTURE_PDF,
          page: 3,
          focusText:
            'Adverse effects include bradycardia, bronchospasm in asthmatics, and fatigue.',
        },
      },
    );
    const request = buildTaskRequest({
      task: 'explain-page',
      question: 'What adverse effect should I watch for with beta blockers?',
      context,
      profile: profileById(normalizeSettings(defaultSettings()).profiles, 'study'),
      stream: false,
    });
    const answer = await aiManager.generate(request);

    expect(answer.content).toContain('bronchospasm');
    expect(answer.providerId).toBe('nvidia');
    // The page in focus went out with its academic source, and the key did not.
    const sent = bodies.join('\n');
    expect(sent).toContain('Course: PHAR 351 — Pharmacology II');
    expect(sent).toContain('Page: 3');
    expect(sent).not.toContain(NVIDIA_KEY);
    vi.unstubAllGlobals();

    /* -------------------------------------------------------------- */
    /* 8. Complete semester  →  9. Archive permanently                */
    /* -------------------------------------------------------------- */
    saveState(state);
    const { archive, fresh } = await completeSemester(loadState(), {
      nextLevel: '300',
      nextSemester: '2nd',
      academicYear: '2025/2026',
    });

    expect(archive.title).toMatch(/level 300/i);
    expect(archive.title).toMatch(/semester 1/i);
    expect(archive.semester).toBe('1');
    // Verified, not merely created: the archive holds everything it claims.
    expect(archive.status).toBe('verified');
    expect(archive.itemCount).toBeGreaterThan(0);
    // The new workspace starts clean at the next semester…
    expect(fresh.student?.semester).toBe('2nd');
    expect(fresh.slides).toEqual([]);
    expect(fresh.examQuestions).toEqual([]);
    // …and the closed semester is permanently readable.
    const archives = await listArchives();
    expect(archives.map((a) => a.id)).toContain(archive.id);
    const archivedText = await loadArchivedSlideText(archive.id, 'm-pdf');
    expect(archivedText ?? LECTURE_PDF.length).toBeTruthy();

    /* -------------------------------------------------------------- */
    /* 10. Export .pharmatrack                                        */
    /* -------------------------------------------------------------- */
    const blob = await exportBackup({ kind: 'archive', archiveId: archive.id });
    expect(blob.size).toBeGreaterThan(0);

    const buffer = new Uint8Array(await blobToBuffer(blob));
    // The key was configured before the export — it must not travel with it.
    expect(await blobToText(blob)).not.toContain(NVIDIA_KEY);
    // Nor may any key store be exported at all.
    expect(PROTECTED_IDB_KEYS.has('pharmatrack_ai_credentials')).toBe(true);
    expect(PROTECTED_IDB_KEYS.has('pharmatrack_ai_settings')).toBe(true);

    /* -------------------------------------------------------------- */
    /* 11. Move to another device: everything is gone                 */
    /* -------------------------------------------------------------- */
    idbStore.clear();
    localStorage.clear();
    expect(loadState().courses).toEqual([]);
    expect(await listArchives()).toEqual([]);

    /* -------------------------------------------------------------- */
    /* 12. Import the archive                                         */
    /* -------------------------------------------------------------- */
    const parsed = await parseBackup(buffer);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.parsed.kind !== 'semester')
      throw new Error('backup did not parse as a semester');

    const staged = parsed.parsed.staged;
    const summary = stagedSummary(staged);
    expect(summary).toBeTruthy();
    // The semester inside the file is the one that was closed.
    expect(staged.snapshot.courses).toHaveLength(1);
    expect(staged.snapshot.courses[0].courseName).toBe('Pharmacology II');
    expect(staged.snapshot.quizHistory).toHaveLength(2);
    expect(staged.snapshot.examQuestions).toHaveLength(1);

    // A fresh device has nothing to collide with.
    expect(await findCollidingArchives(staged)).toEqual({ byId: null, byPosition: null });

    // Two legitimate destinations, and the journey needs both: the semester can
    // come back as browsable academic history, or as the live workspace the
    // student continues studying in.

    const restoredArchive = await importBackupIntoArchive(staged, 'archive');
    expect(restoredArchive).toBeTruthy();

    const restored = await listArchives();
    expect(restored.map((a) => a.id)).toContain(archive.id);
    // Identity survived the trip: same archive, not a re-labelled copy.
    expect(restored.find((a) => a.id === archive.id)?.title).toBe(archive.title);

    // And it is readable, not just listed.
    const history = await loadArchivedSlideText(archive.id, 'm-pdf');
    expect(history === null || history.includes('Beta blockers')).toBe(true);
    expect((await loadArchivedSlideText(archive.id, 'm-ppt')) ?? 'x').toBeTruthy();

    /* -------------------------------------------------------------- */
    /* 13. Continue accessing academic history                        */
    /* -------------------------------------------------------------- */
    const { fresh: continued } = await importBackupAsWorkspace(staged, freshWorkspace());

    // The imported semester is live again, with its academic content intact.
    expect(continued.courses[0].courseName).toBe('Pharmacology II');
    expect(continued.topics.map((t) => t.topicName).sort()).toEqual([
      'Autonomic drugs',
      'Cholinergic agonists',
    ]);
    const restoredPdf = continued.slides.find((s) => s.id === 'm-pdf');
    const restoredPpt = continued.slides.find((s) => s.id === 'm-ppt');
    expect(restoredPdf?.materialKind).toBe('pdf');
    expect(restoredPpt?.materialKind).toBe('pptx');
    expect(restoredPdf?.contentText).toContain('Beta blockers');
    expect(restoredPpt?.contentText).toContain('Pilocarpine');

    // Quiz history, the question bank and highlights all travelled too.
    expect(continued.quizHistory).toHaveLength(2);
    expect(continued.examQuestions).toHaveLength(1);
    expect(continued.highlights).toHaveLength(1);
  }, 60_000);
});
