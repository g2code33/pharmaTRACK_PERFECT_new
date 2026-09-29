import { describe, expect, it, vi } from 'vitest';
import {
  buildQuickQuizPack,
  decodeQuickQuizPack,
  encodeLegacyQuickQuizPack,
  encodeQuickQuizPack,
  quickQuizCodeUrl,
  quickQuizShareUrl,
  quickQuizUrl,
  shareQuickQuizPack,
} from '../utils/quickQuizShare';
import type { ExamQuestion } from '../types';

const question = (id: string): ExamQuestion => ({
  id,
  courseId: 'course-1',
  topicId: 'topic-1',
  semester: '1',
  questionText: `Question ${id}?`,
  questionType: 'mcq',
  marksAllocation: 1,
  difficulty: 'medium',
  probability: 'medium',
  modelAnswer: 'Because it is correct.'.repeat(20),
  explanation: 'Because it is correct.'.repeat(20),
  correctAnswer: 'Answer B',
  tags: ['manual'],
  isPracticed: false,
  needsReview: false,
  isSaved: true,
  createdAt: '2026-09-29T00:00:00.000Z',
  options: ['Answer A', 'Answer B', 'Answer C'],
  correctOption: 1,
});

describe('quick quiz sharing', () => {
  it('encodes a small question set into a compressed URL-safe payload and decodes it back', () => {
    const pack = buildQuickQuizPack([question('1'), question('2')], {
      title: 'Test quick quiz',
      course: { code: 'PHAR 101', name: 'Pharmacology' },
      topic: { name: 'Glycosides' },
      timeLimitMinutes: 25,
    });

    expect(pack).not.toBeNull();
    const encoded = encodeQuickQuizPack(pack!);
    expect(encoded).toMatch(/^z/);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encoded.length).toBeLessThan(encodeLegacyQuickQuizPack(pack!).length / 2);

    const decoded = decodeQuickQuizPack(encoded);
    expect(decoded.title).toBe('Test quick quiz');
    expect(decoded.timeLimitMinutes).toBe(25);
    expect(decodeQuickQuizPack(encodeLegacyQuickQuizPack(pack!)).timeLimitMinutes).toBe(25);
    expect(decoded.questionCount).toBe(2);
    expect(decoded.questions[0].questionText).toBe('Question 1?');
    expect(decoded.questions[0].options).toEqual(['Answer A', 'Answer B', 'Answer C']);
    expect(decoded.questions[0].correctOption).toBe(1);
  });

  it('builds a short hash-router fallback link that opens the standalone quick quiz route', () => {
    const pack = buildQuickQuizPack([question('1')], { title: 'One question' })!;
    const url = quickQuizUrl(pack, 'https://example.com/app/index.html#/questions');

    expect(url).toContain('https://example.com/app/index.html#/quick-quiz?p=');
    const encoded = new URL(url).hash.split('p=')[1];
    expect(decodeQuickQuizPack(decodeURIComponent(encoded)).questions).toHaveLength(1);
  });

  it('builds the very short code URL used when the web share API is available', () => {
    const url = quickQuizCodeUrl('AbC234xyz9', 'https://example.com/app/index.html#/questions');
    expect(url).toBe('https://example.com/app/index.html#/q/AbC234xyz9');
  });

  it('requires the sharer to choose timing before a link is copied', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('15');
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText }, share: undefined });

    try {
      const pack = buildQuickQuizPack([question('1')], { title: 'Timed copy' })!;
      const result = await shareQuickQuizPack(pack);
      const copiedUrl = writeText.mock.calls[0]?.[0] as string;
      const encoded = new URL(copiedUrl).hash.split('p=')[1];

      expect(result).toBe('copied');
      expect(prompt).toHaveBeenCalledWith(expect.stringContaining('Set the time before sharing'), 'never');
      expect(prompt.mock.invocationCallOrder[0]).toBeLessThan(writeText.mock.invocationCallOrder[0]);
      expect(decodeQuickQuizPack(decodeURIComponent(encoded)).timeLimitMinutes).toBe(15);
    } finally {
      prompt.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('never shares native tauri://localhost links outside the desktop app', async () => {
    vi.stubEnv('VITE_CLOUDFLARE_API_BASE_URL', 'https://api.example.test');
    const originalFetch = globalThis.fetch;
    let postedBody: any;
    globalThis.fetch = (async (_input, init) => {
      postedBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ code: 'WinShort42' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const pack = buildQuickQuizPack([question('1')], { title: 'Native share', timeLimitMinutes: 12 })!;
      const result = await quickQuizShareUrl(pack, 'tauri://localhost#/questions');
      expect(result).toEqual({
        mode: 'short-code',
        url: 'https://pharmatrack-web.pages.dev/#/q/WinShort42',
      });
      expect(postedBody.pack.timeLimitMinutes).toBe(12);
    } finally {
      globalThis.fetch = originalFetch;
      vi.unstubAllEnvs();
    }
  });
});
