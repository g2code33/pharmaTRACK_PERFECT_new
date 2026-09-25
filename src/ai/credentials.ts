/**
 * PharmaTRACK AI credential vault.
 *
 * Provider credentials never live in localStorage or the normal account/config
 * JSON. The legacy IndexedDB record is migrated in place to an authenticated
 * AES-GCM device-encrypted record (the device key is held by Web Crypto and
 * stored through the existing secure-storage helper). When an account vault is
 * unlocked, accountSync additionally stores an account-recoverable ciphertext
 * envelope in Supabase; the server never receives plaintext credentials.
 */
import * as idb from 'idb-keyval';
import type { ProviderId } from './types';
import { loadEncryptedJson, saveEncryptedJson } from '../examination/secureStorage';

export const CREDENTIAL_STORAGE_KEY = 'pharmatrack_ai_credentials';
export const CREDENTIAL_METADATA_KEY = 'pharmatrack_ai_credential_metadata';

export interface ProviderCredentials {
  apiKey?: string;
  organization?: string;
  project?: string;
  headers?: Record<string, string>;
}

export interface CredentialMetadata {
  providerId: ProviderId;
  hasKey: boolean;
  /** Only the final four characters are exposed to status consumers. */
  maskedSuffix?: string;
  /** True when an account ciphertext exists even if this device is locked. */
  accountConfigured?: boolean;
  updatedAt: string;
  localVersion: number;
  serverVersion?: number;
  syncStatus: 'synced' | 'pending' | 'locked' | 'conflict' | 'error';
  lastError?: string;
}

type CredentialMap = Record<ProviderId, ProviderCredentials>;
type MetadataMap = Record<ProviderId, CredentialMetadata>;

let cache: CredentialMap | null = null;
let metadataCache: MetadataMap | null = null;

function isCredentialMap(value: unknown): value is CredentialMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (item) => item == null || (typeof item === 'object' && !Array.isArray(item)),
  );
}

async function readMetadata(): Promise<MetadataMap> {
  // Read through IndexedDB each time so an account restore, migration, or a
  // second tab cannot leave this boundary serving a stale status snapshot.
  try {
    const stored = (await idb.get(CREDENTIAL_METADATA_KEY)) as MetadataMap | undefined;
    metadataCache = stored ?? {};
  } catch {
    metadataCache = {};
  }
  return metadataCache;
}

async function persistMetadata(next: MetadataMap): Promise<void> {
  metadataCache = next;
  try {
    await idb.set(CREDENTIAL_METADATA_KEY, next);
  } catch {
    // Metadata loss never exposes a secret and the encrypted credential remains usable.
  }
}

function metadataFor(providerId: ProviderId, credentials: ProviderCredentials, previous?: CredentialMetadata): CredentialMetadata {
  return {
    providerId,
    hasKey: Boolean(credentials.apiKey),
    maskedSuffix: credentials.apiKey ? `••••${credentials.apiKey.slice(-4)}` : undefined,
    accountConfigured: Boolean(credentials.apiKey),
    updatedAt: new Date().toISOString(),
    localVersion: (previous?.localVersion ?? 0) + 1,
    serverVersion: previous?.serverVersion,
    syncStatus: 'pending',
  };
}

/**
 * Reads the encrypted local record. A legacy plaintext IndexedDB object is
 * accepted only long enough to migrate it and is never deliberately retained.
 * If encryption fails, the old record is left untouched and the caller can
 * report a migration problem instead of destroying the only copy.
 */
async function read(): Promise<CredentialMap> {
  // Do not serve a stale key after migration, logout, or another tab updates
  // the encrypted record. The manager already batches its reads per request.
  try {
    const raw = await idb.get<unknown>(CREDENTIAL_STORAGE_KEY);
    if (raw == null) {
      cache = {};
      return cache;
    }
    const encrypted = await loadEncryptedJson<unknown>(CREDENTIAL_STORAGE_KEY);
    if (!isCredentialMap(encrypted)) throw new Error('AI credential record is malformed.');

    // `loadEncryptedJson` returns an old object unchanged. Upgrade it before
    // treating the migration as complete, and verify the decryptable copy.
    if (!(raw && typeof raw === 'object' && (raw as { encrypted?: unknown }).encrypted === true)) {
      await saveEncryptedJson(CREDENTIAL_STORAGE_KEY, encrypted);
      const verified = await loadEncryptedJson<unknown>(CREDENTIAL_STORAGE_KEY);
      if (!isCredentialMap(verified)) throw new Error('Encrypted AI credential migration could not be verified.');
    }
    cache = encrypted;
    return cache;
  } catch {
    // Never include a record or value in diagnostics.
    console.error('AI credentials could not be securely read.');
    cache = {};
    return cache;
  }
}

/** Credentials for one provider. This is only used by the credential-aware manager. */
export async function loadCredentials(providerId: ProviderId): Promise<ProviderCredentials> {
  const all = await read();
  return { ...(all[providerId] ?? {}) };
}

/** Reads the actual encrypted store and returns a key only for migration verification. */
export async function storedApiKey(providerId: ProviderId): Promise<string | null> {
  const credentials = await loadCredentials(providerId);
  return credentials.apiKey?.trim() || null;
}

/** All credentials, for the centralized AI manager only. */
export async function loadAllCredentials(): Promise<CredentialMap> {
  return { ...(await read()) };
}

/** Non-secret provider status for React/UI and normal configuration responses. */
export async function loadAllCredentialStatuses(): Promise<Record<ProviderId, CredentialMetadata>> {
  const credentials = await read();
  const metadata = await readMetadata();
  const next = { ...metadata };
  for (const [providerId, value] of Object.entries(credentials)) {
    if (!next[providerId]) {
      next[providerId] = {
        providerId,
        hasKey: Boolean(value.apiKey),
        maskedSuffix: value.apiKey ? `••••${value.apiKey.slice(-4)}` : undefined,
        accountConfigured: Boolean(value.apiKey),
        updatedAt: new Date().toISOString(),
        localVersion: 0,
        syncStatus: 'synced',
      };
    } else {
      next[providerId] = {
        ...next[providerId],
        hasKey: Boolean(value.apiKey),
        maskedSuffix: value.apiKey ? `••••${value.apiKey.slice(-4)}` : undefined,
        accountConfigured: next[providerId].accountConfigured ?? Boolean(value.apiKey),
      };
    }
  }
  return next;
}

/** Metadata used by account conflict/recovery logic; it contains no secret values. */
export async function loadCredentialMetadata(): Promise<MetadataMap> {
  return { ...(await readMetadata()) };
}

/** Adds server-only status rows without downloading or decrypting their secrets. */
export async function mergeAccountCredentialStatuses(
  rows: Array<{ providerId: ProviderId; version: number; updatedAt: string }>,
): Promise<void> {
  const metadata = await readMetadata();
  const next = { ...metadata };
  for (const row of rows) {
    const local = next[row.providerId];
    next[row.providerId] = {
      providerId: row.providerId,
      hasKey: local?.hasKey ?? false,
      accountConfigured: true,
      updatedAt: row.updatedAt,
      localVersion: local?.localVersion ?? 0,
      serverVersion: row.version,
      syncStatus: local?.syncStatus === 'conflict' || local?.syncStatus === 'error'
        ? local.syncStatus
        : local?.hasKey
          ? local.syncStatus
          : 'locked',
      lastError: local?.lastError,
    };
  }
  await persistMetadata(next);
}

async function persistLocal(providerId: ProviderId, credentials: ProviderCredentials, status: CredentialMetadata): Promise<void> {
  const all = { ...(await read()) };
  if (Object.keys(credentials).length) all[providerId] = credentials;
  else delete all[providerId];

  // Do not update the cache until encrypted persistence and decryption verify.
  await saveEncryptedJson(CREDENTIAL_STORAGE_KEY, all);
  const verified = await loadEncryptedJson<unknown>(CREDENTIAL_STORAGE_KEY);
  if (!isCredentialMap(verified)) throw new Error('Encrypted AI credential write could not be verified.');
  cache = all;
  const metadata = await readMetadata();
  await persistMetadata({ ...metadata, [providerId]: status });
}

/** Saves one provider's credentials in the encrypted local vault. */
export async function saveCredentials(
  providerId: ProviderId,
  creds: ProviderCredentials,
  options: { sync?: boolean; preserveExisting?: boolean } = {},
): Promise<void> {
  const clean: ProviderCredentials = options.preserveExisting ? await loadCredentials(providerId) : {};
  if (creds.apiKey !== undefined) {
    if (creds.apiKey.trim()) clean.apiKey = creds.apiKey.trim();
    else delete clean.apiKey;
  }
  if (creds.organization !== undefined) {
    if (creds.organization.trim()) clean.organization = creds.organization.trim();
    else delete clean.organization;
  }
  if (creds.project !== undefined) {
    if (creds.project.trim()) clean.project = creds.project.trim();
    else delete clean.project;
  }
  if (creds.headers !== undefined) {
    if (Object.keys(creds.headers).length) clean.headers = { ...creds.headers };
    else delete clean.headers;
  }
  const previous = (await readMetadata())[providerId];
  const status = metadataFor(providerId, clean, previous);
  try {
    await persistLocal(providerId, clean, status);
    if (options.sync !== false) {
      void import('./accountSync')
        .then(({ queueSecretSync }) => queueSecretSync?.(providerId, clean, status.localVersion))
        .catch(() => {
          // The encrypted local copy remains the offline source of truth.
        });
    }
  } catch (error) {
    console.error('AI credentials could not be securely saved.');
    const metadata = await readMetadata();
    await persistMetadata({
      ...metadata,
      [providerId]: { ...status, syncStatus: 'error', lastError: 'Encrypted local save failed.' },
    });
    throw error;
  }
}

export async function deleteCredentials(providerId: ProviderId): Promise<void> {
  await saveCredentials(providerId, {}, { sync: false });
  void import('./accountSync')
    .then(({ queueSecretDeletion }) => queueSecretDeletion?.(providerId))
    .catch(() => {
      // Local deletion already completed; a later authenticated restore can reconcile it.
    });
}

/** Called by accountSync after decrypting an account ciphertext. */
export async function replaceCredentialsFromAccount(
  providerId: ProviderId,
  credentials: ProviderCredentials,
  serverVersion: number,
): Promise<void> {
  const metadata: CredentialMetadata = {
    providerId,
    hasKey: Boolean(credentials.apiKey),
    maskedSuffix: credentials.apiKey ? `••••${credentials.apiKey.slice(-4)}` : undefined,
    accountConfigured: Boolean(credentials.apiKey),
    updatedAt: new Date().toISOString(),
    localVersion: serverVersion,
    serverVersion,
    syncStatus: 'synced',
  };
  await persistLocal(providerId, credentials, metadata);
}

/** Marks a local credential as synchronized without changing its secret. */
export async function markCredentialSyncStatus(
  providerId: ProviderId,
  syncStatus: CredentialMetadata['syncStatus'],
  lastError?: string,
  serverVersion?: number,
): Promise<void> {
  const metadata = await readMetadata();
  const current = metadata[providerId];
  if (!current) return;
  await persistMetadata({
    ...metadata,
    [providerId]: { ...current, syncStatus, lastError, serverVersion: serverVersion ?? current.serverVersion },
  });
}

/** Removes every encrypted local credential and its non-secret metadata. */
export async function clearAllCredentials(): Promise<void> {
  cache = {};
  metadataCache = {};
  try {
    await idb.del(CREDENTIAL_STORAGE_KEY);
    await idb.del(CREDENTIAL_METADATA_KEY);
  } catch {
    console.error('AI credentials could not be cleared.');
  }
}

export function stripCredentials<T extends { apiKey?: unknown; organization?: unknown; project?: unknown; headers?: unknown }>(
  config: T,
): Omit<T, 'apiKey' | 'organization' | 'project' | 'headers'> {
  const { apiKey: _apiKey, organization: _organization, project: _project, headers: _headers, ...rest } = config;
  return rest;
}

/** Redacts anything key-shaped inside an arbitrary JSON structure (backup guard). */
export function scrubSecretsDeep(value: unknown): unknown {
  if (typeof value === 'string') {
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

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bnvapi-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[A-Za-z0-9_-]{8,}/g,
  /\bgsk_[A-Za-z0-9_-]{8,}/g,
  /\bxai-[A-Za-z0-9_-]{8,}/g,
];

export function looksLikeApiKey(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => new RegExp(pattern.source).test(value));
}

/** Removes credential-bearing URL components before endpoint metadata is persisted or sent. */
export function scrubSecretUrl(value: string): string {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(api[_-]?key|key|token|secret|password|authorization|auth)$/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString().replace(/[?&]$/, '');
  } catch {
    return value.replace(/([?&](?:api[_-]?key|key|token|secret|password|authorization|auth)=)[^&#]*/gi, '$1[redacted]');
  }
}

export function maskKey(key: string | undefined): string {
  if (!key) return '';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 3)}••••${trimmed.slice(-4)}`;
}
