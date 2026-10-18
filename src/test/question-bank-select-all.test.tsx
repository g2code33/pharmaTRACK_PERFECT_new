/**
 * Question Bank — filter + Select all.
 *
 * Ticking "Ask AI" checkboxes one by one through a 300-question bank is not a
 * workflow. These tests pin the contract the page now promises:
 *
 *   - a free-text filter narrows the bank and opens the matches by itself;
 *   - Select all operates on EXACTLY the questions the filter left visible
 *     (global, per-course and per-topic), never on hidden or filtered-out
 *     questions;
 *   - Deselect all and Clear undo a selection without losing unrelated picks;
 *   - the AI button stays honest about its 8-question context cap.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AppState, ExamQuestion } from '../types';

const { dispatch, stateRef } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  stateRef: { current: null as AppState | null },
}));

vi.mock('../context/AppContext', () => ({
  useApp: () => ({ state: stateRef.current, dispatch }),
}));

import QuestionBank from '../pages/QuestionBank';

function question(
  partial: Partial<ExamQuestion> & Pick<ExamQuestion, 'id' | 'topicId' | 'questionText'>,
): ExamQuestion {
  return {
    courseId: 'c1',
    questionType: 'mcq',
    marksAllocation: 1,
    difficulty: 'medium',
    probability: 'medium',
    modelAnswer: 'Model answer',
    tags: [],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: '2026-04-01T09:00:00.000Z',
    options: ['A', 'B', 'C', 'D'],
    correctOption: 0,
    ...partial,
  };
}

function bankState(questions: ExamQuestion[]): AppState {
  return {
    isLoggedIn: true,
    student: null,
    courses: [
      {
        id: 'c1', studentId: 'u1', courseCode: 'PHA201', courseName: 'Pharmacology',
        lecturerName: '', semester: 'Year 2', creditHours: 3, createdAt: '',
      },
    ],
    topics: [
      { id: 'auto', courseId: 'c1', topicName: 'Autonomic drugs', orderIndex: 0, createdAt: '' },
      { id: 'cardio', courseId: 'c1', topicName: 'Cardiovascular drugs', orderIndex: 1, createdAt: '' },
    ],
    slides: [],
    notes: [],
    examQuestions: questions,
    learningObjectives: [],
    highlights: [],
    quizHistory: [],
    studyPlans: [],
    examDates: [],
    activities: [],
    chatHistory: [],
    savedInsights: [],
    openAIKey: '',
  } as unknown as AppState;
}

function open() {
  render(
    <MemoryRouter initialEntries={['/questions']}>
      <Routes>
        <Route path="/questions" element={<QuestionBank />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** No filter means the accordion starts closed; open it like a user would. */
function expandCourseAndTopic() {
  fireEvent.click(screen.getByText('PHA201: Pharmacology'));
  fireEvent.click(screen.getByText('Autonomic drugs'));
  fireEvent.click(screen.getByText('Cardiovascular drugs'));
}

const AUTONOMIC = [
  question({ id: 'q1', topicId: 'auto', questionText: 'Which receptor does propranolol block?' }),
  question({ id: 'q2', topicId: 'auto', questionText: 'Name a muscarinic antagonist.' }),
];
const CARDIO = [
  question({ id: 'q3', topicId: 'cardio', questionText: 'Which drug class does propranolol belong to for hypertension?' }),
  question({ id: 'q4', topicId: 'cardio', questionText: 'Name one diuretic.' }),
];

beforeEach(() => {
  dispatch.mockClear();
  stateRef.current = bankState([...AUTONOMIC, ...CARDIO]);
});

describe('filtering the bank', () => {
  it('narrows the bank by free text and opens the matches by itself', async () => {
    open();
    fireEvent.change(screen.getByTestId('question-filter-input'), { target: { value: 'propranolol' } });

    // Both matching topics open without the user expanding anything…
    await waitFor(() => {
      expect(screen.getByText('Which receptor does propranolol block?')).toBeTruthy();
    });
    expect(screen.getByText('Which drug class does propranolol belong to for hypertension?')).toBeTruthy();
    // …and the non-matches are gone.
    expect(screen.queryByText('Name a muscarinic antagonist.')).toBeNull();
    expect(screen.queryByText('Name one diuretic.')).toBeNull();

    // Counts follow the filter: 2 matches, not 4 total.
    expect(screen.getByTestId('select-all-questions').textContent).toContain('2');
  });

  it('matches options and answers, not just question text', async () => {
    stateRef.current = bankState([
      question({ id: 'q1', topicId: 'auto', questionText: 'First line therapy?', options: ['Furosemide', 'Placebo', 'Nothing', 'Else'], correctAnswer: 'Furosemide' }),
    ]);
    open();
    fireEvent.change(screen.getByTestId('question-filter-input'), { target: { value: 'furosemide' } });
    await waitFor(() => {
      expect(screen.getByText('First line therapy?')).toBeTruthy();
    });
  });

  it('shows an explicit no-matches state instead of a silent blank', async () => {
    open();
    fireEvent.change(screen.getByTestId('question-filter-input'), { target: { value: 'zzz-no-such-drug' } });
    await waitFor(() => {
      expect(screen.getByTestId('question-filter-no-matches')).toBeTruthy();
    });
    expect(screen.getByTestId('select-all-questions').textContent).toContain('0');
  });
});

describe('Select all follows the filter', () => {
  it('selects exactly the visible questions at bank level', async () => {
    open();
    expandCourseAndTopic();
    fireEvent.click(screen.getByTestId('select-all-questions'));
    // All four, and the AI button reflects the count.
    expect(screen.getByText('Ask AI about 4 selected')).toBeTruthy();
    ['q1', 'q2', 'q3', 'q4'].forEach((id) => {
      expect((screen.getByTestId(`ai-select-${id}`) as HTMLInputElement).checked).toBe(true);
    });

    // Deselect all reverses it without leaving strays.
    fireEvent.click(screen.getByTestId('select-all-questions'));
    expect(screen.getByText('Ask AI about questions')).toBeTruthy();
  });

  it('selects only the filtered questions, never the hidden ones', async () => {
    open();
    fireEvent.change(screen.getByTestId('question-filter-input'), { target: { value: 'propranolol' } });
    await waitFor(() => {
      expect(screen.getByTestId('select-all-questions').textContent).toContain('Select all (2)');
    });
    fireEvent.click(screen.getByTestId('select-all-questions'));

    expect((screen.getByTestId('ai-select-q1') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('ai-select-q3') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Ask AI about 2 selected')).toBeTruthy();

    // Clearing the filter does not silently widen the selection.
    fireEvent.change(screen.getByTestId('question-filter-input'), { target: { value: '' } });
    expect(screen.getByText('Ask AI about 2 selected')).toBeTruthy();
  });

  it('toggles one topic at a time without touching its siblings', async () => {
    open();
    expandCourseAndTopic();
    fireEvent.click(screen.getByTestId('select-all-topic-auto'));
    expect((screen.getByTestId('ai-select-q1') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('ai-select-q2') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('ai-select-q3') as HTMLInputElement).checked).toBe(false);

    // Toggling the same topic again deselects only that topic.
    fireEvent.click(screen.getByTestId('select-all-topic-auto'));
    expect((screen.getByTestId('ai-select-q1') as HTMLInputElement).checked).toBe(false);
  });

  it('selects a whole course in one click', async () => {
    open();
    fireEvent.click(screen.getByTestId('select-all-course-c1'));
    expect(screen.getByText('Ask AI about 4 selected')).toBeTruthy();
  });

  it('Clear removes the whole selection in one click', async () => {
    open();
    fireEvent.click(screen.getByTestId('select-all-course-c1'));
    fireEvent.click(screen.getByTestId('clear-question-selection'));
    expect(screen.queryByTestId('clear-question-selection')).toBeNull();
    expect(screen.getByText('Ask AI about questions')).toBeTruthy();
  });

  it('keeps the AI button honest about the 8-question context cap', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      question({ id: `m${i}`, topicId: 'auto', questionText: `Bulk question ${i}` }),
    );
    stateRef.current = bankState(many);
    open();
    fireEvent.click(screen.getByTestId('select-all-questions'));
    expect(screen.getByText('Ask AI about 10 selected (first 8)')).toBeTruthy();
  });
});
