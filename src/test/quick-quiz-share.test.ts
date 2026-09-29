import { describe, expect, it } from 'vitest';
import {
  buildQuickQuizPack,
  decodeQuickQuizPack,
  encodeLegacyQuickQuizPack,
  encodeQuickQuizPack,
  quickQuizCodeUrl,
  quickQuizUrl,
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
    });

    expect(pack).not.toBeNull();
    const encoded = encodeQuickQuizPack(pack!);
    expect(encoded).toMatch(/^z/);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encoded.length).toBeLessThan(encodeLegacyQuickQuizPack(pack!).length / 2);

    const decoded = decodeQuickQuizPack(encoded);
    expect(decoded.title).toBe('Test quick quiz');
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
    expect(url).toBe('https://example.com/app/index.html#/quick-quiz?c=AbC234xyz9');
  });
});
