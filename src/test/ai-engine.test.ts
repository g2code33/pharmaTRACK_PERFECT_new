/**
 * PharmaTRACK AI Engine — provider-independent behaviour.
 *
 * Everything here talks to the engine the way the UI does (AIManager), and the
 * network is mocked at the `fetch` boundary, so these tests assert what actually
 * goes on the wire and what comes back — not what an SDK would have done.
 *
 * Covered (per the v4 spec):
 *  - per-adapter request shape: NVIDIA/OpenAI/Groq/OpenRouter/Mistral/custom
 *    (openai-compatible), Gemini, Anthropic
 *  - key placement (headers, never the URL), model and base URL selection
 *  - invalid key / invalid model / rate limit / timeout / outage / offline /
 *    malformed + empty response, each normalised to one category
 *  - retry, fallback (visible, with reason), fallback disabled, cancellation
 *  - capability routing, provider switching, streaming vs non-streaming
 *  - Test Connection and model discovery (with manual fallback)
 *  - context building (only what the request needs) + token budget
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  AIManager,
  AIEngineError,
  buildContext,
  buildTaskRequest,
  estimateTokens,
  looksLikeApiKey,
  normalizeSettings,
  defaultSettings,
  profileById,
  resolveModelInfo,
  adapterFor,
  presetFor,
  withPriority,
  findLegacyKey,
  migrateLegacySettings,
  stripCredentials,
  type AISettings,
  type ProviderId,
} from '../ai';

/* ------------------------------------------------------------------ */
/* Harness                                                            */
/* ------------------------------------------------------------------ */

interface Recorded {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | null;
}

const calls: Recorded[] = [];
let handler: (url: string, init: RequestInit) => Response | Promise<Response>;

function sse(events: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Gemini-style completion payload. */
const geminiBody = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

/** OpenAI-style completion payload. */
const openAiBody = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
  usage: { prompt_tokens: 12, completion_tokens: 34 },
});

beforeEach(() => {
  calls.length = 0;
  handler = () => json(openAiBody('ok'));
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    const raw = typeof init.body === 'string' ? init.body : null;
    calls.push({ url: target, init, body: raw ? JSON.parse(raw) : null });
    return handler(target, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A settings object with the given providers enabled + keyed. */
function makeSettings(
  entries: Array<{ id: ProviderId; model: string; kind?: string; baseUrl?: string; streaming?: boolean; timeoutMs?: number; enabled?: boolean }>,
  patch: Partial<AISettings> = {},
): AISettings {
  const base = normalizeSettings(defaultSettings());
  const providers = base.providers.map((provider) => {
    const entry = entries.find((e) => e.id === provider.id);
    if (!entry) return { ...provider, enabled: false };
    return {
      ...provider,
      kind: (entry.kind as typeof provider.kind) ?? provider.kind,
      model: entry.model,
      baseUrl: entry.baseUrl ?? provider.baseUrl,
      streaming: entry.streaming ?? true,
      timeoutMs: entry.timeoutMs ?? provider.timeoutMs,
      enabled: entry.enabled ?? true,
    };
  });
  // Providers the user added themselves (custom OpenAI-compatible endpoints).
  for (const entry of entries) {
    if (base.providers.some((p) => p.id === entry.id)) continue;
    const kind = (entry.kind ?? 'custom') as (typeof base.providers)[number]['kind'];
    providers.push({
      ...presetFor(kind),
      id: entry.id,
      kind,
      label: entry.id,
      baseUrl: entry.baseUrl ?? presetFor(kind).baseUrl,
      model: entry.model,
      streaming: entry.streaming ?? true,
      timeoutMs: entry.timeoutMs ?? 60_000,
      enabled: entry.enabled ?? true,
    });
  }
  return { ...base, providers, ...patch };
}

function makeManager(
  settings: AISettings,
  creds: Record<string, { apiKey?: string; organization?: string; project?: string }>,
): AIManager {
  return new AIManager({
    loadSettings: () => settings,
    saveSettings: (next) => next,
    loadCreds: async () => creds,
  });
}

const ask = (question = 'What is the mechanism of action?') => ({
  messages: [
    { role: 'system' as const, content: 'You are a pharmacy tutor.' },
    { role: 'user' as const, content: question },
  ],
});

const NVIDIA_KEY = 'nvapi-abcdefghijklmnopqrstuvwxyz0123456789';
const GEMINI_KEY = 'AIzaSyTestKey0123456789abcdefghijklmnop';

/* ------------------------------------------------------------------ */
/* Provider adapters                                                  */
/* ------------------------------------------------------------------ */

describe('provider adapters — request shape', () => {
  it('speaks the OpenAI protocol to NVIDIA with the key in a header, never the URL', async () => {
    const manager = makeManager(
      makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }]),
      { nvidia: { apiKey: NVIDIA_KEY } },
    );

    const response = await manager.generate({ ...ask(), providerId: 'nvidia' });

    expect(response.content).toBe('ok');
    expect(response.providerId).toBe('nvidia');
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(calls[0].url).not.toContain(NVIDIA_KEY);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${NVIDIA_KEY}`);
    expect(calls[0].body).toMatchObject({ model: 'meta/llama-3.3-70b-instruct', stream: false });
  });

  it('serves every OpenAI-compatible provider from the same adapter', async () => {
    const manager = makeManager(
      makeSettings([
        { id: 'openai', model: 'gpt-4o-mini' },
        { id: 'groq', model: 'llama-3.3-70b-versatile' },
        { id: 'openrouter', model: 'meta-llama/llama-3.1-70b-instruct' },
        { id: 'mistral', model: 'mistral-large-latest' },
      ]),
      {
        openai: { apiKey: 'sk-openai-test-1234567890', organization: 'org_pharma', project: 'proj_track' },
        groq: { apiKey: 'gsk_groqkey1234567890' },
        openrouter: { apiKey: 'sk-or-openrouter-1234567890' },
        mistral: { apiKey: 'sk-mistral-1234567890' },
      },
    );

    const expected: Array<[ProviderId, string]> = [
      ['openai', 'https://api.openai.com/v1/chat/completions'],
      ['groq', 'https://api.groq.com/openai/v1/chat/completions'],
      ['openrouter', 'https://openrouter.ai/api/v1/chat/completions'],
      ['mistral', 'https://api.mistral.ai/v1/chat/completions'],
    ];

    for (const [id, url] of expected) {
      calls.length = 0;
      const response = await manager.generate({ ...ask(), providerId: id });
      expect(response.providerId).toBe(id);
      expect(calls[0].url).toBe(url);
      // No provider identity leaks into the shared adapter's request logic.
      expect(adapterFor((await manager.provider(id))!).protocol).toBe('openai-compatible');
    }

    calls.length = 0;
    await manager.generate({ ...ask(), providerId: 'openai' });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['OpenAI-Organization']).toBe('org_pharma');
    expect(headers['OpenAI-Project']).toBe('proj_track');
  });

  it('uses the custom base URL for an OpenAI-compatible endpoint the user added', async () => {
    const manager = makeManager(
      makeSettings([{ id: 'um6p-gateway', kind: 'custom', model: 'pharma-llm-v2', baseUrl: 'https://ai.uni.example.edu/v1' }]),
      { 'um6p-gateway': { apiKey: 'sk-campus-1234567890' } },
    );

    const response = await manager.generate({ ...ask(), providerId: 'um6p-gateway' });
    expect(response.content).toBe('ok');
    expect(calls[0].url).toBe('https://ai.uni.example.edu/v1/chat/completions');
  });

  it('talks Gemini natively, with x-goog-api-key and no key in the query string', async () => {
    handler = () =>
      json({ candidates: [{ content: { parts: [{ text: 'Gemini says hi' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 } });
    const manager = makeManager(makeSettings([{ id: 'gemini', model: 'gemini-2.5-flash' }]), {
      gemini: { apiKey: GEMINI_KEY },
    });

    const response = await manager.generate({ ...ask(), providerId: 'gemini' });

    expect(response.content).toBe('Gemini says hi');
    expect(response.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(calls[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(calls[0].url).not.toContain(GEMINI_KEY);
    expect(calls[0].url).not.toContain('?key=');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe(GEMINI_KEY);
    // Gemini takes the system prompt out of band.
    expect(calls[0].body?.system_instruction).toMatchObject({ parts: [{ text: 'You are a pharmacy tutor.' }] });
  });

  it('talks Anthropic natively, moving system turns into the system field', async () => {
    handler = () => json({ content: [{ type: 'text', text: 'Claude says hi' }], usage: { input_tokens: 3, output_tokens: 4 } });
    const manager = makeManager(makeSettings([{ id: 'anthropic', model: 'claude-3-5-sonnet-latest' }]), {
      anthropic: { apiKey: 'sk-ant-api03-abcdefghijklmnop' },
    });

    const response = await manager.generate({ ...ask(), providerId: 'anthropic' });

    expect(response.content).toBe('Claude says hi');
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-api03-abcdefghijklmnop');
    expect(headers['anthropic-version']).toBeTruthy();
    expect(calls[0].body?.system).toBe('You are a pharmacy tutor.');
    expect((calls[0].body?.messages as unknown[]).length).toBe(1);
  });

  it('restricts the request model to the configured one — no hard-coded model anywhere', async () => {
    const settings = makeSettings([{ id: 'nvidia', model: 'nvidia/llama-3.1-nemotron-70b-instruct' }]);
    const manager = makeManager(settings, { nvidia: { apiKey: NVIDIA_KEY } });

    await manager.generate({ ...ask(), providerId: 'nvidia' });
    expect(calls[0].body?.model).toBe('nvidia/llama-3.1-nemotron-70b-instruct');

    calls.length = 0;
    await manager.generate({ ...ask(), providerId: 'nvidia', model: 'qwen/qwen2.5-72b-instruct' });
    expect(calls[0].body?.model).toBe('qwen/qwen2.5-72b-instruct');
  });
});

/* ------------------------------------------------------------------ */
/* Streaming                                                          */
/* ------------------------------------------------------------------ */

describe('streaming', () => {
  it('streams OpenAI-style deltas and reports provenance + usage', async () => {
    handler = () =>
      sse([
        'data: {"choices":[{"delta":{"content":"Beta"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" blockers"}}]}\n\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]);
    const manager = makeManager(makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }]), {
      nvidia: { apiKey: NVIDIA_KEY },
    });

    const deltas: string[] = [];
    const generator = manager.stream({ ...ask(), providerId: 'nvidia' });
    let chunk = await generator.next();
    while (!chunk.done) {
      deltas.push(chunk.value.text);
      chunk = await generator.next();
    }

    expect(deltas.join('')).toBe('Beta blockers');
    expect(chunk.value.content).toBe('Beta blockers');
    expect(chunk.value.streamed).toBe(true);
    expect(chunk.value.usage).toEqual({ inputTokens: 9, outputTokens: 2 });
    expect(calls[0].body?.stream).toBe(true);
    expect(calls[0].body?.stream_options).toEqual({ include_usage: true });
  });

  it('parses Gemini SSE events', async () => {
    handler = () =>
      sse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Alpha"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":" agonist"}]}}]}\n\n',
      ]);
    const manager = makeManager(makeSettings([{ id: 'gemini', model: 'gemini-2.5-flash' }]), {
      gemini: { apiKey: GEMINI_KEY },
    });

    const generator = manager.stream({ ...ask(), providerId: 'gemini' });
    let chunk = await generator.next();
    let text = '';
    while (!chunk.done) {
      text += chunk.value.text;
      chunk = await generator.next();
    }

    expect(text).toBe('Alpha agonist');
    expect(calls[0].url).toContain(':streamGenerateContent?alt=sse');
  });

  it('falls back to a single non-streaming response when the provider ignores stream:true', async () => {
    // A provider that answers `stream: true` with one plain JSON body has no
    // body stream at all — the adapters must still produce the answer.
    handler = () =>
      ({
        ok: true,
        status: 200,
        body: null,
        text: async () => JSON.stringify(openAiBody('whole answer at once')),
      }) as unknown as Response;
    const manager = makeManager(makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }]), {
      nvidia: { apiKey: NVIDIA_KEY },
    });

    const generator = manager.stream({ ...ask(), providerId: 'nvidia' });
    let chunk = await generator.next();
    let text = '';
    while (!chunk.done) {
      text += chunk.value.text;
      chunk = await generator.next();
    }
    expect(text).toBe('whole answer at once');
    expect(chunk.value.content).toBe('whole answer at once');
  });

  it('does not stream when the provider configuration says streaming is off', async () => {
    const manager = makeManager(
      makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct', streaming: false }]),
      { nvidia: { apiKey: NVIDIA_KEY } },
    );

    const response = await manager.generate({ ...ask(), providerId: 'nvidia', stream: true });
    expect(response.streamed).toBe(false);
    expect(calls[0].body?.stream).toBe(false);
  });

  it('Stop aborts the live request instead of only hiding the output', async () => {
    let seenSignal: AbortSignal | undefined;
    handler = (_url, init) => {
      seenSignal = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };
    const manager = makeManager(makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }]), {
      nvidia: { apiKey: NVIDIA_KEY },
    });

    const runId = 'run_stop_me';
    const pending = manager.generate({ ...ask(), providerId: 'nvidia', runId });
    await vi.waitFor(() => expect(seenSignal).toBeDefined());

    expect(manager.cancel(runId)).toBe(true);
    await expect(pending).rejects.toMatchObject({ category: 'USER_CANCELLED' });
    expect(seenSignal?.aborted).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Errors, retry, fallback                                            */
/* ------------------------------------------------------------------ */

describe('error normalisation', () => {
  const cases: Array<{ name: string; respond: () => Response | Promise<Response>; category: string }> = [
    { name: 'invalid key', respond: () => json({ error: { message: 'Invalid API key provided' } }, 401), category: 'AUTHENTICATION' },
    { name: 'invalid model', respond: () => json({ error: { message: 'model not found: gpt-9' } }, 404), category: 'MODEL_UNAVAILABLE' },
    { name: 'rate limit', respond: () => json({ error: { message: 'Rate limit reached' } }, 429, { 'retry-after': '30' }), category: 'RATE_LIMIT' },
    { name: 'provider outage', respond: () => json({ error: { message: 'upstream is down' } }, 503), category: 'PROVIDER_ERROR' },
    { name: 'rejected request', respond: () => json({ error: { message: 'unsupported parameter' } }, 400), category: 'INVALID_REQUEST' },
    { name: 'offline / DNS failure', respond: () => { throw new TypeError('Failed to fetch'); }, category: 'NETWORK' },
    {
      name: 'malformed but 200',
      respond: () => json({ choices: [] }),
      category: 'PROVIDER_ERROR',
    },
    {
      name: 'not JSON at all',
      respond: () => new Response('<html>bad gateway</html>', { status: 502 }),
      category: 'PROVIDER_ERROR',
    },
  ];

  it.each(cases)('maps $name to $category', async ({ respond, category }) => {
    handler = respond;
    const manager = makeManager(makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }]), {
      nvidia: { apiKey: NVIDIA_KEY },
    });

    const error = (await manager
      .generate({ ...ask(), providerId: 'nvidia' })
      .catch((err) => err)) as AIEngineError;

    expect(error).toBeInstanceOf(AIEngineError);
    expect(error.category).toBe(category);
    const report = error.toReport();
    expect(report.reason.length).toBeGreaterThan(0);
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it('reports an actionable reason and check-list for a rejected key', async () => {
    handler = () => json({ error: { message: `Invalid API key ${NVIDIA_KEY}` } }, 401);
    const manager = makeManager(makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }]), {
      nvidia: { apiKey: NVIDIA_KEY },
    });

    const error = (await manager
      .generate({ ...ask(), providerId: 'nvidia' })
      .catch((err) => err)) as AIEngineError;
    const report = error.toReport();

    expect(report.title).toBe('NVIDIA — Authentication failed');
    expect(report.reason).toContain('Authentication failed');
    expect(report.checks.join(' | ')).toContain('API key');
    // The provider echoed our key back — it must not survive into the report.
    expect(report.reason).not.toContain(NVIDIA_KEY);
    expect(JSON.stringify(report)).not.toContain(NVIDIA_KEY);
    expect(looksLikeApiKey(NVIDIA_KEY)).toBe(true);
  });

  it('treats a 200 with no content as a failure rather than an empty answer', async () => {
    handler = () => json({ choices: [{ message: { content: '   ' } }] });
    const manager = makeManager(makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }]), {
      nvidia: { apiKey: NVIDIA_KEY },
    });

    const error = (await manager
      .generate({ ...ask(), providerId: 'nvidia' })
      .catch((err) => err)) as AIEngineError;
    expect(error.category).toBe('PROVIDER_ERROR');
  });
});

describe('retry, fallback and switching', () => {
  it('retries a rate-limited provider, then succeeds', async () => {
    let attempt = 0;
    handler = () => {
      attempt += 1;
      return attempt === 1 ? json({ error: { message: 'rate limited' } }, 429) : json(openAiBody('second try worked'));
    };
    const manager = makeManager(makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }]), {
      nvidia: { apiKey: NVIDIA_KEY },
    });

    const response = await manager.generate({ ...ask(), providerId: 'nvidia', runId: 'retry-run' });
    expect(response.content).toBe('second try worked');
    expect(response.attempts).toHaveLength(1);
    expect(response.attempts[0].ok).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('does not retry an authentication failure — it switches instead', async () => {
    handler = () => json({ error: { message: 'invalid api key' } }, 401);
    const manager = makeManager(makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }]), {
      nvidia: { apiKey: NVIDIA_KEY },
    });

    await expect(manager.generate({ ...ask(), providerId: 'nvidia' })).rejects.toMatchObject({
      category: 'AUTHENTICATION',
    });
    expect(calls).toHaveLength(1);
  });

  it('falls back from NVIDIA to Gemini and says so, with the reason', async () => {
    handler = (url) =>
      url.includes('nvidia')
        ? json({ error: { message: 'API key not valid' } }, 403)
        : json({ candidates: [{ content: { parts: [{ text: 'Gemini answered instead' }] } }] });
    const manager = makeManager(
      makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }, { id: 'gemini', model: 'gemini-2.5-flash' }], {
        activeProfileId: 'default',
      }),
      { nvidia: { apiKey: NVIDIA_KEY }, gemini: { apiKey: GEMINI_KEY } },
    );

    const response = await manager.generate(ask());

    expect(response.providerId).toBe('gemini');
    expect(response.requestedProvider).toBe('nvidia');
    expect(response.fallback).toMatchObject({
      requestedProvider: 'nvidia',
      usedProvider: 'gemini',
      reason: 'AUTHENTICATION',
    });
    expect(response.fallback?.message).toBe('NVIDIA unavailable. Switched to Google Gemini fallback.');
    // Both providers were genuinely tried, in order.
    expect(response.attempts.map((a) => a.providerId)).toEqual(['nvidia', 'gemini']);
    expect(response.attempts[1].ok).toBe(true);
  });

  it('still fails over when the caller names the provider explicitly (as the UI does)', async () => {
    handler = (url) => (url.includes('nvidia') ? json({ error: { message: 'invalid api key' } }, 401) : json(geminiBody('gemini took over')));
    const manager = makeManager(
      makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }, { id: 'gemini', model: 'gemini-2.5-flash' }]),
      { nvidia: { apiKey: NVIDIA_KEY }, gemini: { apiKey: GEMINI_KEY } },
    );

    const response = await manager.generate({ ...ask(), providerId: 'nvidia' });

    expect(response.providerId).toBe('gemini');
    expect(response.requestedProvider).toBe('nvidia');
    expect(response.fallback?.message).toBe('NVIDIA unavailable. Switched to Google Gemini fallback.');
  });

  it('honours the profile order and never silently hides a switch', async () => {
    handler = (url) => (url.includes('groq') ? json(openAiBody('groq answered')) : json({ error: { message: 'down' } }, 500));
    const settings = makeSettings(
      [
        { id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' },
        { id: 'groq', model: 'llama-3.3-70b-versatile' },
      ],
      { automaticFallback: true },
    );
    // Primary = nvidia, first fallback = groq.
    settings.profiles = settings.profiles.map((profile) =>
      profile.id === 'default' ? { ...profile, providerId: 'nvidia', fallbacks: ['groq'] } : profile,
    );
    const manager = makeManager(settings, { nvidia: { apiKey: NVIDIA_KEY }, groq: { apiKey: 'gsk_groq1234567890' } });

    const response = await manager.generate(ask());
    expect(response.providerId).toBe('groq');
    expect(response.fallback?.message).toContain('Switched to Groq fallback');
    expect(calls.map((c) => (c.url.includes('groq') ? 'groq' : 'nvidia'))).toContain('nvidia');
  });

  it('stops at the failure when the user disables fallback', async () => {
    handler = () => json({ error: { message: 'API key not valid' } }, 401);
    const settings = makeSettings(
      [{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }, { id: 'gemini', model: 'gemini-2.5-flash' }],
      { automaticFallback: false },
    );
    settings.profiles = settings.profiles.map((profile) =>
      profile.id === 'default' ? { ...profile, providerId: 'nvidia', useFallback: false } : profile,
    );
    const manager = makeManager(settings, { nvidia: { apiKey: NVIDIA_KEY }, gemini: { apiKey: GEMINI_KEY } });

    await expect(manager.generate(ask())).rejects.toMatchObject({ category: 'AUTHENTICATION' });
    // Only NVIDIA was contacted — Gemini was not used behind the student's back.
    expect(calls.every((c) => c.url.includes('nvidia'))).toBe(true);
  });

  it('reports a switched-away provider in the chat provenance line', async () => {
    handler = (url) =>
      url.includes('nvidia') ? json({ error: { message: 'invalid api key' } }, 401) : json(geminiBody('hi from gemini'));
    const manager = makeManager(
      makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }, { id: 'gemini', model: 'gemini-2.5-flash' }]),
      { nvidia: { apiKey: NVIDIA_KEY }, gemini: { apiKey: GEMINI_KEY } },
    );

    const response = await manager.generate(ask());
    expect(`${response.providerId.toUpperCase()} • ${response.model}`).toBe('GEMINI • gemini-2.5-flash');
    expect(response.fallback?.attempts.join(' ')).toContain('nvidia');
  });

  it('times out a provider that never answers and can still fall back', async () => {
    handler = (url, init) => {
      if (url.includes('nvidia')) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('timeout');
            error.name = 'AbortError';
            reject(error);
          });
        });
      }
      return json(geminiBody('gemini after timeout'));
    };
    const manager = makeManager(
      makeSettings([
        { id: 'nvidia', model: 'meta/llama-3.3-70b-instruct', timeoutMs: 10 },
        { id: 'gemini', model: 'gemini-2.5-flash' },
      ]),
      { nvidia: { apiKey: NVIDIA_KEY }, gemini: { apiKey: GEMINI_KEY } },
    );

    const response = await manager.generate(ask());
    expect(response.providerId).toBe('gemini');
    expect(response.fallback?.reason).toBe('TIMEOUT');
  });

  it('says exactly what to fix when nothing can answer', async () => {
    const manager = makeManager(makeSettings([], {}), {});
    const error = (await manager.generate(ask()).catch((err) => err)) as AIEngineError;
    const report = error.toReport();
    expect(report.reason).toContain('No AI provider is configured');
    expect(report.checks.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Capability routing                                                 */
/* ------------------------------------------------------------------ */

describe('capability routing', () => {
  it('picks a vision-capable provider for an image question', async () => {
    handler = (url) => (url.includes('gemini') ? json({ candidates: [{ content: { parts: [{ text: 'I can see the diagram' }] } }] }) : json(openAiBody('no vision here')));
    const manager = makeManager(
      makeSettings([
        { id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' },
        { id: 'gemini', model: 'gemini-2.5-flash' },
      ]),
      { nvidia: { apiKey: NVIDIA_KEY }, gemini: { apiKey: GEMINI_KEY } },
    );

    const response = await manager.generate({
      ...ask('What does this labelled diagram show?'),
      capability: 'vision',
      images: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
    });

    expect(response.providerId).toBe('gemini');
    expect(calls[0].url).toContain('gemini');
    const parts = (calls[0].body?.contents as Array<{ parts: unknown[] }>)[0].parts;
    expect(parts.length).toBe(2);
  });

  it('routes long-context work to a large-window model when one is configured', async () => {
    const manager = makeManager(
      makeSettings([
        { id: 'groq', model: 'gemma-2-9b-it' },
        { id: 'gemini', model: 'gemini-2.5-pro' },
      ]),
      { groq: { apiKey: 'gsk_groq1234567890' }, gemini: { apiKey: GEMINI_KEY } },
    );

    const { chain } = await manager.resolveChain({
      messages: ask().messages,
      capability: 'long_context',
    });

    expect(chain.map((c) => c.id)).toEqual(['gemini']);
  });

  it('never invents capabilities for an unknown model', () => {
    const preset = { ...presetFor('custom'), model: 'mystery-model-v0' };
    const info = resolveModelInfo(preset, 'mystery-model-v0', ['text_generation', 'streaming']);
    expect(info.source).toBe('assumed');
    expect(info.capabilities).toEqual(['text_generation', 'streaming']);
    expect(info.capabilities).not.toContain('vision');
  });
});

/* ------------------------------------------------------------------ */
/* Test Connection + models                                           */
/* ------------------------------------------------------------------ */

describe('test connection', () => {
  it('passes all four checks for a working provider', async () => {
    handler = (url) => (url.includes('/models') ? json({ data: [{ id: 'meta/llama-3.3-70b-instruct' }] }) : json(openAiBody('OK')));
    const manager = makeManager(makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }]), {
      nvidia: { apiKey: NVIDIA_KEY },
    });

    const result = await manager.testConnection('nvidia');
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual(['Endpoint', 'API key', 'Model availability', 'Generation']);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(result.sample).toBe('OK');
  });

  it('fails the key check without pretending the model is broken', async () => {
    handler = () => json({ error: { message: 'invalid api key' } }, 401);
    const manager = makeManager(makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }]), {
      nvidia: { apiKey: NVIDIA_KEY },
    });

    const result = await manager.testConnection('nvidia');
    expect(result.ok).toBe(false);
    expect(result.error?.category).toBe('AUTHENTICATION');
    expect(result.error?.checks.join(' ')).toContain('API key');
    expect(JSON.stringify(result)).not.toContain(NVIDIA_KEY);
  });

  it('flags a model the provider does not offer, and still tries to generate', async () => {
    handler = (url) =>
      url.includes('/models')
        ? json({ data: [{ id: 'meta/llama-3.3-70b-instruct' }] })
        : json({ error: { message: 'model not found' } }, 404);
    const manager = makeManager(makeSettings([{ id: 'nvidia', model: 'gpt-9-ultra' }]), {
      nvidia: { apiKey: NVIDIA_KEY },
    });

    const result = await manager.testConnection('nvidia');
    const modelCheck = result.checks.find((c) => c.name === 'Model availability');
    expect(modelCheck?.ok).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error?.category).toBe('MODEL_UNAVAILABLE');
  });

  it('skips straight to a report when the provider is not configured', async () => {
    const manager = makeManager(makeSettings([]), {});
    const result = await manager.testConnection('mistral');
    expect(result.ok).toBe(false);
    expect(result.error?.reason.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });
});

describe('model discovery', () => {
  it('reads the OpenAI-compatible model list', async () => {
    handler = () => json({ data: [{ id: 'meta/llama-3.3-70b-instruct' }, { id: 'nvidia/nemotron-4-340b-instruct' }] });
    const manager = makeManager(makeSettings([{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }]), {
      nvidia: { apiKey: NVIDIA_KEY },
    });

    const models = await manager.listModels('nvidia');
    expect(models.map((m) => m.id)).toEqual(['meta/llama-3.3-70b-instruct', 'nvidia/nemotron-4-340b-instruct']);
    expect(models[0].source).toBe('provider');
  });

  it('reads the Gemini model list and strips the models/ prefix', async () => {
    handler = () => json({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] }] });
    const manager = makeManager(makeSettings([{ id: 'gemini', model: 'gemini-2.5-flash' }]), {
      gemini: { apiKey: GEMINI_KEY },
    });

    const models = await manager.listModels('gemini');
    expect(models[0]).toMatchObject({ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1048576 });
  });

  it('returns nothing (manual model ids) when the provider cannot list models', async () => {
    const manager = makeManager(makeSettings([{ id: 'custom', kind: 'custom', model: 'pharma-llm', baseUrl: 'https://ai.example.edu/v1' }]), {
      custom: { apiKey: 'sk-custom-1234567890' },
    });
    handler = () => json({ error: { message: 'not implemented' } }, 404);
    const models = await manager.listModels('custom').catch(() => []);
    expect(models).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Context + tasks                                                    */
/* ------------------------------------------------------------------ */

describe('academic context', () => {
  const state = {
    student: { level: 'Level 300', semester: '1st Semester', program: 'Pharm.D' },
    courses: [{ id: 'c1', courseCode: 'PHS 301', courseName: 'Pharmacology' }],
    topics: [{ id: 't1', courseId: 'c1', topicName: 'Autonomic Pharmacology' }],
    slides: [
      {
        id: 'm1',
        topicId: 't1',
        title: 'Lecture 4 — Autonomic Pharmacology',
        fileType: 'pdf',
        contentText: 'page one text\n--- Slide 23 ---\nBeta blockers reduce heart rate.',
      },
    ],
    learningObjectives: [{ id: 'o1', courseId: 'c1', topicId: 't1', objectiveText: 'Describe beta blocker action', status: 'partial' }],
    notes: [{ id: 'n1', topicId: 't1', noteText: 'Remember: beta-1 is cardiac.' }],
    quizHistory: [{ courseId: 'c1', scorePercentage: 62, weakTopics: ['t1'], completedAt: '2026-03-01T10:00:00.000Z', answersGiven: [{ isCorrect: false }, { isCorrect: true }] }],
    studyPlans: [{ courseId: 'c1', date: '2026-03-04', timeSlot: '18:00', activityType: 'revision', notes: 'Beta blockers', isCompleted: false }],
    examQuestions: [
      {
        id: 'q1',
        courseId: 'c1',
        topicId: 't1',
        questionText: 'Which receptor does propranolol block?',
        questionType: 'mcq',
        difficulty: 'medium',
        correctAnswer: 'Beta-1 adrenergic receptor',
      },
      {
        id: 'q2',
        courseId: 'c1',
        topicId: 't1',
        questionText: 'An unselected question that must never be sent.',
        questionType: 'mcq',
        difficulty: 'easy',
        correctAnswer: 'Never sent',
      },
    ],
  };

  it('sends the selected page/slide and identifies its source', () => {
    const bundle = buildContext(state, {
      courseId: 'c1',
      topicId: 't1',
      materialId: 'm1',
      page: 23,
      materialText: {
        label: 'Lecture 4 — Autonomic Pharmacology',
        text: 'Beta blockers reduce heart rate.',
        page: 23,
      },
    });

    const labels = bundle.blocks.map((b) => b.label).join(' | ');
    expect(labels).toContain('Lecture 4 — Autonomic Pharmacology');
    expect(bundle.sources.some((s) => s.kind === 'page' && s.page === 23)).toBe(true);
    const material = bundle.blocks.find((b) => b.source.kind === 'page' || b.source.kind === 'material');
    expect(material?.text).toContain('Beta blockers reduce heart rate.');
  });

  it('sends only the selection when asked a question about a highlighted phrase', () => {
    const bundle = buildContext(state, {
      topicId: 't1',
      materialId: 'm1',
      selection: 'Beta blockers reduce heart rate.',
    });
    const selection = bundle.sources.find((s) => s.kind === 'selection');
    expect(selection).toBeDefined();
  });

  it('never dumps the whole database — quiz and plan summaries stay compact', () => {
    const bundle = buildContext(state, { topicId: 't1', courseId: 'c1', includePerformance: true, includePlan: true });
    const text = bundle.blocks.map((b) => b.text).join('\n');
    expect(text).toContain('62%');
    expect(text).toContain('Weak topics flagged');
    expect(text.length).toBeLessThan(6000);
    expect(estimateTokens(text)).toBeLessThan(2000);
  });

  it('truncates and warns instead of blowing the model limit', () => {
    const huge = 'x'.repeat(200_000);
    const bundle = buildContext(
      state,
      { topicId: 't1', materialId: 'm1', materialText: { label: 'Huge deck', text: huge } },
      2000,
    );
    expect(bundle.truncated).toBe(true);
    expect(bundle.warnings.join(' ')).toMatch(/truncat|context/i);
    expect(estimateTokens(bundle.blocks.map((b) => b.text).join('\n'))).toBeLessThanOrEqual(2100);
  });

  it('frames a task request with the profile instructions, the context and the question', () => {
    const bundle = buildContext(state, { topicId: 't1', materialId: 'm1', page: 23 });
    const request = buildTaskRequest({
      task: 'explain',
      question: 'Explain beta blockers.',
      context: bundle,
      profile: profileById(defaultSettings().profiles, 'study'),
    });

    expect(request.messages[0].role).toBe('system');
    expect(request.messages[0].content).toContain('pharmacy tutor');
    expect(request.messages[request.messages.length - 1]).toMatchObject({ role: 'user', content: 'Explain beta blockers.' });
    expect(request.messages.map((m) => m.content).join(' ')).toContain('--- ');
    expect(request.profileId).toBe('study');
  });

  it('generates questions linked to the course, topic and material they came from', () => {
    const bundle = buildContext(state, {
      courseId: 'c1',
      topicId: 't1',
      materialId: 'm1',
      page: 23,
      materialText: {
        label: 'Lecture 4 — Autonomic Pharmacology',
        text: 'Beta blockers reduce heart rate.',
        page: 23,
      },
    });
    const request = buildTaskRequest({
      task: 'questions-from-material',
      question: 'Write 3 MCQs on this slide.',
      context: bundle,
      profile: profileById(defaultSettings().profiles, 'quiz'),
    });
    const text = request.messages.map((m) => m.content).join('\n');
    expect(request.capability).toBe('text_generation');
    expect(text).toContain('PHS 301');
    expect(text).toContain('Autonomic Pharmacology');
    expect(text).toContain('Lecture 4 — Autonomic Pharmacology');
  });

  it('sends only the bank questions the student selected, with their answers', () => {
    const bundle = buildContext(state, { topicId: 't1', courseId: 'c1', questionIds: ['q1'] });
    const block = bundle.blocks.find((b) => b.source.kind === 'question');
    expect(block?.label).toBe('Selected questions');
    expect(block?.text).toContain('Which receptor does propranolol block?');
    expect(block?.text).toContain('Beta-1 adrenergic receptor');
    const sent = bundle.blocks.map((b) => b.text).join('\n');
    expect(sent).not.toContain('An unselected question');
  });

  it('sends stems without answers when a whole topic is in scope', () => {
    const bundle = buildContext(state, { topicId: 't1', courseId: 'c1', includeQuestions: true });
    const block = bundle.blocks.find((b) => b.source.kind === 'question');
    expect(block?.text).toContain('Which receptor does propranolol block?');
    expect(block?.text).not.toContain('Beta-1 adrenergic receptor');
  });
});

/* ------------------------------------------------------------------ */
/* Multi-provider architecture                                        */
/* ------------------------------------------------------------------ */

describe('multi-provider architecture', () => {
  it('answers from a local server that needs no API key', async () => {
    handler = () => json(openAiBody('answered on this device'));
    const manager = makeManager(
      makeSettings([{ id: 'local', kind: 'local', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' }]),
      {},
    );

    const response = await manager.generate({ ...ask(), providerId: 'local' });

    expect(response.providerId).toBe('local');
    expect(response.model).toBe('llama3.1');
    expect(calls[0].url).toContain('localhost:11434/v1/chat/completions');
    // Nothing to leak: the credential header is empty and no key was stored.
    expect(String((calls[0].init.headers as Record<string, string>).Authorization)).toBe('Bearer ');
  });

  it('keeps several providers configured at once and ranks them by priority', () => {
    const settings = makeSettings([
      { id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' },
      { id: 'gemini', model: 'gemini-2.5-flash' },
      { id: 'groq', model: 'llama-3.3-70b-versatile' },
    ]);

    const normalized = normalizeSettings(settings);
    expect(normalized.providerPriority.slice(0, 3)).toEqual(['nvidia', 'gemini', 'groq']);
    expect(normalized.providers.find((p) => p.id === 'nvidia')?.priority).toBe(1);
    expect(normalized.providers.find((p) => p.id === 'groq')?.priority).toBe(3);

    const reordered = withPriority(normalized, ['groq', 'nvidia', 'gemini']);
    expect(reordered.providers.find((p) => p.id === 'groq')?.priority).toBe(1);
    expect(reordered.providers.find((p) => p.id === 'gemini')?.priority).toBe(3);
    // Every provider still has a rank, so none can drop out of routing.
    expect(reordered.providers.every((p) => typeof p.priority === 'number')).toBe(true);
  });

  it('lets a fallback answer with its own model, never the primary’s', async () => {
    handler = (url) =>
      url.includes('nvidia')
        ? json({ error: { message: 'API key not valid' } }, 403)
        : json(geminiBody('Gemini answered instead'));
    const settings = makeSettings(
      [{ id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }, { id: 'gemini', model: 'gemini-2.5-flash' }],
      {
        profiles: defaultSettings().profiles.map((p) =>
          p.id === 'default'
            ? { ...p, providerId: 'nvidia', model: 'meta/llama-3.3-70b-instruct' }
            : p,
        ),
      },
    );
    const manager = makeManager(settings, {
      nvidia: { apiKey: NVIDIA_KEY },
      gemini: { apiKey: GEMINI_KEY },
    });

    const response = await manager.generate({
      ...ask(),
      providerId: 'nvidia',
      model: 'meta/llama-3.3-70b-instruct',
    });

    expect(response.providerId).toBe('gemini');
    expect(response.model).toBe('gemini-2.5-flash');
    const geminiCall = calls.find((c) => c.url.includes('generativelanguage'));
    expect(geminiCall?.url).toContain('gemini-2.5-flash');
    expect(geminiCall?.url).not.toContain('llama');
  });

  it('routes a capability request to the first enabled provider that establishes it', async () => {
    handler = (url) =>
      url.includes('generativelanguage') ? json(geminiBody('vision answer')) : json(openAiBody('vision answer'));
    const manager = makeManager(
      makeSettings([
        { id: 'nvidia', model: 'meta/llama-3.3-70b-instruct' },
        { id: 'gemini', model: 'gemini-2.5-flash' },
      ]),
      { nvidia: { apiKey: NVIDIA_KEY }, gemini: { apiKey: GEMINI_KEY } },
    );

    const response = await manager.generate({ ...ask(), capability: 'vision' });

    // Neither llama-3.3-70b nor the OpenAI-compatible baseline claims vision,
    // so the engine picks Gemini, whose registry entry does.
    expect(response.providerId).toBe('gemini');
  });

  it('tests a keyless local connection without reporting a missing key', async () => {
    handler = (url) =>
      String(url).endsWith('/models') ? json({ data: [{ id: 'llama3.1' }] }) : json(openAiBody('OK'));
    const manager = makeManager(
      makeSettings([{ id: 'local', kind: 'local', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' }]),
      {},
    );

    const result = await manager.testConnection('local');

    expect(result.ok).toBe(true);
    const keyCheck = result.checks.find((c) => c.name === 'API key');
    expect(keyCheck?.ok).toBe(true);
    expect(keyCheck?.detail).toContain('No key needed');
    expect(result.checks.find((c) => c.name === 'Model availability')?.ok).toBe(true);
    expect(result.checks.find((c) => c.name === 'Generation')?.ok).toBe(true);
  });

  it('migrates a legacy single key into the provider architecture without losing it', () => {
    const legacyKey = 'AIzaSyLegacyKey0123456789abcdefghijkl';
    const found = findLegacyKey({ courses: [], openAIKey: legacyKey });
    expect(found).toEqual({ field: 'openAIKey', key: legacyKey });

    const result = migrateLegacySettings(normalizeSettings(defaultSettings()), found!.key);

    expect(result.providerId).toBe('gemini');
    const provider = result.settings.providers.find((p) => p.id === 'gemini');
    expect(provider?.enabled).toBe(true);
    expect(provider?.apiKey).toBe(legacyKey);
    expect(provider?.migratedFrom).toBe('openAIKey');
    // Behaviour is unchanged: the default profile now points at that provider.
    expect(result.settings.profiles.find((p) => p.id === 'default')?.providerId).toBe('gemini');
    // What is persisted is key-free; the credential goes to its own store.
    expect(JSON.stringify(stripCredentials(result.settings.providers.find((p) => p.id === 'gemini')!))).not.toContain(
      legacyKey,
    );
  });

  it('serves two instances of the same protocol without either knowing about the other', async () => {
    handler = () => json(openAiBody('gateway answer'));
    const manager = makeManager(
      makeSettings([
        { id: 'gateway-a', kind: 'custom', model: 'pharma-llm-v2', baseUrl: 'https://ai.uni-a.example.edu/v1' },
        { id: 'gateway-b', kind: 'custom', model: 'pharma-llm-v3', baseUrl: 'https://ai.uni-b.example.edu/v1' },
      ]),
      { 'gateway-a': { apiKey: 'sk-a-abcdefghijklmnop' }, 'gateway-b': { apiKey: 'sk-b-abcdefghijklmnop' } },
    );

    const first = await manager.generate({ ...ask(), providerId: 'gateway-a' });
    const second = await manager.generate({ ...ask(), providerId: 'gateway-b' });

    expect(calls[0].url).toContain('uni-a.example.edu');
    expect(calls[0].body).toMatchObject({ model: 'pharma-llm-v2' });
    expect(calls[1].url).toContain('uni-b.example.edu');
    expect(calls[1].body).toMatchObject({ model: 'pharma-llm-v3' });
    // Each request is signed only with its own provider's key.
    expect(String((calls[0].init.headers as Record<string, string>).Authorization)).toBe('Bearer sk-a-abcdefghijklmnop');
    expect(String((calls[1].init.headers as Record<string, string>).Authorization)).toBe('Bearer sk-b-abcdefghijklmnop');
    expect(first.providerId).toBe('gateway-a');
    expect(second.providerId).toBe('gateway-b');
  });
});
