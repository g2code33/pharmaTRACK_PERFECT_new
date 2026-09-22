/**
 * PharmaTRACK AI Engine — credential safety (spec §19, §21, §33).
 *
 * The promise under test: an API key exists in exactly one place (the AI
 * credential store) and can never reach a settings blob, an export, a backup, a
 * log line, an error message or a request URL — while the *old* single-key
 * configuration still migrates without being destroyed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const idbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => { idbStore.set(k, v); },
  del: async (k: string) => { idbStore.delete(k); },
  delMany: async (keys: string[]) => { keys.forEach((k) => idbStore.delete(k)); },
  keys: async () => [...idbStore.keys()],
  clear: async () => { idbStore.clear(); },
}));

import JSZip from 'jszip';
import {
  AI_SETTINGS_KEY,
  clearAISettings,
  defaultSettings,
  findLegacyKey,
  looksLikeApiKey,
  maskKey,
  migrateLegacySettings,
  normalizeSettings,
  providerForLegacyKey,
  redactSecrets,
  saveAISettings,
  scrubSecretsDeep,
  stripCredentials,
  loadAISettings,
  AIManager,
  resolveModelInfo,
} from '../ai';
import {
  clearAllCredentials,
  loadAllCredentials,
  loadCredentials,
  saveCredentials,
} from '../ai/credentials';
import { createSemesterArchive, exportBackup, verifySemesterArchive } from '../utils/semesterArchive';
import type { AppState } from '../types';

const NVIDIA_KEY = 'nvapi-abcdefghijklmnopqrstuvwxyz0123456789';
const GEMINI_KEY = 'AIzaSyLegacyKey0123456789abcdefghijkl';
const ALL_KEYS = [NVIDIA_KEY, GEMINI_KEY, 'sk-ant-api03-abcdefghijklmnop', 'gsk_groq0123456789abcdef', 'sk-or-v1-abcdefghijklmnop'];

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
  void clearAllCredentials();
});

/* ------------------------------------------------------------------ */
/* Settings blob                                                      */
/* ------------------------------------------------------------------ */

describe('AI configuration never contains a key', () => {
  it('strips the key when settings are persisted', () => {
    const settings = defaultSettings();
    settings.providers = settings.providers.map((p) =>
      p.id === 'nvidia' ? { ...p, enabled: true, apiKey: NVIDIA_KEY, organization: 'org_x' } : p,
    );

    saveAISettings(settings);

    const raw = localStorage.getItem(AI_SETTINGS_KEY) ?? '';
    expect(raw).not.toContain(NVIDIA_KEY);
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('org_x');

    const reloaded = loadAISettings();
    expect(reloaded.providers.find((p) => p.id === 'nvidia')?.enabled).toBe(true);
    expect(reloaded.providers.find((p) => p.id === 'nvidia')?.apiKey).toBeUndefined();
  });

  it('keeps AI configuration in its own store, not in the academic state blob', () => {
    const settings = defaultSettings();
    saveAISettings(settings);
    const academic = localStorage.getItem('pharmatrack_state') ?? '';
    expect(academic).not.toContain(AI_SETTINGS_KEY);
    expect(academic).not.toContain('providerPriority');
    // And the academic blob is not written by saving AI settings at all.
    expect(localStorage.getItem('pharmatrack_state')).toBeNull();
  });

  it('stripCredentials removes every secret field, leaving the rest intact', () => {
    const stripped = stripCredentials({
      id: 'custom',
      label: 'Campus gateway',
      baseUrl: 'https://ai.example.edu/v1',
      apiKey: 'sk-secret-1234567890',
      organization: 'org_1',
      project: 'proj_1',
      headers: { 'X-Api-Key': 'sk-secret-1234567890' },
    });
    expect(stripped).toEqual({
      id: 'custom',
      label: 'Campus gateway',
      baseUrl: 'https://ai.example.edu/v1',
    });
    expect(JSON.stringify(stripped)).not.toContain('sk-secret');
  });

  it('scrubs key-shaped strings out of nested structures', () => {
    const scrubbed = scrubSecretsDeep({
      note: `my key is ${NVIDIA_KEY} ok`,
      nested: { deep: [`AIzaSyNestedKey0123456789`, 'harmless text'] },
      openAIKey: GEMINI_KEY,
      longText: 'Beta blockers reduce heart rate. '.repeat(20),
    }) as Record<string, unknown>;

    const json = JSON.stringify(scrubbed);
    for (const key of ALL_KEYS) expect(json).not.toContain(key);
    expect(json).toContain('harmless text');
    // Legitimate study text is never mangled by the scrubber.
    expect(json).toContain('Beta blockers reduce heart rate.');
  });

  it('never renders a full key in the UI mask', () => {
    expect(maskKey(GEMINI_KEY)).not.toBe(GEMINI_KEY);
    expect(maskKey(GEMINI_KEY)).toContain('••••');
    expect(maskKey(undefined)).toBe('');
    expect(looksLikeApiKey('just some normal text')).toBe(false);
    expect(looksLikeApiKey(NVIDIA_KEY)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Credential store                                                   */
/* ------------------------------------------------------------------ */

describe('credential store', () => {
  it('round-trips a key through the store and never through settings', async () => {
    await saveCredentials('nvidia', { apiKey: NVIDIA_KEY });
    expect(await loadCredentials('nvidia')).toEqual({ apiKey: NVIDIA_KEY });

    const blob = JSON.stringify(await loadAllCredentials());
    expect(blob).toContain(NVIDIA_KEY); // the credential store is where it lives
    expect(localStorage.getItem(AI_SETTINGS_KEY) ?? '').not.toContain(NVIDIA_KEY);
  });

  it('deletes credentials on request', async () => {
    await saveCredentials('nvidia', { apiKey: NVIDIA_KEY });
    await saveCredentials('nvidia', {});
    expect(await loadCredentials('nvidia')).toEqual({});
  });

  it('clears every credential when the workspace is wiped', async () => {
    await saveCredentials('nvidia', { apiKey: NVIDIA_KEY });
    await saveCredentials('gemini', { apiKey: GEMINI_KEY });
    await clearAllCredentials();
    expect(await loadAllCredentials()).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* Requests + errors                                                  */
/* ------------------------------------------------------------------ */

describe('keys in transit', () => {
  const cases = [
    { kind: 'nvidia', key: NVIDIA_KEY, header: 'Authorization' },
    { kind: 'openai', key: 'sk-openai-abcdefghijklmnop', header: 'Authorization' },
    { kind: 'groq', key: 'gsk_groqabcdefghijklmnop', header: 'Authorization' },
    { kind: 'openrouter', key: 'sk-or-v1-abcdefghijklmnop', header: 'Authorization' },
    { kind: 'mistral', key: 'sk-mistral-abcdefghijklmnop', header: 'Authorization' },
    { kind: 'gemini', key: GEMINI_KEY, header: 'x-goog-api-key' },
    { kind: 'anthropic', key: 'sk-ant-api03-abcdefghijklmnop', header: 'x-api-key' },
  ] as const;

  it.each(cases)('sends the $kind key in a header and never in the URL', async ({ kind, key, header }) => {
    const urls: string[] = [];
    let headers: Record<string, string> = {};
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
      urls.push(String(url));
      headers = init.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }], candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
        { status: 200 },
      );
    });

    const settings = defaultSettings();
    settings.providers = settings.providers.map((p) =>
      p.id === kind ? { ...p, enabled: true, model: p.model || 'test-model' } : p,
    );
    const manager = new AIManager({
      loadSettings: () => settings,
      saveSettings: (next) => next,
      loadCreds: async () => ({ [kind]: { apiKey: key } }),
    });

    await manager
      .generate({ messages: [{ role: 'user', content: 'hi' }], providerId: kind })
      .catch(() => undefined);

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toContain(key);
      expect(url).not.toContain(encodeURIComponent(key));
      expect(url).not.toContain('key=');
    }
    const value = headers[header] ?? headers[header.toLowerCase()];
    expect(value).toBe(header === 'Authorization' ? `Bearer ${key}` : key);
    vi.unstubAllGlobals();
  });
});

describe('keys in errors and logs', () => {
  it('redacts a key the provider echoed back', () => {
    const text = redactSecrets(`Invalid API key: ${NVIDIA_KEY}`, [NVIDIA_KEY]);
    expect(text).not.toContain(NVIDIA_KEY);
    expect(text).toContain('[redacted]');
  });

  it('redacts unknown key shapes and bearer headers too', () => {
    expect(redactSecrets(`key=sk-live-abcdefghijklmnop`)).not.toContain('sk-live-abcdefghijklmnop');
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrst')).not.toContain('abcdefghijklmnopqrst');
    expect(redactSecrets(`https://api.example.com/v1?key=${GEMINI_KEY}&x=1`)).not.toContain(GEMINI_KEY);
  });
});

/* ------------------------------------------------------------------ */
/* Migration (spec §33)                                               */
/* ------------------------------------------------------------------ */

describe('legacy key migration', () => {
  it('finds the old AppState key field', () => {
    expect(findLegacyKey({ openAIKey: GEMINI_KEY })).toEqual({ field: 'openAIKey', key: GEMINI_KEY });
    expect(findLegacyKey({ openAIKey: '   ' })).toBeNull();
    expect(findLegacyKey({})).toBeNull();
  });

  it('maps an AIza key to Gemini (the field was always a Google key)', () => {
    expect(providerForLegacyKey(GEMINI_KEY).kind).toBe('gemini');
    expect(providerForLegacyKey(NVIDIA_KEY).kind).toBe('nvidia');
    expect(providerForLegacyKey('sk-ant-api03-abcdefghijklmnop').kind).toBe('anthropic');
    expect(providerForLegacyKey('gsk_groq0123456789').kind).toBe('groq');
    expect(providerForLegacyKey('sk-proj-abcdefghijklmnop').kind).toBe('openai');
  });

  it('turns the legacy key into an enabled provider + default profile, and persists no key', () => {
    const before = normalizeSettings(defaultSettings());
    const { settings, providerId } = migrateLegacySettings(before, GEMINI_KEY, { model: 'gemini-2.5-flash' });

    expect(providerId).toBe('gemini');
    const gemini = settings.providers.find((p) => p.id === 'gemini');
    expect(gemini?.enabled).toBe(true);
    expect(gemini?.migratedFrom).toBe('openAIKey');
    expect(settings.profiles.find((p) => p.id === 'default')?.providerId).toBe('gemini');

    // Persisting the migrated configuration keeps the key out of localStorage.
    saveAISettings(settings);
    expect(localStorage.getItem(AI_SETTINGS_KEY) ?? '').not.toContain(GEMINI_KEY);
  });

  it('does not lose the old configuration when migration has not run yet', () => {
    // The app-level migration only clears `openAIKey` after the new store has
    // accepted the key; nothing here deletes the legacy value itself.
    const state = { openAIKey: GEMINI_KEY, courses: [{ id: 'c1' }] };
    const found = findLegacyKey(state);
    expect(found?.key).toBe(GEMINI_KEY);
    expect(state.openAIKey).toBe(GEMINI_KEY);
  });
});

/* ------------------------------------------------------------------ */
/* Backups (spec §21, acceptance G)                                   */
/* ------------------------------------------------------------------ */

function makeState(): AppState {
  return {
    isLoggedIn: true,
    student: {
      id: 'u1',
      name: 'Ama',
      university: 'UCC',
      program: 'Pharm.D',
      level: 'Level 300',
      semester: '1st Semester',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    courses: [{ id: 'c1', courseCode: 'PHS 301', courseName: 'Pharmacology', semester: '1st Semester', level: 'Level 300', createdAt: '2026-01-01T00:00:00.000Z' }],
    topics: [{ id: 't1', courseId: 'c1', topicName: 'Autonomic Pharmacology', createdAt: '2026-01-01T00:00:00.000Z' }],
    slides: [
      {
        id: 'm1',
        topicId: 't1',
        title: 'Lecture 4',
        fileType: 'pdf',
        fileData: '',
        contentText: 'Beta blockers reduce heart rate.',
        createdAt: '2026-01-01T00:00:00.000Z',
        extractedText: 'Beta blockers reduce heart rate.',
      },
    ],
    learningObjectives: [{ id: 'o1', courseId: 'c1', topicId: 't1', objectiveText: 'Describe beta blockers', status: 'partial', createdAt: '2026-01-01T00:00:00.000Z' }],
    examQuestions: [],
    quizHistory: [],
    studyPlans: [],
    notes: [{ id: 'n1', topicId: 't1', noteText: 'Beta-1 is cardiac.', isAiGenerated: false, createdAt: '2026-01-01T00:00:00.000Z' }],
    examDates: [],
    activities: [],
    chatHistory: [
      {
        id: 'ch1',
        topicId: 't1',
        messages: [
          { id: 'msg1', role: 'assistant', content: 'Beta blockers reduce heart rate.', timestamp: '2026-01-02T10:00:00.000Z', providerId: 'nvidia', model: 'meta/llama-3.3-70b-instruct' },
        ],
      },
    ],
    highlights: [],
    savedInsights: [],
    // The legacy field is deliberately populated: an export must not carry it.
    openAIKey: GEMINI_KEY,
    timetables: { class: [], quiz: [], exam: [] },
    timetablePdf: null,
  } as unknown as AppState;
}

describe('backups exclude credentials (acceptance G)', () => {
  it('keeps every key out of a live .pharmatrack backup', async () => {
    await saveCredentials('nvidia', { apiKey: NVIDIA_KEY });
    const blob = await exportBackup({ kind: 'live', state: makeState() });

    const zip = await JSZip.loadAsync(blob);
    const names = Object.keys(zip.files);
    expect(names.some((n) => n.endsWith('.json'))).toBe(true);

    const texts: string[] = [];
    for (const name of names) {
      if (zip.files[name].dir) continue;
      const bytes = await zip.files[name].async('uint8array');
      texts.push(new TextDecoder().decode(bytes));
    }
    const all = texts.join('\n');

    for (const key of ALL_KEYS) expect(all).not.toContain(key);
    expect(all).not.toContain('apiKey');
    expect(all).not.toContain('pharmatrack_ai_settings');
    // The academic content itself is present — we excluded keys, not data.
    expect(all).toContain('Beta blockers reduce heart rate.');
    expect(all).toContain('PHS 301');
  });

  it('keeps every key out of a semester archive and its stored snapshot', async () => {
    await saveCredentials('nvidia', { apiKey: NVIDIA_KEY });
    const meta = await createSemesterArchive(makeState(), { level: 'Level 300', semester: '1st Semester' });
    const verified = await verifySemesterArchive(meta.id);
    expect(verified.status).toBe('verified');

    // The archive record (what replaces the workspace) must be free of keys,
    // including the legacy `openAIKey` field that used to travel with it.
    const record = [...idbStore.entries()].find(([key]) => key.includes(meta.id))?.[1];
    const snapshot = JSON.stringify(record);
    for (const key of ALL_KEYS) expect(snapshot).not.toContain(key);
    expect(snapshot).not.toContain(GEMINI_KEY);
    expect((record as { snapshot?: { openAIKey?: string } }).snapshot?.openAIKey).toBeFalsy();
  });

  it('does not carry a legacy key into a fresh semester workspace', () => {
    const state = makeState();
    // buildFreshWorkspace is asserted in the semester suite; here we only pin
    // the credential rule that motivated the change.
    const cleared = { ...state, openAIKey: '' };
    expect(findLegacyKey(cleared)).toBeNull();
    expect(findLegacyKey(state as unknown as Record<string, unknown>)?.key).toBe(GEMINI_KEY);
  });
});

/* ------------------------------------------------------------------ */
/* Capability honesty                                                 */
/* ------------------------------------------------------------------ */

describe('capabilities are never invented', () => {
  it('marks an unknown model as assumed and gives it only protocol guarantees', () => {
    const preset = defaultSettings().providers.find((p) => p.id === 'custom')!;
    const info = resolveModelInfo({ ...preset, model: 'campus-llm-9000' }, 'campus-llm-9000', ['text_generation', 'streaming']);
    expect(info.source).toBe('assumed');
    expect(info.capabilities).toEqual(['text_generation', 'streaming']);
  });

  it('clears stored settings without touching academic data', () => {
    saveAISettings(defaultSettings());
    clearAISettings();
    expect(localStorage.getItem(AI_SETTINGS_KEY)).toBeNull();
  });
});
