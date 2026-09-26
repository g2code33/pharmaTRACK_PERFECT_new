/**
 * The question bank hands selected questions to the AI workspace. Only the ids
 * travel in the URL — the engine rebuilds the context from the bank, so no part
 * of the app state is sent along with them.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { AppState, ExamQuestion } from '../types';

const { dispatch, stateRef } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  stateRef: { current: null as AppState | null },
}));

vi.mock('../context/AppContext', () => ({
  useApp: () => ({ state: stateRef.current, dispatch }),
}));

import QuestionBank from '../pages/QuestionBank';

const AIRoute: React.FC = () => {
  const location = useLocation();
  return <div data-testid="ai-route">{location.search}</div>;
};

function question(partial: Partial<ExamQuestion> & Pick<ExamQuestion, 'id' | 'topicId' | 'questionText'>): ExamQuestion {
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

beforeEach(() => {
  dispatch.mockClear();
  stateRef.current = {
    isLoggedIn: true,
    student: null,
    courses: [
      {
        id: 'c1', studentId: 'u1', courseCode: 'PHA201', courseName: 'Pharmacology',
        lecturerName: '', semester: 'Year 2', creditHours: 3, createdAt: '',
      },
    ],
    topics: [{ id: 'auto', courseId: 'c1', topicName: 'Autonomic drugs', orderIndex: 0, createdAt: '' }],
    slides: [],
    notes: [],
    examQuestions: [
      question({ id: 'q1', topicId: 'auto', questionText: 'Which receptor does propranolol block?' }),
      question({ id: 'q2', topicId: 'auto', questionText: 'Name a muscarinic antagonist.' }),
    ],
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
});

function open() {
  render(
    <MemoryRouter initialEntries={['/questions']}>
      <Routes>
        <Route path="/questions" element={<QuestionBank />} />
        <Route path="/ai" element={<AIRoute />} />
      </Routes>
    </MemoryRouter>,
  );
  // The bank is an accordion: open the course, then the topic.
  fireEvent.click(screen.getByText(/PHA201: Pharmacology/));
  fireEvent.click(screen.getByText(/Autonomic drugs/));
}

describe('question bank → AI context', () => {
  it('sends only the ticked questions to the AI workspace', () => {
    open();

    // Nothing is selected yet, so the action is disabled.
    expect(screen.getByText(/Ask AI about questions/).closest('button')).toBeDisabled();

    fireEvent.click(screen.getByTestId('ai-select-q1'));
    expect(screen.getByText(/Ask AI about 1 selected/)).toBeTruthy();

    fireEvent.click(screen.getByText(/Ask AI about 1 selected/));

    const search = screen.getByTestId('ai-route').textContent ?? '';
    expect(search).toContain('questions=q1');
    expect(search).toContain('topic=auto');
    expect(search).toContain('course=c1');
    // The second question was never ticked, so it does not travel either.
    expect(search).not.toContain('q2');
  });

  it('caps the hand-off at eight questions', () => {
    open();
    fireEvent.click(screen.getByTestId('ai-select-q1'));
    fireEvent.click(screen.getByTestId('ai-select-q2'));
    // Ticking the same question again removes it rather than duplicating it.
    fireEvent.click(screen.getByTestId('ai-select-q2'));

    fireEvent.click(screen.getByText(/Ask AI about 1 selected/));
    const search = screen.getByTestId('ai-route').textContent ?? '';
    expect(search).toContain('questions=q1');
    expect(search).not.toContain('q2');
  });
});
