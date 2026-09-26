/**
 * PharmaTRACK AI Engine — acceptance walkthrough A–H (spec §35).
 *
 *   A  a question is answered by NVIDIA
 *   B  switching the provider to Gemini answers with Gemini
 *   C  NVIDIA fails → the switch to Gemini is visible, with the reason
 *   D  a PDF page is the context unit (and only that page is sent)
 *   E  a PPT slide is the context unit
 *   F  generated questions are tied to course/topic/material
 *   G  a backup never contains a key
 *   H  a restart restores providers, profiles, history and academic data
 *
 * Everything runs through the same path the app uses: AIChatPanel → AIManager →
 * adapter → (mocked) provider.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

import {
  aiManager,
  defaultSettings,
  loadAISettings,
  normalizeSettings,
  saveAISettings,
  type AISettings,
} from '../ai';
import { saveCredentials } from '../ai/credentials';
import { AIProvider, useAI } from '../ai/state';
import AIChatPanel from '../components/AIChatPanel';
import { saveState } from '../utils/storage';
import type { AppState } from '../types';
import type { AppStateLike, ContextSelection } from '../ai/context/types';

const NVIDIA_KEY = 'nvapi-abcdefghijklmnopqrstuvwxyz0123456789';
const GEMINI_KEY = 'AIzaSyAccTestKey0123456789abcdefghijkl';

const captured = { urls: [] as string[], bodies: [] as string[] };

/** A streaming (SSE) answer, the way a real provider replies to `stream: true`. */
function ok(text: string, style: 'openai' | 'gemini' = 'openai'): Response {
  const chunks = text.split(' ');
  const events =
    style === 'openai'
      ? [
          ...chunks.map((word, i) => `data: ${JSON.stringify({ choices: [{ delta: { content: `${i ? ' ' : ''}${word}` } }] })}\n\n`),
          `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
          'data: [DONE]\n\n',
        ]
      : [
          ...chunks.map((word, i) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `${i ? ' ' : ''}${word}` }] } }] })}\n\n`),
        ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

beforeEach(() => {
  captured.urls.length = 0;
  captured.bodies.length = 0;
  idbStore.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                          */
/* ------------------------------------------------------------------ */

const academicState: AppStateLike = {
  student: { level: 'Level 300', semester: '1st Semester', program: 'Pharm.D' },
  courses: [{ id: 'c1', courseCode: 'PHS 301', courseName: 'Pharmacology' }],
  topics: [{ id: 't1', courseId: 'c1', topicName: 'Autonomic Pharmacology' }],
  slides: [
    { id: 'm1', topicId: 't1', title: 'Lecture 4 — Autonomic Pharmacology' },
    { id: 'm2', topicId: 't1', title: 'Lecture 5 — Cardiovascular' },
  ],
  learningObjectives: [
    { id: 'o1', courseId: 'c1', topicId: 't1', objectiveText: 'Explain beta blocker selectivity', status: 'partial' },
  ],
  notes: [],
  quizHistory: [],
  studyPlans: [],
};

/** Configures the engine the way AI Settings would, then renders the panel. */
async function setUpEngine(entries: Array<{ id: string; model: string; primary?: boolean }>, keys: Record<string, string>) {
  const base: AISettings = normalizeSettings(defaultSettings());
  const settings: AISettings = {
    ...base,
    providers: base.providers.map((provider) => {
      const entry = entries.find((e) => e.id === provider.id);
      if (!entry) return { ...provider, enabled: false };
      return { ...provider, enabled: true, model: entry.model };
    }),
    profiles: base.profiles.map((profile) =>
      profile.id === 'default'
        ? { ...profile, providerId: entries.find((e) => e.primary)?.id ?? entries[0]?.id ?? '', fallbacks: [] }
        : profile,
    ),
  };
  saveAISettings(settings);
  for (const [id, key] of Object.entries(keys)) await saveCredentials(id, { apiKey: key });
  aiManager.reload();
  await aiManager.ensureCredentials();
  return settings;
}

/** The panel disables itself until the credential store has been read. */
async function waitForConfigured() {
  await waitFor(
    () => expect(screen.getByPlaceholderText(/ask about this material/i)).toBeEnabled(),
    { timeout: 5000 },
  );
}

/**
 * Drives the provider switch the way AI Settings does — through the AI context,
 * so the panel keeps its conversation and just starts routing elsewhere.
 */
const SwitchProvider: React.FC<{ id: string; model: string; apiKey: string }> = ({ id, model, apiKey }) => {
  const ai = useAI();
  const done = React.useRef(false);
  React.useEffect(() => {
    if (done.current) return;
    done.current = true;
    const provider = ai.providers.find((p) => p.id === id);
    if (!provider) return;
    const { hasKey: _hasKey, ...rest } = provider;
    void (async () => {
      await ai.saveProvider({ ...rest, enabled: true, model, apiKey });
      ai.saveProfile({ ...ai.activeProfile, providerId: id, model });
    })();
  }, [ai, id, model, apiKey]);
  return null;
};

function renderPanel(scope: ContextSelection, appState: AppStateLike = academicState) {
  return render(
    <MemoryRouter>
      <AIProvider>
        {/* The switcher slot stays in place so re-rendering it never remounts
            the panel (which owns the transcript). */}
        {null}
        <AIChatPanel scope={scope} appState={appState} quickTasks={['summarize', 'questions-from-material', 'explain']} />
      </AIProvider>
    </MemoryRouter>,
  );
}

/** Opens a quick-task group menu and runs one task, as the student would. */
async function runTask(group: string, label: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: group }));
  });
  const button = await screen.findByRole('button', { name: new RegExp(label, 'i') });
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() => expect(screen.queryByTestId('ai-stop')).not.toBeInTheDocument(), { timeout: 5000 });
}

async function askQuestion(question: string) {
  const input = screen.getByPlaceholderText(/ask about this material|configure a provider/i);
  await act(async () => {
    fireEvent.change(input, { target: { value: question } });
  });
  const form = input.closest('form') as HTMLFormElement;
  await act(async () => {
    fireEvent.submit(form);
  });
  await waitFor(() => expect(screen.queryByTestId('ai-stop')).not.toBeInTheDocument(), { timeout: 5000 });
}

const pdfScope: ContextSelection = {
  courseId: 'c1',
  topicId: 't1',
  materialId: 'm1',
  page: 12,
  materialText: {
    label: 'Lecture 4 — Autonomic Pharmacology',
    text: 'Page 12: Beta blockers reduce heart rate by blocking beta-1 receptors.',
    page: 12,
    focusText: 'Page 12: Beta blockers reduce heart rate by blocking beta-1 receptors.',
  },
};

const slideScope: ContextSelection = {
  courseId: 'c1',
  topicId: 't1',
  materialId: 'm2',
  slide: 23,
  materialText: {
    label: 'Lecture 5 — Cardiovascular',
    text: 'Slide 23: ACE inhibitors reduce afterload.',
    slide: 23,
    focusText: 'Slide 23: ACE inhibitors reduce afterload.',
  },
};

/* ------------------------------------------------------------------ */
/* A + B — generation, then a provider switch                         */
/* ------------------------------------------------------------------ */

describe('acceptance A–C: generation, switching and fallback', () => {
  it('A: answers with NVIDIA and shows which provider answered', async () => {
    await setUpEngine([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct', primary: true }], { nvidia: NVIDIA_KEY });
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
      captured.urls.push(String(url));
      if (typeof init.body === 'string') captured.bodies.push(init.body);
      return ok('Beta blockers act on beta-1 receptors in the heart.');
    });

    renderPanel(pdfScope);
    await waitForConfigured();
    await askQuestion('Explain beta blockers');

    await waitFor(() => expect(screen.getByText(/beta-1 receptors in the heart/i)).toBeInTheDocument());
    expect(screen.getByText(/NVIDIA • meta\/llama-3.3-70b-instruct/)).toBeInTheDocument();
    expect(captured.urls[0]).toContain('integrate.api.nvidia.com');
    expect(captured.urls[0]).not.toContain(NVIDIA_KEY);
  });

  it('B: switching the provider to Gemini answers with Gemini and keeps the history', async () => {
    await setUpEngine([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct', primary: true }], { nvidia: NVIDIA_KEY });
    vi.stubGlobal('fetch', async (url: string | URL) => {
      captured.urls.push(String(url));
      return ok('First answer from NVIDIA.');
    });

    const view = renderPanel(pdfScope);
    await waitForConfigured();
    await askQuestion('First question');
    await waitFor(() => expect(screen.getByText(/First answer from NVIDIA/)).toBeInTheDocument());

    // Gemini is added + made the active provider, exactly as AI Settings does.
    const switcher = <SwitchProvider id="gemini" model="gemini-2.5-flash" apiKey={GEMINI_KEY} />;
    view.rerender(
      <MemoryRouter>
        <AIProvider>
          {switcher}
          <AIChatPanel scope={pdfScope} appState={academicState} />
        </AIProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(aiManager.getSettings().profiles[0].providerId).toBe('gemini'));

    captured.urls.length = 0;
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
      captured.urls.push(String(url));
      if (typeof init.body === 'string') captured.bodies.push(init.body);
      return ok('Second answer from Gemini.', 'gemini');
    });
    await askQuestion('Second question');

    await waitFor(() => expect(screen.getByText(/Second answer from Gemini/)).toBeInTheDocument());
    expect(screen.getByText(/GEMINI • gemini-2.5-flash/)).toBeInTheDocument();
    expect(captured.urls.some((u) => String(u).includes('generativelanguage'))).toBe(true);
    expect(captured.urls.some((u) => String(u).includes('nvidia'))).toBe(false);
    // The earlier NVIDIA answer is still on screen after the switch.
    expect(screen.getByText(/First answer from NVIDIA/)).toBeInTheDocument();
  });

  it('C: reports the NVIDIA → Gemini fallback instead of hiding it', async () => {
    await setUpEngine(
      [
        { id: 'nvidia', model: 'meta/llama-3.3-70b-instruct', primary: true },
        { id: 'gemini', model: 'gemini-2.5-flash' },
      ],
      { nvidia: NVIDIA_KEY, gemini: GEMINI_KEY },
    );
    vi.stubGlobal('fetch', async (url: string | URL) => {
      captured.urls.push(String(url));
      return String(url).includes('nvidia')
        ? new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 403 })
        : ok('Gemini covered the answer.', 'gemini');
    });

    renderPanel(pdfScope);
    await waitForConfigured();
    await askQuestion('Explain beta blockers');

    await waitFor(() => expect(screen.getByTestId('ai-fallback-notice')).toBeInTheDocument());
    expect(screen.getByTestId('ai-fallback-notice').textContent).toContain('Switched to Google Gemini fallback');
    expect(screen.getByText(/Gemini covered the answer/)).toBeInTheDocument();
    expect(screen.getByText(/GEMINI • gemini-2.5-flash/)).toBeInTheDocument();
    // Both providers were genuinely contacted, NVIDIA first.
    expect(captured.urls[0]).toContain('nvidia');
    expect(captured.urls.some((u) => u.includes('generativelanguage'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* D + E + F — context                                                */
/* ------------------------------------------------------------------ */

describe('acceptance D–F: material-aware context', () => {
  it('D: sends the PDF page in view — not the whole document', async () => {
    await setUpEngine([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct', primary: true }], { nvidia: NVIDIA_KEY });
    vi.stubGlobal('fetch', async (_url: string | URL, init: RequestInit = {}) => {
      if (typeof init.body === 'string') captured.bodies.push(init.body);
      return ok('This page explains beta blockade.');
    });

    renderPanel({
      ...pdfScope,
      materialText: {
        ...pdfScope.materialText!,
        // The full document is available to the builder but the page is the unit.
        text: `Page 1: unrelated intro. Page 12: ${pdfScope.materialText!.text} Page 90: appendix.`,
      },
    });

    await waitForConfigured();
    // Transparency: the panel can show exactly what will be sent.
    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-context-toggle'));
    });
    expect(screen.getByTestId('ai-context-preview').textContent).toMatch(/Lecture 4 — Autonomic Pharmacology/);
    expect(screen.getByTestId('ai-context-preview').textContent).toMatch(/page 12/i);

    await askQuestion('Explain this page');
    await waitFor(() => expect(screen.getByText(/beta blockade/i)).toBeInTheDocument());

    const payload = captured.bodies.join('\n');
    expect(payload).toContain('Page 12: Beta blockers reduce heart rate');
    expect(payload).toContain('Current page (12)');
    expect(payload).not.toContain('Page 90: appendix');
    expect(payload).toContain('PHS 301');
    expect(payload).toContain('Autonomic Pharmacology');
  });

  it('E: sends the slide in view for a PPT material', async () => {
    await setUpEngine([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct', primary: true }], { nvidia: NVIDIA_KEY });
    vi.stubGlobal('fetch', async (_url: string | URL, init: RequestInit = {}) => {
      if (typeof init.body === 'string') captured.bodies.push(init.body);
      return ok('ACE inhibitors lower afterload.');
    });

    renderPanel(slideScope);
    await waitForConfigured();
    await askQuestion('Explain this slide');

    await waitFor(() => expect(screen.getByText(/lower afterload/i)).toBeInTheDocument());
    const payload = captured.bodies.join('\n');
    expect(payload).toContain('Current slide (23) of Lecture 5 — Cardiovascular');
    expect(payload).toContain('ACE inhibitors reduce afterload');
  });

  it('F: generated questions are framed with their course, topic and material', async () => {
    await setUpEngine([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct', primary: true }], { nvidia: NVIDIA_KEY });
    vi.stubGlobal('fetch', async (_url: string | URL, init: RequestInit = {}) => {
      if (typeof init.body === 'string') captured.bodies.push(init.body);
      return ok('1) Which receptor does propranolol block?');
    });

    renderPanel(pdfScope);
    await waitForConfigured();
    await runTask('This material', 'Questions from this material');
    await waitFor(() => expect(screen.getByText(/Which receptor does propranolol block/)).toBeInTheDocument());

    const payload = captured.bodies.join('\n');
    expect(payload).toContain('PHS 301');
    expect(payload).toContain('Autonomic Pharmacology');
    expect(payload).toContain('Lecture 4 — Autonomic Pharmacology');
    expect(payload).toContain('exam question');
  });

  it('G: no key ever appears in the DOM, the request URL or the request body', async () => {
    await setUpEngine([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct', primary: true }], { nvidia: NVIDIA_KEY });
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
      captured.urls.push(String(url));
      if (typeof init.body === 'string') captured.bodies.push(init.body);
      return ok('Answer without secrets.');
    });

    const { container } = renderPanel(pdfScope);
    await waitForConfigured();
    await askQuestion('What is in this page?');
    await waitFor(() => expect(screen.getByText(/Answer without secrets/)).toBeInTheDocument());

    expect(container.innerHTML).not.toContain(NVIDIA_KEY);
    expect(container.innerHTML).not.toContain('••••');
    expect(captured.urls.join(' ')).not.toContain(NVIDIA_KEY);
    expect(captured.bodies.join(' ')).not.toContain(NVIDIA_KEY);
  });
});

/* ------------------------------------------------------------------ */
/* H — restart                                                        */
/* ------------------------------------------------------------------ */

describe('acceptance H: a restart restores everything', () => {
  it('restores providers, profiles, credentials, conversations and academic data', async () => {
    await setUpEngine([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct', primary: true }], { nvidia: NVIDIA_KEY });

    // A conversation, saved the way the chat panel saves it.
    const { newConversation, appendMessage, saveConversation } = await import('../ai/conversations');
    const conversation = appendMessage(
      newConversation({ title: 'Beta blockers', courseId: 'c1', topicId: 't1', materialId: 'm1', page: 12 }),
      { role: 'user', content: 'Explain beta blockers', providerId: 'nvidia', model: 'meta/llama-3.3-70b-instruct' },
    );
    await saveConversation(conversation);

    // Academic data, saved the way the app saves it.
    const appState = {
      student: { id: 'u1', name: 'Ama', level: 'Level 300', semester: '1st Semester' },
      courses: [{ id: 'c1', courseCode: 'PHS 301', courseName: 'Pharmacology' }],
      topics: [{ id: 't1', courseId: 'c1', topicName: 'Autonomic Pharmacology' }],
      slides: [],
      notes: [],
      openAIKey: '',
    } as unknown as AppState;
    saveState(appState);

    // ---- restart: every module is reloaded from scratch -------------------
    vi.resetModules();
    const freshAI = await import('../ai');
    const freshCreds = await import('../ai/credentials');
    const freshConversations = await import('../ai/conversations');
    const { loadState } = await import('../utils/storage');

    freshAI.aiManager.reload();
    await freshAI.aiManager.ensureCredentials();

    const restored = freshAI.loadAISettings();
    expect(restored.providers.find((p) => p.id === 'nvidia')?.enabled).toBe(true);
    expect(restored.providers.find((p) => p.id === 'nvidia')?.model).toBe('meta/llama-3.3-70b-instruct');
    expect(restored.profiles.map((p) => p.id)).toContain('default');
    expect(restored.activeProfileId).toBe('default');
    expect(restored.providerPriority[0]).toBe('nvidia');
    // Keys come back from the credential store…
    expect(await freshCreds.loadCredentials('nvidia')).toEqual({ apiKey: NVIDIA_KEY });
    const provider = await freshAI.aiManager.provider('nvidia');
    expect(provider?.apiKey).toBe(NVIDIA_KEY);
    // …and are still absent from the settings blob.
    expect(JSON.stringify(restored)).not.toContain(NVIDIA_KEY);

    // History is readable after the restart, with its academic scope.
    const list = await freshConversations.listConversations();
    expect(list.map((c) => c.title)).toContain('Beta blockers');
    const reloaded = await freshConversations.loadConversation(list[0].id);
    expect(reloaded?.messages.length).toBe(1);
    expect(reloaded?.courseId).toBe('c1');
    expect(reloaded?.materialId).toBe('m1');

    // Academic data survived the restart untouched.
    const state = loadState();
    expect(state.courses).toHaveLength(1);
    expect(state.topics).toHaveLength(1);
    expect(state.openAIKey).toBeFalsy();
  });

  it('reopens a stored conversation written by another provider, offline', async () => {
    const { newConversation, appendMessage, saveConversation } = await import('../ai/conversations');

    // A conversation written while NVIDIA was the provider…
    let conversation = appendMessage(newConversation({ title: 'Beta blockers', courseId: 'c1', topicId: 't1' }), {
      role: 'user',
      content: 'Explain beta blockers',
    });
    conversation = appendMessage(conversation, {
      role: 'assistant',
      content: 'Beta blockers reduce heart rate.',
      providerId: 'nvidia',
      model: 'meta/llama-3.3-70b-instruct',
    });
    await saveConversation(conversation);

    // …is opened later, after the student has switched to Gemini, with the
    // network down. The history must still render, with its original metadata.
    vi.stubGlobal('fetch', () => {
      throw new TypeError('Failed to fetch');
    });
    await setUpEngine([{ id: 'gemini', model: 'gemini-2.5-flash', primary: true }], { gemini: GEMINI_KEY });

    const { loadConversation } = await import('../ai/conversations');
    const stored = await loadConversation(conversation.id);
    render(
      <MemoryRouter>
        <AIProvider>
          <AIChatPanel scope={pdfScope} appState={academicState} initialConversation={stored} />
        </AIProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Beta blockers reduce heart rate/)).toBeInTheDocument();
    expect(screen.getByText(/Explain beta blockers/)).toBeInTheDocument();
    expect(screen.getByText(/NVIDIA • meta\/llama-3.3-70b-instruct/)).toBeInTheDocument();
  });

  it('still opens the app offline: prior history reads without the network', async () => {
    const { newConversation, appendMessage, saveConversation, listConversations } = await import('../ai/conversations');
    const conversation = appendMessage(newConversation({ title: 'Offline revision' }), {
      role: 'assistant',
      content: 'Saved answer while online.',
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
    });
    await saveConversation(conversation);

    vi.stubGlobal('fetch', () => {
      throw new TypeError('Failed to fetch');
    });

    const list = await listConversations();
    expect(list).toHaveLength(1);
  });
});
