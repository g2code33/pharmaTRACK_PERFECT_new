import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const quickQuiz = fs.readFileSync(path.resolve(__dirname, '../pages/QuickQuiz.tsx'), 'utf8');
const attempts = fs.readFileSync(path.resolve(__dirname, '../utils/quickQuizAttempts.ts'), 'utf8');

describe('quick quiz responsive layout', () => {
  it('keeps the shared quiz route viewport-bound with a compact header and body scrolling', () => {
    expect(quickQuiz).toContain('flex h-[100dvh] flex-col overflow-hidden bg-slate-100');
    expect(quickQuiz).toContain('ref={questionScrollRef}');
    expect(quickQuiz).toContain('min-h-0 flex-1 overflow-y-auto overscroll-contain');
    expect(quickQuiz).toContain('Q{setStart + 1}-{setEnd}/{packResult.questions.length}');
    expect(quickQuiz).toContain("timerLabel = timerSeconds === null ? 'No time limit'");
  });

  it('shows quiz questions in sets of three and places navigation after the set', () => {
    expect(quickQuiz).toContain('const QUIZ_SET_SIZE = 3;');
    expect(quickQuiz).toContain('data-quick-quiz-question-set="three"');
    expect(quickQuiz).toContain('data-quick-quiz-set-navigation');
    expect(quickQuiz).not.toContain('<footer className="safe-area-x safe-area-bottom shrink-0');
    expect(quickQuiz.indexOf('data-quick-quiz-question-set="three"')).toBeLessThan(
      quickQuiz.indexOf('data-quick-quiz-set-navigation'),
    );
  });

  it('adds an explicit back action to standalone quick quiz screens', () => {
    expect(quickQuiz).toContain('const handleBack = () =>');
    expect(quickQuiz).toContain('onClick={handleBack}');
    // Inside a shared course the same control goes back to the topic list.
    expect(quickQuiz).toContain("aria-label={courseRoute ? 'Back to all topics' : 'Back'}");
  });

  it('keeps previous, finish and next on one row of the same navigation card', () => {
    const navigation = quickQuiz.slice(
      quickQuiz.indexOf('data-quick-quiz-set-navigation'),
      quickQuiz.indexOf('data-quick-quiz-set-navigation') + 1600,
    );
    expect(quickQuiz).toContain('grid grid-cols-[repeat(3,minmax(0,1fr))] items-center gap-2 rounded-2xl');
    expect(navigation).toContain('justify-self-start');
    expect(navigation).toContain('justify-self-center');
    expect(navigation).toContain('justify-self-end');
    expect(navigation.indexOf('justify-self-start')).toBeLessThan(navigation.indexOf('justify-self-center'));
    expect(navigation.indexOf('justify-self-center')).toBeLessThan(navigation.indexOf('justify-self-end'));
  });

  it('only unlocks finish on the last question and reviews answers before submitting', () => {
    expect(quickQuiz).toContain(
      'const isOnLastQuestion = packResult.questions.length > 0 && currentIndex === packResult.questions.length - 1;',
    );
    expect(quickQuiz).toContain('const openSubmitReview = () => {');
    expect(quickQuiz).toContain('if (!isOnLastQuestion) return;');
    expect(quickQuiz).toContain('onClick={openSubmitReview}');
    expect(quickQuiz).toContain('disabled={!isOnLastQuestion}');
    expect(quickQuiz).toContain('Check answered and unanswered questions');
    expect(quickQuiz).toContain('Unanswered — tap to correct');
    expect(quickQuiz).toContain('Corrections');
    expect(quickQuiz).toContain('Submit quiz');
  });

  it('can pause a shared quiz and continue it after leaving the page', () => {
    // The attempt storage is shared with the course page, so it lives in
    // src/utils/quickQuizAttempts.ts and both agree on the keys.
    expect(attempts).toContain("const PAUSE_PREFIX = 'pharmatrack.quickQuiz.pause.v1:';");
    expect(quickQuiz).toContain('const pauseQuickQuiz = () => {');
    expect(quickQuiz).toContain('const continuePausedQuickQuiz = () => {');
    expect(quickQuiz).toContain('onClick={pauseQuickQuiz}');
    expect(quickQuiz).toContain('onClick={continuePausedQuickQuiz}');
    expect(quickQuiz).toContain('savePausedQuickQuiz(payload);');
    expect(quickQuiz).toContain('loadPausedQuickQuiz(packResult.packKey)');
  });

  it('pins the question jump selection to the right on desktop while staying scrollable', () => {
    expect(quickQuiz).toContain('lg:grid-cols-[minmax(0,1fr)_18rem]');
    expect(quickQuiz).toContain('lg:sticky lg:top-3');
    expect(quickQuiz).toContain('aria-label="Jump to question"');
    expect(quickQuiz).toContain('data-quick-quiz-jump-grid="right-fixed"');
    expect(quickQuiz).toContain('onClick={() => goToQuestion(idx)}');
  });
});
