/**
 * UI tests for the Academic Archive page + read-only ArchiveViewer:
 *  - Current Semester / Previous Semesters / Backup & Transfer layout
 *  - deletion policy modal (Export Backup First / Delete Permanently / Cancel)
 *  - full import flow: select .pharmatrack → validated summary → import
 *    into the archive (the safe default) → done
 *  - ArchiveViewer is a pure read: it renders the historical snapshot and
 *    never writes to live state
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
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
import AcademicArchive from '../pages/AcademicArchive';
import ArchiveViewer from '../pages/ArchiveViewer';
import { createSemesterArchive, exportBackup } from '../utils/semesterArchive';
import type { AppState } from '../types';

const seedWorkspace = () => {
  const state = {
    isLoggedIn: false,
    student: { id: 'u1', name: 'Ama', university: 'UCC', level: 'Level 300', program: 'Pharm.D', semester: '1st Semester', createdAt: '2024-01-01' },
    courses: [
      { id: 'c1', studentId: 'u1', courseCode: 'PHA301', courseName: 'Pharmacology', lecturerName: 'Dr. B', semester: '1st Semester', creditHours: 4, createdAt: '2024-01-01' },
    ],
    topics: [{ id: 't1', courseId: 'c1', topicName: 'Cardiac Glycosides', orderIndex: 0, createdAt: '2024-01-01' }],
    slides: [
      { id: 's1', topicId: 't1', slideNumber: 1, title: 'Digoxin', contentText: 'x'.repeat(2500), fileUrl: 'local:file1', fileType: 'pdf', status: 'completed', createdAt: '2024-01-02' },
    ],
    notes: [{ id: 'n1', topicId: 't1', noteText: 'Digoxin: narrow therapeutic index', isAiGenerated: false, createdAt: '2024-01-04' }],
    examQuestions: [{ id: 'q1', courseId: 'c1', topicId: 't1', questionText: 'Q?', questionType: 'mcq', marksAllocation: 2, difficulty: 'easy', probability: 'high', modelAnswer: 'A', tags: [], isPracticed: false, needsReview: false, isSaved: false, createdAt: '2024-01-01' }],
    quizHistory: [],
    learningObjectives: [], studyPlans: [], examDates: [], activities: [], chatHistory: [], highlights: [], savedInsights: [],
    openAIKey: '',
    timetables: { class: [], quiz: [], exam: [] },
    timetablePdf: null,
  };
  localStorage.setItem('pharmatrack_state', JSON.stringify(state));
  idbStore.set('file_file1', new Blob(['%PDF fake digoxin'], { type: 'application/pdf' }));
  idbStore.set('slidetext_s1', 'x'.repeat(2500));
  return state as AppState;
};

const Probe: React.FC = () => {
  const { state } = useApp();
  return <div data-testid="live-courses">{state.courses.length}</div>;
};

const renderArchivePage = () => render(
  <MemoryRouter initialEntries={['/archive']}>
    <AppProvider>
      <Probe />
      <Routes>
        <Route path="/archive" element={<AcademicArchive />} />
        <Route path="/archive/:id" element={<ArchiveViewer />} />
      </Routes>
    </AppProvider>
  </MemoryRouter>,
);

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
  authState.callbacks = [];
  setOnline(true);
});

describe('Academic Archive page', () => {
  it('shows the Current Semester card and Backup & Transfer actions', async () => {
    seedWorkspace();
    renderArchivePage();

    await waitFor(() => expect(screen.getByTestId('live-courses').textContent).toBe('1'));

    // Current semester card.
    expect(screen.getByText('Current Semester')).toBeTruthy();
    expect(screen.getByText('Level 300 • 1st Semester')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Continue Semester')).toBeTruthy();

    // Backup & Transfer.
    expect(screen.getByText('Backup & Transfer')).toBeTruthy();
    expect(screen.getByText('Export Current Semester')).toBeTruthy();
    expect(screen.getByText('Export All Academic Data')).toBeTruthy();
    expect(screen.getAllByText('Import Semester Backup').length).toBe(2); // header + section

    // No completed semesters yet.
    expect(await screen.findByText('No completed semesters yet')).toBeTruthy();
  });

  it('lists completed semesters with stats and opens the deletion policy', async () => {
    const state = seedWorkspace();
    const meta = await createSemesterArchive(state, { level: 'Level 200', semester: '1st Semester', academicYear: '2025/2026' });
    renderArchivePage();

    await waitFor(() => expect(screen.getByText('Level 200 — Semester 1')).toBeTruthy());
    expect(screen.getByText('Verified')).toBeTruthy();
    // Both the current-semester card and the archive card show the same stats line.
    expect(screen.getAllByText(/1 Courses · 1 Topics · 1 Materials · 1 Notes/).length).toBe(2);

    // Delete requires the explicit policy modal.
    fireEvent.click(screen.getByText('Delete…'));
    expect(await screen.findByText('Delete Archived Semester?')).toBeTruthy();
    expect(screen.getByText('Export Backup First')).toBeTruthy();
    expect(screen.getByText('Delete Permanently')).toBeTruthy();

    // Confirm the deletion.
    fireEvent.click(screen.getByText('Delete Permanently'));
    expect(await screen.findByText('No completed semesters yet')).toBeTruthy();
    expect([...idbStore.keys()].filter((k) => k.startsWith('semester_archive'))).toEqual([]);
    void meta;
  });
});

describe('import flow (safe default: into the archive)', () => {
  it('validates a .pharmatrack file, shows what is inside, and imports it', async () => {
    // Build a real backup on "device A" (Level 200, different semester).
    const donor: AppState = {
      ...seedWorkspace(),
      student: { id: 'u1', name: 'Ama', university: 'UCC', level: 'Level 200', program: 'Pharm.D', semester: '1st Semester', createdAt: '2023-01-01' },
      courses: [{ id: 'dc', studentId: 'u1', courseCode: 'PHA201', courseName: 'Physical Pharmaceutics', lecturerName: 'Dr. K', semester: '1st Semester', creditHours: 3, createdAt: '2023-01-01' }],
      topics: [{ id: 'dt', courseId: 'dc', topicName: 'Emulsions', orderIndex: 0, createdAt: '2023-01-01' }],
      slides: [{ id: 'ds', topicId: 'dt', slideNumber: 1, title: 'O/W', contentText: 'emulsion basics', status: 'not_started', createdAt: '2023-01-02' }],
      notes: [], examQuestions: [], quizHistory: [], studyPlans: [], examDates: [], activities: [], chatHistory: [], highlights: [], savedInsights: [], learningObjectives: [],
      timetables: { class: [], quiz: [], exam: [] },
      timetablePdf: null,
    } as AppState;
    const donorBlob = await exportBackup({ kind: 'live', state: donor });

    // Device B: render the archive page with a current (Level 300) semester.
    seedWorkspace();
    renderArchivePage();
    await waitFor(() => expect(screen.getByTestId('live-courses').textContent).toBe('1'));

    // Select the file.
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([donorBlob], 'PharmaTRACK_Level-200_Semester-1.pharmatrack', { type: 'application/zip' });
    fireEvent.change(input, { target: { files: [file] } });

    // The validated summary shows exactly what is inside.
    expect(await screen.findByText('Level 200 — Semester 1 (current)')).toBeTruthy();
    expect(screen.getByText('Backup integrity: ✓ Valid')).toBeTruthy();
    expect(screen.getByText('Import into Academic Archive')).toBeTruthy();

    // Import (the safe default — the current workspace must stay put).
    fireEvent.click(screen.getByText('Import into Academic Archive'));
    expect(await screen.findByText('Imported into Academic Archive', {}, { timeout: 10_000 })).toBeTruthy();

    // The backup is now part of the permanent archive…
    const archiveKeys = [...idbStore.keys()].filter(
      (k) => k.startsWith('semester_archive') && !k.startsWith('semester_archive_file_') && !k.startsWith('semester_archive_text_'),
    );
    expect(archiveKeys).toHaveLength(1);
    const record = idbStore.get(archiveKeys[0]) as any;
    expect(record.meta.status).toBe('verified');
    expect(record.snapshot.courses.map((c: { id: string }) => c.id)).toEqual(['dc']);
    // …and the current (live) semester was never touched.
    expect(screen.getByTestId('live-courses').textContent).toBe('1');
  });

  it('shows the failure screen when the file is not a valid backup', async () => {
    seedWorkspace();
    renderArchivePage();
    await waitFor(() => expect(screen.getByTestId('live-courses').textContent).toBe('1'));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const bad = new File([new TextEncoder().encode('not a zip at all')], 'backup.pharmatrack');
    fireEvent.change(input, { target: { files: [bad] } });

    expect(await screen.findByText('Import failed')).toBeTruthy();
    expect(screen.getByText(/could not open it as a ZIP/i)).toBeTruthy();
    // Nothing was imported.
    expect([...idbStore.keys()].filter((k) => k.startsWith('semester_archive'))).toEqual([]);
  });
});

describe('ArchiveViewer — read-only historical snapshot', () => {
  it('renders the archived semester and never mutates live state', async () => {
    const state = seedWorkspace();
    const meta = await createSemesterArchive(state, { level: 'Level 200', semester: '1st Semester', academicYear: '2025/2026' });

    // Snapshot of the live state BEFORE viewing.
    const stateBefore = localStorage.getItem('pharmatrack_state');
    const idbBefore = new Map(idbStore);

    render(
      <MemoryRouter initialEntries={[`/archive/${meta.id}`]}>
        <Routes>
          <Route path="/archive/:id" element={<ArchiveViewer />} />
        </Routes>
      </MemoryRouter>,
    );

    // The ARCHIVED SEMESTER banner + read-only indicator.
    expect(await screen.findByText('Archived Semester')).toBeTruthy();
    expect(screen.getByText(/preserved as historical academic data/)).toBeTruthy();
    expect(screen.getAllByText(/Read-only/).length).toBeGreaterThan(0);

    // The historical content is browsable.
    expect(screen.getByText('Overview')).toBeTruthy();
    expect(screen.getAllByText('PHA301').length).toBeGreaterThan(0);
    expect(screen.getByText('Digoxin: narrow therapeutic index')).toBeTruthy(); // note

    // …and viewing changed nothing on disk (no dispatches, no idb writes).
    await waitFor(() => expect(localStorage.getItem('pharmatrack_state')).toBe(stateBefore));
    expect([...idbStore.keys()].sort()).toEqual([...idbBefore.keys()].sort());
  });
});
