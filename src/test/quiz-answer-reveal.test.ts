import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const readSource = (path: string) => readFileSync(join(root, path), 'utf8');

describe('quiz answer reveal controls', () => {
  it('does not expose pre-submission show-answer controls in normal quizzes', () => {
    const source = readSource('src/pages/Quiz.tsx');
    expect(source).not.toContain('showAnswer');
    expect(source).not.toContain('Show Model Answer');
    expect(source).not.toContain('Hide Answer');
  });

  it('does not expose pre-submission show-answer controls in shared quick quizzes', () => {
    const source = readSource('src/pages/QuickQuiz.tsx');
    expect(source).not.toContain('showAnswer');
    expect(source).not.toContain('Show answer');
    expect(source).not.toContain('Hide answer');
  });

  it('keeps answer explanations on the post-submission shared quick quiz result screen', () => {
    const source = readSource('src/pages/QuickQuiz.tsx');
    expect(source).toContain('finished');
    expect(source).toContain('Correct:');
    expect(source).toContain('Your answer:');
  });
});
