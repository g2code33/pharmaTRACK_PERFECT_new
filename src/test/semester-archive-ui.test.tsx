/**
 * UI tests for the Complete Semester dialog.
 *
 * Runs the REAL archive engine (against a mocked IndexedDB) so the test
 * proves the whole user-facing flow: confirmation stats → backup → verified →
 * fresh workspace visible in the live app state.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setOnline } from './setup';

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => { idbStore.set(k, v); },
  del: async (k: string) => { idbStore.delete(k); },
  delMany: async (keys: string[]) => { keys.forEach((k) => idbStore.delete(k)); },
  keys: async () => [...idbStore.keys()],
  clear: async () => { idbStore.clear(); },
}));

const authState = { callbacks: [] as Array<(e: string, s: unknown) => void> };

vi.mock('../utils/supabase', async () => {
  const actual = await vi.importActual<typeof import('../utils/supabase')>('../utils/supabase');
  return {
    ...actual,
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: null } }),
        getUser: async () => ({ data: { user: null } }),
        signOut: async () => ({ error: null }),
        onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
          authState.callbacks.push(cb);
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
      },
      from: () => ({
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: { message: 'x' } }) }) }),
      }),
    },
  };
});

import { AppProvider, useApp } from '../context/AppContext';
import CompleteSemesterModal from '../components/CompleteSemesterModal';

const seedWorkspace = () => {
  const state = {
    isLoggedIn: false,
    student: { id: 'u1', name: 'Ama', university: 'UCC', level: 'Level 300', program: 'Pharm.D', semester: '1st Semester', createdAt: '2024-01-01' },
    courses: [
      { id: 'c1', studentId: 'u1', courseCode: 'PHA301', courseName: 'Pharmacology', lecturerName: 'Dr. B', semester: '1st Semester', creditHours: 4, createdAt: '2024-01-01' },
    ],
    topics: [{ id: 't1', courseId: 'c1', topicName: 'Cardiac Glycosides', orderIndex: 0, createdAt: '2024-01-01' }],
    slides: [
      { id: 's1', topicId: 't1', slideNumber: 1, title: 'Digoxin', contentText: 'x'.repeat(2500), fileUrl: 'local:file1', fileType: 'pdf', status: 'not_started', createdAt: '2024-01-02' },
      { id: 's2', topicId: 't1', slideNumber: 2, title: 'Toxicity', contentText: 'short', status: 'not_started', createdAt: '2024-01-03' },
    ],
    notes: [{ id: 'n1', topicId: 't1', noteText: 'note', isAiGenerated: false, createdAt: '2024-01-04' }],
    examQuestions: [{ id: 'q1', courseId: 'c1', topicId: 't1', questionText: 'Q?', questionType: 'mcq', marksAllocation: 2, difficulty: 'easy', probability: 'high', modelAnswer: 'A', tags: [], isPracticed: false, needsReview: false, isSaved: false, createdAt: '2024-01-01' }],
    quizHistory: [
      { id: 'zh1', studentId: 'u1', courseId: 'c1', questionsUsed: ['q1'], answersGiven: [], scorePercentage: 80, weakTopics: [], timeTaken: 60, completedAt: '2024-02-01' },
    ],
    learningObjectives: [], studyPlans: [], examDates: [], activities: [], chatHistory: [], highlights: [], savedInsights: [],
    openAIKey: '',
    timetables: { class: [], quiz: [], exam: [] },
    timetablePdf: null,
  };
  localStorage.setItem('pharmatrack_state', JSON.stringify(state));
  idbStore.set('file_file1', new Blob(['%PDF fake'], { type: 'application/pdf' }));
  idbStore.set('slidetext_s1', 'x'.repeat(2500));
};

const Probe: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { state } = useApp();
  return (
    <div>
      <span data-testid="courses">{state.courses.length}</span>
      <span data-testid="semester">{state.student?.semester}</span>
      {children}
    </div>
  );
};

const renderModal = () => {
  const Harness: React.FC = () => {
    const [open, setOpen] = React.useState(true);
    return (
      <MemoryRouter>
        <AppProvider>
          <Probe>
            <CompleteSemesterModal open={open} onClose={() => setOpen(false)} />
          </Probe>
        </AppProvider>
      </MemoryRouter>
    );
  };
  return render(<Harness />);
};

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
  authState.callbacks = [];
  setOnline(true);
});

describe('Complete Semester dialog', () => {
  it('shows the current-semester stats and suggests the next position', async () => {
    seedWorkspace();
    renderModal();

    expect(await screen.findByText('Complete Semester?')).toBeTruthy();
    // Wait for the provider to load the seeded state (async load).
    await waitFor(() => expect(screen.getByTestId('courses').textContent).toBe('1'));

    // Suggested progression: Level 300, 1st → Level 300, 2nd Semester.
    const levelSelect = screen.getByDisplayValue('Level 300') as HTMLSelectElement;
    const semesterSelect = screen.getByDisplayValue('2nd Semester') as HTMLSelectElement;
    expect(levelSelect.tagName).toBe('SELECT');
    expect(semesterSelect.tagName).toBe('SELECT');
  });

  it('completes the semester end-to-end: verified archive + fresh workspace', async () => {
    seedWorkspace();
    renderModal();

    // Wait for the provider to load the seeded state.
    await waitFor(() => expect(screen.getByTestId('courses').textContent).toBe('1'));

    fireEvent.change(screen.getByLabelText('Academic year of this semester'), { target: { value: '2025/2026' } });
    await fireEvent.click(screen.getByText('Back Up & Complete Semester'));

    // Success screen with the verified-backup promise.
    expect(await screen.findByText('Semester completed successfully 🎓', {}, { timeout: 10_000 })).toBeTruthy();
    expect(screen.getByText('Backup verified ✓')).toBeTruthy();

    // The live app state is now the fresh workspace.
    await waitFor(() => expect(screen.getByTestId('courses').textContent).toBe('0'));
    expect(screen.getByTestId('semester').textContent).toBe('2nd Semester');

    // The archive exists on "disk" (mocked IndexedDB) and is verified.
    const archiveKeys = [...idbStore.keys()].filter((k) => k.startsWith('semester_archive_') && !k.startsWith('semester_archive_file_') && !k.startsWith('semester_archive_text_'));
    expect(archiveKeys).toHaveLength(1);
    const record = idbStore.get(archiveKeys[0]) as any;
    expect(record.meta.status).toBe('verified');
    // Archived semester is the one that ended, not the fresh workspace.
    expect(record.meta.level).toBe('300');
    expect(record.meta.semester).toBe('1');
    expect(record.meta.title).toBe('Level 300 — Semester 1');
    expect(record.meta.academicYear).toBe('2025/2026');
    expect(record.snapshot.courses).toHaveLength(1);
    expect(record.snapshot.slides).toHaveLength(2);
    expect(record.snapshot.notes).toHaveLength(1);
    // The binary was copied into the archive.
    expect(idbStore.has(`semester_archive_file_${record.meta.id}_file1`)).toBe(true);
    // The old workspace's records were pruned after the verified archive.
    expect(idbStore.has('file_file1')).toBe(false);
    expect(idbStore.has('slidetext_s1')).toBe(false);

    // The fresh state was persisted.
    const saved = JSON.parse(localStorage.getItem('pharmatrack_state')!);
    expect(saved.courses).toEqual([]);
    expect(saved.student.level).toBe('Level 300');
    expect(saved.student.semester).toBe('2nd Semester');
    expect(saved.student.name).toBe('Ama');
  });

  it('cancel leaves the workspace untouched', async () => {
    seedWorkspace();
    const { getByText } = renderModal();
    await waitFor(() => expect(screen.getByTestId('courses').textContent).toBe('1'));

    fireEvent.click(getByText('Cancel'));

    // Modal closes; state intact.
    expect(screen.queryByText('Complete Semester?')).toBeNull();
    expect(screen.getByTestId('courses').textContent).toBe('1');
    expect([...idbStore.keys()].filter((k) => k.startsWith('semester_archive_'))).toEqual([]);
    act(() => {});
  });
});
