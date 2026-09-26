/**
 * Phase 11 — the RAG pipeline, end to end through the real UI path.
 *
 * The unit tests prove the index and the ranker work. This file proves the
 * pipeline is actually *wired in*: a question asked in the chat panel is
 * answered from the slide in front of the student plus passages retrieved from
 * the rest of the topic, each labelled with its course, topic, material and
 * page/slide — and never from the whole workspace.
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
  normalizeSettings,
  saveAISettings,
  type AISettings,
} from '../ai';
import { saveCredentials } from '../ai/credentials';
import { AIProvider } from '../ai/state';
import AIChatPanel from '../components/AIChatPanel';
import type { AppStateLike, ContextSelection } from '../ai/context/types';

const KEY = 'nvapi-abcdefghijklmnopqrstuvwxyz0123456789';
const captured = { bodies: [] as string[] };

/** Minimal streaming reply, the way a real provider answers `stream: true`. */
function streamOf(text: string): Response {
  const events = [
    ...text.split(' ').map((word, i) => `data: ${JSON.stringify({ choices: [{ delta: { content: `${i ? ' ' : ''}${word}` } }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
    'data: [DONE]\n\n',
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

const FOCUS_SLIDE = 'Beta blockers lower sympathetic tone and slow the heart rate.';
const OTHER_SLIDE =
  '--- Slide 7 ---\nAminoglycosides such as gentamicin cause dose-related ototoxicity, worsened by loop diuretics.';

const appState: AppStateLike = {
  student: { level: 'Level 300', semester: '2nd Semester', program: 'Pharm.D' },
  courses: [{ id: 'c1', courseCode: 'PHARM 301', courseName: 'Pharmacology' }],
  topics: [{ id: 't1', courseId: 'c1', topicName: 'Autonomic drugs' }],
  slides: [
    { id: 'm1', topicId: 't1', title: 'Lecture 4', contentText: `--- Slide 3 ---\n${FOCUS_SLIDE}`, materialKind: 'pptx' },
    { id: 'm2', topicId: 't1', title: 'Lecture 9', contentText: OTHER_SLIDE, materialKind: 'pptx' },
  ],
  learningObjectives: [],
  notes: [],
  quizHistory: [],
  studyPlans: [],
};

/** The slide the student is looking at; only this slide is "in focus". */
const scope: ContextSelection = {
  courseId: 'c1',
  topicId: 't1',
  materialId: 'm1',
  slide: 3,
  materialText: { label: 'Lecture 4', text: `--- Slide 3 ---\n${FOCUS_SLIDE}`, slide: 3, focusText: FOCUS_SLIDE },
};

async function setUpEngine() {
  const base: AISettings = normalizeSettings(defaultSettings());
  const nvidia = base.providers.find((p) => p.id === 'nvidia');
  const settings: AISettings = {
    ...base,
    providers: base.providers.map((p) => (p.id === 'nvidia' ? { ...p, enabled: true, model: 'meta/llama-3.1-70b-instruct' } : { ...p, enabled: false })),
    profiles: base.profiles.map((profile) =>
      profile.id === 'default' ? { ...profile, providerId: nvidia?.id ?? 'nvidia', fallbacks: [] } : profile,
    ),
  };
  saveAISettings(settings);
  await saveCredentials('nvidia', { apiKey: KEY });
  aiManager.reload();
  await aiManager.ensureCredentials();
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <AIProvider>
        <AIChatPanel scope={scope} appState={appState} quickTasks={['explain-slide', 'summarize']} />
      </AIProvider>
    </MemoryRouter>,
  );
}

async function ask(question: string) {
  const input = screen.getByPlaceholderText(/ask about this material/i);
  await act(async () => {
    fireEvent.change(input, { target: { value: question } });
  });
  await act(async () => {
    fireEvent.submit(input.closest('form') as HTMLFormElement);
  });
  await waitFor(() => expect(screen.queryByTestId('ai-stop')).not.toBeInTheDocument(), { timeout: 5000 });
}

/** Everything the provider received, as one searchable string. */
function sentToProvider(): string {
  return captured.bodies.join('\n');
}

beforeEach(async () => {
  captured.bodies.length = 0;
  idbStore.clear();
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { body?: string }) => {
      if (init?.body) captured.bodies.push(init.body);
      return streamOf('Aminoglycosides cause ototoxicity.');
    }),
  );
  await setUpEngine();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI answers are grounded in retrieved material', () => {
  it('retrieves a passage from another lecture and labels it with its source', async () => {
    renderPanel();
    await screen.findByPlaceholderText(/ask about this material/i);
    await act(async () => {});
    await waitFor(() => expect(screen.getByPlaceholderText(/ask about this material/i)).toBeEnabled(), { timeout: 5000 });

    await ask('What causes ototoxicity?');

    const sent = sentToProvider();
    // The slide in front of the student went out…
    expect(sent).toContain(FOCUS_SLIDE);
    // …and so did the passage that actually answers the question, from a
    // different lecture, carrying its own academic source.
    expect(sent).toContain('Aminoglycosides');
    expect(sent).toContain('Course: PHARM 301 — Pharmacology');
    expect(sent).toContain('Topic: Autonomic drugs');
    expect(sent).toContain('Source: Lecture 9');
    expect(sent).toContain('Slide: 7');
    // The key never travels with the context.
    expect(sent).not.toContain(KEY);
  });

  it('shows the student where the answer came from', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByPlaceholderText(/ask about this material/i)).toBeEnabled(), { timeout: 5000 });

    await ask('Explain this slide.');

    const source = await screen.findByTestId('ai-source-line');
    expect(source.textContent).toContain('Pharmacology');
    expect(source.textContent).toContain('Autonomic drugs');
    expect(source.textContent).toContain('Lecture 4');
    expect(source.textContent).toContain('slide 3');
  });

  it('does not send a lecture that has nothing to do with the question', async () => {
    const quiet: AppStateLike = {
      ...appState,
      slides: [
        ...appState.slides,
        {
          id: 'm3',
          topicId: 't1',
          title: 'Unrelated lecture',
          contentText: '--- Slide 1 ---\nDispensing law, record keeping and pharmacy ethics.',
          materialKind: 'pptx',
        },
      ],
    };
    render(
      <MemoryRouter>
        <AIProvider>
          <AIChatPanel scope={scope} appState={quiet} quickTasks={['explain-slide']} />
        </AIProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByPlaceholderText(/ask about this material/i)).toBeEnabled(), { timeout: 5000 });

    await ask('What causes ototoxicity?');

    expect(sentToProvider()).not.toContain('Dispensing law');
  });
});
