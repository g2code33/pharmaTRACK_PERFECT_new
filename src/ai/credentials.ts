/**
 * PharmaTRACK AI Engine — credential store.
 *
 * API keys are deliberately kept in a different place from everything else:
 *
 *   AI settings (providers, models, profiles, priority)  → localStorage
 *   AI credentials (keys, org, project, custom headers)  → IndexedDB
 *
 * Why: academic data and app state are serialised all over the place (semester
 * archives, .pharmatrack backups, cloud sync snapshots, JSON exports). Keeping
 * secrets out of that blob means a bug — or a future feature — cannot smuggle a
 * key into a file someone emails to a friend. `stripCredentials()` is the single
 * guard every export path already goes through, and this module is the only
 * thing that ever reads a key back.
 *
 * Honest limitation, shown to the user in AI Settings: in a browser/PWA
 * (and the Tauri webview) there is no OS keychain available to a web page, so
 * these live in the app's own IndexedDB — protected from exports, logs and other
 * PharmaTRACK users on the same origin, but NOT encrypted at rest against
 * someone with access to this device's profile. That is stated in the UI rather
 * than implied away.
 */
import * as idb from 'idb-keyval';
import type { ProviderId } from './types';

const CRED_KEY = 'pharmatrack_ai_credentials';

export interface ProviderCredentials {
  apiKey?: string;
  organization?: string;
  project?: string;
  headers?: Record<string, string>;
}

type CredentialMap = Record<ProviderId, ProviderCredentials>;

let cache: CredentialMap | null = null;

async function read(): Promise<CredentialMap> {
  if (cache) return cache;
  try {
    cache = ((await idb.get(CRED_KEY)) as CredentialMap | undefined) ?? {};
  } catch (err) {
    // Never log the value — only the fact that the read failed.
    console.error('AI credentials could not be read from IndexedDB:', err);
    cache = {};
  }
  return cache;
}

/** Credentials for one provider (never logged, never serialised). */
export async function loadCredentials(providerId: ProviderId): Promise<ProviderCredentials> {
  const all = await read();
  return all[providerId] ?? {};
}

/**
 * The key actually persisted in IndexedDB, bypassing the in-memory cache.
 * `saveCredentials` updates the cache even when the write fails, so a migration
 * must not treat the cache as proof that the key is safe to remove elsewhere.
 * Returns null when the store cannot be read — callers must keep the old copy.
 */
export async function storedApiKey(providerId: ProviderId): Promise<string | null> {
  try {
    const all = (await idb.get(CRED_KEY)) as CredentialMap | undefined;
    const key = all?.[providerId]?.apiKey;
    return typeof key === 'string' && key.trim() ? key : null;
  } catch {
    return null;
  }
}

/** All credentials, for attaching to provider configs at load time. */
export async function loadAllCredentials(): Promise<CredentialMap> {
  return { ...(await read()) };
}

/** Saves (or clears, when the key is empty) one provider's credentials. */
export async function saveCredentials(
  providerId: ProviderId,
  creds: ProviderCredentials,
): Promise<void> {
  const all = { ...(await read()) };
  const clean: ProviderCredentials = {};
  if (creds.apiKey?.trim()) clean.apiKey = creds.apiKey.trim();
  if (creds.organization?.trim()) clean.organization = creds.organization.trim();
  if (creds.project?.trim()) clean.project = creds.project.trim();
  if (creds.headers && Object.keys(creds.headers).length) clean.headers = { ...creds.headers };

  if (Object.keys(clean).length) all[providerId] = clean;
  else delete all[providerId];
  cache = all;
  try {
    await idb.set(CRED_KEY, all);
  } catch (err) {
    console.error('AI credentials could not be saved to IndexedDB:', err);
  }
}

export async function deleteCredentials(providerId: ProviderId): Promise<void> {
  await saveCredentials(providerId, {});
}

/** Removes every stored credential (used by “Clear ALL Data”). */
export async function clearAllCredentials(): Promise<void> {
  cache = {};
  try {
    await idb.del(CRED_KEY);
  } catch (err) {
    console.error('AI credentials could not be cleared:', err);
  }
}

/**
 * Last line of defence for exports: removes secret fields from anything that
 * looks like AI configuration. Used by the backup builder and the archive
 * verifier, and covered by tests — a key must never reach a `.pharmatrack` file.
 */
export function stripCredentials<T extends { apiKey?: unknown; organization?: unknown; project?: unknown; headers?: unknown }>(
  config: T,
): Omit<T, 'apiKey' | 'organization' | 'project' | 'headers'> {
  const { apiKey: _apiKey, organization: _organization, project: _project, headers: _headers, ...rest } = config;
  return rest;
}

/** Redacts anything key-shaped inside an arbitrary JSON structure (backup guard). */
export function scrubSecretsDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    // One pass over every known key shape (see looksLikeApiKey below — the two
    // must stay in step, and SECRET_PATTERNS is the single source of truth).
    let out = value;
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
    return out;
  }
  if (Array.isArray(value)) return value.map(scrubSecretsDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (/^(api[_-]?key|apikey|authorization|secret|access[_-]?token|refresh[_-]?token|openaiKey)$/i.test(key)) {
        out[key] = undefined;
        continue;
      }
      out[key] = scrubSecretsDeep(val);
    }
    return out;
  }
  return value;
}

/**
 * Every credential shape the engine knows about. Deliberately per-provider
 * prefixes rather than "anything long and random", so a student's essay or a
 * base64 diagram is never mistaken for a secret and mangled in a backup.
 *   sk-…     OpenAI / OpenRouter / Anthropic / Mistral and most compatible APIs
 *   nvapi-…  NVIDIA,  AIza…  Google Gemini,  gsk_…  Groq,  xai-…  xAI
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bnvapi-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[A-Za-z0-9_-]{8,}/g,
  /\bgsk_[A-Za-z0-9_-]{8,}/g,
  /\bxai-[A-Za-z0-9_-]{8,}/g,
];

/** True when a string looks like a real provider key (used by tests + guards). */
export function looksLikeApiKey(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => new RegExp(pattern.source).test(value));
}

/** Masks a key for display: never render a full credential in the DOM/logs. */
export function maskKey(key: string | undefined): string {
  if (!key) return '';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 3)}••••${trimmed.slice(-4)}`;
}
