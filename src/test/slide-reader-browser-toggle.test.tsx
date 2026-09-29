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
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: {} }) }) }),
      }),
    },
  };
});

vi.mock('../utils/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/storage')>();
  return {
    ...actual,
    loadFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    loadFileBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
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

describe('SlideReader Browser / AI Panel Toggle Integration', () => {
  beforeEach(() => {
    localStorage.clear();
    const storedState = {
      courses: [initialCourse],
      topics: [initialTopic],
      slides: [initialSlide],
      highlights: [],
      chatHistory: {},
    };
    localStorage.setItem('pharmatrack_state', JSON.stringify(storedState));
  });

  const waitForCollapsedReader = async () => {
    await waitFor(() => {
      expect(screen.getByTitle('Restore side panel')).toBeInTheDocument();
    });
  };

  const openBrowserPanel = async () => {
    await waitForCollapsedReader();
    const browserButton = screen.getByRole('button', { name: /^browser$/i });
    fireEvent.click(browserButton);
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search or enter url/i)).toBeInTheDocument();
    });
    return browserButton;
  };

  it('renders full-width by default and switches between AI and Browser when clicked', async () => {
    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(
      <MemoryRouter initialEntries={['/read/topic-1']}>
        <AppProvider>
          <Routes>
            <Route path="/read/:topicId" element={<SlideReader />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    // The reader starts full-width so opening tabs/files is not squeezed by default.
    await waitForCollapsedReader();
    expect(screen.queryByTestId('mock-ai-chat-panel')).not.toBeInTheDocument();

    const aiButton = screen.getByTitle(/open ai panel/i);
    fireEvent.click(aiButton);
    await waitFor(() => {
      expect(screen.getByTestId('mock-ai-chat-panel')).toBeInTheDocument();
    });

    const browserButton = screen.getByRole('button', { name: /browser/i });
    expect(browserButton).toBeInTheDocument();

    // Click "Browser": should replace AI panel with Browser panel in place!
    fireEvent.click(browserButton);

    // It should NOT call window.open!
    expect(windowOpenSpy).not.toHaveBeenCalled();

    // AI panel should now be gone, and the browser search input should be present
    expect(screen.queryByTestId('mock-ai-chat-panel')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search or enter url/i)).toBeInTheDocument();

    // Clicking "Browser" again brings the AI panel back!
    fireEvent.click(browserButton);

    await waitFor(() => {
      expect(screen.getByTestId('mock-ai-chat-panel')).toBeInTheDocument();
    });
    expect(screen.queryByPlaceholderText(/search or enter url/i)).not.toBeInTheDocument();

    windowOpenSpy.mockRestore();
  });

  it('brings AI panel back when AI button is clicked while Browser panel is open', async () => {
    render(
      <MemoryRouter initialEntries={['/read/topic-1']}>
        <AppProvider>
          <Routes>
            <Route path="/read/:topicId" element={<SlideReader />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    await openBrowserPanel();
    expect(screen.queryByTestId('mock-ai-chat-panel')).not.toBeInTheDocument();

    // Click AI button -> returns to AI panel!
    const aiButton = screen.getByTitle(/open ai panel/i);
    fireEvent.click(aiButton);
    await waitFor(() => {
      expect(screen.getByTestId('mock-ai-chat-panel')).toBeInTheDocument();
    });
    expect(screen.queryByPlaceholderText(/search or enter url/i)).not.toBeInTheDocument();
  });

  it('returns to AI when the X button inside the Browser panel is clicked', async () => {
    render(
      <MemoryRouter initialEntries={['/read/topic-1']}>
        <AppProvider>
          <Routes>
            <Route path="/read/:topicId" element={<SlideReader />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    await openBrowserPanel();

    const returnToAiButton = screen.getByTitle('Close browser and return to AI');
    expect(returnToAiButton).toBeInTheDocument();

    fireEvent.click(returnToAiButton);

    await waitFor(() => {
      expect(screen.getByTestId('mock-ai-chat-panel')).toBeInTheDocument();
    });
  });

  it('renders quick study reference chips and navigates without opening external tabs', async () => {
    const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(
      <MemoryRouter initialEntries={['/read/topic-1']}>
        <AppProvider>
          <Routes>
            <Route path="/read/:topicId" element={<SlideReader />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    await openBrowserPanel();

    const pubMedChip = screen.getByRole('button', { name: /pubmed/i });
    expect(pubMedChip).toBeInTheDocument();

    fireEvent.click(pubMedChip);

    // Still in embedded panel, address bar updated to PubMed
    const input = screen.getByPlaceholderText(/search or enter url/i) as HTMLInputElement;
    expect(input.value).toBe('https://pubmed.ncbi.nlm.nih.gov/');
    expect(windowOpenSpy).not.toHaveBeenCalled();

    windowOpenSpy.mockRestore();
  });

  it('pressing Escape while browser is open restores AI panel', async () => {
    render(
      <MemoryRouter initialEntries={['/read/topic-1']}>
        <AppProvider>
          <Routes>
            <Route path="/read/:topicId" element={<SlideReader />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    await openBrowserPanel();

    expect(screen.queryByTestId('mock-ai-chat-panel')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search or enter url/i)).toBeInTheDocument();

    // Press Escape
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.getByTestId('mock-ai-chat-panel')).toBeInTheDocument();
    });
    expect(screen.queryByPlaceholderText(/search or enter url/i)).not.toBeInTheDocument();
  });

  it('allows creating a new tab and closing tabs inside the browser panel', async () => {
    render(
      <MemoryRouter initialEntries={['/read/topic-1']}>
        <AppProvider>
          <Routes>
            <Route path="/read/:topicId" element={<SlideReader />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    await openBrowserPanel();

    const newTabButton = screen.getByTitle('New tab');
    expect(newTabButton).toBeInTheDocument();

    fireEvent.click(newTabButton);

    // Should have 2 tabs now
    const closeTabButtons = screen.getAllByTitle('Close tab');
    expect(closeTabButtons.length).toBe(2);

    // Close the second tab
    fireEvent.click(closeTabButtons[1]);

    // Should now be back to 1 tab (no close button shown for single remaining tab)
    expect(screen.queryByTitle('Close tab')).not.toBeInTheDocument();
  });

  it('submitting address bar navigates within the panel', async () => {
    render(
      <MemoryRouter initialEntries={['/read/topic-1']}>
        <AppProvider>
          <Routes>
            <Route path="/read/:topicId" element={<SlideReader />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );

    await openBrowserPanel();

    const input = screen.getByPlaceholderText(/search or enter url/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://dailymed.nlm.nih.gov' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(input.value).toBe('https://dailymed.nlm.nih.gov');
    // Still in embedded browser panel
    expect(screen.getByPlaceholderText(/search or enter url/i)).toBeInTheDocument();
  });
});
