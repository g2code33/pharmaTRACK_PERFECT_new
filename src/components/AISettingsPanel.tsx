/**
 * PharmaTRACK AI — AI Settings.
 *
 * The full multi-provider surface: every provider with its own key/model/status,
 * AI profiles, fallback priority, model capability chips and the privacy
 * promises. It talks only to the engine (`useAI`), so the same screen configures
 * NVIDIA, Gemini, Claude, Groq, OpenRouter, Mistral and any custom
 * OpenAI-compatible endpoint without a provider-specific branch in the UI.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleSlash,
  Eye,
  EyeOff,
  Database,
  Key,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';

import {
  CAPABILITY_LABELS,
  PROVIDER_PRESETS,
  adapterFor,
  modelOptions,
  presetFor,
  requiresKey,
  resolveModelInfo,
  indexableSources,
  loadRagIndex,
  statsFor,
  syncIndex,
  getAIAuditEvents,
  clearAIAuditEvents,
  onAIAudit,
  type AICapability,
  type AIConnectionTest,
  type AIAuditEvent,
  type AIProfile,
  type ProviderConfig,
  type ProviderId,
} from '../ai';
import { blankProvider, useAI } from '../ai/state';
import { useApp } from '../context/AppContext';
import { loadSlideText } from '../utils/storage';
import {
  listAccountDevices,
  revokeAccountDevice,
  unlockAccountAI,
  type AccountDevice,
} from '../ai/accountSync';

const inputCls =
  'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#2D6A4F] focus:border-transparent outline-none text-sm';
const btnPrimary =
  'flex items-center gap-2 px-3 py-2 bg-[#2D6A4F] text-white rounded-lg hover:bg-[#1B4332] text-sm font-medium disabled:opacity-50';
const btnGhost =
  'flex items-center gap-2 px-3 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 text-sm font-medium disabled:opacity-50';

/* ------------------------------------------------------------------ */

export const AISettingsPanel: React.FC = () => {
  const ai = useAI();
  const [expanded, setExpanded] = useState<ProviderId | null>(null);
  const [editing, setEditing] = useState<
    Record<string, Partial<ProviderConfig> & { apiKey?: string }>
  >({});
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<ProviderId | null>(null);
  const [fetching, setFetching] = useState<ProviderId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const crud = (id: ProviderId): Partial<ProviderConfig> & { apiKey?: string } => editing[id] ?? {};

  const setField = (id: ProviderId, patch: Partial<ProviderConfig> & { apiKey?: string }) =>
    setEditing((current) => ({ ...current, [id]: { ...current[id], ...patch } }));

  const save = async (provider: ProviderRow) => {
    const patch = crud(provider.id);
    await ai.saveProvider({
      ...provider,
      ...patch,
      id: provider.id,
      kind: provider.kind,
      protocol: provider.protocol,
      label: patch.label ?? provider.label,
      // `undefined` apiKey means "keep the stored one".
      apiKey: patch.apiKey,
    } as ProviderConfig & { apiKey?: string });
    setEditing((current) => ({ ...current, [provider.id]: {} }));
    setNotice(`${provider.label} saved.`);
    setTimeout(() => setNotice(null), 2500);
  };

  const runTest = async (provider: ProviderRow) => {
    setTesting(provider.id);
    try {
      const patch = crud(provider.id);
      if (patch.apiKey || patch.model || patch.baseUrl) {
        await ai.saveProvider({ ...provider, ...patch, apiKey: patch.apiKey } as ProviderConfig & {
          apiKey?: string;
        });
      }
      const result = await ai.testProvider(
        provider.id,
        (patch.model ?? provider.model) || undefined,
      );
      setNotice(
        result.ok
          ? `${provider.label} connected successfully.`
          : `${provider.label} failed — see the checks below.`,
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Test failed.');
    } finally {
      setTesting(null);
      setTimeout(() => setNotice(null), 4000);
    }
  };

  const fetchModels = async (provider: ProviderRow) => {
    setFetching(provider.id);
    try {
      const models = await ai.fetchModels(provider.id);
      setNotice(
        models.length
          ? `${models.length} model${models.length === 1 ? '' : 's'} fetched from ${provider.label}.`
          : `${provider.label} did not return a model list — type the model id instead.`,
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not fetch models.');
    } finally {
      setFetching(null);
      setTimeout(() => setNotice(null), 4000);
    }
  };

  return (
    <div className="space-y-6" data-testid="ai-settings">
      {notice && (
        <div className="p-3 rounded-xl bg-[#2D6A4F]/5 border border-[#2D6A4F]/20 text-sm text-[#1B4332] flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" /> {notice}
        </div>
      )}

      <PrivacyCard />
      <AccountSyncCard />
      <ProvidersCard
        providers={ai.providers}
        onAdd={(kind) =>
          void ai.saveProvider(
            blankProvider(
              kind,
              ai.providers.map((p) => p.id),
            ),
          )
        }
        expanded={expanded}
        setExpanded={setExpanded}
        crud={crud}
        setField={setField}
        showKey={showKey}
        setShowKey={setShowKey}
        testing={testing}
        fetching={fetching}
        onSave={save}
        onTest={runTest}
        onFetchModels={fetchModels}
        onRemove={(id) => void ai.removeProvider(id)}
      />
      <ProfilesCard />
      <FallbackCard />
      <LocalIndexCard />
      <AdvancedCard />
      <AuditTrailCard />
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Local retrieval index                                              */
/* ------------------------------------------------------------------ */

/**
 * The offline retrieval layer, made visible. Indexing is incremental and
 * local — no network call, no provider, no embedding service — and the index is
 * a derived cache, so rebuilding it is always safe.
 */
const LocalIndexCard: React.FC = () => {
  const { state } = useApp();
  const [stats, setStats] = useState<{ materials: number; chunks: number; chars: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStats(statsFor(await loadRagIndex()));
    } catch {
      setStats(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, state.slides.length]);

  const rebuild = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const index = await syncIndex(indexableSources(state), (id) => loadSlideText(id));
      const next = statsFor(index);
      setStats(next);
      setNotice(
        `Indexed ${next.materials} material${next.materials === 1 ? '' : 's'} · ${next.chunks} passages.`,
      );
    } catch {
      setNotice('Could not rebuild the index. Your materials are untouched.');
    } finally {
      setBusy(false);
      setTimeout(() => setNotice(null), 4000);
    }
  };

  return (
    <section
      className="p-4 bg-white rounded-xl border border-gray-200"
      data-testid="ai-local-index"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-gray-800 flex items-center gap-2">
            <Database className="w-4 h-4 text-[#2D6A4F]" /> Local retrieval index
          </h2>
          <p className="text-xs text-gray-500 mt-1 max-w-xl">
            Your materials are chunked and indexed on this device so a question is answered from the
            pages and slides that actually match — never the whole library. Indexing works offline;
            only generation needs a provider. The index is a derived cache and is never included in
            a semester backup.
          </p>
        </div>
        <button type="button" className={btnGhost} onClick={() => void rebuild()} disabled={busy}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {busy ? 'Indexing…' : 'Rebuild'}
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-center">
        <Stat label="Materials" value={stats?.materials ?? 0} />
        <Stat label="Passages" value={stats?.chunks ?? 0} />
        <Stat label="Characters" value={stats?.chars ?? 0} />
      </dl>

      {notice && (
        <p
          className="mt-2 text-xs text-[#1B4332] flex items-center gap-1.5"
          data-testid="ai-index-notice"
        >
          <CheckCircle2 className="w-3.5 h-3.5" /> {notice}
        </p>
      )}
    </section>
  );
};

const Stat: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="p-2 rounded-lg bg-gray-50 border border-gray-100">
    <dt className="text-[10px] uppercase font-black text-gray-400">{label}</dt>
    <dd
      className="text-lg font-black text-gray-800"
      data-testid={`ai-index-stat-${label.toLowerCase()}`}
    >
      {value.toLocaleString()}
    </dd>
  </div>
);

/* ------------------------------------------------------------------ */
/* Account synchronization                                             */
/* ------------------------------------------------------------------ */

const AccountSyncCard: React.FC = () => {
  const ai = useAI();
  const sync = ai.accountSyncStatus;
  const [devices, setDevices] = useState<AccountDevice[]>([]);
  const [devicesBusy, setDevicesBusy] = useState(false);
  const [vaultPassword, setVaultPassword] = useState('');
  const [unlockBusy, setUnlockBusy] = useState(false);

  const refreshDevices = useCallback(async () => {
    if (
      !sync.userId ||
      sync.state === 'signed_out' ||
      sync.state === 'error' ||
      sync.state === 'revoked'
    ) {
      setDevices([]);
      return;
    }
    setDevicesBusy(true);
    try {
      setDevices(await listAccountDevices());
    } catch {
      setDevices([]);
    } finally {
      setDevicesBusy(false);
    }
  }, [sync.userId, sync.state]);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  const revoke = async (device: AccountDevice) => {
    if (device.current) return;
    setDevicesBusy(true);
    try {
      await revokeAccountDevice(device.deviceId);
      await refreshDevices();
    } catch {
      // Device status remains unchanged when the authenticated revoke fails.
    } finally {
      setDevicesBusy(false);
    }
  };

  const unlock = async () => {
    if (!sync.userId || !vaultPassword) return;
    setUnlockBusy(true);
    try {
      await unlockAccountAI(sync.userId, vaultPassword);
      setVaultPassword('');
    } finally {
      setUnlockBusy(false);
    }
  };
  const labels: Record<string, string> = {
    signed_out: 'Not connected',
    restoring: 'Restoring configuration…',
    ready: 'Restored',
    locked: 'Restored settings locked',
    pending: 'Pending synchronization',
    conflict: 'Conflict needs review',
    revoked: 'Device access revoked',
    error: 'Synchronization error',
  };
  const tone =
    sync.state === 'ready'
      ? 'text-green-700 bg-green-50 border-green-200'
      : sync.state === 'error' || sync.state === 'conflict' || sync.state === 'revoked'
        ? 'text-red-700 bg-red-50 border-red-200'
        : sync.state === 'restoring' || sync.state === 'pending' || sync.state === 'locked'
          ? 'text-amber-700 bg-amber-50 border-amber-200'
          : 'text-gray-600 bg-gray-50 border-gray-200';
  return (
    <section
      className="p-4 bg-white rounded-xl border border-gray-200"
      data-testid="ai-account-sync"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-gray-800 flex items-center gap-2">
            <Shield className="w-4 h-4 text-[#2D6A4F]" /> Account synchronization
          </h2>
          <p className="text-xs text-gray-500 mt-1 max-w-xl">
            Settings synchronize across your signed-in devices. Provider secrets are encrypted for
            recovery and are never included in normal configuration responses.
          </p>
        </div>
        <span
          className={`text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-full border ${tone}`}
        >
          {labels[sync.state] ?? sync.state}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-gray-600">
        <div className="rounded-lg bg-gray-50 p-2">
          Server version <strong>{sync.configVersion ?? '—'}</strong>
        </div>
        <div className="rounded-lg bg-gray-50 p-2">
          Secrets configured <strong>{sync.configuredSecretCount ?? 0}</strong>
        </div>
      </div>
      {sync.message && <p className="mt-2 text-xs text-amber-700">{sync.message}</p>}
      {sync.state === 'locked' && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void unlock();
          }}
        >
          <label className="sr-only" htmlFor="ai-vault-password">
            Account password to unlock AI secrets
          </label>
          <input
            id="ai-vault-password"
            type="password"
            value={vaultPassword}
            onChange={(event) => setVaultPassword(event.target.value)}
            placeholder="Account password to unlock secrets"
            autoComplete="current-password"
            className={`${inputCls} max-w-xs`}
          />
          <button type="submit" className={btnGhost} disabled={unlockBusy || !vaultPassword}>
            {unlockBusy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Key className="w-4 h-4" />
            )}
            {unlockBusy ? 'Unlocking…' : 'Unlock recovered keys'}
          </button>
        </form>
      )}
      {devices.length > 0 && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
              Authorized devices
            </p>
            <button
              type="button"
              className="text-[11px] text-[#2D6A4F]"
              onClick={() => void refreshDevices()}
              disabled={devicesBusy}
            >
              Refresh
            </button>
          </div>
          <ul className="mt-2 space-y-1">
            {devices.map((device) => (
              <li
                key={device.deviceId}
                className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-2 py-1.5 text-xs text-gray-600"
              >
                <span className="truncate">
                  {device.label}
                  {device.current ? ' (this device)' : ''}
                  {device.revokedAt ? ' (revoked)' : ''}
                </span>
                {!device.current && !device.revokedAt && (
                  <button
                    type="button"
                    className="text-red-600 shrink-0"
                    onClick={() => void revoke(device)}
                    disabled={devicesBusy}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};

/* Privacy                                                            */
/* ------------------------------------------------------------------ */

const PrivacyCard: React.FC = () => (
  <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
    <div className="p-4 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
      <ShieldCheck className="w-5 h-5 text-[#2D6A4F]" />
      <h2 className="font-semibold text-gray-800">Privacy &amp; keys</h2>
    </div>
    <div className="p-5 space-y-3 text-sm text-gray-600">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
        <p>
          <strong>Keys are never exported.</strong> API keys are stored separately from your
          academic data, so semester archives and <code>.pharmatrack</code> backups cannot contain
          them.
        </p>
      </div>
      <div className="flex items-start gap-2">
        <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
        <p>
          <strong>Only the selected context is sent.</strong> PharmaTRACK sends the slide/page you
          are looking at, plus your question — not your whole semester. You can see exactly what
          will be sent before each request.
        </p>
      </div>
      <div className="flex items-start gap-2">
        <ShieldCheck className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
        <p>
          <strong>Account recovery is encrypted.</strong> The account copy is an AES-GCM envelope
          derived from your account password. The server receives ciphertext and never receives the
          password or a raw key.
        </p>
      </div>
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
        <p>
          <strong>Device storage is encrypted too.</strong> Local records use the device-encrypted
          storage boundary. Anyone who can fully control an unlocked device can still use its AI
          providers; rotate or revoke keys when needed.
        </p>
      </div>
      <div className="flex items-start gap-2">
        <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
        <p>
          <strong>Keys never appear in URLs.</strong> Providers that support an authentication
          header are always called with one (including Gemini), so keys do not end up in browser
          history or proxy logs.
        </p>
      </div>
      <div className="flex items-start gap-2">
        <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
        <p>
          <strong>One key never travels to another provider.</strong> A request is signed only with
          the credentials of the provider answering it, including when it fell back. A local model
          on this device needs no key at all.
        </p>
      </div>
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/* Providers                                                          */
/* ------------------------------------------------------------------ */

/** A provider row as the panel sees it: config plus what the engine derived. */
type ProviderRow = ProviderConfig & {
  hasKey: boolean;
  accountConfigured: boolean;
  maskedSuffix?: string;
  usable: boolean;
  credentialSyncStatus?: string;
  updatedAt?: string;
};

interface ProvidersCardProps {
  providers: ProviderRow[];
  onAdd: (kind: ProviderConfig['kind']) => void;
  expanded: ProviderId | null;
  setExpanded: (id: ProviderId | null) => void;
  crud: (id: ProviderId) => Partial<ProviderConfig> & { apiKey?: string };
  setField: (id: ProviderId, patch: Partial<ProviderConfig> & { apiKey?: string }) => void;
  showKey: Record<string, boolean>;
  setShowKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  testing: ProviderId | null;
  fetching: ProviderId | null;
  onSave: (p: ProviderRow) => void;
  onTest: (p: ProviderRow) => void;
  onFetchModels: (p: ProviderRow) => void;
  onRemove: (id: ProviderId) => void;
}

const ProvidersCard: React.FC<ProvidersCardProps> = ({
  providers,
  onAdd,
  expanded,
  setExpanded,
  crud,
  setField,
  showKey,
  setShowKey,
  testing,
  fetching,
  onSave,
  onTest,
  onFetchModels,
  onRemove,
}) => {
  const [addOpen, setAddOpen] = useState(false);
  const configuredCount = providers.filter(
    (p) => p.accountConfigured || p.hasKey || !requiresKey(p.kind),
  ).length;

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="p-4 bg-gray-50 border-b border-gray-100 flex items-center justify-between gap-3">
        <h2 className="font-semibold text-gray-800 flex items-center gap-2">
          <Plug className="w-5 h-5 text-[#2D6A4F]" /> AI providers
          <span className="text-xs font-normal text-gray-500">
            {configuredCount} of {providers.length} configured
          </span>
        </h2>
        <button className={btnGhost} onClick={() => setAddOpen((v) => !v)}>
          <Plus className="w-4 h-4" /> Add provider
        </button>
      </div>

      {addOpen && (
        <div className="p-4 border-b border-gray-100 bg-[#2D6A4F]/5">
          <p className="text-xs font-bold text-gray-700 mb-2">Add another provider</p>
          <div className="flex flex-wrap gap-2">
            {PROVIDER_PRESETS.filter((p) => p.kind === 'custom' || p.kind === 'local').map(
              (preset) => (
                <button
                  key={`${preset.kind}-${providers.length}`}
                  className={btnGhost}
                  onClick={() => {
                    onAdd(preset.kind);
                    setAddOpen(false);
                  }}
                >
                  <Plus className="w-4 h-4" /> {preset.label}
                </button>
              ),
            )}
          </div>
          <p className="text-[11px] text-gray-500 mt-2">
            Both slots take any endpoint that speaks <code>/chat/completions</code>. Use{' '}
            <strong>Custom</strong> for a university gateway, Together, Fireworks or vLLM, and{' '}
            <strong>Local model</strong> for Ollama, llama.cpp or LM Studio running on this device —
            those need no API key, only a base URL.
          </p>
        </div>
      )}

      <div className="divide-y divide-gray-100">
        {providers.map((provider) => {
          const preset = presetFor(provider.kind);
          const patch = crud(provider.id);
          const isOpen = expanded === provider.id;
          const test = provider.lastTest;
          const needsKey = requiresKey(provider.kind);
          // A local server is configured without a key, so "no key" is only a
          // problem for providers that authenticate.
          const status = !provider.enabled
            ? 'disabled'
            : needsKey && !provider.hasKey
              ? provider.accountConfigured
                ? 'locked'
                : 'unconfigured'
              : test
                ? test.ok
                  ? 'connected'
                  : 'failed'
                : 'untested';

          return (
            <div key={provider.id} data-testid={`ai-provider-${provider.id}`}>
              <button
                className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-gray-50"
                onClick={() => setExpanded(isOpen ? null : provider.id)}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <StatusDot status={status} />
                  <div className="min-w-0">
                    <p className="font-bold text-sm text-gray-800 truncate flex items-center gap-2">
                      {provider.label}
                      <span
                        className="text-[9px] font-black text-gray-400 bg-gray-100 rounded px-1.5 py-0.5"
                        title="Tried in this order for capability routing and fallback"
                      >
                        #{provider.priority ?? '–'}
                      </span>
                    </p>
                    <p className="text-[11px] text-gray-500 truncate">
                      {needsKey
                        ? provider.hasKey
                          ? `Configured · Key: ${provider.maskedSuffix ?? '••••'}`
                          : provider.accountConfigured
                            ? 'Not configured locally · Key recovered (unlock required)'
                            : 'Not configured — No key set'
                        : 'Local — no key needed'}{' '}
                      · {provider.model || 'no model selected'}
                      {provider.credentialSyncStatus
                        ? ` · Sync: ${provider.credentialSyncStatus}`
                        : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusLabel status={status} />
                  {isOpen ? (
                    <ChevronUp className="w-4 h-4 text-gray-400" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-gray-400" />
                  )}
                </div>
              </button>

              {isOpen && (
                <div className="px-4 pb-4 space-y-3 bg-gray-50/60">
                  <p className="text-[11px] text-gray-500">{preset.hint}</p>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-gray-600 bg-white p-2.5 rounded-lg border border-gray-200">
                    <div>
                      <span className="block text-[10px] font-bold uppercase text-gray-400">
                        Configuration
                      </span>
                      <strong
                        className={
                          provider.hasKey || !needsKey ? 'text-green-700' : 'text-gray-500'
                        }
                      >
                        {provider.hasKey || !needsKey ? 'Configured' : 'Not configured'}
                      </strong>
                    </div>
                    <div>
                      <span className="block text-[10px] font-bold uppercase text-gray-400">
                        Credential
                      </span>
                      <strong className="text-gray-700">
                        {provider.hasKey
                          ? provider.maskedSuffix
                            ? `Masked ${provider.maskedSuffix}`
                            : 'Stored'
                          : 'None'}
                      </strong>
                    </div>
                    <div>
                      <span className="block text-[10px] font-bold uppercase text-gray-400">
                        Sync status
                      </span>
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          provider.credentialSyncStatus === 'synced'
                            ? 'bg-green-100 text-green-800'
                            : provider.credentialSyncStatus === 'conflict'
                              ? 'bg-red-100 text-red-800'
                              : provider.credentialSyncStatus === 'locked'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {provider.credentialSyncStatus ?? 'local only'}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] font-bold uppercase text-gray-400">
                        Last updated
                      </span>
                      <span className="text-gray-600 truncate block" title={provider.updatedAt}>
                        {provider.updatedAt
                          ? new Date(provider.updatedAt).toLocaleDateString()
                          : 'Never'}
                      </span>
                    </div>
                  </div>

                  <label className="block">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                      {needsKey
                        ? provider.hasKey
                          ? 'Replace API key'
                          : 'API key'
                        : 'API key (optional)'}
                    </span>
                    {provider.hasKey && (
                      <p className="text-[11px] text-gray-500 mt-0.5 mb-1">
                        Currently stored: <strong>{provider.maskedSuffix ?? '••••••••'}</strong>.
                        Enter a new key below to replace it.
                      </p>
                    )}
                    <div className="relative mt-1">
                      <input
                        type={showKey[provider.id] ? 'text' : 'password'}
                        value={patch.apiKey ?? ''}
                        placeholder={
                          provider.hasKey
                            ? '•••••••• (saved — type to replace)'
                            : (preset.keyPlaceholder ?? 'API key')
                        }
                        onChange={(e) => setField(provider.id, { apiKey: e.target.value })}
                        className={inputCls}
                        autoComplete="off"
                        data-testid={`ai-key-${provider.id}`}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setShowKey((s) => ({ ...s, [provider.id]: !s[provider.id] }))
                        }
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        title={showKey[provider.id] ? 'Hide' : 'Show'}
                      >
                        {showKey[provider.id] ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </label>

                  <div className="grid sm:grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                        Model
                      </span>
                      <input
                        list={`models-${provider.id}`}
                        value={patch.model ?? provider.model}
                        onChange={(e) => setField(provider.id, { model: e.target.value })}
                        className={`${inputCls} mt-1`}
                        placeholder="model id"
                        data-testid={`ai-model-${provider.id}`}
                      />
                      <datalist id={`models-${provider.id}`}>
                        {modelOptions(provider).map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    </label>

                    {(preset.configurableBaseUrl || provider.kind === 'custom') && (
                      <label className="block">
                        <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                          Base URL
                        </span>
                        <input
                          value={patch.baseUrl ?? provider.baseUrl}
                          onChange={(e) => setField(provider.id, { baseUrl: e.target.value })}
                          className={`${inputCls} mt-1`}
                          placeholder="https://api.example.com/v1"
                          data-testid={`ai-baseurl-${provider.id}`}
                        />
                      </label>
                    )}
                  </div>

                  {(preset.configFields?.includes('organization') ||
                    preset.configFields?.includes('project')) && (
                    <div className="grid sm:grid-cols-2 gap-3">
                      {preset.configFields?.includes('organization') && (
                        <label className="block">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                            Organization (optional)
                          </span>
                          <input
                            value={patch.organization ?? provider.organization ?? ''}
                            onChange={(e) =>
                              setField(provider.id, { organization: e.target.value })
                            }
                            className={`${inputCls} mt-1`}
                          />
                        </label>
                      )}
                      {preset.configFields?.includes('project') && (
                        <label className="block">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                            Project (optional)
                          </span>
                          <input
                            value={patch.project ?? provider.project ?? ''}
                            onChange={(e) => setField(provider.id, { project: e.target.value })}
                            className={`${inputCls} mt-1`}
                          />
                        </label>
                      )}
                    </div>
                  )}

                  {preset.configFields?.includes('label') && (
                    <label className="block">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                        Display name
                      </span>
                      <input
                        value={patch.label ?? provider.label}
                        onChange={(e) => setField(provider.id, { label: e.target.value })}
                        className={`${inputCls} mt-1`}
                      />
                    </label>
                  )}

                  <div className="grid sm:grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                        Request timeout (seconds)
                      </span>
                      <input
                        type="number"
                        min={5}
                        max={300}
                        value={Math.round((patch.timeoutMs ?? provider.timeoutMs ?? 60_000) / 1000)}
                        onChange={(e) =>
                          setField(provider.id, { timeoutMs: Number(e.target.value) * 1000 })
                        }
                        className={`${inputCls} mt-1`}
                      />
                    </label>
                    <label className="flex items-center gap-2 mt-5 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={patch.streaming ?? provider.streaming}
                        onChange={(e) => setField(provider.id, { streaming: e.target.checked })}
                      />
                      Stream responses when supported
                    </label>
                  </div>

                  <CapabilityChips
                    provider={provider}
                    patch={patch}
                    onDeclare={(caps) => setField(provider.id, { declaredCapabilities: caps })}
                  />

                  <div className="flex flex-wrap gap-2 pt-1">
                    <button className={btnPrimary} onClick={() => onSave(provider)}>
                      <Save className="w-4 h-4" /> Save
                    </button>
                    <button
                      className={btnGhost}
                      onClick={() => onTest(provider)}
                      disabled={testing === provider.id}
                    >
                      {testing === provider.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Zap className="w-4 h-4" />
                      )}
                      Test connection
                    </button>
                    {preset.supportsModelList && (
                      <button
                        className={btnGhost}
                        onClick={() => onFetchModels(provider)}
                        disabled={fetching === provider.id}
                      >
                        {fetching === provider.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4" />
                        )}
                        Fetch models
                      </button>
                    )}
                    <button
                      className={btnGhost}
                      onClick={() => onRemove(provider.id)}
                      title="Revoke and remove key from device and account"
                      data-testid={`ai-remove-${provider.id}`}
                    >
                      <Trash2 className="w-4 h-4 text-red-500" /> Revoke key
                    </button>
                    <label className="flex items-center gap-2 px-2 text-sm text-gray-600">
                      <input
                        type="checkbox"
                        checked={patch.enabled ?? provider.enabled}
                        onChange={(e) => setField(provider.id, { enabled: e.target.checked })}
                      />
                      Enabled
                    </label>
                  </div>

                  {test && <TestReport test={test} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const StatusDot: React.FC<{ status: string }> = ({ status }) => {
  const cls =
    status === 'connected'
      ? 'bg-green-500'
      : status === 'failed'
        ? 'bg-red-500'
        : status === 'unconfigured' || status === 'disabled'
          ? 'bg-gray-300'
          : status === 'locked'
            ? 'bg-amber-400'
            : 'bg-amber-400';
  return <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${cls}`} />;
};

const StatusLabel: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, { text: string; cls: string }> = {
    connected: { text: 'Connected', cls: 'bg-green-50 text-green-700 border-green-200' },
    failed: { text: 'Failed', cls: 'bg-red-50 text-red-700 border-red-200' },
    untested: { text: 'Not tested', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    unconfigured: { text: 'No key', cls: 'bg-gray-50 text-gray-500 border-gray-200' },
    locked: { text: 'Unlock required', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    disabled: { text: 'Disabled', cls: 'bg-gray-50 text-gray-500 border-gray-200' },
  };
  const item = map[status] ?? map.unconfigured;
  return (
    <span
      className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border ${item.cls}`}
    >
      {item.text}
    </span>
  );
};

/** Per-step result of Test connection: endpoint → key → model → generation. */
const TestReport: React.FC<{ test: AIConnectionTest }> = ({ test }) => (
  <div
    className={`rounded-xl border p-3 text-[11px] ${test.ok ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}
    data-testid="ai-test-report"
  >
    <div className="flex items-center gap-2 mb-1">
      {test.ok ? (
        <CheckCircle2 className="w-4 h-4 text-green-600" />
      ) : (
        <CircleSlash className="w-4 h-4 text-red-600" />
      )}
      <span className={`font-bold ${test.ok ? 'text-green-800' : 'text-red-800'}`}>
        {test.ok ? 'Connection OK' : (test.error?.title ?? 'Connection failed')}
      </span>
      {test.latencyMs ? <span className="text-gray-500">({test.latencyMs} ms)</span> : null}
    </div>
    <ul className="space-y-0.5">
      {test.checks.map((c) => (
        <li key={c.name} className="flex items-start gap-1.5">
          <span className={c.ok ? 'text-green-600' : 'text-red-600'}>{c.ok ? '✓' : '✗'}</span>
          <span className="text-gray-700">
            <strong>{c.name}:</strong> {c.detail}
          </span>
        </li>
      ))}
    </ul>
    {test.error && (
      <div className="mt-1 text-red-800">
        <p>{test.error.reason}</p>
        {test.error.checks.length > 0 && (
          <ul className="list-disc list-inside text-[10px]">
            {test.error.checks.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
      </div>
    )}
  </div>
);

/** Capability chips: established facts labelled, assumptions marked as such. */
const CapabilityChips: React.FC<{
  provider: ProviderRow;
  patch: Partial<ProviderConfig>;
  onDeclare: (caps: AICapability[]) => void;
}> = ({ provider, patch, onDeclare }) => {
  const merged = { ...provider, ...patch };
  const adapter = adapterFor(merged);
  const info = resolveModelInfo(merged, merged.model, adapter.baselineCapabilities);
  const declared = new Set(patch.declaredCapabilities ?? provider.declaredCapabilities ?? []);

  const toggle = (cap: AICapability) => {
    const next = new Set(declared);
    if (next.has(cap)) next.delete(cap);
    else next.add(cap);
    onDeclare([...next]);
  };

  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1">
        Capabilities{' '}
        <span className="font-normal normal-case text-gray-400">
          {info.unknown
            ? '(model unknown — only the protocol baseline is claimed)'
            : `(from ${info.source})`}
        </span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(CAPABILITY_LABELS) as AICapability[]).map((cap) => {
          const established = info.capabilitySources[cap];
          const on = info.capabilities.includes(cap);
          return (
            <button
              key={cap}
              type="button"
              onClick={() => toggle(cap)}
              title={
                established
                  ? `Established (${established})${declared.has(cap) ? ' + declared by you' : ''}`
                  : 'Not established — click to declare it yourself'
              }
              className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                established
                  ? 'bg-green-50 text-green-700 border-green-200'
                  : on
                    ? 'bg-[#2D6A4F]/10 text-[#1B4332] border-[#2D6A4F]/30'
                    : 'bg-gray-50 text-gray-400 border-gray-200'
              }`}
            >
              {declared.has(cap) && !established ? '✓ ' : ''}
              {CAPABILITY_LABELS[cap]}
            </button>
          );
        })}
      </div>
      {info.contextWindow ? (
        <p className="text-[10px] text-gray-500 mt-1">
          Context window: {(info.contextWindow / 1000).toFixed(0)}k tokens
          {info.maxOutputTokens ? ` · max output ${info.maxOutputTokens} tokens` : ''}
        </p>
      ) : (
        <p className="text-[10px] text-gray-400 mt-1">
          Context size not established for this model.
        </p>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Profiles                                                           */
/* ------------------------------------------------------------------ */

const ProfilesCard: React.FC = () => {
  const ai = useAI();
  const [openId, setOpenId] = useState<string | null>(null);
  const ready = ai.providers.filter((p) => p.hasKey);

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="p-4 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
        <h2 className="font-semibold text-gray-800 flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-[#FFB703]" /> AI profiles
        </h2>
        <button
          className={btnGhost}
          onClick={() =>
            ai.saveProfile({
              id: `profile-${Date.now()}`,
              name: 'New profile',
              providerId: ready[0]?.id ?? '',
              fallbacks: [],
              useFallback: true,
              temperature: 0.4,
              maxOutputTokens: 1200,
              contextLimitTokens: 12_000,
            })
          }
        >
          <Plus className="w-4 h-4" /> New profile
        </button>
      </div>
      <div className="divide-y divide-gray-100">
        {ai.settings.profiles.map((profile) => (
          <ProfileRow
            key={profile.id}
            profile={profile}
            active={profile.id === ai.settings.activeProfileId}
            open={openId === profile.id}
            onToggle={() => setOpenId(openId === profile.id ? null : profile.id)}
            providers={ai.providers}
          />
        ))}
      </div>
    </div>
  );
};

const ProfileRow: React.FC<{
  profile: AIProfile;
  active: boolean;
  open: boolean;
  onToggle: () => void;
  providers: Array<ProviderRow>;
}> = ({ profile, active, open, onToggle, providers }) => {
  const ai = useAI();
  const [draft, setDraft] = useState<AIProfile>(profile);
  useEffect(() => setDraft(profile), [profile]);

  const providerLabel = (id: ProviderId) =>
    providers.find((p) => p.id === id)?.label ?? (id || 'not set');

  return (
    <div>
      <div className="flex items-center justify-between gap-3 p-4">
        <button className="flex items-center gap-3 min-w-0 text-left" onClick={onToggle}>
          <StatusDot status={active ? 'connected' : 'unconfigured'} />
          <div className="min-w-0">
            <p className="font-bold text-sm text-gray-800 truncate">
              {profile.name}{' '}
              {active && (
                <span className="text-[10px] font-black uppercase text-[#2D6A4F]">active</span>
              )}
            </p>
            <p className="text-[11px] text-gray-500 truncate">
              {providerLabel(profile.providerId)} · {profile.model || 'provider default'}
              {profile.fallbacks.length
                ? ` · fallback: ${profile.fallbacks.map(providerLabel).join(' → ')}`
                : ''}
            </p>
          </div>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {!active && (
            <button className={btnGhost} onClick={() => ai.setActiveProfile(profile.id)}>
              Use
            </button>
          )}
          {profile.id !== 'default' && (
            <button
              className={btnGhost}
              onClick={() => ai.removeProfile(profile.id)}
              title="Delete profile"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="px-4 pb-4 space-y-3 bg-gray-50/60">
          <label className="block">
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
              Name
            </span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className={`${inputCls} mt-1`}
            />
          </label>

          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                Provider
              </span>
              <select
                value={draft.providerId}
                onChange={(e) => setDraft({ ...draft, providerId: e.target.value })}
                className={`${inputCls} mt-1`}
              >
                <option value="">— not configured —</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.hasKey}>
                    {p.label} {p.hasKey ? '' : '(no key)'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                Model override
              </span>
              <input
                value={draft.model ?? ''}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                className={`${inputCls} mt-1`}
                placeholder="provider default"
              />
            </label>
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                Temperature
              </span>
              <input
                type="number"
                step="0.1"
                min={0}
                max={2}
                value={draft.temperature ?? 0.4}
                onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) })}
                className={`${inputCls} mt-1`}
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                Max output tokens
              </span>
              <input
                type="number"
                min={64}
                max={32_000}
                value={draft.maxOutputTokens ?? 1200}
                onChange={(e) => setDraft({ ...draft, maxOutputTokens: Number(e.target.value) })}
                className={`${inputCls} mt-1`}
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
                Context budget (tokens)
              </span>
              <input
                type="number"
                min={500}
                max={200_000}
                value={draft.contextLimitTokens ?? 12_000}
                onChange={(e) => setDraft({ ...draft, contextLimitTokens: Number(e.target.value) })}
                className={`${inputCls} mt-1`}
              />
            </label>
          </div>

          <label className="block">
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
              System instructions
            </span>
            <textarea
              value={draft.systemInstructions ?? ''}
              onChange={(e) => setDraft({ ...draft, systemInstructions: e.target.value })}
              rows={3}
              className={`${inputCls} mt-1`}
            />
          </label>

          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
              Fallback providers (in order)
            </span>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {providers.map((p) => {
                const on = draft.fallbacks.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={!p.hasKey || p.id === draft.providerId}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        fallbacks: on
                          ? draft.fallbacks.filter((f) => f !== p.id)
                          : [...draft.fallbacks, p.id],
                      })
                    }
                    className={`px-2 py-1 rounded-lg text-[11px] font-bold border disabled:opacity-40 ${
                      on
                        ? 'bg-[#2D6A4F] text-white border-[#2D6A4F]'
                        : 'bg-white text-gray-600 border-gray-200'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <label className="flex items-center gap-2 mt-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={draft.useFallback}
                onChange={(e) => setDraft({ ...draft, useFallback: e.target.checked })}
              />
              Allow automatic fallback for this profile
            </label>
          </div>

          <div className="flex gap-2">
            <button className={btnPrimary} onClick={() => ai.saveProfile(draft)}>
              <Save className="w-4 h-4" /> Save profile
            </button>
            <button className={btnGhost} onClick={() => setDraft(profile)}>
              Revert
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Fallback priority                                                  */
/* ------------------------------------------------------------------ */

const FallbackCard: React.FC = () => {
  const ai = useAI();
  const ordered = useMemo(
    () =>
      ai.settings.providerPriority
        .map((id) => ai.providers.find((p) => p.id === id))
        .filter((p): p is ProviderRow => Boolean(p)),
    [ai.providers, ai.settings.providerPriority],
  );

  const move = (index: number, delta: number) => {
    const next = [...ai.settings.providerPriority];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    ai.setProviderPriority(next);
  };

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="p-4 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
        <Shield className="w-5 h-5 text-[#2D6A4F]" />
        <h2 className="font-semibold text-gray-800">Fallback &amp; priority</h2>
      </div>
      <div className="p-5 space-y-3">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={ai.settings.automaticFallback}
            onChange={(e) => ai.setAutomaticFallback(e.target.checked)}
          />
          Automatic fallback — if the selected provider fails, try the next one (you are always told
          which provider answered)
        </label>

        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1">
            Provider priority — #1 answers first; the rest are tried in this order when it fails,
            and the same order is used to route a capability request
          </p>
          <ol className="space-y-1">
            {ordered.map((provider, index) => (
              <li
                key={provider.id}
                className="flex items-center justify-between gap-2 p-2 rounded-lg border border-gray-100"
              >
                <span className="flex items-center gap-2 text-sm">
                  <span className="w-5 h-5 rounded-full bg-gray-100 text-[10px] font-black flex items-center justify-center">
                    {index + 1}
                  </span>
                  <span className="font-medium text-gray-800">{provider.label}</span>
                  {index === 0 && (
                    <span className="text-[10px] font-black uppercase text-[#2D6A4F]">primary</span>
                  )}
                  {requiresKey(provider.kind) && !provider.hasKey && (
                    <span className="text-[10px] text-gray-400">
                      ({provider.accountConfigured ? 'unlock required' : 'no key'})
                    </span>
                  )}
                  {!provider.usable && (
                    <span className="text-[10px] text-gray-400">(disabled)</span>
                  )}
                </span>
                <span className="flex gap-1">
                  <button
                    className="p-1 text-gray-400 hover:text-gray-700"
                    onClick={() => move(index, -1)}
                    title="Move up"
                  >
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button
                    className="p-1 text-gray-400 hover:text-gray-700"
                    onClick={() => move(index, 1)}
                    title="Move down"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Advanced (reset)                                                   */
/* ------------------------------------------------------------------ */

const AdvancedCard: React.FC = () => {
  const ai = useAI();
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="p-4 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
        <Key className="w-5 h-5 text-gray-500" />
        <h2 className="font-semibold text-gray-800">Reset AI configuration</h2>
      </div>
      <div className="p-5 text-sm text-gray-600 space-y-3">
        <p>
          Removes every stored API key and returns all AI settings to their defaults. Your courses,
          materials, notes and past conversations are not touched.
        </p>
        {confirming ? (
          <div className="flex gap-2">
            <button
              className="px-3 py-2 bg-red-600 text-white rounded-lg text-sm font-medium"
              onClick={() => {
                void ai.resetAll();
                setConfirming(false);
              }}
            >
              Yes, remove all AI keys
            </button>
            <button className={btnGhost} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className={btnGhost} onClick={() => setConfirming(true)}>
            <Trash2 className="w-4 h-4" /> Remove all AI keys &amp; reset
          </button>
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Safe Audit Trail                                                   */
/* ------------------------------------------------------------------ */

const AuditTrailCard: React.FC = () => {
  const [events, setEvents] = useState<AIAuditEvent[]>([]);

  const refresh = useCallback(async () => {
    try {
      const list = await getAIAuditEvents();
      setEvents(list);
    } catch {
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onAIAudit(() => {
      void refresh();
    });
  }, [refresh]);

  const clear = async () => {
    await clearAIAuditEvents();
    setEvents([]);
  };

  if (events.length === 0) return null;

  return (
    <section
      className="bg-white rounded-xl border border-gray-200 p-4"
      data-testid="ai-audit-trail"
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="font-semibold text-gray-800 text-sm flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[#2D6A4F]" /> Security &amp; configuration audit
          trail
        </h2>
        <button
          type="button"
          onClick={() => void clear()}
          className="text-[11px] text-gray-400 hover:text-red-600"
          data-testid="ai-clear-audit"
        >
          Clear audit log
        </button>
      </div>
      <div className="divide-y divide-gray-100 max-h-48 overflow-y-auto">
        {events.slice(0, 15).map((evt) => (
          <div key={evt.id} className="py-2 flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 min-w-0 truncate">
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                  evt.action === 'provider test failed'
                    ? 'bg-red-50 text-red-700'
                    : evt.action === 'provider removed'
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-green-50 text-green-700'
                }`}
              >
                {evt.action}
              </span>
              <strong className="text-gray-700">{evt.providerId}</strong>
              {evt.details?.maskedSuffix ? (
                <span className="text-gray-400 font-mono text-[11px]">
                  {String(evt.details.maskedSuffix)}
                </span>
              ) : null}
              {evt.details?.latencyMs ? (
                <span className="text-gray-400 text-[10px]">
                  ({String(evt.details.latencyMs)} ms)
                </span>
              ) : null}
            </div>
            <span className="text-[10px] text-gray-400 shrink-0">
              {new Date(evt.timestamp).toLocaleTimeString()}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
};

export default AISettingsPanel;
