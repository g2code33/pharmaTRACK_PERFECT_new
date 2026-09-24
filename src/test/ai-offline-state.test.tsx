/**
 * Phase 12 — the AI offline state.
 *
 * When no provider can be reached the panel says "AI unavailable offline" and
 * stops there. The important half of that contract is the second half: reading,
 * notes, quizzes, search, revision and archives must carry on, and a provider
 * running on the device (Ollama / llama.cpp) must keep working while offline.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
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

import { aiManager, defaultSettings, normalizeSettings, saveAISettings, type AISettings } from '../ai';
import { saveCredentials } from '../ai/credentials';
import { AIProvider } from '../ai/state';
import AIChatPanel from '../components/AIChatPanel';
import type { AppStateLike, ContextSelection } from '../ai/context/types';

const NVIDIA_KEY = 'nvapi-abcdefghijklmnopqrstuvwxyz0123456789';

const appState: AppStateLike = {
  student: { level: '300', semester: '2nd', program: 'Pharm.D' },
  courses: [{ id: 'c1', courseCode: 'PHARM 301', courseName: 'Pharmacology' }],
  topics: [{ id: 't1', courseId: 'c1', topicName: 'Autonomic drugs' }],
  slides: [{ id: 'm1', topicId: 't1', title: 'Lecture 4', contentText: '--- Slide 1 ---\nBeta blockers.' }],
  learningObjectives: [],
  notes: [],
  quizHistory: [],
  studyPlans: [],
};

const scope: ContextSelection = {
  courseId: 'c1',
  topicId: 't1',
  materialId: 'm1',
  slide: 1,
  materialText: { label: 'Lecture 4', text: 'Beta blockers.', slide: 1, focusText: 'Beta blockers.' },
};

/** Configures the engine with exactly one enabled provider. */
async function setUpEngine(providerId: string, apiKey?: string, baseUrl?: string) {
  const base: AISettings = normalizeSettings(defaultSettings());
  const settings: AISettings = {
    ...base,
    providers: base.providers.map((p) =>
      p.id === providerId
        ? { ...p, enabled: true, model: p.model || 'test-model', ...(baseUrl ? { baseUrl } : {}) }
        : { ...p, enabled: false },
    ),
    profiles: base.profiles.map((profile) =>
      profile.id === 'default' ? { ...profile, providerId, fallbacks: [] } : profile,
    ),
  };
  saveAISettings(settings);
  if (apiKey) await saveCredentials(providerId, { apiKey });
  aiManager.reload();
  await aiManager.ensureCredentials();
}

function setOnline(value: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(value);
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <AIProvider>
        <AIChatPanel scope={scope} appState={appState} quickTasks={['explain-slide']} />
      </AIProvider>
    </MemoryRouter>,
  );
}

async function ready() {
  await waitFor(() => expect(screen.getByPlaceholderText(/ask about this material|AI unavailable offline|Configure a provider/i)).toBeInTheDocument(), { timeout: 5000 });
}

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AI offline state', () => {
  it('says AI is unavailable when offline with only a cloud provider', async () => {
    setOnline(false);
    await setUpEngine('nvidia', NVIDIA_KEY);
    renderPanel();
    await ready();

    const banner = await screen.findByTestId('ai-offline-state');
    expect(banner.textContent).toContain('AI unavailable offline');

    // The composer is disabled rather than failing mid-answer.
    const input = screen.getByPlaceholderText(/AI unavailable offline/i);
    expect(input).toBeDisabled();
  });

  it('tells the student that local study features still work', async () => {
    setOnline(false);
    await setUpEngine('nvidia', NVIDIA_KEY);
    renderPanel();
    await ready();

    const banner = await screen.findByTestId('ai-offline-state');
    expect(banner.textContent).toMatch(/reading|notes|quizzes|search|revision|archives/i);
    expect(banner.textContent).toMatch(/local provider/i);
  });

  it('keeps AI available offline when a local provider is configured', async () => {
    setOnline(false);
    await setUpEngine('local', undefined, 'http://localhost:11434/v1');
    renderPanel();
    await ready();

    await waitFor(() => expect(screen.queryByTestId('ai-offline-state')).not.toBeInTheDocument(), { timeout: 5000 });
    // Not blocked: the composer is live and shows the normal prompt.
    await waitFor(() => expect(screen.getByPlaceholderText(/ask about this material/i)).toBeEnabled(), { timeout: 5000 });
  });

  it('treats a self-hosted OpenAI-compatible endpoint as reachable offline', async () => {
    setOnline(false);
    await setUpEngine('custom', 'sk-local-test-key', 'http://127.0.0.1:1234/v1');
    renderPanel();
    await ready();

    await waitFor(() => expect(screen.queryByTestId('ai-offline-state')).not.toBeInTheDocument(), { timeout: 5000 });
  });

  it('clears the offline notice when the connection comes back', async () => {
    setOnline(false);
    await setUpEngine('nvidia', NVIDIA_KEY);
    renderPanel();
    await ready();
    expect(await screen.findByTestId('ai-offline-state')).toBeInTheDocument();

    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(screen.queryByTestId('ai-offline-state')).not.toBeInTheDocument(), { timeout: 5000 });
    await waitFor(() => expect(screen.getByPlaceholderText(/ask about this material/i)).toBeEnabled(), { timeout: 5000 });
  });

  it('a cloud provider still answers when the connection is up', async () => {
    setOnline(true);
    await setUpEngine('nvidia', NVIDIA_KEY);
    renderPanel();
    await ready();

    expect(screen.queryByTestId('ai-offline-state')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByPlaceholderText(/ask about this material/i)).toBeEnabled(), { timeout: 5000 });
  });
});
