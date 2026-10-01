import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const quickQuiz = fs.readFileSync(path.resolve(__dirname, '../pages/QuickQuiz.tsx'), 'utf8');

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
    expect(quickQuiz).toContain('aria-label="Back"');
  });

  it('pins the question jump selection to the right on desktop while staying scrollable', () => {
    expect(quickQuiz).toContain('lg:grid-cols-[minmax(0,1fr)_18rem]');
    expect(quickQuiz).toContain('lg:sticky lg:top-3');
    expect(quickQuiz).toContain('aria-label="Jump to question"');
    expect(quickQuiz).toContain('data-quick-quiz-jump-grid="right-fixed"');
    expect(quickQuiz).toContain('onClick={() => goToQuestion(idx)}');
  });
});
