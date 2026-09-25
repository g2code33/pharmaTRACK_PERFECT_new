/** Account AI synchronization contract tests.
 *
 * The transport is mocked at the Supabase RPC boundary; encryption, queueing,
 * locking, conflict and deletion behavior remain real. RLS and SECURITY
 * DEFINER behavior are asserted by the SQL migration contract tests below and
 * still require deployment-level validation against Supabase.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { idbStore, rpcMock } = vi.hoisted(() => ({
  idbStore: new Map<string, unknown>(),
  rpcMock: vi.fn(),
}));

vi.mock('idb-keyval', () => ({
  get: async (key: string) => idbStore.get(key),
  set: async (key: string, value: unknown) => {
    idbStore.set(key, value);
  },
  del: async (key: string) => {
    idbStore.delete(key);
  },
  keys: async () => [...idbStore.keys()],
}));

vi.mock('../utils/supabase', () => ({
  supabase: { rpc: rpcMock },
}));

import { defaultSettings, saveAISettings } from '../ai/settings';
import {
  getAccountAIStatus,
  listAccountDevices,
  lockAccountAI,
  deleteAccountAIData,
  revokeAccountDevice,
  restoreAccountAIFromSession,
  unlockAccountAI,
} from '../ai/accountSync';
import { deleteCredentials, loadAllCredentialStatuses, saveCredentials } from '../ai/credentials';

const SECRET = 'nvapi-account-sync-test-secret-123456';

function responseFor(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'pharmatrack_ai_register_device':
      return { data: { deviceToken: 'device-token-test' }, error: null };
    case 'pharmatrack_ai_get_configuration':
      return { data: { found: false }, error: null };
    case 'pharmatrack_ai_get_secrets':
      return { data: [], error: null };
    case 'pharmatrack_ai_get_secret_metadata':
      return {
        data: [
          {
            providerId: 'nvidia',
            secretVersion: 3,
            updatedAt: '2026-09-25T00:00:00.000Z',
            keyStatus: 'configured',
          },
        ],
        error: null,
      };
    case 'pharmatrack_ai_upsert_configuration':
      return { data: { accepted: true, configVersion: 1 }, error: null };
    case 'pharmatrack_ai_upsert_secret':
      return { data: { accepted: true, secretVersion: 1 }, error: null };
    case 'pharmatrack_ai_get_configuration_for_test':
      return { data: args, error: null };
    case 'pharmatrack_ai_list_devices':
      return {
        data: [
          {
            deviceId: args.p_device_id,
            label: 'Current browser',
            createdAt: '2026-01-01',
            lastActiveAt: '2026-09-25',
          },
          {
            deviceId: 'device-old',
            label: 'Old laptop',
            createdAt: '2026-01-02',
            lastActiveAt: '2026-08-25',
          },
        ],
        error: null,
      };
    case 'pharmatrack_ai_revoke_device':
    case 'pharmatrack_ai_delete_account_data':
      return { data: null, error: null };
    default:
      return { data: null, error: null };
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  idbStore.clear();
  localStorage.clear();
  rpcMock.mockReset();
  rpcMock.mockImplementation(responseFor);
  lockAccountAI();
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
});

afterEach(() => {
  lockAccountAI();
});

describe('account AI synchronization', () => {
  it('sends key-free configuration and encrypted secret envelopes', async () => {
    await expect(unlockAccountAI('user-a', 'account-password')).resolves.toMatchObject({
      state: 'ready',
    });

    const settings = defaultSettings();
    settings.providers = settings.providers.map((provider) =>
      provider.id === 'nvidia'
        ? {
            ...provider,
            enabled: true,
            apiKey: SECRET,
            baseUrl: 'https://gateway.example/v1?api_key=should-not-persist',
          }
        : provider,
    );
    saveAISettings(settings);
    await saveCredentials('nvidia', { apiKey: SECRET });
    await flush();

    const configWrites = rpcMock.mock.calls.filter(
      ([name]) => name === 'pharmatrack_ai_upsert_configuration',
    );
    const secretWrites = rpcMock.mock.calls.filter(
      ([name]) => name === 'pharmatrack_ai_upsert_secret',
    );
    expect(configWrites.length).toBeGreaterThan(0);
    expect(secretWrites.length).toBeGreaterThan(0);
    const configPayload = JSON.stringify(configWrites[configWrites.length - 1]?.[1]);
    const secretPayload = JSON.stringify(secretWrites[secretWrites.length - 1]?.[1]);
    expect(configPayload).not.toContain(SECRET);
    expect(configPayload).not.toContain('apiKey');
    expect(configPayload).not.toContain('api_key=');
    expect(secretPayload).not.toContain(SECRET);
    expect(secretPayload).toContain('AES-GCM-256');
  });

  it('surfaces configuration version conflicts without overwriting a newer remote copy', async () => {
    await unlockAccountAI('user-a', 'account-password');
    const remoteSettings = defaultSettings();
    rpcMock.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'pharmatrack_ai_upsert_configuration') {
        return {
          data: {
            accepted: false,
            conflict: true,
            configVersion: 9,
            configuration: {
              found: true,
              configVersion: 9,
              settings: remoteSettings,
              vaultSalt: 'remote-salt',
              updatedAt: '2026-09-25T00:00:00.000Z',
            },
          },
          error: null,
        };
      }
      return responseFor(name, args);
    });
    saveAISettings({ ...defaultSettings(), automaticFallback: false });
    await flush();
    expect(getAccountAIStatus().state).toBe('conflict');
    expect(getAccountAIStatus().configVersion).toBe(9);
  });

  it('restores metadata without decrypting secrets when the account vault is locked', async () => {
    const result = await restoreAccountAIFromSession('user-a');
    expect(result.state).toBe('locked');
    expect(result.configuredSecretCount).toBe(1);
    const statuses = await loadAllCredentialStatuses();
    expect(statuses.nvidia?.accountConfigured).toBe(true);
    expect(statuses.nvidia?.hasKey).toBe(false);
    expect(JSON.stringify(statuses)).not.toContain(SECRET);
  });

  it('tracks device awareness and supports authenticated revocation', async () => {
    await unlockAccountAI('user-a', 'account-password');
    const devices = await listAccountDevices();
    expect(devices).toHaveLength(2);
    expect(devices.find((device) => device.deviceId === devices[0].deviceId)?.current).toBe(true);
    await revokeAccountDevice('device-old');
    expect(
      rpcMock.mock.calls.some(
        ([name, args]) =>
          name === 'pharmatrack_ai_revoke_device' && args.p_target_device_id === 'device-old',
      ),
    ).toBe(true);
  });

  it('cleans local account AI data after server deletion succeeds', async () => {
    await unlockAccountAI('user-a', 'account-password');
    await saveCredentials('nvidia', { apiKey: SECRET });
    await flush();
    await deleteAccountAIData();
    expect(getAccountAIStatus().state).toBe('signed_out');
    expect(await loadAllCredentialStatuses()).toEqual({});
    expect(idbStore.has('pharmatrack_ai_credentials')).toBe(false);
  });

  it('preserves an offline deletion as a pending tombstone instead of restoring the key', async () => {
    await unlockAccountAI('user-a', 'account-password');
    await saveCredentials('nvidia', { apiKey: SECRET });
    await flush();
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    rpcMock.mockRejectedValue(new Error('network unavailable'));
    await deleteCredentials('nvidia');
    await flush();
    expect((await loadAllCredentialStatuses()).nvidia?.syncStatus).toBe('pending');
    expect((await loadAllCredentialStatuses()).nvidia?.hasKey).toBe(false);
  });

  it('keeps local operation available and marks restoration pending while offline', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    rpcMock.mockRejectedValue(new Error('network unavailable'));
    const result = await restoreAccountAIFromSession('user-a');
    expect(result.state).toBe('pending');
    expect(result.message).toMatch(/offline/i);
  });
});

// Keep this test intentionally small and text-based: it proves the checked-in
// deployment contract contains the ownership and no-plaintext guardrails.
describe('Supabase AI sync migration contract', () => {
  it('contains user ownership, direct-access denial, version conflicts and cleanup', async () => {
    const sql = await (
      await import('node:fs/promises')
    ).readFile('supabase/ai-account-sync.sql', 'utf8');
    expect(sql).toContain('references auth.users(id) on delete cascade');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('revoke all on function public.pharmatrack_ai_get_secrets');
    expect(sql).toContain('p_base_version < row.config_version');
    expect(sql).toContain('p_base_version < row.secret_version');
    expect(sql).toContain('pharmatrack_ai_delete_account_data');
    expect(sql).toContain('AES-GCM-256');
    expect(sql).toContain('Sensitive credential fields are not accepted');
  });
});
