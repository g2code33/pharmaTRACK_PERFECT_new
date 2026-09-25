/**
 * Account-scoped AI configuration, device sessions, and encrypted secret sync.
 *
 * Normal configuration is synchronized as JSON without credential fields.
 * Credential rows contain only AES-GCM ciphertext produced by secretCrypto.ts;
 * decryption requires the account password-derived CryptoKey held in memory.
 */
import { supabase } from '../utils/supabase';
import { randomId } from '../examination/crypto';
import { saveEncryptedJson } from '../examination/secureStorage';
import {
  createVaultSalt,
  decryptAccountSecret,
  deriveAccountVaultKey,
  encryptAccountSecret,
  type EncryptedSecretEnvelope,
} from './secretCrypto';
import type { AISettings, ProviderId } from './types';
import { loadAISettings, normalizeSettings, saveAISettings } from './settings';
import { scrubSecretUrl, stripCredentials, type ProviderCredentials } from './credentials';

const DEVICE_ID_KEY = 'pharmatrack_ai_device_id_v1';
const DEVICE_SESSION_KEY = 'pharmatrack_ai_device_session_v1';
const CONFIG_META_PREFIX = 'pharmatrack_ai_config_sync_v1_';
const DEVICE_LABEL =
  typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 120) : 'PharmaTRACK device';

export type AccountAISyncState =
  'signed_out' | 'restoring' | 'ready' | 'locked' | 'pending' | 'conflict' | 'revoked' | 'error';

export interface AccountAIStatus {
  state: AccountAISyncState;
  userId?: string;
  deviceId?: string;
  configVersion?: number;
  configuredSecretCount?: number;
  lastSyncedAt?: string;
  message?: string;
}

export interface AccountDevice {
  deviceId: string;
  label: string;
  createdAt: string;
  lastActiveAt: string;
  revokedAt?: string | null;
  current?: boolean;
}

interface DeviceSession {
  userId: string;
  deviceId: string;
  deviceToken: string;
}

interface ActiveAccountSession extends DeviceSession {
  key?: CryptoKey;
  vaultSalt: string;
  configVersion: number;
  secretVersions: Record<ProviderId, number>;
}

interface AccountConfigResponse {
  found?: boolean;
  configVersion?: number;
  settings?: Partial<AISettings>;
  vaultSalt?: string;
  updatedAt?: string;
  updatedByDeviceId?: string;
}

interface AccountSecretRow {
  secretId: string;
  providerId: ProviderId;
  credentialType: string;
  encryptedSecret?: EncryptedSecretEnvelope;
  secretVersion: number;
  updatedAt: string;
  keyStatus: string;
}

interface ConfigWriteResponse {
  accepted: boolean;
  conflict?: boolean;
  configVersion?: number;
  configuration?: AccountConfigResponse;
}

interface SecretWriteResponse {
  accepted: boolean;
  conflict?: boolean;
  secretVersion?: number;
  current?: AccountSecretRow;
}

const listeners = new Set<(status: AccountAIStatus) => void>();
let status: AccountAIStatus = { state: 'signed_out' };
let active: ActiveAccountSession | null = null;
let initializationGeneration = 0;
let explicitUnlockInProgress = false;
let configurationQueue: Promise<void> = Promise.resolve();
const secretQueues = new Map<ProviderId, Promise<void>>();

function offline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function setStatus(next: AccountAIStatus): void {
  status = next;
  for (const listener of listeners) {
    try {
      listener(status);
    } catch {
      /* status observers must not break synchronization */
    }
  }
}

export function getAccountAIStatus(): AccountAIStatus {
  return status;
}

export function onAccountAIStatus(listener: (next: AccountAIStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isAccountVaultUnlocked(): boolean {
  return Boolean(active?.key);
}

function localConfigMeta(userId: string): { version: number; updatedAt?: string; status?: string } {
  try {
    const raw = localStorage.getItem(`${CONFIG_META_PREFIX}${userId}`);
    return raw
      ? (JSON.parse(raw) as { version: number; updatedAt?: string; status?: string })
      : { version: 0 };
  } catch {
    return { version: 0 };
  }
}

function saveLocalConfigMeta(
  userId: string,
  value: { version: number; updatedAt?: string; status?: string },
): void {
  try {
    localStorage.setItem(`${CONFIG_META_PREFIX}${userId}`, JSON.stringify(value));
  } catch {
    /* metadata is recoverable and never contains secrets */
  }
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}

function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const created = randomId('device');
    localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  } catch {
    return randomId('device');
  }
}

async function registerDevice(userId: string): Promise<DeviceSession> {
  const id = deviceId();
  const result = await rpc<{ deviceToken: string }>('pharmatrack_ai_register_device', {
    p_device_id: id,
    p_device_label: DEVICE_LABEL,
  });
  const session = { userId, deviceId: id, deviceToken: result.deviceToken };
  await saveEncryptedJson(DEVICE_SESSION_KEY, session);
  return session;
}

async function getConfiguration(session: DeviceSession): Promise<AccountConfigResponse | null> {
  const result = await rpc<AccountConfigResponse | null>('pharmatrack_ai_get_configuration', {
    p_device_id: session.deviceId,
    p_device_token: session.deviceToken,
  });
  return result?.found === false ? null : result;
}

function safeAccountSettings(settings: AISettings): AISettings {
  const normalized = normalizeSettings(settings);
  return normalizeSettings({
    ...normalized,
    providers: normalized.providers.map((provider) => ({
      ...stripCredentials(provider),
      baseUrl: scrubSecretUrl(provider.baseUrl),
    })),
  });
}

async function applyRemoteConfiguration(
  config: AccountConfigResponse,
  userId: string,
): Promise<void> {
  if (!config.settings) return;
  const sanitized = safeAccountSettings(config.settings as AISettings);
  saveAISettings(sanitized, { sync: false });
  saveLocalConfigMeta(userId, {
    version: Number(config.configVersion ?? 0),
    updatedAt: config.updatedAt,
    status: 'synced',
  });
}

async function writeConfiguration(
  settings: AISettings,
  baseVersion: number,
  vaultSalt: string,
): Promise<void> {
  if (!active) return;
  setStatus({
    ...status,
    state: 'pending',
    message: 'Synchronizing AI configuration…',
  });
  const result = await rpc<ConfigWriteResponse>('pharmatrack_ai_upsert_configuration', {
    p_device_id: active.deviceId,
    p_device_token: active.deviceToken,
    p_base_version: baseVersion,
    p_settings: safeAccountSettings(settings),
    p_vault_salt: vaultSalt,
  });
  if (!result.accepted) {
    const remote = result.configuration;
    if (remote) await applyRemoteConfiguration(remote, active.userId);
    active.configVersion = Number(
      remote?.configVersion ?? result.configVersion ?? active.configVersion,
    );
    setStatus({
      ...status,
      state: 'conflict',
      configVersion: active.configVersion,
      message: 'A newer AI configuration was found on another device; the newer version was kept.',
    });
    return;
  }
  active.configVersion = Number(result.configVersion ?? active.configVersion + 1);
  saveLocalConfigMeta(active.userId, {
    version: active.configVersion,
    updatedAt: new Date().toISOString(),
    status: 'synced',
  });
  setStatus({
    ...status,
    state: 'ready',
    configVersion: active.configVersion,
    lastSyncedAt: new Date().toISOString(),
    message: 'AI configuration synchronized.',
  });
}

/** Called by saveAISettings; a no-op while signed out or before login. */
export function queueAccountSettingsSync(settings: AISettings): void {
  if (!active) return;
  configurationQueue = configurationQueue
    .then(() => {
      if (!active) return;
      return writeConfiguration(settings, active.configVersion, active.vaultSalt);
    })
    .catch((error) => {
      const revoked = error instanceof Error && /revoked|invalid device/i.test(error.message);
      setStatus({
        ...status,
        state: revoked ? 'revoked' : offline() ? 'pending' : 'error',
        message: 'AI configuration sync failed; changes remain pending locally.',
      });
      console.error('AI configuration sync failed.');
    });
}

async function getSecretRows(session: DeviceSession): Promise<AccountSecretRow[]> {
  return (
    (await rpc<AccountSecretRow[]>('pharmatrack_ai_get_secrets', {
      p_device_id: session.deviceId,
      p_device_token: session.deviceToken,
    })) ?? []
  );
}

async function getSecretMetadataRows(session: DeviceSession): Promise<AccountSecretRow[]> {
  return (
    (await rpc<AccountSecretRow[]>('pharmatrack_ai_get_secret_metadata', {
      p_device_id: session.deviceId,
      p_device_token: session.deviceToken,
    })) ?? []
  );
}

async function writeSecret(
  providerId: ProviderId,
  credentials: ProviderCredentials,
  localVersion?: number,
): Promise<void> {
  if (!active) return;
  if (!active.key) {
    const { markCredentialSyncStatus } = await import('./credentials');
    await markCredentialSyncStatus(
      providerId,
      'locked',
      'Unlock the account with your password to synchronize this credential.',
    );
    return;
  }
  const metadata = await (await import('./credentials')).loadCredentialMetadata();
  const baseVersion = active.secretVersions[providerId] ?? 0;
  const envelope = await encryptAccountSecret(
    active.key,
    credentials,
    `${active.userId}:${providerId}`,
  );
  const result = await rpc<SecretWriteResponse>('pharmatrack_ai_upsert_secret', {
    p_device_id: active.deviceId,
    p_device_token: active.deviceToken,
    p_provider_id: providerId,
    p_credential_type: 'api_provider_credentials',
    p_base_version: baseVersion,
    p_encrypted_secret: envelope,
    p_local_version: localVersion ?? metadata[providerId]?.localVersion ?? 0,
  });
  if (!result.accepted) {
    const { markCredentialSyncStatus } = await import('./credentials');
    await markCredentialSyncStatus(
      providerId,
      'conflict',
      'A newer credential version exists on another device; the newer server version was kept.',
    );
    setStatus({
      ...status,
      state: 'conflict',
      message: 'A provider credential changed on another device; verify the provider.',
    });
    return;
  }
  active.secretVersions[providerId] = Number(result.secretVersion ?? baseVersion + 1);
  const { markCredentialSyncStatus } = await import('./credentials');
  await markCredentialSyncStatus(
    providerId,
    'synced',
    undefined,
    active.secretVersions[providerId],
  );
}

export function queueSecretSync(
  providerId: ProviderId,
  credentials: ProviderCredentials,
  localVersion?: number,
): void {
  if (!active) return;
  const previous = secretQueues.get(providerId) ?? Promise.resolve();
  const next = previous
    .then(() => writeSecret(providerId, credentials, localVersion))
    .catch((error) => {
      const revoked = error instanceof Error && /revoked|invalid device/i.test(error.message);
      setStatus({
        ...status,
        state: revoked ? 'revoked' : offline() ? 'pending' : 'error',
        message: 'Provider credential sync failed; it remains pending locally.',
      });
      console.error('AI credential sync failed.');
    });
  secretQueues.set(providerId, next);
}

export function queueSecretDeletion(providerId: ProviderId): void {
  if (!active) return;
  const previous = secretQueues.get(providerId) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      const baseVersion = active?.secretVersions[providerId] ?? 0;
      if (!active) return;
      const result = await rpc<SecretWriteResponse>('pharmatrack_ai_delete_secret', {
        p_device_id: active.deviceId,
        p_device_token: active.deviceToken,
        p_provider_id: providerId,
        p_credential_type: 'api_provider_credentials',
        p_base_version: baseVersion,
      });
      if (result.accepted) {
        delete active.secretVersions[providerId];
        const { markCredentialSyncStatus } = await import('./credentials');
        await markCredentialSyncStatus(providerId, 'synced');
      } else {
        const { markCredentialSyncStatus } = await import('./credentials');
        await markCredentialSyncStatus(
          providerId,
          'conflict',
          'A newer credential version exists on another device.',
        );
      }
    })
    .catch(async (error) => {
      const { markCredentialSyncStatus } = await import('./credentials');
      await markCredentialSyncStatus(
        providerId,
        'pending',
        'Credential deletion remains pending until the account is reachable.',
      );
      const revoked = error instanceof Error && /revoked|invalid device/i.test(error.message);
      setStatus({
        ...status,
        state: revoked ? 'revoked' : offline() ? 'pending' : 'error',
        message: 'Provider credential deletion remains pending.',
      });
      console.error('AI credential deletion sync failed.');
    });
  secretQueues.set(providerId, next);
}

async function restoreSecrets(session: DeviceSession, key: CryptoKey): Promise<number> {
  const {
    loadAllCredentials,
    loadCredentialMetadata,
    replaceCredentialsFromAccount,
    markCredentialSyncStatus,
  } = await import('./credentials');
  const local = await loadAllCredentials();
  const metadata = await loadCredentialMetadata();
  const remoteRows = await getSecretRows(session);
  const remoteByProvider = new Map(remoteRows.map((row) => [row.providerId, row]));
  const versions: Record<ProviderId, number> = {};

  // A local pending update gets one explicit conflict attempt before a remote
  // row is applied. This prevents a stale device from silently overwriting a
  // newer secret and makes the conflict visible to the user.
  for (const [providerId, credentials] of Object.entries(local)) {
    const remote = remoteByProvider.get(providerId);
    if (!remote) {
      await writeSecret(providerId, credentials, metadata[providerId]?.localVersion);
      versions[providerId] = active?.secretVersions[providerId] ?? 1;
      continue;
    }
    versions[providerId] = Number(remote.secretVersion ?? 0);
    if (metadata[providerId]?.syncStatus === 'conflict') {
      await markCredentialSyncStatus(
        providerId,
        'conflict',
        'Choose whether to keep this device credential or the account credential.',
      );
      continue;
    }
    if (metadata[providerId]?.syncStatus === 'pending' && active?.key) {
      const knownBaseVersion = metadata[providerId]?.serverVersion;
      if (knownBaseVersion === Number(remote.secretVersion ?? 0)) {
        const result = await rpc<SecretWriteResponse>('pharmatrack_ai_upsert_secret', {
          p_device_id: session.deviceId,
          p_device_token: session.deviceToken,
          p_provider_id: providerId,
          p_credential_type: 'api_provider_credentials',
          p_base_version: knownBaseVersion,
          p_encrypted_secret: await encryptAccountSecret(
            active.key,
            credentials,
            `${session.userId}:${providerId}`,
          ),
          p_local_version: metadata[providerId]?.localVersion ?? 0,
        });
        if (result.accepted) {
          versions[providerId] = Number(result.secretVersion ?? 0);
          await markCredentialSyncStatus(providerId, 'synced', undefined, versions[providerId]);
          continue;
        }
      }
      await markCredentialSyncStatus(
        providerId,
        'conflict',
        'A newer credential version exists on another device.',
      );
    }
    if (!remote.encryptedSecret) continue;
    const decrypted = await decryptAccountSecret<ProviderCredentials>(
      key,
      remote.encryptedSecret,
      `${session.userId}:${remote.providerId}`,
    );
    await replaceCredentialsFromAccount(providerId, decrypted, versions[providerId]);
  }

  // Providers configured on another device may not exist locally at all.
  for (const remote of remoteRows) {
    if (local[remote.providerId] || !remote.encryptedSecret) continue;
    const remoteVersion = Number(remote.secretVersion ?? 0);
    const localMeta = metadata[remote.providerId];
    if (localMeta?.syncStatus === 'pending' && !localMeta.hasKey) {
      versions[remote.providerId] = remoteVersion;
      if (localMeta.serverVersion === remoteVersion) {
        const result = await rpc<SecretWriteResponse>('pharmatrack_ai_delete_secret', {
          p_device_id: session.deviceId,
          p_device_token: session.deviceToken,
          p_provider_id: remote.providerId,
          p_credential_type: 'api_provider_credentials',
          p_base_version: remoteVersion,
        });
        if (result.accepted) {
          await markCredentialSyncStatus(remote.providerId, 'synced', undefined, remoteVersion);
          delete versions[remote.providerId];
          continue;
        }
      }
      await markCredentialSyncStatus(
        remote.providerId,
        'conflict',
        'The account credential changed while its deletion was pending; choose an explicit resolution.',
      );
      continue;
    }
    if (localMeta?.syncStatus === 'conflict') {
      versions[remote.providerId] = Number(remote.secretVersion ?? 0);
      await markCredentialSyncStatus(
        remote.providerId,
        'conflict',
        'Choose whether to restore or remove the newer account credential.',
      );
      continue;
    }
    const decrypted = await decryptAccountSecret<ProviderCredentials>(
      key,
      remote.encryptedSecret,
      `${session.userId}:${remote.providerId}`,
    );
    versions[remote.providerId] = Number(remote.secretVersion ?? 0);
    await replaceCredentialsFromAccount(remote.providerId, decrypted, versions[remote.providerId]);
  }
  if (active) active.secretVersions = versions;
  return remoteRows.length;
}

async function restoreMetadataOnly(session: DeviceSession): Promise<number> {
  const rows = await getSecretMetadataRows(session);
  const { mergeAccountCredentialStatuses } = await import('./credentials');
  await mergeAccountCredentialStatuses(
    rows.map((row) => ({
      providerId: row.providerId,
      version: Number(row.secretVersion ?? 0),
      updatedAt: row.updatedAt,
    })),
  );
  return rows.length;
}

/**
 * Called after explicit password login. The password is never stored; it is
 * used only to derive the account vault key and then discarded by the caller.
 */
export async function unlockAccountAI(userId: string, password: string): Promise<AccountAIStatus> {
  explicitUnlockInProgress = true;
  try {
    return await initializeAccountAI(userId, password);
  } finally {
    explicitUnlockInProgress = false;
  }
}

/** Called when Supabase restores a session without a password in memory. */
export async function restoreAccountAIFromSession(userId: string): Promise<AccountAIStatus> {
  if (active?.userId === userId && active.key) return status;
  if (explicitUnlockInProgress) return status;
  return initializeAccountAI(userId);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (status.userId && !active && (status.state === 'pending' || status.state === 'error')) {
      void restoreAccountAIFromSession(status.userId);
    }
  });
}

async function initializeAccountAI(userId: string, password?: string): Promise<AccountAIStatus> {
  const generation = ++initializationGeneration;
  setStatus({ state: 'restoring', userId, message: 'Restoring your AI configuration…' });
  try {
    const session = await registerDevice(userId);
    const remote = await getConfiguration(session);
    if (generation !== initializationGeneration) return status;
    const salt = remote?.vaultSalt || createVaultSalt();
    const key = password ? await deriveAccountVaultKey(password, salt) : undefined;
    active = {
      ...session,
      key,
      vaultSalt: salt,
      configVersion: Number(remote?.configVersion ?? 0),
      secretVersions: {},
    };

    const localMeta = localConfigMeta(userId);
    if (remote && Number(remote.configVersion ?? 0) > localMeta.version) {
      await applyRemoteConfiguration(remote, userId);
    } else if (!remote || localMeta.version > Number(remote.configVersion ?? 0)) {
      await writeConfiguration(loadAISettings(), Number(remote?.configVersion ?? 0), salt);
    }

    const configuredSecretCount = key
      ? await restoreSecrets(session, key)
      : await restoreMetadataOnly(session);
    if (generation !== initializationGeneration) return status;

    const next: AccountAIStatus = {
      state: key ? 'ready' : 'locked',
      userId,
      deviceId: session.deviceId,
      configVersion: active.configVersion,
      configuredSecretCount,
      lastSyncedAt: new Date().toISOString(),
      message: key
        ? 'AI configuration restored.'
        : 'AI configuration restored. Provider credentials require password verification on this device.',
    };
    setStatus(next);
    return next;
  } catch (error) {
    if (generation !== initializationGeneration) return status;
    active = null;
    const revoked = error instanceof Error && /revoked|invalid device/i.test(error.message);
    const next: AccountAIStatus = {
      state: revoked ? 'revoked' : offline() ? 'pending' : 'error',
      userId,
      message: offline()
        ? 'You are offline. Local AI settings remain available and synchronization will retry when you reconnect.'
        : 'AI configuration could not be restored.',
    };
    setStatus(next);
    return next;
  }
}

export async function listAccountDevices(): Promise<AccountDevice[]> {
  if (!active) return [];
  return (
    (await rpc<AccountDevice[]>('pharmatrack_ai_list_devices', {
      p_device_id: active.deviceId,
      p_device_token: active.deviceToken,
    })) ?? []
  ).map((device) => ({ ...device, current: device.deviceId === active?.deviceId }));
}

export async function revokeAccountDevice(targetDeviceId: string): Promise<void> {
  if (!active) throw new Error('Sign in to manage account devices.');
  await rpc('pharmatrack_ai_revoke_device', {
    p_device_id: active.deviceId,
    p_device_token: active.deviceToken,
    p_target_device_id: targetDeviceId,
  });
}

export async function deleteAccountAIData(): Promise<void> {
  if (!active) throw new Error('Sign in to delete account AI data.');
  await rpc('pharmatrack_ai_delete_account_data', {
    p_device_id: active.deviceId,
    p_device_token: active.deviceToken,
  });
  const { clearAllCredentials } = await import('./credentials');
  await clearAllCredentials();
  initializationGeneration += 1;
  active = null;
  explicitUnlockInProgress = false;
  setStatus({
    state: 'signed_out',
    message: 'Account AI configuration and credentials were deleted.',
  });
}

/** Clears the in-memory account key/token while retaining encrypted local offline credentials. */
export function lockAccountAI(): void {
  initializationGeneration += 1;
  explicitUnlockInProgress = false;
  active = null;
  configurationQueue = Promise.resolve();
  secretQueues.clear();
  setStatus({ state: 'signed_out', message: 'Account AI session ended.' });
}
