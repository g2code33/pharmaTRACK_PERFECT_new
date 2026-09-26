/**
 * Material Library page: the fields are visible, favorites toggle, and a long
 * list does not paint every row.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AppState, Slide } from '../types';

const { dispatch, stateRef } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  stateRef: { current: null as AppState | null },
}));

vi.mock('../context/AppContext', () => ({
  useApp: () => ({ state: stateRef.current, dispatch }),
}));

vi.mock('../utils/storage', () => ({
  loadFile: vi.fn(async () => null),
}));

import MaterialLibrary from '../pages/MaterialLibrary';

function slide(partial: Partial<Slide> & Pick<Slide, 'id' | 'title'>): Slide {
  return {
    topicId: 't1',
    slideNumber: 1,
    contentText: '',
    fileType: 'text',
    status: 'not_started',
    createdAt: '2026-01-15T00:00:00.000Z',
    fileSize: 1200,
    materialKind: 'text',
    ocrStatus: 'not_needed',
    ...partial,
  };
}

function stateWith(slides: Slide[]): AppState {
  return {
    isLoggedIn: false,
    student: null,
    courses: [{
      id: 'c1', studentId: 'u1', courseCode: 'PHM214', courseName: 'Pharmacology',
      lecturerName: '', semester: '1st', creditHours: 3, createdAt: '',
    }],
    topics: [{ id: 't1', courseId: 'c1', topicName: 'Beta blockers', orderIndex: 0, createdAt: '' }],
    slides,
    notes: [],
    examQuestions: [],
    learningObjectives: [],
    highlights: [],
    quizHistory: [],
    studyPlans: [],
    examDates: [],
    activities: [],
    chatHistory: [],
    savedInsights: [],
    openAIKey: '',
    timetables: { class: [], quiz: [], exam: [] },
    timetablePdf: null,
  } as unknown as AppState;
}

beforeEach(() => {
  dispatch.mockClear();
  stateRef.current = stateWith([
    slide({
      id: 'deck',
      title: 'Beta blockers',
      materialKind: 'pptx',
      contentText: '--- Slide 1 ---\n',
      pageCount: 40,
      fileSize: 2_400_000,
      ocrStatus: 'not_needed',
      favorite: true,
      tags: ['cardio'],
      lastOpenedAt: '2026-03-02T00:00:00.000Z',
      lastPosition: 23,
    }),
  ]);
});

describe('Material Library page', () => {
  it('shows course, type, size, count, OCR, last opened and last slide', () => {
    render(
      <MemoryRouter>
        <MaterialLibrary />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Material Library' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Beta blockers' })).toBeTruthy();
    expect(screen.getByText(/PHM214 Pharmacology/)).toBeTruthy();
    expect(screen.getAllByText('PowerPoint').length).toBeGreaterThan(0);
    expect(screen.getByText(/2\.3 MB/)).toBeTruthy();
    expect(screen.getByText(/40 slides/)).toBeTruthy();
    expect(screen.getByText(/No OCR needed/)).toBeTruthy();
    expect(screen.getByText(/Last slide 23/)).toBeTruthy();
    expect(screen.getByText('cardio')).toBeTruthy();
  });

  it('toggles a favorite without leaving the page', () => {
    render(
      <MemoryRouter>
        <MaterialLibrary />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove favorite Beta blockers' }));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'UPDATE_SLIDE',
      payload: { id: 'deck', updates: { favorite: false } },
    });
  });

  it('does not paint every row of a long list', () => {
    const many = Array.from({ length: 60 }, (_, i) => slide({
      id: `s${i}`,
      title: `Lecture ${i}`,
      createdAt: `2026-01-${String((i % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    stateRef.current = stateWith(many);
    render(
      <MemoryRouter>
        <MaterialLibrary />
      </MemoryRouter>,
    );
    expect(screen.getByText('60 of 60')).toBeTruthy();
    const cards = screen.getAllByTestId('library-card');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThan(20);
  });
});
