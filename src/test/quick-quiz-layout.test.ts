import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const quickQuiz = fs.readFileSync(path.resolve(__dirname, '../pages/QuickQuiz.tsx'), 'utf8');

describe('quick quiz mobile layout', () => {
  it('locks the shared quiz route to the viewport and scrolls only the question body', () => {
    expect(quickQuiz).toContain('flex h-[100dvh] flex-col overflow-hidden bg-slate-100');
    expect(quickQuiz).toContain('ref={questionScrollRef}');
    expect(quickQuiz).toContain('min-h-0 flex-1 overflow-y-auto overscroll-contain');
  });

  it('keeps the compact quiz header and bottom controls outside question scrolling', () => {
    expect(quickQuiz).toContain('<header className="safe-area-x shrink-0');
    expect(quickQuiz).toContain('<footer className="safe-area-x safe-area-bottom shrink-0');
    expect(quickQuiz).toContain('Q{currentIndex + 1}/{packResult.questions.length}');
  });

  it('gives the question jump buttons their own scroll area for long quizzes', () => {
    expect(quickQuiz).toContain('max-h-24 overflow-y-auto overscroll-contain');
    expect(quickQuiz).toContain('aria-label="Jump to question"');
    expect(quickQuiz).toContain('onClick={() => goToQuestion(idx)}');
  });
});
