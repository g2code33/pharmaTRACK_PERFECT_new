import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const quiz = fs.readFileSync(path.resolve(__dirname, '../pages/Quiz.tsx'), 'utf8');

describe('standard quiz responsive layout', () => {
  it('renders active quiz questions in compact sets of three', () => {
    expect(quiz).toContain('const QUIZ_SET_SIZE = 3;');
    expect(quiz).toContain('const visibleQuestions = quizQuestions.slice(setStart, setStart + QUIZ_SET_SIZE);');
    expect(quiz).toContain('data-quiz-question-set="three"');
    expect(quiz).toContain('data-quiz-set-navigation');
    expect(quiz.indexOf('data-quiz-question-set="three"')).toBeLessThan(
      quiz.indexOf('data-quiz-set-navigation'),
    );
  });

  it('keeps question jumping fixed on the right for desktop web and desktop apps', () => {
    expect(quiz).toContain('lg:grid-cols-[minmax(0,1fr)_17rem]');
    expect(quiz).toContain('lg:sticky lg:top-4');
    expect(quiz).toContain('aria-label="Jump to question"');
    expect(quiz).toContain('data-quiz-jump-grid="right-fixed"');
  });

  it('lets a reviewed quiz be resat with the same questions', () => {
    expect(quiz).toContain('const resitCurrentQuiz = () =>');
    expect(quiz).toContain('Resit quiz');
    expect(quiz).toContain('setIsReviewMode(true);');
    expect(quiz).toContain('setIsReviewMode(false);');
  });
});
