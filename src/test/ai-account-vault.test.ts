/**
 * PharmaTRACK Secure Account AI / API Key Vault Acceptance Tests.
 *
 * Verifies the mandatory acceptance flow across multiple devices:
 *
 * Device A:
 *   → login
 *   → configure NVIDIA / API key
 *   → save
 *   → logout
 *
 * Device B:
 *   → login
 *   → provider appears configured
 *   → AI request succeeds
 *
 * Device A:
 *   → replace key
 *
 * Device B:
 *   → receives updated credential state
 *
 * Device B:
 *   → remove key
 *
 * Device A:
 *   → credential no longer works through PharmaTRACK
 *
 * Also tests:
 *   → Session revocation
 *   → Account deletion
 *   → Provider independence (OpenAI, Gemini, Anthropic, Groq, Mistral, Custom)
 *   → Audit trail recording and secret non-exposure
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Storage mock for Device A and Device B switching
let currentDeviceStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: async (key: string) => currentDeviceStore.get(key),
  set: async (key: string, value: unknown) => {
    currentDeviceStore.set(key, value);
  },
  del: async (key: string) => {
    currentDeviceStore.delete(key);
  },
  keys: async () => [...currentDeviceStore.keys()],
  clear: async () => {
    currentDeviceStore.clear();
  },
}));

// Shared server-side simulation
interface ServerDevice {
  userId: string;
  deviceId: string;
  deviceToken: string;
  label: string;
  revokedAt?: string | null;
}

interface ServerSecret {
  secretId: string;
  userId: string;
  providerId: string;
  credentialType: string;
  encryptedSecret: unknown;
  secretVersion: number;
  localVersion: number;
  updatedAt: string;
  keyStatus: string;
}

interface ServerConfig {
  userId: string;
  configVersion: number;
  settings: unknown;
  vaultSalt: string;
  updatedAt: string;
}

class MockSupabaseServer {
  devices = new Map<string, ServerDevice>();
  configs = new Map<string, ServerConfig>();
  secrets = new Map<string, ServerSecret>(); // key: `${userId}:${providerId}`

  reset() {
    this.devices.clear();
    this.configs.clear();
    this.secrets.clear();
  }

  handleRpc(name: string, args: Record<string, unknown>): { data: unknown; error: unknown } {
    switch (name) {
      case 'pharmatrack_ai_register_device': {
        const deviceId = String(args.p_device_id);
        const existing = this.devices.get(deviceId);
        if (existing?.revokedAt) {
          return { data: null, error: new Error('This device has been revoked.') };
        }
        const deviceToken = `token-${deviceId}`;
        this.devices.set(deviceId, {
          userId: 'user-vault-test',
          deviceId,
          deviceToken,
          label: String(args.p_device_label || 'Test device'),
        });
        return { data: { deviceToken }, error: null };
      }

      case 'pharmatrack_ai_get_configuration': {
        const deviceId = String(args.p_device_id);
        const device = this.devices.get(deviceId);
        if (!device || device.revokedAt) {
          return { data: null, error: new Error('AI device session is revoked or invalid') };
        }
        const config = this.configs.get(device.userId);
        if (!config) return { data: { found: false }, error: null };
        return { data: { found: true, ...config }, error: null };
      }

      case 'pharmatrack_ai_upsert_configuration': {
        const deviceId = String(args.p_device_id);
        const device = this.devices.get(deviceId);
        if (!device || device.revokedAt) {
          return { data: null, error: new Error('AI device session is revoked or invalid') };
        }
        const existing = this.configs.get(device.userId);
        const baseVersion = Number(args.p_base_version ?? 0);
        if (existing && baseVersion < existing.configVersion) {
          return {
            data: {
              accepted: false,
              conflict: true,
              configVersion: existing.configVersion,
              configuration: existing,
            },
            error: null,
          };
        }
        const nextVersion = (existing?.configVersion ?? 0) + 1;
        const saved: ServerConfig = {
          userId: device.userId,
          configVersion: nextVersion,
          settings: args.p_settings,
          vaultSalt: String(args.p_vault_salt),
          updatedAt: new Date().toISOString(),
        };
        this.configs.set(device.userId, saved);
        return { data: { accepted: true, configVersion: nextVersion }, error: null };
      }

      case 'pharmatrack_ai_get_secrets': {
        const deviceId = String(args.p_device_id);
        const device = this.devices.get(deviceId);
        if (!device || device.revokedAt) {
          return { data: null, error: new Error('AI device session is revoked or invalid') };
        }
        const userSecrets = [...this.secrets.values()].filter(
          (s) => s.userId === device.userId && s.keyStatus === 'configured',
        );
        return { data: userSecrets, error: null };
      }

      case 'pharmatrack_ai_get_secret_metadata': {
        const deviceId = String(args.p_device_id);
        const device = this.devices.get(deviceId);
        if (!device || device.revokedAt) {
          return { data: null, error: new Error('AI device session is revoked or invalid') };
        }
        const metadata = [...this.secrets.values()]
          .filter((s) => s.userId === device.userId)
          .map((s) => ({
            providerId: s.providerId,
            secretVersion: s.secretVersion,
            updatedAt: s.updatedAt,
            keyStatus: s.keyStatus,
          }));
        return { data: metadata, error: null };
      }

      case 'pharmatrack_ai_upsert_secret': {
        const deviceId = String(args.p_device_id);
        const device = this.devices.get(deviceId);
        if (!device || device.revokedAt) {
          return { data: null, error: new Error('AI device session is revoked or invalid') };
        }
        const providerId = String(args.p_provider_id);
        const key = `${device.userId}:${providerId}`;
        const existing = this.secrets.get(key);
        const baseVersion = Number(args.p_base_version ?? 0);
        if (existing && baseVersion < existing.secretVersion) {
          return {
            data: { accepted: false, conflict: true, secretVersion: existing.secretVersion },
            error: null,
          };
        }
        const nextVersion = (existing?.secretVersion ?? 0) + 1;
        this.secrets.set(key, {
          secretId: `secret-${providerId}-${nextVersion}`,
          userId: device.userId,
          providerId,
          credentialType: String(args.p_credential_type),
          encryptedSecret: args.p_encrypted_secret,
          secretVersion: nextVersion,
          localVersion: Number(args.p_local_version ?? 0),
          updatedAt: new Date().toISOString(),
          keyStatus: 'configured',
        });
        return { data: { accepted: true, secretVersion: nextVersion }, error: null };
      }

      case 'pharmatrack_ai_delete_secret': {
        const deviceId = String(args.p_device_id);
        const device = this.devices.get(deviceId);
        if (!device || device.revokedAt) {
          return { data: null, error: new Error('AI device session is revoked or invalid') };
        }
        const providerId = String(args.p_provider_id);
        const key = `${device.userId}:${providerId}`;
        const existing = this.secrets.get(key);
        if (!existing) return { data: { accepted: true }, error: null };
        const baseVersion = Number(args.p_base_version ?? 0);
        if (baseVersion < existing.secretVersion) {
          return {
            data: { accepted: false, conflict: true, secretVersion: existing.secretVersion },
            error: null,
          };
        }
        this.secrets.delete(key);
        return { data: { accepted: true }, error: null };
      }

      case 'pharmatrack_ai_list_devices': {
        const deviceId = String(args.p_device_id);
        const device = this.devices.get(deviceId);
        if (!device || device.revokedAt) {
          return { data: null, error: new Error('AI device session is revoked or invalid') };
        }
        const list = [...this.devices.values()].filter((d) => d.userId === device.userId);
        return { data: list, error: null };
      }

      case 'pharmatrack_ai_revoke_device': {
        const deviceId = String(args.p_device_id);
        const device = this.devices.get(deviceId);
        if (!device || device.revokedAt) {
          return { data: null, error: new Error('AI device session is revoked or invalid') };
        }
        const targetId = String(args.p_target_device_id);
        const target = this.devices.get(targetId);
        if (target) {
          target.revokedAt = new Date().toISOString();
        }
        return { data: null, error: null };
      }

      case 'pharmatrack_ai_delete_account_data': {
        const deviceId = String(args.p_device_id);
        const device = this.devices.get(deviceId);
        if (!device || device.revokedAt) {
          return { data: null, error: new Error('AI device session is revoked or invalid') };
        }
        this.configs.delete(device.userId);
        for (const [k, s] of [...this.secrets.entries()]) {
          if (s.userId === device.userId) this.secrets.delete(k);
        }
        for (const [k, d] of [...this.devices.entries()]) {
          if (d.userId === device.userId) this.devices.delete(k);
        }
        return { data: null, error: null };
      }

      default:
        return { data: null, error: null };
    }
  }
}

const server = new MockSupabaseServer();

vi.mock('../utils/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Record<string, unknown>) =>
      Promise.resolve(server.handleRpc(name, args)),
  },
}));

// Import modules under test
import {
  AIManager,
  defaultSettings,
  saveAISettings,
  saveCredentials,
  loadCredentials,
  loadAllCredentialStatuses,
  deleteCredentials,
  getAIAuditEvents,
  clearAIAuditEvents,
} from '../ai';
import {
  unlockAccountAI,
  lockAccountAI,
  restoreAccountAIFromSession,
  getAccountAIStatus,
  deleteAccountAIData,
  revokeAccountDevice,
} from '../ai/accountSync';

const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const DEVICE_A_ID = 'device-alpha-1111';
const DEVICE_B_ID = 'device-beta-2222';
const USER_ID = 'user-vault-test';
const USER_PASSWORD = 'super-secure-student-password-2026';

const INITIAL_NVIDIA_KEY = 'nvapi-initial-nvidia-secret-key-1111';
const REPLACED_NVIDIA_KEY = 'nvapi-replaced-nvidia-secret-key-2222';

describe('PHARMATRACK Secure Account AI / API Key Vault', () => {
  const storeA = new Map<string, unknown>();
  const storeB = new Map<string, unknown>();

  function useDeviceA() {
    currentDeviceStore = storeA;
    localStorage.setItem('pharmatrack_ai_device_id_v1', DEVICE_A_ID);
  }

  function useDeviceB() {
    currentDeviceStore = storeB;
    localStorage.setItem('pharmatrack_ai_device_id_v1', DEVICE_B_ID);
  }

  beforeEach(() => {
    storeA.clear();
    storeB.clear();
    server.reset();
    localStorage.clear();
    lockAccountAI();
    void clearAIAuditEvents();
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  });

  afterEach(() => {
    lockAccountAI();
  });

  it('executes the mandatory acceptance criteria across Device A and Device B', async () => {
    // -------------------------------------------------------------------------
    // Phase 1: Device A → login → configure NVIDIA/API key → save → logout
    // -------------------------------------------------------------------------
    useDeviceA();
    const unlockA = await unlockAccountAI(USER_ID, USER_PASSWORD);
    expect(unlockA.state).toBe('ready');

    const managerA = new AIManager();

    // Enable NVIDIA provider in settings
    const settingsA = defaultSettings();
    settingsA.providers = settingsA.providers.map((p) =>
      p.id === 'nvidia' ? { ...p, enabled: true, model: 'meta/llama-3.3-70b-instruct' } : p,
    );
    saveAISettings(settingsA);

    // Configure NVIDIA API key on Device A
    await saveCredentials('nvidia', { apiKey: INITIAL_NVIDIA_KEY });
    await delay(50); // allow async queue to push to mock server

    // Verify key exists on Device A
    const credsA1 = await managerA.provider('nvidia');
    expect(credsA1?.apiKey).toBe(INITIAL_NVIDIA_KEY);

    // Verify server has encrypted secret (not plaintext)
    expect(server.secrets.has(`${USER_ID}:nvidia`)).toBe(true);
    const serverRow1 = server.secrets.get(`${USER_ID}:nvidia`)!;
    expect(serverRow1.secretVersion).toBe(1);
    expect(JSON.stringify(serverRow1.encryptedSecret)).not.toContain(INITIAL_NVIDIA_KEY);
    expect(JSON.stringify(serverRow1.encryptedSecret)).toContain('AES-GCM-256');

    // Device A logs out
    lockAccountAI();
    managerA.clearCredentialCache();
    expect(getAccountAIStatus().state).toBe('signed_out');

    // -------------------------------------------------------------------------
    // Phase 2: Device B → login → provider appears configured → AI request succeeds
    // -------------------------------------------------------------------------
    useDeviceB();
    const unlockB = await unlockAccountAI(USER_ID, USER_PASSWORD);
    expect(unlockB.state).toBe('ready');

    const managerB = new AIManager();
    await managerB.ensureCredentials();

    // Provider appears configured on Device B
    const statusesB1 = await loadAllCredentialStatuses();
    expect(statusesB1.nvidia?.hasKey).toBe(true);
    expect(statusesB1.nvidia?.maskedSuffix).toBe('••••1111');
    expect(statusesB1.nvidia?.syncStatus).toBe('synced');

    // Resolving provider on Device B returns the decrypted secret
    const credsB1 = await managerB.provider('nvidia');
    expect(credsB1?.apiKey).toBe(INITIAL_NVIDIA_KEY);

    // Mock completion adapter to prove the AI request succeeds using this key
    const completionSpy = vi.fn().mockResolvedValue({
      content: 'Aspirin inhibits COX-1 and COX-2 enzymes.',
      usage: { inputTokens: 10, outputTokens: 8 },
    });
    vi.spyOn(managerB, 'generate').mockImplementation(async (req) => {
      const pid = req.providerId ?? 'nvidia';
      const config = await managerB.provider(pid);
      if (!config?.apiKey) throw new Error('API key required');
      return completionSpy(req);
    });

    const aiResponse = await managerB.generate({
      providerId: 'nvidia',
      model: 'meta/llama-3.3-70b-instruct',
      messages: [{ role: 'user', content: 'Explain aspirin mechanism' }],
    });
    expect(aiResponse.content).toContain('Aspirin inhibits COX-1');
    expect(completionSpy).toHaveBeenCalled();

    // -------------------------------------------------------------------------
    // Phase 3: Device A → replace key
    // -------------------------------------------------------------------------
    useDeviceA();
    await unlockAccountAI(USER_ID, USER_PASSWORD);
    const managerA2 = new AIManager();

    // Replace the NVIDIA key with a new key
    await saveCredentials('nvidia', { apiKey: REPLACED_NVIDIA_KEY });
    await delay(50);

    // Verify key was updated in server with version increment
    const serverRow2 = server.secrets.get(`${USER_ID}:nvidia`)!;
    expect(serverRow2.secretVersion).toBe(2);
    expect(JSON.stringify(serverRow2.encryptedSecret)).not.toContain(REPLACED_NVIDIA_KEY);

    // -------------------------------------------------------------------------
    // Phase 4: Device B → receives updated credential state
    // -------------------------------------------------------------------------
    useDeviceB();
    // Device B synchronizes / unlocks session
    await unlockAccountAI(USER_ID, USER_PASSWORD);
    await delay(50);

    const statusesB2 = await loadAllCredentialStatuses();
    expect(statusesB2.nvidia?.maskedSuffix).toBe('••••2222');
    expect(statusesB2.nvidia?.serverVersion).toBe(2);

    const credsB2 = await managerB.provider('nvidia');
    expect(credsB2?.apiKey).toBe(REPLACED_NVIDIA_KEY);

    // -------------------------------------------------------------------------
    // Phase 5: Device B → remove key
    // -------------------------------------------------------------------------
    useDeviceB();
    await deleteCredentials('nvidia');
    await delay(50);

    // Server secret row is deleted
    expect(server.secrets.has(`${USER_ID}:nvidia`)).toBe(false);

    // Local key on Device B is removed
    const statusesB3 = await loadAllCredentialStatuses();
    expect(statusesB3.nvidia?.hasKey).toBe(false);
    expect(statusesB3.nvidia?.maskedSuffix).toBeUndefined();

    // -------------------------------------------------------------------------
    // Phase 6: Device A → credential no longer works through PharmaTRACK
    // -------------------------------------------------------------------------
    useDeviceA();
    // Device A reconnects and synchronizes
    await unlockAccountAI(USER_ID, USER_PASSWORD);
    await delay(50);

    // Device A's local key must have been removed due to remote deletion
    const credsAAfterSync = await managerA2.provider('nvidia');
    expect(credsAAfterSync?.apiKey).toBeUndefined();

    const statusesA3 = await loadAllCredentialStatuses();
    expect(statusesA3.nvidia?.hasKey).toBe(false);
    expect(statusesA3.nvidia?.maskedSuffix).toBeUndefined();

    // Attempting a real key-requiring AI call on Device A fails
    const realManagerA = new AIManager();
    await expect(
      realManagerA.generate({
        providerId: 'nvidia',
        model: 'meta/llama-3.3-70b-instruct',
        messages: [{ role: 'user', content: 'Test' }],
      }),
    ).rejects.toThrow();
  });

  it('supports session revocation and invalidates subsequent requests', async () => {
    useDeviceA();
    await unlockAccountAI(USER_ID, USER_PASSWORD);
    lockAccountAI();

    useDeviceB();
    await unlockAccountAI(USER_ID, USER_PASSWORD);
    lockAccountAI();

    // Device A logs in and revokes Device B
    useDeviceA();
    await unlockAccountAI(USER_ID, USER_PASSWORD);
    await revokeAccountDevice(DEVICE_B_ID);
    lockAccountAI();

    // Device B attempts to synchronize and receives revocation
    useDeviceB();
    const result = await restoreAccountAIFromSession(USER_ID);
    expect(result.state).toBe('revoked');
  });

  it('supports account deletion and wipes local + remote credentials', async () => {
    useDeviceA();
    await unlockAccountAI(USER_ID, USER_PASSWORD);
    await saveCredentials('nvidia', { apiKey: INITIAL_NVIDIA_KEY });
    await delay(50);

    expect(server.secrets.size).toBe(1);
    expect((await loadCredentials('nvidia')).apiKey).toBe(INITIAL_NVIDIA_KEY);

    await deleteAccountAIData();

    expect(server.secrets.size).toBe(0);
    expect(server.devices.size).toBe(0);
    expect((await loadCredentials('nvidia')).apiKey).toBeUndefined();
    expect(getAccountAIStatus().state).toBe('signed_out');
  });

  it('records safe audit trail events without exposing secrets', async () => {
    useDeviceA();
    await unlockAccountAI(USER_ID, USER_PASSWORD);

    await saveCredentials('nvidia', { apiKey: INITIAL_NVIDIA_KEY });
    await delay(20);

    await saveCredentials('nvidia', { apiKey: REPLACED_NVIDIA_KEY });
    await delay(20);

    await deleteCredentials('nvidia');
    await delay(20);

    const auditEvents = await getAIAuditEvents();
    expect(auditEvents.length).toBeGreaterThanOrEqual(3);

    const actions = auditEvents.map((e) => e.action);
    expect(actions).toContain('provider configured');
    expect(actions).toContain('provider updated');
    expect(actions).toContain('provider removed');

    // CRITICAL: verify no secret ever appears in the audit log
    const auditJson = JSON.stringify(auditEvents);
    expect(auditJson).not.toContain(INITIAL_NVIDIA_KEY);
    expect(auditJson).not.toContain(REPLACED_NVIDIA_KEY);
    expect(auditJson).not.toContain('nvapi-');
    expect(auditJson).toContain('••••1111');
    expect(auditJson).toContain('••••2222');
  });

  it('verifies provider independence across all PharmaTRACK supported providers', async () => {
    useDeviceA();
    await unlockAccountAI(USER_ID, USER_PASSWORD);

    const providersToTest = [
      { id: 'openai' as const, key: 'sk-proj-openai-test-key-1234' },
      { id: 'gemini' as const, key: 'AIzaSyGemini-test-key-5678' },
      { id: 'anthropic' as const, key: 'sk-ant-anthropic-test-key-9012' },
      { id: 'groq' as const, key: 'gsk_groq-test-key-3456' },
      { id: 'openrouter' as const, key: 'sk-or-v1-openrouter-key-7890' },
      { id: 'mistral' as const, key: 'mistral-api-test-key-2468' },
      { id: 'custom' as const, key: 'sk-custom-campus-gw-key-1357' },
    ];

    for (const p of providersToTest) {
      await saveCredentials(p.id, { apiKey: p.key });
    }
    await delay(100);

    // Verify all saved on server
    for (const p of providersToTest) {
      expect(server.secrets.has(`${USER_ID}:${p.id}`)).toBe(true);
      const row = server.secrets.get(`${USER_ID}:${p.id}`)!;
      expect(JSON.stringify(row.encryptedSecret)).not.toContain(p.key);
    }

    // Switch to Device B and verify all restore cleanly
    useDeviceB();
    await unlockAccountAI(USER_ID, USER_PASSWORD);
    await delay(100);

    const managerB = new AIManager();
    for (const p of providersToTest) {
      const resolved = await managerB.provider(p.id);
      expect(resolved?.apiKey).toBe(p.key);
    }
  });
});
