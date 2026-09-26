/**
 * Phase 11 — the local retrieval index, as the student sees it in Settings → AI.
 *
 * Indexing is meant to be visible and rebuildable, and it must never break the
 * settings screen: the card renders inside the real app context, builds an index
 * from the workspace's materials, and reports what it indexed.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => { idbStore.set(k, v); },
  del: async (k: string) => { idbStore.delete(k); },
  delMany: async (keys: string[]) => { keys.forEach((k) => idbStore.delete(k)); },
  keys: async () => [...idbStore.keys()],
  clear: async () => { idbStore.clear(); },
}));

import { AppProvider } from '../context/AppContext';
import { AIProvider } from '../ai/state';
import AISettingsPanel from '../components/AISettingsPanel';
import { RAG_INDEX_KEY, loadRagIndex } from '../ai';
import { saveState } from '../utils/storage';
import type { AppState } from '../types';

const workspace: AppState = {
  student: { id: 's1', name: 'Student', level: 'Level 300', semester: '2nd Semester', program: 'Pharm.D', institution: 'KNUST' },
  courses: [{ id: 'c1', courseCode: 'PHARM 301', courseName: 'Pharmacology', lecturer: 'Dr A', credits: 3, semester: '2nd Semester', level: 'Level 300', createdAt: '' }],
  topics: [{ id: 't1', courseId: 'c1', topicName: 'Autonomic drugs', createdAt: '' }],
  slides: [
    {
      id: 'm1',
      topicId: 't1',
      slideNumber: 1,
      title: 'Lecture 4',
      contentText: '--- Slide 1 ---\nBeta blockers lower sympathetic tone and slow the heart rate.',
      status: 'not_started',
      createdAt: '',
      materialKind: 'pptx',
    },
  ],
  notes: [],
  quizHistory: [],
  studyPlans: [],
  learningObjectives: [],
  highlights: [],
  chatHistory: [],
  timetables: { class: [], quiz: [], exam: [] },
} as unknown as AppState;

function renderSettings() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <AIProvider>
          <AISettingsPanel />
        </AIProvider>
      </AppProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
  saveState(workspace);
});

describe('Settings → AI shows the local retrieval index', () => {
  it('renders the index card', async () => {
    renderSettings();
    expect(await screen.findByTestId('ai-local-index')).toBeTruthy();
    expect(screen.getByText(/local retrieval index/i)).toBeTruthy();
  });

  it('builds an index from the workspace and reports what it indexed', async () => {
    renderSettings();
    const card = await screen.findByTestId('ai-local-index');
    const rebuild = screen.getByRole('button', { name: /rebuild/i });

    fireEvent.click(rebuild);

    await waitFor(() => expect(screen.getByTestId('ai-index-notice')).toBeTruthy(), { timeout: 5000 });
    expect(screen.getByTestId('ai-index-notice').textContent).toMatch(/indexed 1 material/i);

    // The index really was written, and it holds the workspace's passages.
    const index = await loadRagIndex();
    expect(Object.keys(index.materials)).toContain('m1');
    expect(index.materials.m1.chunks[0]).toMatchObject({
      courseName: 'Pharmacology',
      topicName: 'Autonomic drugs',
      materialTitle: 'Lecture 4',
      slide: 1,
    });
    expect(card).toBeTruthy();
  });

  it('keeps the index out of the semester backup keys', async () => {
    renderSettings();
    await screen.findByTestId('ai-local-index');
    expect(idbStore.has(RAG_INDEX_KEY)).toBe(false);
    // Nothing is indexed until the student asks or presses Rebuild: opening
    // the library must not silently read every file.
  });
});
