/**
 * Regression test for "it has been loading for ages" — opening a PDF/PPTX
 * used to leave "Loading Material..." on screen forever whenever the file
 * load finished (successfully or not) without producing a fileUrl, because
 * the loading spinner's own render condition (`isLoadingContent || !fileUrl`)
 * stayed true either way. SlideReader must now show a distinct, actionable
 * error state with a Retry button instead.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../utils/supabase', async () => {
  const actual = await vi.importActual<typeof import('../utils/supabase')>('../utils/supabase');
  return {
    ...actual,
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: null } }),
        getUser: async () => ({ data: { user: null } }),
        signOut: async () => ({ error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: {} }) }) }) }),
    },
  };
});

const loadFileBytesMock = vi.fn();

vi.mock('../utils/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/storage')>();
  return {
    ...actual,
    loadFileBytes: (...args: Parameters<typeof loadFileBytesMock>) => loadFileBytesMock(...args),
    loadSlideText: vi.fn(async () => 'Sample slide text'),
  };
});

vi.mock('../components/PdfViewer', () => ({
  default: () => <div data-testid="mock-pdf-viewer">PDF Viewer Content</div>,
}));

vi.mock('../components/PptxViewer', () => ({
  default: () => <div data-testid="mock-pptx-viewer">PPTX Viewer Content</div>,
}));

vi.mock('../components/AIChatPanel', () => ({
  default: ({ title }: { title: string }) => (
    <div data-testid="mock-ai-chat-panel">
      <span>{title}</span>
    </div>
  ),
}));

import { AppProvider } from '../context/AppContext';
import SlideReader from '../pages/SlideReader';

const initialCourse = {
  id: 'course-1',
  title: 'Pharmacology 101',
  courseCode: 'PHARM101',
  year: 1,
  color: '#2D6A4F',
};

const initialTopic = {
  id: 'topic-1',
  courseId: 'course-1',
  title: 'Adrenergic Agonists',
  lastStudied: new Date().toISOString(),
  confidenceLevel: 3,
};

const initialSlide = {
  id: 'slide-1',
  topicId: 'topic-1',
  fileType: 'pdf' as const,
  title: 'Lecture 1: Sympathetic Nervous System',
  createdAt: new Date().toISOString(),
  pageCount: 10,
};

const renderReader = () =>
  render(
    <MemoryRouter initialEntries={['/read/topic-1']}>
      <AppProvider>
        <Routes>
          <Route path="/read/:topicId" element={<SlideReader />} />
        </Routes>
      </AppProvider>
    </MemoryRouter>,
  );

describe('SlideReader — load failure shows a clear error, never an eternal spinner', () => {
  beforeEach(() => {
    localStorage.clear();
    loadFileBytesMock.mockReset();
    const storedState = {
      courses: [initialCourse],
      topics: [initialTopic],
      slides: [initialSlide],
      highlights: [],
      chatHistory: {},
    };
    localStorage.setItem('pharmatrack_state', JSON.stringify(storedState));
  });

  it('shows a retryable error instead of "Loading Material..." forever when the read times out', async () => {
    loadFileBytesMock.mockRejectedValue(
      new Error("Reading this file's bytes did not finish within 20000ms — the file may be corrupted or this device's storage may be stuck."),
    );

    renderReader();

    await waitFor(() => {
      expect(screen.getByText(/taking far longer than it should to load/i)).toBeInTheDocument();
    });
    // The old bug: this text would stay on screen forever instead.
    expect(screen.queryByText(/loading material/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('shows a clear message instead of hanging when there is genuinely no file stored', async () => {
    loadFileBytesMock.mockResolvedValue(null);

    renderReader();

    await waitFor(() => {
      expect(screen.getByText(/no file is stored for this material/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/loading material/i)).not.toBeInTheDocument();
  });

  it('retrying calls loadFileBytes again', async () => {
    loadFileBytesMock.mockRejectedValue(new Error('This file could not be loaded.'));

    renderReader();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });
    const callsBefore = loadFileBytesMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(loadFileBytesMock.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});
