/**
 * PharmaTRACK AI Engine — the manager.
 *
 * Everything the app is allowed to do with AI goes through this object:
 *
 *   aiManager.generate()        one-shot completion (with routing + fallback)
 *   aiManager.stream()          streamed completion, cancellable
 *   aiManager.testConnection()  four-step check for a configured provider
 *   aiManager.listModels()      discovery, where the provider supports it
 *   aiManager.settings()        the current (key-free) configuration
 *
 * The manager owns: provider resolution, capability routing, the fallback chain,
 * timeouts, cancellation, retries, and turning every outcome into an
 * `AIResponse` + `attempts` trail so the UI can say *what actually happened*
 * ("NVIDIA unavailable. Switched to Gemini fallback.") instead of hiding it.
 */
import type {
  AIConnectionTest,
  AIChatTurn,
  AIFallbackNotice,
  AIProfile,
  AIRequest,
  AIResponse,
  AISettings,
  AIStatusEvent,
  AIStatusListener,
  AIStreamDelta,
  ModelInfo,
  ProviderConfig,
  ProviderId,
} from './types';
import { AIEngineError, normalizeError, reportFor } from './errors';
import { adapterFor, presetFor } from './providers';
import { resolveModelInfo } from './models';
import { profileById } from './profiles';
import { loadAllCredentials, loadCredentials } from './credentials';
import { loadAISettings, saveAISettings } from './settings';
import type { CallContext, ProviderAdapter } from './providers/base';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
/** Retries are only sensible for these categories, and only with backoff. */
const RETRY_BACKOFF_MS = 700;

export interface ManagerDeps {
  /** Overridable for tests; defaults to loadAISettings/loadAllCredentials. */
  loadSettings?: () => AISettings;
  saveSettings?: (settings: AISettings) => AISettings;
  loadCreds?: () => Promise<Record<string, { apiKey?: string; organization?: string; project?: string; headers?: Record<string, string> }>>;
}

/** Internal listener registry, so the UI can show "connecting → streaming". */
const listeners = new Set<AIStatusListener>();

export function onAIStatus(listener: AIStatusListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitStatus(event: AIStatusEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* a broken listener must never break a generation */
    }
  }
}

export class AIManager {
  private settings: AISettings;
  private credentials: Record<string, { apiKey?: string; organization?: string; project?: string; headers?: Record<string, string> }> = {};
  private credentialsLoaded = false;
  private deps: ManagerDeps;
  /** Live runs, so Stop can abort the exact request (spec §15). */
  private runs = new Map<string, AbortController>();

  constructor(deps: ManagerDeps = {}) {
    this.deps = deps;
    this.settings = (deps.loadSettings ?? loadAISettings)();
  }

  /* ---------------------------------------------------------------- */
  /* Settings + credentials                                            */
  /* ---------------------------------------------------------------- */

  /** Current configuration (never contains credentials). */
  getSettings(): AISettings {
    return this.settings;
  }

  /** Persists settings and keeps the in-memory copy in sync. */
  updateSettings(next: AISettings): AISettings {
    this.settings = (this.deps.saveSettings ?? saveAISettings)(next);
    return this.settings;
  }

  /** Reloads from storage (used after AI Settings writes directly). */
  reload(): AISettings {
    this.settings = (this.deps.loadSettings ?? loadAISettings)();
    this.credentialsLoaded = false;
    return this.settings;
  }

  /** Loads credentials into memory; called lazily so the AI screen is cheap. */
  async ensureCredentials(): Promise<void> {
    if (this.credentialsLoaded) return;
    this.credentials = this.deps.loadCreds ? await this.deps.loadCreds() : await loadAllCredentials();
    this.credentialsLoaded = true;
  }

  /** A provider config with its credentials attached, ready to call. */
  async provider(id: ProviderId): Promise<ProviderConfig | null> {
    await this.ensureCredentials();
    const base = this.settings.providers.find((p) => p.id === id);
    if (!base) return null;
    const creds = this.credentials[id] ?? {};
    return {
      ...base,
      apiKey: creds.apiKey,
      organization: creds.organization,
      project: creds.project,
      headers: creds.headers ? { ...base.headers, ...creds.headers } : base.headers,
    };
  }

  private get profile(): AIProfile {
    return profileById(this.settings.profiles, this.settings.activeProfileId);
  }

  /**
   * Providers that are enabled AND have a key (so they could actually answer),
   * with their credentials attached — the routing chain is built from these, so
   * this is the single place where a stored key is handed to an adapter.
   */
  async readyProviders(): Promise<ProviderConfig[]> {
    await this.ensureCredentials();
    const ready: ProviderConfig[] = [];
    for (const provider of this.settings.providers) {
      if (!provider.enabled) continue;
      const creds = this.credentials[provider.id] ?? {};
      if (!creds.apiKey) continue;
      ready.push({
        ...provider,
        apiKey: creds.apiKey,
        organization: creds.organization,
        project: creds.project,
        headers: creds.headers ? { ...provider.headers, ...creds.headers } : provider.headers,
      });
    }
    return ready;
  }

  /* ---------------------------------------------------------------- */
  /* Routing                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Decides which providers to try, in order:
   *   1. an explicit providerId on the request,
   *   2. a capability request → providers that establish it, in priority order,
   *   3. the selected profile's provider,
   * then appends the fallback chain (profile fallbacks → provider priority),
   * filtered to providers that can serve the requested capability.
   */
  async resolveChain(req: AIRequest): Promise<{ chain: ProviderConfig[]; reason: string }> {
    await this.ensureCredentials();
    const profile = req.profileId
      ? profileById(this.settings.profiles, req.profileId)
      : this.profile;
    const capability = req.capability;
    const ready = await this.readyProviders();
    const byId = new Map(ready.map((p) => [p.id, p]));

    const canServe = (config: ProviderConfig): boolean => {
      if (!capability) return true;
      const adapter = adapterFor(config);
      const info = resolveModelInfo(config, req.model ?? config.model, adapter.baselineCapabilities);
      return info.capabilities.includes(capability);
    };

    const chain: ProviderConfig[] = [];
    const push = (config: ProviderConfig | undefined) => {
      if (!config || !config.enabled || !byId.has(config.id)) return;
      if (!canServe(config)) return;
      if (!chain.some((c) => c.id === config.id)) chain.push(config);
    };

    let reason = '';
    if (req.providerId) {
      push(byId.get(req.providerId));
      reason = `requested provider ${req.providerId}`;
    } else if (capability) {
      // Capability routing: walk the user's priority order, not our preference.
      const priority = this.settings.providerPriority;
      const ordered = [...ready].sort(
        (a, b) => priorityIndex(priority, a.id) - priorityIndex(priority, b.id),
      );
      ordered.filter(canServe).forEach(push);
      reason = `capability “${capability}”`;
    } else {
      push(byId.get(profile.providerId));
      reason = `profile “${profile.name}”`;
    }

    // An explicit providerId names the *primary* choice — it does not opt out
    // of the fallback system. The UI sends the profile's provider explicitly
    // (so the answer matches the selected profile), and that must not disable
    // failover; only the user's own switches in AI Settings can do that.
    const wantsFallback = this.settings.automaticFallback && profile.useFallback;
    if (wantsFallback) {
      for (const id of profile.fallbacks) push(byId.get(id));
      const priority = this.settings.providerPriority;
      const rest = [...ready]
        .filter((p) => !profile.fallbacks.includes(p.id) && p.id !== profile.providerId)
        .sort((a, b) => priorityIndex(priority, a.id) - priorityIndex(priority, b.id));
      rest.forEach(push);
    }

    // Last resort: an explicit provider request still deserves the profile's
    // provider when the named one is not configured at all.
    if (!chain.length && !req.providerId) {
      for (const provider of ready) push(provider);
    }
    return { chain, reason };
  }

  /* ---------------------------------------------------------------- */
  /* Generation                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * One-shot (non-streaming) generation. Tries the chain in order, retries
   * transient failures on the same provider, and reports exactly what happened.
   */
  async generate(req: AIRequest): Promise<AIResponse> {
    const runId = req.runId ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const controller = req.signal ? null : new AbortController();
    const signal = req.signal ?? controller!.signal;
    this.runs.set(runId, controller ?? new AbortController());
    try {
      return await this.execute(req, { runId, signal, stream: false });
    } finally {
      this.runs.delete(runId);
    }
  }

  /**
   * Streamed generation. Yields deltas as they arrive; the returned generator's
   * `result` promise resolves with the full response (provenance, usage,
   * attempts) once the stream ends. Stop is real: the abort propagates into the
   * provider request, not just into the UI.
   */
  async *stream(
    req: AIRequest,
  ): AsyncGenerator<AIStreamDelta, AIResponse, void> {
    const runId = req.runId ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    this.runs.set(runId, controller);
    // An external signal (the caller's own AbortController) is forwarded.
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const signal = controller.signal;

    const queue: AIStreamDelta[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    let finalResponse: AIResponse | null = null;

    const wake = () => {
      notify?.();
      notify = null;
    };

    const run = this.execute({ ...req, stream: true }, {
      runId,
      signal,
      stream: true,
      onDelta: (delta) => {
        queue.push(delta);
        wake();
      },
    })
      .then((response) => {
        finalResponse = response;
      })
      .catch((err: unknown) => {
        finalResponse = {
          content: '',
          providerId: req.providerId ?? '',
          model: req.model ?? '',
          latencyMs: 0,
          streamed: true,
          attempts: [],
          requestedProvider: undefined,
          fallback: undefined,
          usage: undefined,
          error: err,
        } as AIResponse & { error: unknown };
      })
      .finally(() => {
        finished = true;
        wake();
      });

    try {
      for (;;) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      if (!finished) controller.abort();
      await run.catch(() => undefined);
      this.runs.delete(runId);
    }

    const response = finalResponse as (AIResponse & { error?: unknown }) | null;
    if (response && 'error' in response && response.error) throw response.error;
    if (!response) {
      throw new AIEngineError({ category: 'UNKNOWN', message: 'The AI run ended without a response.' });
    }
    return response;
  }

  /** Aborts a run by id (Stop button). */
  cancel(runId: string): boolean {
    const controller = this.runs.get(runId);
    if (!controller) return false;
    controller.abort();
    this.runs.delete(runId);
    return true;
  }

  cancelAll(): void {
    for (const controller of this.runs.values()) controller.abort();
    this.runs.clear();
  }

  get activeRuns(): string[] {
    return [...this.runs.keys()];
  }

  /* ---------------------------------------------------------------- */
  /* Connection testing + models                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Test Connection. Runs the same four checks for every provider — endpoint,
   * credentials, model availability, real generation — so the result means the
   * same thing whichever provider it is, and returns actionable detail instead
   * of a bare "Error".
   */
  async testConnection(providerId: ProviderId, model?: string): Promise<AIConnectionTest> {
    const config = await this.provider(providerId);
    const at = new Date().toISOString();
    if (!config) {
      return {
        providerId,
        model: model ?? '',
        ok: false,
        at,
        checks: [{ name: 'Provider', ok: false, detail: 'This provider is not configured.' }],
        error: reportFor(
          new AIEngineError({ category: 'INVALID_REQUEST', message: 'Provider not configured.', providerId }),
        ),
      };
    }
    const target = model ?? config.model;
    const adapter = adapterFor(config);
    const checks: AIConnectionTest['checks'] = [
      {
        name: 'Endpoint',
        ok: /^https?:\/\//i.test(config.baseUrl || presetFor(config.kind).baseUrl),
        detail: config.baseUrl || presetFor(config.kind).baseUrl || 'No base URL set',
      },
      { name: 'API key', ok: Boolean(config.apiKey), detail: config.apiKey ? 'Key present' : 'No API key set' },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
    const ctx = { config, model: target, signal: controller.signal } as CallContext;
    const started = Date.now();

    try {
      if (adapter.probe) {
        const probed = await adapter.probe(ctx);
        for (const checkResult of probed) {
          // Endpoint/key are already reported above — avoid duplicates.
          if (checkResult.name === 'Endpoint' || checkResult.name === 'API key') continue;
          checks.push(checkResult);
        }
      }

      // Step 4: does it actually generate? A key can be valid while the model
      // is not entitled, and only a real call proves that.
      const generation = await this.generate({
        messages: [
          { role: 'system', content: 'Reply with exactly: OK' },
          { role: 'user', content: 'Connection test.' },
        ],
        providerId,
        model: target,
        maxOutputTokens: 16,
        stream: false,
      });
      const sample = generation.content.trim().slice(0, 80);
      checks.push({ name: 'Generation', ok: true, detail: sample ? `Model replied: “${sample}”` : 'Model replied.' });
      const result: AIConnectionTest = {
        providerId,
        model: target,
        ok: checks.every((c) => c.ok),
        at,
        latencyMs: Date.now() - started,
        checks,
        sample,
      };
      this.recordTest(result);
      return result;
    } catch (err) {
      const error = err instanceof AIEngineError ? err : await normalizeError(err, { providerId, secrets: [config.apiKey] });
      checks.push({ name: 'Generation', ok: false, detail: error.message });
      const result: AIConnectionTest = {
        providerId,
        model: target,
        ok: false,
        at,
        latencyMs: Date.now() - started,
        checks,
        error: reportFor(error),
      };
      this.recordTest(result);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  private recordTest(result: AIConnectionTest): void {
    const next: AISettings = {
      ...this.settings,
      providers: this.settings.providers.map((p) => (p.id === result.providerId ? { ...p, lastTest: result } : p)),
    };
    this.updateSettings(next);
  }

  /** Model discovery where supported; returns [] when the provider can't list. */
  async listModels(providerId: ProviderId): Promise<ModelInfo[]> {
    const config = await this.provider(providerId);
    if (!config) return [];
    const adapter = adapterFor(config);
    if (!adapter.listModels) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
    try {
      return await adapter.listModels({ config, model: config.model, signal: controller.signal });
    } catch (err) {
      throw await normalizeError(err, { providerId, secrets: [config.apiKey] });
    } finally {
      clearTimeout(timeout);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Execution core                                                    */
  /* ---------------------------------------------------------------- */

  private async execute(
    req: AIRequest,
    opts: {
      runId: string;
      signal: AbortSignal;
      stream: boolean;
      onDelta?: (delta: AIStreamDelta) => void;
    },
  ): Promise<AIResponse> {
    const { chain, reason } = await this.resolveChain(req);
    const started = Date.now();
    const attempts: AIResponse['attempts'] = [];

    if (!chain.length) {
      const configured = this.settings.providers.filter((p) => p.enabled);
      const message = configured.length
        ? 'No provider in the fallback chain can serve this request. Check the API key and model in AI Settings.'
        : 'No AI provider is configured yet. Add one in Settings → AI.';
      const error = new AIEngineError({
        category: configured.length ? 'MODEL_UNAVAILABLE' : 'INVALID_REQUEST',
        message,
      });
      emitStatus({ runId: opts.runId, status: 'error', message });
      throw error;
    }

    const profile = req.profileId ? profileById(this.settings.profiles, req.profileId) : this.profile;
    let lastError: AIEngineError | null = null;
    // What the request "asked for": the named provider, the profile's provider,
    // or — when a profile is still unbound — whichever provider the engine tried
    // first. Without the last case a priority-order fallback would look like a
    // first attempt and the switch would go unreported.
    const requestedProvider = req.providerId || profile.providerId || chain[0]?.id;
    const requestedLabel = requestedProvider ? displayName(this.settings, requestedProvider) : '';

    for (const config of chain) {
      const model = req.model ?? (config.id === profile.providerId ? profile.model || config.model : config.model);
      const adapter = adapterFor(config);
      const attempt: AIResponse['attempts'][number] = { providerId: config.id, model, ok: false };

      // Retry transient failures on this provider; never retry auth or a
      // user cancellation, and never loop forever.
      for (let tryIndex = 0; tryIndex <= DEFAULT_MAX_RETRIES; tryIndex++) {
        const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const timer = new AbortController();
        const timedOut = { value: false };
        const timeout = setTimeout(() => {
          timedOut.value = true;
          timer.abort();
        }, timeoutMs);
        const linked = linkSignals(opts.signal, timer.signal);

        const ctx: CallContext = { config, model, signal: linked.signal };
        emitStatus({
          runId: opts.runId,
          status: 'connecting',
          providerId: config.id,
          model,
          message: tryIndex === 0 ? undefined : `Retrying ${config.label} (attempt ${tryIndex + 1})…`,
        });

        try {
          const startedAt = Date.now();
          const wantStream = Boolean(opts.stream && req.stream !== false && config.streaming && adapter.stream);
          let content = '';
          let usage: AIResponse['usage'];
          let streamed = false;

          if (wantStream && adapter.stream) {
            streamed = true;
            emitStatus({ runId: opts.runId, status: 'streaming', providerId: config.id, model });
            for await (const delta of adapter.stream(ctx, req)) {
              if (delta.text) {
                content += delta.text;
                opts.onDelta?.({ text: delta.text });
              }
              if (delta.usage) usage = delta.usage;
            }
          } else {
            const raw = await adapter.complete(ctx, req);
            content = raw.text;
            usage = raw.usage
              ? { inputTokens: raw.usage.inputTokens, outputTokens: raw.usage.outputTokens }
              : undefined;
            if (opts.onDelta && content) opts.onDelta({ text: content });
          }

          // A provider that answers 200 with nothing useful is still a failure.
          if (!content.trim()) {
            throw new AIEngineError({
              category: 'PROVIDER_ERROR',
              message: `${config.label} returned an empty response for this request.`,
              providerId: config.id,
            });
          }

          attempt.ok = true;
          attempt.latencyMs = Date.now() - startedAt;
          attempt.streamed = streamed;
          attempts.push(attempt);

          const fallback: AIFallbackNotice | undefined =
            config.id !== requestedProvider && requestedProvider
              ? {
                  requestedProvider,
                  requestedModel: profile.model,
                  usedProvider: config.id,
                  usedModel: model,
                  reason: lastError?.category ?? 'PROVIDER_ERROR',
                  message: `${requestedLabel || 'The selected provider'} unavailable. Switched to ${config.label} fallback.`,
                  attempts: attempts.map((a) => `${a.providerId}${a.ok ? ' ✓' : ` ✗ ${a.category ?? ''}`}`),
                }
              : undefined;

          emitStatus({
            runId: opts.runId,
            status: 'done',
            providerId: config.id,
            model,
            message: fallback?.message,
          });

          return {
            content,
            providerId: config.id,
            model,
            requestedProvider: requestedProvider !== config.id ? requestedProvider : undefined,
            fallback,
            usage,
            latencyMs: Date.now() - started,
            streamed,
            attempts,
          };
        } catch (err) {
          const error = await normalizeError(err, {
            providerId: config.id,
            secrets: [config.apiKey],
            cancelled: opts.signal.aborted && !timedOut.value,
            timedOut: timedOut.value,
          });
          lastError = error;
          attempt.category = error.category;
          attempt.message = error.message;

          if (error.category === 'USER_CANCELLED') {
            attempts.push({ ...attempt, ok: false, message: 'Stopped by the user' });
            emitStatus({ runId: opts.runId, status: 'cancelled', providerId: config.id, model });
            throw error; // never fall through to another provider after a Stop
          }
          if (!error.retryable || tryIndex === DEFAULT_MAX_RETRIES) break;
          await delay(RETRY_BACKOFF_MS * (tryIndex + 1), opts.signal);
        } finally {
          clearTimeout(timeout);
          linked.dispose();
        }
      }

      attempts.push(attempt);
      emitStatus({
        runId: opts.runId,
        status: 'error',
        providerId: config.id,
        model,
        message: `${config.label} failed (${attempt.category}): ${attempt.message}`,
      });
      // Non-switchable failures (bad request, unknown error) stop the chain —
      // hammering every provider with a malformed request helps nobody.
      if (lastError && !lastError.switchable) break;
    }

    const finalError =
      lastError ??
      new AIEngineError({ category: 'UNKNOWN', message: `No provider could answer (${reason}).` });
    throw finalError;
  }
}

function priorityIndex(order: ProviderId[], id: ProviderId): number {
  const index = order.indexOf(id);
  return index === -1 ? order.length + 100 : index;
}

function displayName(settings: AISettings, id: ProviderId): string {
  return settings.providers.find((p) => p.id === id)?.label ?? id.toUpperCase();
}

/** Links two abort signals; returns the combined signal plus a dispose hook. */
function linkSignals(...signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      continue;
    }
    const handler = () => controller.abort();
    signal.addEventListener('abort', handler, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', handler));
  }
  return { signal: controller.signal, dispose: () => cleanups.forEach((fn) => fn()) };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Convenience used across the app: a ready-to-use manager. */
export const aiManager = new AIManager();

/** Re-export so features can type their own parameters without deep imports. */
export type { AIChatTurn };
