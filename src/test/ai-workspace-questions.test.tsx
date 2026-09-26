/**
 * The AI workspace shows the questions it was handed before anything is sent.
 * The ids arrive in the URL from the question bank; the text is read back from
 * the bank, so the context the student sees is the context that will be sent.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AppState, ExamQuestion } from '../types';

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => { idbStore.set(k, v); },
  del: async (k: string) => { idbStore.delete(k); },
  delMany: async (keys: string[]) => { keys.forEach((k) => idbStore.delete(k)); },
  keys: async () => [...idbStore.keys()],
  clear: async () => { idbStore.clear(); },
}));

const { stateRef } = vi.hoisted(() => ({ stateRef: { current: null as AppState | null } }));

vi.mock('../context/AppContext', () => ({
  useApp: () => ({ state: stateRef.current, dispatch: vi.fn(), getSlidesForTopic: () => [] }),
}));

vi.mock('../utils/storage', () => ({
  loadSlideText: vi.fn(async () => null),
  loadState: vi.fn(async () => null),
  saveState: vi.fn(),
  loadFile: vi.fn(async () => null),
}));

import { AIProvider } from '../ai/state';
import AiAssistant from '../pages/AiAssistant';

function question(id: string, text: string): ExamQuestion {
  return {
    id,
    courseId: 'c1',
    topicId: 'auto',
    questionType: 'mcq',
    marksAllocation: 1,
    difficulty: 'medium',
    probability: 'medium',
    modelAnswer: 'Model answer',
    questionText: text,
    tags: [],
    isPracticed: false,
    needsReview: false,
    isSaved: false,
    createdAt: '2026-04-01T09:00:00.000Z',
    options: ['A', 'B', 'C', 'D'],
    correctOption: 0,
  } as ExamQuestion;
}

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
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
      question('q1', 'Which receptor does propranolol block?'),
      question('q2', 'Name a muscarinic antagonist.'),
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

describe('AI workspace — attached questions', () => {
  it('lists the questions handed over from the bank and only those', async () => {
    render(
      <MemoryRouter initialEntries={['/ai?course=c1&topic=auto&questions=q1']}>
        <AIProvider>
          <AiAssistant />
        </AIProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Questions in scope')).toBeTruthy());
    expect(screen.getByText('Which receptor does propranolol block?')).toBeTruthy();
    expect(screen.queryByText('Name a muscarinic antagonist.')).toBeNull();
  });

  it('shows no question block when nothing was selected', async () => {
    render(
      <MemoryRouter initialEntries={['/ai?course=c1&topic=auto']}>
        <AIProvider>
          <AiAssistant />
        </AIProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('PharmaTRACK AI')).toBeTruthy());
    expect(screen.queryByText('Questions in scope')).toBeNull();
  });
});
