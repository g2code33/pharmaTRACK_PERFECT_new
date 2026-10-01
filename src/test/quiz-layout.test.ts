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

  it('keeps previous, finish and next on one row of the same navigation card', () => {
    const navigation = quiz.slice(
      quiz.indexOf('data-quiz-set-navigation'),
      quiz.indexOf('data-quiz-set-navigation') + 1600,
    );
    expect(quiz).toContain('grid grid-cols-[repeat(3,minmax(0,1fr))] items-center gap-2 rounded-2xl');
    expect(navigation).toContain('justify-self-start');
    expect(navigation).toContain('justify-self-center');
    expect(navigation).toContain('justify-self-end');
    expect(navigation.indexOf('justify-self-start')).toBeLessThan(navigation.indexOf('justify-self-center'));
    expect(navigation.indexOf('justify-self-center')).toBeLessThan(navigation.indexOf('justify-self-end'));
  });

  it('only unlocks finish on the last question and reviews answers before submitting', () => {
    expect(quiz).toContain('const isOnLastQuestion = quizQuestions.length > 0 && currentIndex === quizQuestions.length - 1;');
    expect(quiz).toContain('const openSubmitReview = () => {');
    expect(quiz).toContain('if (!isOnLastQuestion) return;');
    expect(quiz).toContain('onClick={openSubmitReview}');
    expect(quiz).toContain('disabled={!isOnLastQuestion}');
    expect(quiz).toContain('Check answered and unanswered questions');
    expect(quiz).toContain('Unanswered — tap to correct');
    expect(quiz).toContain('Corrections');
    expect(quiz).toContain('Submit quiz');
  });

  it('can pause an active quiz and continue it later', () => {
    expect(quiz).toContain("const QUIZ_PAUSE_KEY = 'pharmatrack.quiz.pause.v1';");
    expect(quiz).toContain('const pauseQuiz = () => {');
    expect(quiz).toContain('const continuePausedQuiz = () => {');
    expect(quiz).toContain('onClick={pauseQuiz}');
    expect(quiz).toContain('onClick={continuePausedQuiz}');
    expect(quiz).toContain('savePausedQuiz(payload);');
    expect(quiz).toContain('removePausedQuiz();');
  });
});
