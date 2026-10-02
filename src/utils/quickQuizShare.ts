import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import type { ExamQuestion } from '../types';
import type { SharedQuestion } from './questionShare';
import { isNativeShellOrigin } from '../platform/runtime';

export const QUICK_QUIZ_FORMAT = 'pharmatrack-quick-quiz';
export const QUICK_QUIZ_VERSION = 1;

export interface QuickQuizPack {
  format: typeof QUICK_QUIZ_FORMAT;
  version: number;
  title: string;
  exportedAt: string;
  course?: { code?: string; name?: string };
  topic?: { name?: string };
  /** Positive minutes for a timed shared quiz. Missing means no time limit. */
  timeLimitMinutes?: number;
  questionCount: number;
  questions: SharedQuestion[];
}

type CompactQuestion = [
  string,
  SharedQuestion['questionType'],
  SharedQuestion['difficulty'],
  string[] | undefined,
  number | undefined,
  string | undefined,
  string | undefined,
  string | undefined,
  string[] | undefined,
];

type CompactPack = {
  f: 'ptqq';
  v: number;
  t: string;
  at: string;
  c?: { c?: string; n?: string };
  p?: { n?: string };
  tm?: number;
  q: CompactQuestion[];
};

type TinyQuestion =
  | [string, 'm', string[], number, string?]
  | [string, 's' | 'e', string?];

type TinyPack = {
  f: 'q2';
  t: string;
  tm?: number;
  q: TinyQuestion[];
};

type ShareUrlResult = { url: string; mode: 'short-code' | 'inline' };

const PUBLIC_APP_URL_FALLBACK = 'https://pharmatrack-web.pages.dev/';
const INLINE_LINK_MAX_LENGTH = 1800;

const TYPE_TO_CODE: Record<SharedQuestion['questionType'], 'm' | 's' | 'e'> = {
  mcq: 'm',
  short_answer: 's',
  essay: 'e',
  structured: 'e',
  case_study: 'e',
};

const CODE_TO_TYPE: Record<'m' | 's' | 'e', SharedQuestion['questionType']> = {
  m: 'mcq',
  s: 'short_answer',
  e: 'essay',
};

const toSharedQuestion = (q: ExamQuestion): SharedQuestion => ({
  questionText: q.questionText,
  questionType: q.questionType,
  difficulty: q.difficulty,
  options: q.options,
  correctOption: q.correctOption,
  correctAnswer: q.correctAnswer,
  explanation: q.explanation || q.modelAnswer || undefined,
  semester: q.semester,
  tags: q.tags?.filter((tag) => tag !== 'imported' && tag !== 'manual' && tag !== 'shared'),
});

function normalizeTimeLimitMinutes(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(24 * 60, Math.max(1, Math.round(n)));
}

export function buildQuickQuizPack(
  questions: ExamQuestion[],
  meta: { title: string; course?: { code?: string; name?: string }; topic?: { name?: string }; timeLimitMinutes?: number },
): QuickQuizPack | null {
  const usable = questions.filter((q) => q.questionText.trim());
  if (!usable.length) return null;
  const timeLimitMinutes = normalizeTimeLimitMinutes(meta.timeLimitMinutes);
  return {
    format: QUICK_QUIZ_FORMAT,
    version: QUICK_QUIZ_VERSION,
    title: meta.title.trim() || 'Shared PharmaTRACK Quiz',
    exportedAt: new Date().toISOString(),
    course: meta.course,
    topic: meta.topic,
    ...(timeLimitMinutes ? { timeLimitMinutes } : {}),
    questionCount: usable.length,
    questions: usable.map(toSharedQuestion),
  };
}

const compactQuestion = (q: SharedQuestion): CompactQuestion => [
  q.questionText,
  q.questionType,
  q.difficulty,
  q.options,
  q.correctOption,
  q.correctAnswer,
  q.explanation,
  q.semester,
  q.tags,
];

const expandQuestion = (q: CompactQuestion): SharedQuestion => ({
  questionText: q[0],
  questionType: q[1],
  difficulty: q[2],
  options: q[3],
  correctOption: q[4],
  correctAnswer: q[5],
  explanation: q[6],
  semester: q[7],
  tags: q[8],
});

const toCompact = (pack: QuickQuizPack): CompactPack => ({
  f: 'ptqq',
  v: pack.version,
  t: pack.title,
  at: pack.exportedAt,
  c: pack.course ? { c: pack.course.code, n: pack.course.name } : undefined,
  p: pack.topic ? { n: pack.topic.name } : undefined,
  tm: normalizeTimeLimitMinutes(pack.timeLimitMinutes),
  q: pack.questions.map(compactQuestion),
});

const fromCompact = (pack: CompactPack): QuickQuizPack => ({
  format: QUICK_QUIZ_FORMAT,
  version: pack.v || QUICK_QUIZ_VERSION,
  title: pack.t || 'Shared PharmaTRACK Quiz',
  exportedAt: pack.at || new Date().toISOString(),
  course: pack.c ? { code: pack.c.c, name: pack.c.n } : undefined,
  topic: pack.p ? { name: pack.p.n } : undefined,
  timeLimitMinutes: normalizeTimeLimitMinutes(pack.tm),
  questionCount: Array.isArray(pack.q) ? pack.q.length : 0,
  questions: Array.isArray(pack.q) ? pack.q.map(expandQuestion) : [],
});

const toTinyQuestion = (q: SharedQuestion): TinyQuestion => {
  const type = TYPE_TO_CODE[q.questionType] || 'm';
  if (type === 'm') {
    const options = (q.options || []).map((option) => option.trim()).filter(Boolean);
    const correctOption = Number.isInteger(q.correctOption) ? q.correctOption as number : -1;
    const answer = q.correctAnswer?.trim();
    return answer && (correctOption < 0 || options[correctOption] !== answer)
      ? [q.questionText, 'm', options, correctOption, answer]
      : [q.questionText, 'm', options, correctOption];
  }
  return [q.questionText, type, q.correctAnswer?.trim() || q.explanation?.trim() || ''];
};

const fromTinyQuestion = (q: TinyQuestion): SharedQuestion => {
  if (q[1] === 'm') {
    const correctOption = Number.isInteger(q[3]) && q[3] >= 0 ? q[3] : undefined;
    return {
      questionText: q[0],
      questionType: 'mcq',
      difficulty: 'medium',
      options: Array.isArray(q[2]) ? q[2] : [],
      correctOption,
      correctAnswer: q[4] || (correctOption !== undefined ? q[2][correctOption] : undefined),
    };
  }
  return {
    questionText: q[0],
    questionType: CODE_TO_TYPE[q[1]] || 'short_answer',
    difficulty: 'medium',
    correctAnswer: q[2] || undefined,
  };
};

const toTiny = (pack: QuickQuizPack): TinyPack => ({
  f: 'q2',
  t: pack.title,
  tm: normalizeTimeLimitMinutes(pack.timeLimitMinutes),
  q: pack.questions.map(toTinyQuestion),
});

const fromTiny = (pack: TinyPack): QuickQuizPack => ({
  format: QUICK_QUIZ_FORMAT,
  version: QUICK_QUIZ_VERSION,
  title: pack.t || 'Shared PharmaTRACK Quiz',
  exportedAt: new Date().toISOString(),
  timeLimitMinutes: normalizeTimeLimitMinutes(pack.tm),
  questionCount: Array.isArray(pack.q) ? pack.q.length : 0,
  questions: Array.isArray(pack.q) ? pack.q.map(fromTinyQuestion) : [],
});

function base64UrlEncode(raw: string): string {
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(encoded: string): string {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function normalizeQuickQuizPack(value: unknown): QuickQuizPack {
  const parsed = value as Partial<QuickQuizPack> | CompactPack | TinyPack | undefined;
  const pack = parsed && 'f' in parsed && parsed.f === 'q2'
    ? fromTiny(parsed as TinyPack)
    : parsed && 'f' in parsed && parsed.f === 'ptqq'
      ? fromCompact(parsed as CompactPack)
      : parsed as QuickQuizPack;
  if (!pack || pack.format !== QUICK_QUIZ_FORMAT || !Array.isArray(pack.questions) || pack.questions.length === 0) {
    throw new Error('This quick quiz link is invalid or empty.');
  }
  const timeLimitMinutes = normalizeTimeLimitMinutes((pack as Partial<QuickQuizPack>).timeLimitMinutes);
  return {
    ...pack,
    ...(timeLimitMinutes ? { timeLimitMinutes } : { timeLimitMinutes: undefined }),
    questionCount: pack.questions.length,
  };
}

export function encodeQuickQuizPack(pack: QuickQuizPack): string {
  // q2 is intentionally tiny: it keeps only what a recipient needs to start the
  // quiz (question, options and answer), drops bulky explanations/tags, and then
  // LZ-compresses the JSON into a URL-safe string for offline fallback links.
  return `z${compressToEncodedURIComponent(JSON.stringify(toTiny(pack))).replace(/\+/g, '~')}`;
}

export function encodeLegacyQuickQuizPack(pack: QuickQuizPack): string {
  return base64UrlEncode(JSON.stringify(toCompact(pack)));
}

export function decodeQuickQuizPack(encoded: string): QuickQuizPack {
  const value = encoded.trim();
  if (!value) throw new Error('This quick quiz link is empty.');
  if (value.startsWith('z')) {
    const json = decompressFromEncodedURIComponent(value.slice(1).replace(/~/g, '+'));
    if (!json) throw new Error('This quick quiz link is invalid or empty.');
    return normalizeQuickQuizPack(JSON.parse(json));
  }
  return normalizeQuickQuizPack(JSON.parse(base64UrlDecode(value)));
}

function apiBase(): string | null {
  const configured = (import.meta.env.VITE_CLOUDFLARE_API_BASE_URL || '').replace(/\/$/, '');
  if (configured) return configured;
  // The desktop app (tauri://localhost) and the Android APK (app asset origin)
  // serve the bundle from a local origin with no API behind it, so a relative
  // URL there asks the bundle for /api/... and short links silently fail.
  // Those runtimes always talk to the public web app instead.
  if (isNativeShellOrigin()) return PUBLIC_APP_URL_FALLBACK.replace(/\/$/, '');
  return import.meta.env.PROD ? '' : null;
}

function isNativeAppUrl(url: URL): boolean {
  return (
    url.protocol === 'tauri:' ||
    url.hostname === 'tauri.localhost' ||
    url.protocol === 'file:' ||
    url.hostname.endsWith('appassets.androidplatform.net')
  );
}

function shareBaseUrl(href: string): URL {
  const current = new URL(href);
  const configured = (import.meta.env.VITE_PUBLIC_APP_URL || '').trim();
  if (configured) return new URL(configured);
  return isNativeAppUrl(current) ? new URL(PUBLIC_APP_URL_FALLBACK) : current;
}

function buildHashUrl(route: string, href: string): string {
  const url = shareBaseUrl(href);
  url.search = '';
  url.hash = route.startsWith('/') ? route : `/${route}`;
  return url.toString();
}

const cleanText = (value: string | undefined): string | undefined => {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  return cleaned || undefined;
};

function toShortCodePack(pack: QuickQuizPack): QuickQuizPack {
  const questions = pack.questions.map((q): SharedQuestion => {
    const type = q.questionType === 'mcq' || q.questionType === 'short_answer' ? q.questionType : 'essay';
    const options = type === 'mcq' ? (q.options || []).map((option) => option.trim()).filter(Boolean) : undefined;
    const correctOption = type === 'mcq' && Number.isInteger(q.correctOption) ? q.correctOption : undefined;
    const optionAnswer = type === 'mcq' && options && correctOption !== undefined ? options[correctOption] : undefined;
    return {
      questionText: cleanText(q.questionText) || q.questionText,
      questionType: type,
      difficulty: q.difficulty,
      options,
      correctOption,
      correctAnswer: cleanText(q.correctAnswer) || optionAnswer || cleanText(q.explanation),
    };
  });
  return {
    format: QUICK_QUIZ_FORMAT,
    version: QUICK_QUIZ_VERSION,
    title: cleanText(pack.title) || 'Shared PharmaTRACK Quiz',
    exportedAt: pack.exportedAt || new Date().toISOString(),
    course: pack.course,
    topic: pack.topic,
    timeLimitMinutes: normalizeTimeLimitMinutes(pack.timeLimitMinutes),
    questionCount: questions.length,
    questions,
  };
}

async function createShortQuickQuizCode(pack: QuickQuizPack): Promise<string | null> {
  const base = apiBase();
  if (base === null || typeof fetch !== 'function') return null;
  try {
    const response = await fetch(`${base}/api/v1/quick-quizzes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack: toShortCodePack(pack) }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { code?: string };
    return payload.code || null;
  } catch {
    return null;
  }
}

export async function fetchQuickQuizPackByCode(code: string): Promise<QuickQuizPack> {
  const base = apiBase();
  if (base === null || typeof fetch !== 'function') {
    throw new Error('Short quick quiz links need the online PharmaTRACK web app.');
  }
  const safeCode = code.trim();
  const response = await fetch(`${base}/api/v1/quick-quizzes/${encodeURIComponent(safeCode)}`);
  if (!response.ok) {
    throw new Error(response.status === 404 ? 'This quick quiz link has expired or was not found.' : 'This quick quiz link could not be loaded.');
  }
  const payload = await response.json() as { pack?: unknown };
  return normalizeQuickQuizPack(payload.pack);
}

export function quickQuizUrl(pack: QuickQuizPack, href: string = window.location.href): string {
  return buildHashUrl(`/quick-quiz?p=${encodeURIComponent(encodeQuickQuizPack(pack))}`, href);
}

export function quickQuizCodeUrl(code: string, href: string = window.location.href): string {
  return buildHashUrl(`/q/${encodeURIComponent(code.trim())}`, href);
}

export async function quickQuizShareUrl(pack: QuickQuizPack, href: string = window.location.href): Promise<ShareUrlResult> {
  const code = await createShortQuickQuizCode(pack);
  if (code) return { url: quickQuizCodeUrl(code, href), mode: 'short-code' };

  const url = quickQuizUrl(pack, href);
  if (url.length <= INLINE_LINK_MAX_LENGTH) return { url, mode: 'inline' };
  throw new Error('Could not create a short quick quiz link. Check your internet connection and try again — this quiz is too large for a safe offline fallback link.');
}

/** Normalises a chosen share duration; anything invalid means "no time limit". */
export function quickQuizShareTiming(minutes: number | undefined): number | undefined {
  return normalizeTimeLimitMinutes(minutes);
}
