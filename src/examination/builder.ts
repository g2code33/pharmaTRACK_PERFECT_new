import { v4 as uuidv4 } from 'uuid';
import { createQuestion } from '../utils/questionBank';
import type { ExamQuestion } from '../types';

export interface QuestionImportResult {
  valid: ExamQuestion[];
  errors: string[];
}

/**
 * Formal-exam imports use the same question fields as the existing Question
 * Bank. Invalid rows are reported individually and never partially inserted.
 */
export function parseExamQuestionJson(
  raw: string,
  courseId: string,
  topicId: string,
  semester?: string,
): QuestionImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: [], errors: ['JSON is malformed.'] };
  }
  if (!Array.isArray(parsed)) return { valid: [], errors: ['The import must be a JSON array.'] };
  const valid: ExamQuestion[] = [];
  const errors: string[] = [];
  const allowed = new Set<ExamQuestion['questionType']>([
    'mcq',
    'short_answer',
    'structured',
    'essay',
    'case_study',
  ]);
  parsed.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      errors.push(`Question ${index + 1}: must be an object.`);
      return;
    }
    const row = item as Record<string, unknown>;
    const text = String(row.question_text ?? row.questionText ?? '').trim();
    const options = Array.isArray(row.choices)
      ? row.choices.map(String)
      : Array.isArray(row.options)
        ? row.options.map(String)
        : undefined;
    const rawType = String(
      row.question_type ?? row.questionType ?? (options ? 'mcq' : 'short_answer'),
    ) as ExamQuestion['questionType'];
    const type = allowed.has(rawType) ? rawType : undefined;
    if (!text) errors.push(`Question ${index + 1}: question text is required.`);
    if (!type) errors.push(`Question ${index + 1}: unsupported question type.`);
    if (type === 'mcq' && (!options || options.length < 2))
      errors.push(`Question ${index + 1}: MCQ needs at least two options.`);
    const correctRaw = row.correct_answer ?? row.correctAnswer ?? row.correctOption;
    const correctOption = correctRaw == null ? undefined : Number(correctRaw);
    if (
      type === 'mcq' &&
      (correctOption == null ||
        !Number.isInteger(correctOption) ||
        correctOption < 0 ||
        correctOption >= (options?.length || 0))
    ) {
      errors.push(`Question ${index + 1}: correct option is invalid.`);
    }
    if (
      !text ||
      !type ||
      (type === 'mcq' &&
        (correctOption == null ||
          !Number.isInteger(correctOption) ||
          correctOption < 0 ||
          correctOption >= (options?.length || 0)))
    )
      return;
    valid.push(
      createQuestion({
        id: uuidv4(),
        courseId,
        topicId,
        semester,
        questionText: text,
        questionType: type,
        difficulty:
          row.difficulty === 'easy' || row.difficulty === 'hard' ? row.difficulty : 'medium',
        options,
        correctOption,
        correctAnswer: typeof correctRaw === 'string' ? correctRaw : undefined,
        explanation: String(row.explanation ?? row.modelAnswer ?? ''),
        source: { origin: 'imported', label: 'Formal examination JSON import' },
        tags: ['imported', 'examination'],
        isImported: true,
      }),
    );
  });
  return { valid, errors };
}

export function reorderQuestionIds(ids: string[], from: number, to: number): string[] {
  if (from < 0 || to < 0 || from >= ids.length || to >= ids.length || from === to) return [...ids];
  const next = [...ids];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
