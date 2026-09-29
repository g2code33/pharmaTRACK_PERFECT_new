import type { ExamQuestion } from '../types';
import type { SharedQuestion } from './questionShare';

export const QUICK_QUIZ_FORMAT = 'pharmatrack-quick-quiz';
export const QUICK_QUIZ_VERSION = 1;

export interface QuickQuizPack {
  format: typeof QUICK_QUIZ_FORMAT;
  version: number;
  title: string;
  exportedAt: string;
  course?: { code?: string; name?: string };
  topic?: { name?: string };
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
  q: CompactQuestion[];
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

export function buildQuickQuizPack(
  questions: ExamQuestion[],
  meta: { title: string; course?: { code?: string; name?: string }; topic?: { name?: string } },
): QuickQuizPack | null {
  const usable = questions.filter((q) => q.questionText.trim());
  if (!usable.length) return null;
  return {
    format: QUICK_QUIZ_FORMAT,
    version: QUICK_QUIZ_VERSION,
    title: meta.title.trim() || 'Shared PharmaTRACK Quiz',
    exportedAt: new Date().toISOString(),
    course: meta.course,
    topic: meta.topic,
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
  q: pack.questions.map(compactQuestion),
});

const fromCompact = (pack: CompactPack): QuickQuizPack => ({
  format: QUICK_QUIZ_FORMAT,
  version: pack.v || QUICK_QUIZ_VERSION,
  title: pack.t || 'Shared PharmaTRACK Quiz',
  exportedAt: pack.at || new Date().toISOString(),
  course: pack.c ? { code: pack.c.c, name: pack.c.n } : undefined,
  topic: pack.p ? { name: pack.p.n } : undefined,
  questionCount: Array.isArray(pack.q) ? pack.q.length : 0,
  questions: Array.isArray(pack.q) ? pack.q.map(expandQuestion) : [],
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

export function encodeQuickQuizPack(pack: QuickQuizPack): string {
  return base64UrlEncode(JSON.stringify(toCompact(pack)));
}

export function decodeQuickQuizPack(encoded: string): QuickQuizPack {
  const parsed = JSON.parse(base64UrlDecode(encoded));
  const pack = parsed?.f === 'ptqq' ? fromCompact(parsed as CompactPack) : parsed as QuickQuizPack;
  if (!pack || pack.format !== QUICK_QUIZ_FORMAT || !Array.isArray(pack.questions) || pack.questions.length === 0) {
    throw new Error('This quick quiz link is invalid or empty.');
  }
  return { ...pack, questionCount: pack.questions.length };
}

export function quickQuizUrl(pack: QuickQuizPack, href: string = window.location.href): string {
  const url = new URL(href);
  url.hash = `/quick-quiz?pack=${encodeURIComponent(encodeQuickQuizPack(pack))}`;
  return url.toString();
}

export async function shareQuickQuizPack(pack: QuickQuizPack): Promise<'shared' | 'copied'> {
  const url = quickQuizUrl(pack);
  const title = `PharmaTRACK Quick Quiz: ${pack.title}`;
  const text = `Open this PharmaTRACK quick quiz and start immediately (${pack.questionCount} question${pack.questionCount === 1 ? '' : 's'}).`;
  if (navigator.share) {
    await navigator.share({ title, text, url });
    return 'shared';
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return 'copied';
  }
  window.prompt('Copy this quick quiz link:', url);
  return 'copied';
}
