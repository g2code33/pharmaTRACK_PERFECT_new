import { describe, expect, it } from 'vitest';
import { parseExamQuestionJson, reorderQuestionIds } from '../examination/builder';

describe('formal examination builder helpers', () => {
  it('imports valid Question Bank JSON while rejecting malformed rows without partial validity loss', () => {
    const result = parseExamQuestionJson(
      JSON.stringify([
        {
          question_text: 'What is Rx?',
          choices: ['A', 'B'],
          correct_answer: 0,
          difficulty: 'easy',
        },
        { question_text: 'Missing choices', choices: ['A'], correct_answer: 4 },
        { question_text: 'Short answer', question_type: 'short_answer', correct_answer: 'A' },
      ]),
      'course-1',
      'topic-1',
      'Semester 1',
    );
    expect(result.valid).toHaveLength(2);
    expect(result.valid[0].questionText).toBe('What is Rx?');
    expect(result.valid[0].options).toEqual(['A', 'B']);
    expect(result.valid[1].questionType).toBe('short_answer');
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((error) => error.includes('Question 2'))).toBe(true);
  });

  it('rejects non-array and malformed JSON', () => {
    expect(parseExamQuestionJson('{"question_text":"no"}', 'c', 't').errors).toEqual([
      'The import must be a JSON array.',
    ]);
    expect(parseExamQuestionJson('[', 'c', 't').errors).toEqual(['JSON is malformed.']);
  });

  it('keeps exact selected question order when the builder reorders', () => {
    expect(reorderQuestionIds(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(reorderQuestionIds(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(reorderQuestionIds(['a', 'b'], 4, 0)).toEqual(['a', 'b']);
  });
});
