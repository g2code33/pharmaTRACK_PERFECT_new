/**
 * The Question Bank has two share buttons and they must not do the same thing.
 *
 *  - The TOPIC button shares one quiz and drops the recipient straight into it.
 *    Unchanged.
 *  - The COURSE button shares the course: the recipient lands on a page listing
 *    every topic, picks one, does it, and can come back for the rest later.
 *
 * A course link carries no questions. Each topic is uploaded as its own
 * ordinary quick quiz and the course link only carries names and codes, so the
 * link stays short however big the course is and every topic is opened by the
 * existing quiz page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ExamQuestion } from '../types';
import {
  QUICK_COURSE_FORMAT,
  createQuickCourseShare,
  decodeQuickCoursePack,
  encodeQuickCoursePack,
  quickCourseTopicRoute,
  quickCourseUrl,
  type QuickCoursePack,
} from '../utils/quickCourseShare';
import {
  quickCourseEntryKey,
  quickCourseEntryProgress,
  quickQuizPackKey,
  rememberQuickCourseEntryPack,
  savePausedQuickQuiz,
  saveQuickCourseResult,
} from '../utils/quickQuizAttempts';

const root = path.resolve(process.cwd());
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const question = (text: string, index: number): ExamQuestion => ({
  id: `q-${index}`,
  courseId: 'course-1',
  topicId: 'topic-1',
  questionText: text,
  questionType: 'mcq',
  marksAllocation: 1,
  difficulty: 'medium',
  probability: 'medium',
  modelAnswer: '',
  options: ['Alpha', 'Beta', 'Gamma', 'Delta'],
  correctOption: 1,
  correctAnswer: 'Beta',
  isPracticed: false,
  needsReview: false,
  isSaved: true,
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
});

const topicInput = (name: string, count: number) => ({
  name,
  questions: Array.from({ length: count }, (_, index) => question(`${name} question ${index + 1}`, index)),
});

const HREF = 'https://pharmatrack.example.com/';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

describe('course pack encoding', () => {
  const pack: QuickCoursePack = {
    format: QUICK_COURSE_FORMAT,
    version: 1,
    title: 'PHA 301: Pharmacology',
    course: { code: 'PHA 301', name: 'Pharmacology' },
    timeLimitMinutes: 15,
    entries: [
      { name: 'Autonomic drugs', questionCount: 12, code: 'abcd1234ef' },
      { name: 'Antibiotics', questionCount: 8, code: 'ghij5678kl' },
    ],
  };

  it('round-trips through the link', () => {
    const decoded = decodeQuickCoursePack(encodeQuickCoursePack(pack));
    expect(decoded.title).toBe('PHA 301: Pharmacology');
    expect(decoded.course).toEqual({ code: 'PHA 301', name: 'Pharmacology' });
    expect(decoded.timeLimitMinutes).toBe(15);
    expect(decoded.entries).toEqual(pack.entries);
  });

  it('stays short regardless of how many questions the course holds', () => {
    const big: QuickCoursePack = {
      ...pack,
      entries: Array.from({ length: 20 }, (_, index) => ({
        name: `Topic number ${index + 1}`,
        questionCount: 40,
        code: `code${index}abcdef`,
      })),
    };
    const url = quickCourseUrl(big, HREF);
    expect(url.length).toBeLessThan(900);
    expect(url).toContain('#/quick-course?p=');
  });

  it('refuses a link that carries nothing', () => {
    expect(() => decodeQuickCoursePack('')).toThrow();
    expect(() => decodeQuickCoursePack('not-a-course')).toThrow();
  });

  it('sends each topic to the route that can open it', () => {
    expect(quickCourseTopicRoute({ name: 'A', questionCount: 2, code: 'abc123' }, 'zPACK')).toBe(
      '/q/abc123?from=zPACK',
    );
    const inline = quickCourseTopicRoute({ name: 'A', questionCount: 2, pack: 'zTINY' }, 'zPACK');
    expect(inline).toBe('/quick-quiz?p=zTINY&from=zPACK');
  });
});

describe('creating a course share', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { ...window, location: { href: HREF } });
    // Short links need a configured API; without one the share falls straight
    // back to packing every topic into the link.
    vi.stubEnv('VITE_CLOUDFLARE_API_BASE_URL', 'https://api.pharmatrack.example.com');
  });

  it('uploads one quiz per topic and keeps only their codes in the link', async () => {
    const bodies: string[] = [];
    let counter = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body || ''));
        counter += 1;
        return {
          ok: true,
          json: async () => ({ code: `code${counter}xxxxx` }),
        } as unknown as Response;
      }),
    );

    const result = await createQuickCourseShare(
      [topicInput('Autonomic drugs', 3), topicInput('Antibiotics', 2)],
      { title: 'PHA 301: Pharmacology', course: { code: 'PHA 301', name: 'Pharmacology' } },
      { href: HREF },
    );

    expect(bodies).toHaveLength(2);
    expect(result.offlineTopics).toEqual([]);
    expect(result.pack.entries.map((entry) => entry.code)).toEqual(['code1xxxxx', 'code2xxxxx']);
    expect(result.pack.entries.map((entry) => entry.name)).toEqual([
      'Autonomic drugs',
      'Antibiotics',
    ]);
    expect(result.pack.entries.map((entry) => entry.questionCount)).toEqual([3, 2]);
    // The questions travel to the server, never inside the link.
    expect(result.url).not.toContain('Autonomic drugs question 1');
    expect(result.url.length).toBeLessThan(400);
  });

  it('applies the chosen time limit to every topic quiz', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body || ''));
        return { ok: true, json: async () => ({ code: 'abcdefghij' }) } as unknown as Response;
      }),
    );

    const result = await createQuickCourseShare(
      [topicInput('One', 2), topicInput('Two', 2)],
      { title: 'Course', timeLimitMinutes: 20 },
      { href: HREF },
    );

    expect(result.pack.timeLimitMinutes).toBe(20);
    for (const body of bodies) {
      expect(JSON.parse(body).pack.timeLimitMinutes).toBe(20);
    }
  });

  it('reports progress so a big course does not look frozen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ code: 'abcdefghij' }) }) as unknown as Response),
    );
    const seen: string[] = [];
    await createQuickCourseShare(
      [topicInput('One', 1), topicInput('Two', 1), topicInput('Three', 1)],
      { title: 'Course' },
      { href: HREF, onProgress: ({ current, total, name }) => seen.push(`${current}/${total} ${name}`) },
    );
    expect(seen).toEqual(['1/3 One', '2/3 Two', '3/3 Three']);
  });

  it('keeps a topic the server rejected by packing it into the link', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        if (call === 1) return { ok: false, status: 500 } as unknown as Response;
        return { ok: true, json: async () => ({ code: 'abcdefghij' }) } as unknown as Response;
      }),
    );

    const result = await createQuickCourseShare(
      [topicInput('Offline topic', 2), topicInput('Online topic', 2)],
      { title: 'Course' },
      { href: HREF },
    );

    expect(result.offlineTopics).toEqual(['Offline topic']);
    expect(result.pack.entries[0].pack).toBeTruthy();
    expect(result.pack.entries[0].code).toBeUndefined();
    expect(result.pack.entries[1].code).toBe('abcdefghij');
  });

  it('refuses a course with nothing in it', async () => {
    await expect(
      createQuickCourseShare([{ name: 'Empty', questions: [] }], { title: 'Course' }, { href: HREF }),
    ).rejects.toThrow(/no questions/i);
  });
});

describe('per-topic progress on the course page', () => {
  const entry = { name: 'Autonomic drugs', questionCount: 3, code: 'abcd1234ef' };

  it('starts out as not started', () => {
    expect(quickCourseEntryProgress(quickCourseEntryKey(entry)).status).toBe('not-started');
  });

  it('shows a saved score once the topic has been submitted', () => {
    const key = quickCourseEntryKey(entry);
    saveQuickCourseResult(key, {
      percent: 67,
      correct: 2,
      total: 3,
      completedAt: '2026-02-01T10:00:00.000Z',
    });
    const progress = quickCourseEntryProgress(key);
    expect(progress).toMatchObject({ status: 'done', percent: 67, correct: 2, total: 3 });
  });

  it('shows an unfinished attempt as in progress', () => {
    const key = quickCourseEntryKey(entry);
    const packKey = quickQuizPackKey({
      format: 'pharmatrack-quick-quiz',
      version: 1,
      title: 'Autonomic drugs',
      exportedAt: '2026-01-01T00:00:00.000Z',
      questionCount: 3,
      questions: [],
    });
    rememberQuickCourseEntryPack(key, packKey);
    savePausedQuickQuiz({
      version: 1,
      reason: 'auto',
      savedAt: '2026-02-01T10:00:00.000Z',
      packKey,
      answers: { a: '1', b: '', c: '2' },
      currentIndex: 1,
      timeRemainingSeconds: null,
      timeExpired: false,
    });
    expect(quickCourseEntryProgress(key)).toMatchObject({ status: 'in-progress', answered: 2 });
  });

  it("keeps each topic's progress separate", () => {
    const first = quickCourseEntryKey({ code: 'aaaa1111bb' });
    const second = quickCourseEntryKey({ code: 'cccc2222dd' });
    expect(first).not.toBe(second);
    saveQuickCourseResult(first, {
      percent: 100,
      correct: 3,
      total: 3,
      completedAt: '2026-02-01T10:00:00.000Z',
    });
    expect(quickCourseEntryProgress(first).status).toBe('done');
    expect(quickCourseEntryProgress(second).status).toBe('not-started');
  });

  it('identifies offline topics by their pack, so reopening the link keeps progress', () => {
    const key = quickCourseEntryKey({ pack: 'zSOMETHING' });
    expect(key).toBe(quickCourseEntryKey({ pack: 'zSOMETHING' }));
    expect(key).not.toBe(quickCourseEntryKey({ pack: 'zOTHER' }));
  });
});

describe('the two buttons stay different', () => {
  it('the course button shares the course and the topic button shares one quiz', () => {
    const page = read('src/pages/QuestionBank.tsx');
    expect(page).toContain('shareQuickCourse(course, e)');
    expect(page).toContain('Share course');
    // The topic button is untouched: still one pack, straight into the quiz.
    expect(page).toContain('void shareQuickQuiz(topic.questions');
    expect(page).toContain('Quick Start');
    // The course button no longer flattens every topic into a single quiz.
    expect(page).not.toContain('course.topics.flatMap((t) => t.questions)');
  });

  it('routes the course page and treats its link as an app link', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('lazyRoute(\'/quick-course\'');
    expect(app).toContain('<Route path="/quick-course" element={<QuickCourse />} />');

    const links = read('src/utils/appLinks.ts');
    expect(links).toContain("'/quick-course'");
  });

  it('lets a student go back to the topic list from inside a topic', () => {
    const quiz = read('src/pages/QuickQuiz.tsx');
    expect(quiz).toContain("params.get('from')");
    expect(quiz).toContain('/quick-course?p=');
    expect(quiz).toContain('quick-quiz-back-to-course');
    expect(quiz).toContain('Choose another topic');
    // Submitting reports the score back so the list can show it.
    expect(quiz).toContain('saveQuickCourseResult(courseEntryKey');
  });

  it('shows every topic with its own start control on the course page', () => {
    const page = read('src/pages/QuickCourse.tsx');
    expect(page).toContain('quick-course-topics');
    expect(page).toContain('quickCourseTopicRoute(entry, courseParam)');
    expect(page).toContain('Resit');
    expect(page).toContain('Resume');
    expect(page).toContain('topics done');
  });
});
