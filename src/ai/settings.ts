/**
 * PharmaTRACK AI Engine — settings store and migration.
 *
 * AI configuration is *separate* from academic data on purpose: a semester
 * archive is a portable academic record, and importing one must never bring
 * someone else's credentials with it (spec §21). So:
 *
 *   • provider/model/profile configuration → localStorage, keys stripped
 *   • credentials → IndexedDB (see credentials.ts)
 *   • semester archives → never contain either
 *
 * `migrateLegacySettings` is what keeps existing users working: the app has
 * shipped an `openAIKey` field in AppState since forever, but that key was
 * actually used against Google's Gemini endpoint. The migration therefore maps
 * it to the *Gemini* provider (with the model the old code hard-coded), so the
 * user's key keeps doing exactly what it did before — and does not silently
 * become an "OpenAI key".
 */
import type {
  AIProfile,
  AISettings,
  ModelInfo,
  ProviderConfig,
  ProviderKind,
  ProviderId,
} from './types';
import { PRESET_PROFILES } from './profiles';
import { PROVIDER_PRESETS, presetFor, protocolForKind } from './providers';
import { MODEL_SUGGESTIONS } from './models';
import { stripCredentials } from './credentials';

export const AI_SETTINGS_KEY = 'pharmatrack_ai_settings';
export const AI_SETTINGS_VERSION = 2;

/** Old AppState field names that may hold a provider key. */
export const LEGACY_KEY_FIELDS = ['openAIKey', 'geminiKey', 'apiKey', 'nvidiaKey'] as const;

export interface SeedProviderInput {
  kind: ProviderKind;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  id?: ProviderId;
  migratedFrom?: string;
}

/** Builds a provider entry straight from a preset. */
export function createProviderConfig(input: SeedProviderInput): ProviderConfig {
  const preset = presetFor(input.kind);
  const config: ProviderConfig = {
    id: input.id ?? input.kind,
    kind: input.kind,
    label: preset.label,
    protocol: protocolForKind(input.kind),
    baseUrl: input.baseUrl ?? preset.baseUrl,
    model: input.model ?? MODEL_SUGGESTIONS[input.kind][0] ?? '',
    enabled: true,
    streaming: true,
  };
  if (input.apiKey) config.apiKey = input.apiKey;
  if (input.migratedFrom) config.migratedFrom = input.migratedFrom;
  return config;
}

/** Every provider PharmaTRACK ships with, all disabled until configured. */
export function defaultProviders(): ProviderConfig[] {
  return PROVIDER_PRESETS.map((preset) =>
    createProviderConfig({ kind: preset.kind, model: MODEL_SUGGESTIONS[preset.kind][0] ?? '' }),
  ).map((config, index) => ({ ...config, enabled: false, model: config.model || '', priority: index + 1 }));
}

export function defaultSettings(): AISettings {
  return {
    version: AI_SETTINGS_VERSION,
    providers: defaultProviders(),
    profiles: PRESET_PROFILES.map((p) => ({ ...p, fallbacks: [...p.fallbacks] })),
    activeProfileId: 'default',
    automaticFallback: true,
    providerPriority: ['nvidia', 'gemini', 'groq', 'openai', 'anthropic', 'openrouter', 'mistral', 'custom', 'local'],
    sendSelectedContextOnly: true,
    excludeKeysFromBackups: true,
  };
}

/** Fills in anything a stored settings blob is missing (forward compatible). */
export function normalizeSettings(raw: Partial<AISettings> | null | undefined): AISettings {
  const base = defaultSettings();
  if (!raw) return base;

  const stored = (raw.providers ?? []).filter((p): p is ProviderConfig => Boolean(p?.id));
  const byId = new Map(stored.map((p) => [p.id, p]));
  // Keep the shipped presets, in order, then append user-created providers.
  const providers: ProviderConfig[] = base.providers.map((preset) => {
    const found = byId.get(preset.id);
    if (!found) return preset;
    byId.delete(preset.id);
    const presetMeta = presetFor(found.kind ?? preset.kind);
    return {
      ...preset,
      ...found,
      kind: found.kind ?? preset.kind,
      protocol: found.protocol ?? protocolForKind(found.kind ?? preset.kind),
      label: found.label || presetMeta.label,
      baseUrl: found.baseUrl ?? presetMeta.baseUrl,
      // A stored config never carries a key; credentials come from IndexedDB.
      apiKey: undefined,
    };
  });
  for (const extra of byId.values()) {
    providers.push({ ...extra, protocol: extra.protocol ?? protocolForKind(extra.kind), apiKey: undefined });
  }

  const storedProfiles = raw.profiles?.filter((p) => p?.id) ?? [];
  const profileIds = new Set(storedProfiles.map((p) => p.id));
  const profiles: AIProfile[] = [
    ...storedProfiles.map((p) => ({ ...p, fallbacks: p.fallbacks ?? [], useFallback: p.useFallback ?? true })),
    ...base.profiles.filter((p) => !profileIds.has(p.id)),
  ];

  const activeProfileId = profiles.some((p) => p.id === raw.activeProfileId)
    ? (raw.activeProfileId as string)
    : base.activeProfileId;

  /* Priority is one list, stored twice: the ordered `providerPriority` the
   * engine walks, and a 1-based `priority` on each provider so the settings
   * screen can show a rank without recomputing it. They are reconciled here so
   * a provider added by an older version can never end up unrouted. */
  const storedPriority =
    Array.isArray(raw.providerPriority) && raw.providerPriority.length
      ? raw.providerPriority
      : base.providerPriority;
  const ids = providers.map((p) => p.id);
  const providerPriority = [
    ...storedPriority.filter((id) => ids.includes(id)),
    ...ids.filter((id) => !storedPriority.includes(id)),
  ];
  const ranked = providers.map((p) => ({ ...p, priority: providerPriority.indexOf(p.id) + 1 }));

  return {
    ...base,
    ...raw,
    version: AI_SETTINGS_VERSION,
    providers: ranked,
    profiles,
    activeProfileId,
    automaticFallback: raw.automaticFallback ?? base.automaticFallback,
    providerPriority,
    sendSelectedContextOnly: raw.sendSelectedContextOnly ?? base.sendSelectedContextOnly,
    excludeKeysFromBackups: true,
  };
}

/** Re-ranks every provider so `priority` matches an edited priority list. */
export function withPriority(settings: AISettings, order: ProviderId[]): AISettings {
  const ids = settings.providers.map((p) => p.id);
  const providerPriority = [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))];
  return {
    ...settings,
    providerPriority,
    providers: settings.providers.map((p) => ({ ...p, priority: providerPriority.indexOf(p.id) + 1 })),
  };
}

/**
 * Reads AI settings. Credentials are NOT attached here (that is async and lives
 * in the provider store) — this deliberately returns a key-free structure.
 */
export function loadAISettings(): AISettings {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_KEY);
    if (!raw) return defaultSettings();
    return normalizeSettings(JSON.parse(raw) as Partial<AISettings>);
  } catch (err) {
    console.error('AI settings could not be read:', err);
    return defaultSettings();
  }
}

/**
 * Persists AI settings with every credential field removed. Credentials are
 * written separately (IndexedDB) so a settings export can never carry a key.
 */
export function saveAISettings(settings: AISettings): AISettings {
  const sanitized: AISettings = {
    ...settings,
    providers: settings.providers.map((p) => ({ ...stripCredentials(p), apiKey: undefined })),
  };
  try {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(sanitized));
  } catch (err) {
    console.error('AI settings could not be saved:', err);
  }
  return sanitized;
}

export function clearAISettings(): void {
  try {
    localStorage.removeItem(AI_SETTINGS_KEY);
  } catch (err) {
    console.error('AI settings could not be cleared:', err);
  }
}

/* ------------------------------------------------------------------ */
/* Model list helpers                                                 */
/* ------------------------------------------------------------------ */

/** Merges discovered/entered models into a provider, keeping user entries. */
export function mergeModels(
  existing: ModelInfo[] | undefined,
  incoming: ModelInfo[],
  source: ModelInfo['source'],
): ModelInfo[] {
  const byId = new Map((existing ?? []).map((m) => [m.id, m]));
  for (const model of incoming) {
    const current = byId.get(model.id);
    byId.set(model.id, {
      ...current,
      ...model,
      // Never overwrite a user's own declaration with provider metadata.
      capabilities: current?.source === 'user' ? current.capabilities : model.capabilities,
      source: current?.source === 'user' ? 'user' : source,
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Models offered in the selector: discovered list, then curated suggestions. */
export function modelOptions(provider: ProviderConfig): string[] {
  const discovered = (provider.models ?? []).map((m) => m.id);
  const suggestions = MODEL_SUGGESTIONS[provider.kind] ?? [];
  const current = provider.model ? [provider.model] : [];
  return [...new Set([...current, ...discovered, ...suggestions])].filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Legacy migration                                                   */
/* ------------------------------------------------------------------ */

export interface LegacyMigrationResult {
  /** Set when the legacy key was found and a provider created/filled. */
  migratedKey?: string;
  providerId?: ProviderId;
  /** Human sentence for the Settings banner. */
  message: string;
}

/** Picks the legacy key out of an AppState-shaped object. */
export function findLegacyKey(state: Record<string, unknown> | null | undefined): {
  field: string;
  key: string;
} | null {
  if (!state) return null;
  for (const field of LEGACY_KEY_FIELDS) {
    const value = state[field];
    if (typeof value === 'string' && value.trim()) return { field, key: value.trim() };
  }
  return null;
}

/**
 * Which provider a legacy key belonged to. The shipped field is named
 * `openAIKey` but was always used against Google's endpoint, and the old code
 * refused any key that did not start with `AIza`. So: an AIza key → Gemini;
 * anything else → OpenAI (the honest reading of a key that is not a Gemini one),
 * and the message says which assumption was made.
 */
export function providerForLegacyKey(key: string): { kind: ProviderKind; reason: string } {
  if (key.startsWith('AIza')) {
    return { kind: 'gemini', reason: 'Google AI Studio key detected — mapped to the Gemini provider.' };
  }
  if (key.startsWith('nvapi-')) {
    return { kind: 'nvidia', reason: 'NVIDIA key detected — mapped to the NVIDIA provider.' };
  }
  if (key.startsWith('sk-ant-')) {
    return { kind: 'anthropic', reason: 'Anthropic key detected — mapped to the Anthropic provider.' };
  }
  if (key.startsWith('gsk_')) {
    return { kind: 'groq', reason: 'Groq key detected — mapped to the Groq provider.' };
  }
  return {
    kind: 'openai',
    reason: 'Mapped to the OpenAI provider. If this key belonged to another service, change the provider and base URL below.',
  };
}

/**
 * Converts a legacy single-key configuration into a provider entry. Returns the
 * settings plus the credentials that must be written separately, and does NOT
 * delete the legacy field — the caller clears it only after the new settings
 * have been persisted (spec §33).
 */
export function migrateLegacySettings(
  settings: AISettings,
  legacyKey: string,
  opts: { model?: string } = {},
): { settings: AISettings; providerId: ProviderId; reason: string } {
  const { kind, reason } = providerForLegacyKey(legacyKey);
  const existing = settings.providers.find((p) => p.id === kind);
  const provider: ProviderConfig = existing
    ? {
        ...existing,
        enabled: true,
        apiKey: legacyKey,
        // The old code hard-coded a Gemini model; keep it, but only as the
        // default so the user can switch to anything the provider offers.
        model: existing.model || opts.model || MODEL_SUGGESTIONS[kind][0] || '',
        migratedFrom: 'openAIKey',
      }
    : { ...createProviderConfig({ kind, apiKey: legacyKey, model: opts.model, migratedFrom: 'openAIKey' }), enabled: true };

  const providers = settings.providers.some((p) => p.id === provider.id)
    ? settings.providers.map((p) => (p.id === provider.id ? provider : p))
    : [...settings.providers, provider];

  // Point the default profile at the migrated provider so behaviour is
  // unchanged: the key that used to answer questions still answers them.
  const profiles = settings.profiles.map((profile) =>
    profile.id === 'default' ? { ...profile, providerId: provider.id, model: provider.model } : profile,
  );

  return {
    settings: { ...settings, providers, profiles },
    providerId: provider.id,
    reason,
  };
}

/** What the old Gemini call sites hard-coded, reused as migration defaults. */
export const LEGACY_GEMINI_MODELS = {
  summary: 'gemini-2.5-flash',
  chat: 'gemini-2.5-flash-lite',
} as const;
