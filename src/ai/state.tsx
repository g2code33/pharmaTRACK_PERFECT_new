/**
 * PharmaTRACK AI Engine — React binding.
 *
 * Keeps the UI in sync with the engine without letting any component touch an
 * adapter, a URL or a key. Two providers:
 *
 *   <AIProvider>        settings + credentials + mutations (AI Settings screen)
 *   <AIConversation…>   a single live conversation (chat panel)
 *
 * Credentials are loaded asynchronously and only ever exposed as booleans
 * (`hasKey`) — the key itself never enters React state, so it cannot end up in
 * a devtools snapshot, a re-render or a crash report.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AIConnectionTest,
  AIConversation,
  AIProfile,
  AISettings,
  ModelInfo,
  ProviderConfig,
  ProviderId,
} from './types';
import { aiManager, onAIStatus } from './manager';
import {
  deleteCredentials,
  loadAllCredentialStatuses,
  onCredentialsChanged,
  saveCredentials,
  clearAllCredentials,
} from './credentials';
import {
  clearAISettings,
  mergeModels as mergeModelLists,
  saveAISettings,
  withPriority,
} from './settings';
import { defaultSettings, normalizeSettings } from './settings';
import { createProviderConfig } from './settings';
import { presetFor, protocolForKind, requiresKey } from './providers';
import { AI_SETTINGS_KEY } from './settings';
import {
  deleteAccountAIData,
  getAccountAIStatus,
  onAccountAIStatus,
  type AccountAIStatus,
} from './accountSync';

interface AIProviderState {
  settings: AISettings;
  /** Provider configs annotated with non-secret credential status only. */
  providers: Array<
    ProviderConfig & {
      hasKey: boolean;
      accountConfigured: boolean;
      maskedSuffix?: string;
      usable: boolean;
      credentialSyncStatus?: string;
      updatedAt?: string;
    }
  >;
  credentialsLoaded: boolean;
  accountSyncStatus: AccountAIStatus;
  /** Providers that are enabled *and* keyed, newest test result included. */
  readyCount: number;
  /** True when at least one configured provider could answer right now. */
  ready: boolean;
  /** Human label of the provider the engine would use for the active profile. */
  activeProviderLabel: string;
  /** The model that provider would use (may be empty for manual entry). */
  activeModel: string;
  activeProfile: AIProfile;
  saveProvider: (provider: ProviderConfig & { apiKey?: string }) => Promise<void>;
  removeProvider: (id: ProviderId) => Promise<void>;
  testProvider: (id: ProviderId, model?: string) => Promise<AIConnectionTest>;
  fetchModels: (id: ProviderId) => Promise<ModelInfo[]>;
  saveProfile: (profile: AIProfile) => void;
  removeProfile: (id: string) => void;
  setActiveProfile: (id: string) => void;
  setAutomaticFallback: (enabled: boolean) => void;
  setProviderPriority: (ids: ProviderId[]) => void;
  /** Writes settings + credentials and refreshes the manager. */
  commit: (
    next: AISettings,
    creds?: {
      id: ProviderId;
      apiKey?: string;
      organization?: string;
      project?: string;
      headers?: Record<string, string>;
    },
  ) => Promise<void>;
  resetAll: () => Promise<void>;
}

const AIContext = createContext<AIProviderState | undefined>(undefined);

/** Reads settings, tolerating a legacy blob that predates the AI engine. */
function readSettings(): AISettings {
  const settings = aiManager.getSettings();
  return settings?.providers?.length ? settings : normalizeSettings(defaultSettings());
}

export const AIProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<AISettings>(readSettings);
  const [credentialStatuses, setCredentialStatuses] = useState<
    Record<ProviderId, Awaited<ReturnType<typeof loadAllCredentialStatuses>>[ProviderId]>
  >({});
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  const [accountSyncStatus, setAccountSyncStatus] = useState<AccountAIStatus>(getAccountAIStatus);

  // Load statuses only. Raw credentials remain inside AIManager's execution
  // path and never enter React state, component props, or DOM snapshots.
  const refreshCredentials = useCallback(async () => {
    const statuses = await loadAllCredentialStatuses();
    setCredentialStatuses(statuses);
    setCredentialsLoaded(true);
    return statuses;
  }, []);

  useEffect(() => {
    void refreshCredentials();
    const unsubSync = onAccountAIStatus((next) => {
      setAccountSyncStatus(next);
      if (next.state === 'signed_out') aiManager.clearCredentialCache();
      else aiManager.reload();
      void refreshCredentials();
      setSettings(aiManager.getSettings());
    });
    const unsubCreds = onCredentialsChanged(() => {
      aiManager.clearCredentialCache();
      void refreshCredentials();
      setSettings(aiManager.getSettings());
    });
    return () => {
      unsubSync();
      unsubCreds();
    };
  }, [refreshCredentials]);

  // Pick up settings written by another tab/tool (storage event).
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === AI_SETTINGS_KEY) {
        aiManager.reload();
        setSettings(aiManager.getSettings());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const commit = useCallback(
    async (
      next: AISettings,
      creds?: {
        id: ProviderId;
        apiKey?: string;
        organization?: string;
        project?: string;
        headers?: Record<string, string>;
      },
    ) => {
      // withPriority keeps each provider's rank in step with the ordered list,
      // so adding or removing a provider cannot leave the ranks out of sync.
      const saved = saveAISettings(withPriority(next, next.providerPriority));
      aiManager.updateSettings(saved);
      if (creds) {
        // apiKey === undefined means "leave the stored one alone"; '' clears it.
        const patch: {
          apiKey?: string;
          organization?: string;
          project?: string;
          headers?: Record<string, string>;
        } = {
          organization: creds.organization,
          project: creds.project,
          headers: creds.headers,
        };
        if (creds.apiKey !== undefined) patch.apiKey = creds.apiKey;
        await saveCredentials(creds.id, patch, { preserveExisting: true });
        await refreshCredentials();
      }
      aiManager.reload();
      setSettings(aiManager.getSettings());
    },
    [refreshCredentials],
  );

  const providers = useMemo(
    () =>
      settings.providers.map((p) => {
        const credentialStatus = credentialStatuses[p.id];
        const hasKey = Boolean(credentialStatus?.hasKey);
        return {
          ...p,
          hasKey,
          accountConfigured: Boolean(credentialStatus?.accountConfigured || hasKey),
          maskedSuffix: credentialStatus?.maskedSuffix,
          credentialSyncStatus: credentialStatus?.syncStatus,
          updatedAt: credentialStatus?.updatedAt,
          // A local server answers with no key, so "usable" is not "has a key".
          usable: p.enabled && (hasKey || !requiresKey(p.kind)),
        };
      }),
    [settings.providers, credentialStatuses],
  );

  const value = useMemo<AIProviderState>(() => {
    /**
     * The live settings, not the ones captured when this render happened.
     * Two UI actions can land in the same tick (add a key, then point the
     * profile at that provider); building the second write on a stale snapshot
     * would silently undo the first, so every mutator starts from the manager.
     */
    const current = () => aiManager.getSettings();
    const activeProfile =
      settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0];

    // Who would answer a request right now? The active profile's provider when
    // it is usable, otherwise the first usable provider in priority order —
    // the same order the manager falls through, so the UI never claims
    // something the engine would not actually do.
    const usable = (id: ProviderId) => providers.find((p) => p.id === id && p.usable);
    const routed =
      usable(activeProfile.providerId) ?? settings.providerPriority.map(usable).find(Boolean);
    const readyCount = providers.filter((p) => p.usable).length;

    return {
      settings,
      providers,
      credentialsLoaded,
      accountSyncStatus,
      readyCount,
      ready: Boolean(routed),
      activeProviderLabel: routed?.label ?? '',
      activeModel:
        (routed && (activeProfile.providerId === routed.id ? activeProfile.model : undefined)) ||
        routed?.model ||
        '',
      activeProfile,

      async saveProvider(provider) {
        const { apiKey, ...rest } = provider;
        const base = current();
        const exists = base.providers.some((p) => p.id === rest.id);
        const next: AISettings = exists
          ? {
              ...base,
              providers: base.providers.map((p) => (p.id === rest.id ? { ...p, ...rest } : p)),
            }
          : {
              ...base,
              providers: [...base.providers, { ...rest }],
              providerPriority: base.providerPriority.includes(rest.id)
                ? base.providerPriority
                : [...base.providerPriority, rest.id],
            };
        await commit(next, {
          id: rest.id,
          apiKey,
          organization: rest.organization,
          project: rest.project,
          headers: rest.headers,
        });
      },

      async removeProvider(id) {
        const base = current();
        const next: AISettings = {
          ...base,
          providers: base.providers
            .map((p) =>
              p.kind === 'custom' || p.kind === 'local'
                ? p
                : { ...p, enabled: false, lastTest: undefined, models: undefined },
            )
            .filter((p) => p.id !== id || p.kind === 'custom' || p.kind === 'local'),
          profiles: base.profiles.map((p) => ({
            ...p,
            providerId: p.providerId === id ? '' : p.providerId,
            fallbacks: p.fallbacks.filter((f) => f !== id),
          })),
          providerPriority: base.providerPriority.filter((pid) => pid !== id),
        };
        await deleteCredentials(id);
        await commit(next);
      },

      async testProvider(id, model) {
        const result = await aiManager.testConnection(id, model);
        setSettings(aiManager.getSettings());
        return result;
      },

      async fetchModels(id) {
        const models = await aiManager.listModels(id);
        if (models.length) {
          const base = current();
          const next: AISettings = {
            ...base,
            providers: base.providers.map((p) =>
              p.id === id ? { ...p, models: mergeModelLists(p.models, models, 'provider') } : p,
            ),
          };
          await commit(next);
        }
        return models;
      },

      saveProfile(profile) {
        const base = current();
        const exists = base.profiles.some((p) => p.id === profile.id);
        void commit({
          ...base,
          profiles: exists
            ? base.profiles.map((p) => (p.id === profile.id ? profile : p))
            : [...base.profiles, profile],
        });
      },

      removeProfile(id) {
        if (id === 'default') return; // the default profile is structural
        const base = current();
        void commit({
          ...base,
          profiles: base.profiles.filter((p) => p.id !== id),
          activeProfileId: base.activeProfileId === id ? 'default' : base.activeProfileId,
        });
      },

      setActiveProfile(id) {
        void commit({ ...current(), activeProfileId: id });
      },

      setAutomaticFallback(enabled) {
        void commit({ ...current(), automaticFallback: enabled });
      },

      setProviderPriority(ids) {
        void commit({ ...current(), providerPriority: ids });
      },

      commit,

      async resetAll() {
        if (accountSyncStatus.userId && accountSyncStatus.state !== 'signed_out') {
          try {
            await deleteAccountAIData();
          } catch {
            // Preserve the local reset even when the account is offline; the server copy remains subject to restore conflict handling.
          }
        }
        clearAISettings();
        await clearAllCredentials();
        const fresh = normalizeSettings(defaultSettings());
        aiManager.updateSettings(fresh);
        setSettings(fresh);
        await refreshCredentials();
      },
    };
  }, [settings, providers, credentialsLoaded, accountSyncStatus, commit, refreshCredentials]);

  return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
};

export function useAI(): AIProviderState {
  const context = useContext(AIContext);
  if (!context) throw new Error('useAI must be used inside <AIProvider>');
  return context;
}

/**
 * Convenience: a new provider from a preset (used by “Add provider”). Several
 * instances of the same kind are allowed — a second gateway or a second local
 * runtime gets its own id, so it can hold its own base URL, model and priority.
 */
export function blankProvider(
  kind: ProviderConfig['kind'],
  existingIds: string[] = [],
): ProviderConfig & { apiKey?: string } {
  const preset = presetFor(kind);
  let id = kind as string;
  for (let n = 2; existingIds.includes(id); n += 1) id = `${kind}-${n}`;
  const config = createProviderConfig({ kind, id });
  return { ...config, protocol: protocolForKind(kind), baseUrl: preset.baseUrl, enabled: true };
}

/* ------------------------------------------------------------------ */
/* Status line (streaming/fallback feedback)                          */
/* ------------------------------------------------------------------ */

export interface AIStatusState {
  status: 'idle' | 'connecting' | 'streaming' | 'done' | 'error' | 'cancelled';
  providerId?: ProviderId;
  model?: string;
  message?: string;
}

/**
 * Live engine status for one run id. The UI uses it for "AI is responding…"
 * and for the "switched to a fallback" notice.
 */
export function useAIStatus(runId: string | undefined): AIStatusState {
  const [state, setState] = useState<AIStatusState>({ status: 'idle' });
  const latest = useRef(runId);
  latest.current = runId;

  useEffect(() => {
    if (!runId) return;
    const off = onAIStatus((event) => {
      if (event.runId !== latest.current) return;
      setState({
        status: event.status,
        providerId: event.providerId,
        model: event.model,
        message: event.message,
      });
    });
    return off;
  }, [runId]);

  return state;
}

/** True when the device currently has no network (live AI is unavailable). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

export type { AIConversation };
