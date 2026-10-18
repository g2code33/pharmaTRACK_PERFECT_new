/**
 * Sharing a whole course as a set of topic quizzes.
 *
 * The topic button shares one quiz and drops the recipient straight into it.
 * The course button is different on purpose: it shares the course, and the
 * recipient lands on a page listing every topic so they can pick one, do it,
 * come back, and do another whenever they like.
 *
 * A course link does NOT carry the questions. Each topic is uploaded as its
 * own ordinary quick quiz (the same short links the topic button creates), and
 * the course link carries only the topic names and their codes. That keeps the
 * link short no matter how big the course is, lets each topic be opened,
 * resumed and submitted by the existing quiz page with no special cases, and
 * needs nothing new from the server.
 */
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import type { ExamQuestion } from '../types';
import {
  INLINE_LINK_MAX_LENGTH,
  buildQuickQuizPack,
  buildShareHashUrl,
  createShortQuickQuizCode,
  encodeQuickQuizPack,
  type QuickQuizPack,
} from './quickQuizShare';

export const QUICK_COURSE_FORMAT = 'pharmatrack-quick-course';

/** One topic inside a shared course: either a short code or an offline pack. */
export interface QuickCourseEntry {
  name: string;
  questionCount: number;
  /** Short link code, when the quiz could be uploaded. */
  code?: string;
  /** Encoded inline pack, used when a short link could not be created. */
  pack?: string;
}

export interface QuickCoursePack {
  format: typeof QUICK_COURSE_FORMAT;
  version: 1;
  title: string;
  course?: { code?: string; name?: string };
  /** Applies to every topic quiz in the course. */
  timeLimitMinutes?: number;
  entries: QuickCourseEntry[];
}

/** A course's topics, before any of them have been turned into links. */
export interface QuickCourseTopicInput {
  name: string;
  questions: ExamQuestion[];
}

type TinyEntry = [name: string, count: number, value: string, isInline: 0 | 1];

type TinyCourse = {
  f: 'cq1';
  t: string;
  c?: [code: string, name: string];
  tm?: number;
  s: TinyEntry[];
};

function normalizeMinutes(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(24 * 60, Math.max(1, Math.round(n)));
}

export function encodeQuickCoursePack(pack: QuickCoursePack): string {
  const tiny: TinyCourse = {
    f: 'cq1',
    t: pack.title,
    c: pack.course ? [pack.course.code || '', pack.course.name || ''] : undefined,
    tm: normalizeMinutes(pack.timeLimitMinutes),
    s: pack.entries.map((entry): TinyEntry => [
      entry.name,
      entry.questionCount,
      entry.code || entry.pack || '',
      entry.code ? 0 : 1,
    ]),
  };
  return `z${compressToEncodedURIComponent(JSON.stringify(tiny)).replace(/\+/g, '~')}`;
}

export function decodeQuickCoursePack(encoded: string): QuickCoursePack {
  const value = (encoded || '').trim();
  if (!value.startsWith('z')) throw new Error('This course link is invalid or empty.');
  const json = decompressFromEncodedURIComponent(value.slice(1).replace(/~/g, '+'));
  if (!json) throw new Error('This course link is invalid or empty.');
  const tiny = JSON.parse(json) as TinyCourse;
  if (!tiny || tiny.f !== 'cq1' || !Array.isArray(tiny.s) || tiny.s.length === 0) {
    throw new Error('This course link is invalid or empty.');
  }
  return {
    format: QUICK_COURSE_FORMAT,
    version: 1,
    title: tiny.t || 'Shared PharmaTRACK Course',
    course: tiny.c ? { code: tiny.c[0] || undefined, name: tiny.c[1] || undefined } : undefined,
    timeLimitMinutes: normalizeMinutes(tiny.tm),
    entries: tiny.s
      .filter((entry) => Array.isArray(entry) && entry[2])
      .map((entry) => ({
        name: entry[0] || 'Topic',
        questionCount: Number(entry[1]) || 0,
        ...(entry[3] === 1 ? { pack: entry[2] } : { code: entry[2] }),
      })),
  };
}

export function quickCourseUrl(
  pack: QuickCoursePack,
  href: string = window.location.href,
): string {
  return buildShareHashUrl(`/quick-course?p=${encodeURIComponent(encodeQuickCoursePack(pack))}`, href);
}

/**
 * Where the "Start" button for one topic goes. Short-code topics reuse the
 * ordinary /q/:code route and offline ones the inline route, so the quiz page
 * needs no knowledge of courses beyond the link back.
 */
export function quickCourseTopicRoute(entry: QuickCourseEntry, courseParam: string): string {
  const back = `from=${encodeURIComponent(courseParam)}`;
  if (entry.code) return `/q/${encodeURIComponent(entry.code)}?${back}`;
  return `/quick-quiz?p=${encodeURIComponent(entry.pack || '')}&${back}`;
}

export interface QuickCourseShareProgress {
  /** 1-based index of the topic currently being uploaded. */
  current: number;
  total: number;
  name: string;
}

export interface QuickCourseShareResult {
  url: string;
  pack: QuickCoursePack;
  /** Topics that had to fall back to an offline link. */
  offlineTopics: string[];
}

/**
 * Turns a course's topics into one shareable link.
 *
 * Each topic is uploaded on its own so one failure does not lose the rest; a
 * topic that cannot be uploaded falls back to an offline link carried inside
 * the course link itself.
 */
export async function createQuickCourseShare(
  topics: QuickCourseTopicInput[],
  meta: {
    title: string;
    course?: { code?: string; name?: string };
    timeLimitMinutes?: number;
  },
  options: {
    href?: string;
    onProgress?: (progress: QuickCourseShareProgress) => void;
  } = {},
): Promise<QuickCourseShareResult> {
  const usable = topics.filter((topic) => topic.questions.some((q) => q.questionText.trim()));
  if (!usable.length) {
    throw new Error('This course has no questions to share yet.');
  }

  const timeLimitMinutes = normalizeMinutes(meta.timeLimitMinutes);
  const entries: QuickCourseEntry[] = [];
  const offlineTopics: string[] = [];

  for (let index = 0; index < usable.length; index += 1) {
    const topic = usable[index];
    options.onProgress?.({ current: index + 1, total: usable.length, name: topic.name });

    const quizPack: QuickQuizPack | null = buildQuickQuizPack(topic.questions, {
      title: topic.name,
      course: meta.course,
      topic: { name: topic.name },
      timeLimitMinutes,
    });
    if (!quizPack) continue;

    const code = await createShortQuickQuizCode(quizPack);
    if (code) {
      entries.push({ name: topic.name, questionCount: quizPack.questionCount, code });
      continue;
    }
    offlineTopics.push(topic.name);
    entries.push({
      name: topic.name,
      questionCount: quizPack.questionCount,
      pack: encodeQuickQuizPack(quizPack),
    });
  }

  if (!entries.length) throw new Error('This course has no questions to share yet.');

  const pack: QuickCoursePack = {
    format: QUICK_COURSE_FORMAT,
    version: 1,
    title: meta.title.trim() || 'Shared PharmaTRACK Course',
    course: meta.course,
    timeLimitMinutes,
    entries,
  };

  const url = quickCourseUrl(pack, options.href ?? window.location.href);
  if (url.length > INLINE_LINK_MAX_LENGTH) {
    throw new Error(
      'Could not create a short course link. Check your internet connection and try again — some topics had to be packed into the link itself, which made it too long.',
    );
  }
  return { url, pack, offlineTopics };
}
