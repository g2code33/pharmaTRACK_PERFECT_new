/**
 * Normal account-owned synchronization.
 *
 * This module deliberately does not know about AppState. The academic
 * workspace, downloaded materials, examination state, LAN sessions and UI
 * caches stay on the device. Only the small, typed records in
 * ACCOUNT_SYNC_RECORD_TYPES may cross the account boundary.
 *
 * Local writes are committed before a network request. A server version is
 * required for every write, so an offline device can never silently replace a
 * newer account record. Conflicts retain both values until the caller makes
 * an explicit choice.
 */
import * as idb from 'idb-keyval';
import { supabase } from '../utils/supabase';

export const ACCOUNT_SYNC_RECORD_TYPES = [
  'profile_preferences',
  'application_settings',
  'ai_profile_selection',
  'permitted_data',
] as const;

export type AccountSyncRecordType = (typeof ACCOUNT_SYNC_RECORD_TYPES)[number];

export type AccountSyncState =
  'signed_out' | 'restoring' | 'ready' | 'pending' | 'conflict' | 'revoked' | 'error';

export interface ProfilePreferences {
  fullName?: string;
  university?: string;
  level?: string;
  program?: string;
  semester?: string;
}

export interface ApplicationSettings {
  theme?: 'light' | 'dark' | 'system';
  compactMode?: boolean;
  notificationsEnabled?: boolean;
  language?: string;
}

export interface AIProfileSelection {
  activeProfileId: string;
}

/**
 * The only currently permitted non-configuration data. This is intentionally
 * preferences, not course content, quiz history, notes, materials, or exam
 * state. Adding a new kind requires a code review and a schema change.
 */
export interface PermittedAccountData {
  kind: 'study_preferences';
  values: {
    dailyGoalMinutes?: number;
    preferredStudyDays?: number[];
    remindersEnabled?: boolean;
  };
}

export type AccountSyncPayload =
  ProfilePreferences | ApplicationSettings | AIProfileSelection | PermittedAccountData;

export interface RemoteAccountRecord {
  recordId: string;
  recordType: AccountSyncRecordType;
  payload: AccountSyncPayload | null;
  version: number;
  updatedAt: string;
  updatedByDeviceId?: string | null;
  deletedAt?: string | null;
}

export interface PendingAccountChange {
  recordId: string;
  recordType: AccountSyncRecordType;
  payload: AccountSyncPayload | null;
  baseVersion: number;
  updatedAt: string;
  deleted: boolean;
  deviceId: string;
  attempts: number;
  lastError?: string;
}

interface LocalAccountRecord extends RemoteAccountRecord {
  /** True while the value has not been confirmed by the server. */
  localOnly?: boolean;
}

export interface AccountSyncStoreState {
  records: Record<string, LocalAccountRecord>;
  pending: Record<string, PendingAccountChange>;
  conflicts: Record<string, { local: LocalAccountRecord; remote: RemoteAccountRecord }>;
  lastSyncedAt?: string;
}

export interface AccountSyncStatus {
  state: AccountSyncState;
  userId?: string;
  pendingCount: number;
  conflictCount: number;
  lastSyncedAt?: string;
  message?: string;
}

export interface AccountSyncTransport {
  currentUserId(): Promise<string | null>;
  pull(userId: string): Promise<RemoteAccountRecord[]>;
  push(
    userId: string,
    change: PendingAccountChange,
  ): Promise<
    | { accepted: true; record: RemoteAccountRecord }
    | { accepted: false; conflict: true; record: RemoteAccountRecord | null }
  >;
}

export interface AccountSyncStore {
  read(userId: string): Promise<AccountSyncStoreState>;
  write(userId: string, state: AccountSyncStoreState): Promise<void>;
  clear(userId: string): Promise<void>;
}

const STORE_PREFIX = 'pharmatrack_account_sync_v1_';
const DEVICE_ID_KEY = 'pharmatrack_account_device_id_v1';
const keyFor = (recordId: string) => recordId;

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Synchronization failed');
}

function isRevokedError(error: unknown): boolean {
  const message = errorMessage(error);
  return /revoked|invalid token|jwt|not authenticated|authentication required|session expired/i.test(
    message,
  );
}

function isNetworkError(error: unknown): boolean {
  if (isOffline()) return true;
  const message = errorMessage(error);
  return /network|fetch|failed to fetch|timeout|offline|load failed/i.test(message);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Account synchronization payload must be an object.');
  }
  return value as Record<string, unknown>;
}

function assertOnlyFields(value: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`Account field is not permitted: ${unexpected}`);
}

function optionalString(value: unknown, field: string, max = 240): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max)
    throw new Error(`Invalid account field: ${field}`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Invalid account field: ${field}`);
  return value;
}

/**
 * Whitelist and normalize the payload before it is written to IndexedDB or
 * sent to Supabase. This is the boundary that prevents accidental AppState or
 * examination uploads.
 */
export function sanitizeAccountPayload(
  recordType: AccountSyncRecordType,
  input: unknown,
): AccountSyncPayload {
  const value = asObject(input);
  if (recordType === 'profile_preferences') {
    assertOnlyFields(value, ['fullName', 'university', 'level', 'program', 'semester']);
    return {
      fullName: optionalString(value.fullName, 'fullName'),
      university: optionalString(value.university, 'university'),
      level: optionalString(value.level, 'level', 80),
      program: optionalString(value.program, 'program'),
      semester: optionalString(value.semester, 'semester', 80),
    };
  }
  if (recordType === 'application_settings') {
    assertOnlyFields(value, ['theme', 'compactMode', 'notificationsEnabled', 'language']);
    const theme = value.theme;
    if (theme != null && theme !== 'light' && theme !== 'dark' && theme !== 'system') {
      throw new Error('Invalid account field: theme');
    }
    return {
      theme: theme as ApplicationSettings['theme'],
      compactMode: optionalBoolean(value.compactMode, 'compactMode'),
      notificationsEnabled: optionalBoolean(value.notificationsEnabled, 'notificationsEnabled'),
      language: optionalString(value.language, 'language', 20),
    };
  }
  if (recordType === 'ai_profile_selection') {
    assertOnlyFields(value, ['activeProfileId']);
    const activeProfileId = optionalString(value.activeProfileId, 'activeProfileId', 120);
    if (!activeProfileId) throw new Error('An active AI profile is required.');
    return { activeProfileId };
  }

  assertOnlyFields(value, ['kind', 'values']);
  if (value.kind !== 'study_preferences')
    throw new Error('This permitted account record is not supported.');
  const values = asObject(value.values);
  assertOnlyFields(values, ['dailyGoalMinutes', 'preferredStudyDays', 'remindersEnabled']);
  const dailyGoalMinutes = values.dailyGoalMinutes;
  if (
    dailyGoalMinutes != null &&
    (typeof dailyGoalMinutes !== 'number' ||
      !Number.isInteger(dailyGoalMinutes) ||
      dailyGoalMinutes < 0 ||
      dailyGoalMinutes > 1440)
  ) {
    throw new Error('Invalid study preference: dailyGoalMinutes');
  }
  const preferredStudyDays = values.preferredStudyDays;
  if (
    preferredStudyDays != null &&
    (!Array.isArray(preferredStudyDays) ||
      preferredStudyDays.some(
        (day) => typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6,
      ))
  ) {
    throw new Error('Invalid study preference: preferredStudyDays');
  }
  return {
    kind: 'study_preferences',
    values: {
      dailyGoalMinutes: dailyGoalMinutes as number | undefined,
      preferredStudyDays: preferredStudyDays as number[] | undefined,
      remindersEnabled: optionalBoolean(values.remindersEnabled, 'remindersEnabled'),
    },
  };
}

function normalizeRemote(value: RemoteAccountRecord): RemoteAccountRecord {
  return {
    ...value,
    recordId: String(value.recordId),
    version: Number(value.version),
    payload: value.deletedAt ? null : sanitizeAccountPayload(value.recordType, value.payload),
  };
}

function normalizeState(value: AccountSyncStoreState | null | undefined): AccountSyncStoreState {
  if (!value || typeof value !== 'object') return { records: {}, pending: {}, conflicts: {} };
  return {
    records: value.records && typeof value.records === 'object' ? value.records : {},
    pending: value.pending && typeof value.pending === 'object' ? value.pending : {},
    conflicts: value.conflicts && typeof value.conflicts === 'object' ? value.conflicts : {},
    lastSyncedAt: value.lastSyncedAt,
  };
}

export class IndexedDbAccountSyncStore implements AccountSyncStore {
  private readonly fallback = new Map<string, AccountSyncStoreState>();

  async read(userId: string): Promise<AccountSyncStoreState> {
    try {
      return normalizeState(await idb.get(`${STORE_PREFIX}${userId}`));
    } catch {
      // A restricted webview/test environment may not expose IndexedDB. Keep
      // the app usable in memory rather than turning a boot-time restore into
      // an unhandled rejection. Real supported browsers use the durable path.
      return normalizeState(this.fallback.get(userId));
    }
  }

  async write(userId: string, state: AccountSyncStoreState): Promise<void> {
    try {
      await idb.set(`${STORE_PREFIX}${userId}`, state);
    } catch {
      this.fallback.set(userId, normalizeState(state));
    }
  }

  async clear(userId: string): Promise<void> {
    this.fallback.delete(userId);
    try {
      await idb.del(`${STORE_PREFIX}${userId}`);
    } catch {
      // The in-memory fallback was cleared above.
    }
  }
}

export class MemoryAccountSyncStore implements AccountSyncStore {
  private readonly values = new Map<string, AccountSyncStoreState>();

  async read(userId: string): Promise<AccountSyncStoreState> {
    return normalizeState(this.values.get(userId));
  }

  async write(userId: string, state: AccountSyncStoreState): Promise<void> {
    this.values.set(userId, JSON.parse(JSON.stringify(state)) as AccountSyncStoreState);
  }

  async clear(userId: string): Promise<void> {
    this.values.delete(userId);
  }
}

export class AccountSyncEngine {
  private activeUserId: string | null = null;
  private status: AccountSyncStatus = { state: 'signed_out', pendingCount: 0, conflictCount: 0 };
  private readonly listeners = new Set<(status: AccountSyncStatus) => void>();
  private readonly inFlight = new Map<string, Promise<AccountSyncStatus>>();

  constructor(
    private readonly transport: AccountSyncTransport,
    private readonly store: AccountSyncStore,
    private readonly getDeviceId: () => string = defaultDeviceId,
  ) {}

  getStatus(): AccountSyncStatus {
    return this.status;
  }

  subscribe(listener: (status: AccountSyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(next: AccountSyncStatus): AccountSyncStatus {
    this.status = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        /* observers are never synchronization dependencies */
      }
    }
    return next;
  }

  private statusFor(
    userId: string,
    state: AccountSyncState,
    local: AccountSyncStoreState,
    message?: string,
  ): AccountSyncStatus {
    return this.setStatus({
      state,
      userId,
      pendingCount: Object.keys(local.pending).length,
      conflictCount: Object.keys(local.conflicts).length,
      lastSyncedAt: local.lastSyncedAt,
      message,
    });
  }

  private async authenticated(userId: string): Promise<void> {
    const current = await this.transport.currentUserId();
    if (!current || current !== userId)
      throw new Error('The account session is revoked or no longer active.');
  }

  async queue(
    userId: string,
    recordId: string,
    recordType: AccountSyncRecordType,
    input: AccountSyncPayload,
  ): Promise<AccountSyncStatus> {
    if (!ACCOUNT_SYNC_RECORD_TYPES.includes(recordType))
      throw new Error('This record type is not syncable.');
    if (!recordId || recordId.length > 160)
      throw new Error('A stable account record ID is required.');
    const payload = sanitizeAccountPayload(recordType, input);
    const local = await this.store.read(userId);
    const existing = local.records[keyFor(recordId)];
    const existingPending = local.pending[keyFor(recordId)];
    const existingConflict = local.conflicts[keyFor(recordId)];
    const baseVersion =
      existingConflict?.remote.version ?? existingPending?.baseVersion ?? existing?.version ?? 0;
    const now = new Date().toISOString();
    local.records[keyFor(recordId)] = {
      recordId,
      recordType,
      payload,
      version: existing?.version ?? baseVersion,
      updatedAt: now,
      updatedByDeviceId: this.getDeviceId(),
      deletedAt: null,
      localOnly: true,
    };
    local.pending[keyFor(recordId)] = {
      recordId,
      recordType,
      payload,
      baseVersion,
      updatedAt: now,
      deleted: false,
      deviceId: this.getDeviceId(),
      attempts: existingPending?.attempts ?? 0,
    };
    delete local.conflicts[keyFor(recordId)];
    await this.store.write(userId, local);
    this.statusFor(userId, 'pending', local, 'Saved locally. Waiting for account synchronization.');
    if (this.activeUserId === userId && !isOffline())
      void this.flush(userId).catch(() => undefined);
    return this.status;
  }

  async remove(
    userId: string,
    recordId: string,
    recordType: AccountSyncRecordType,
  ): Promise<AccountSyncStatus> {
    if (!ACCOUNT_SYNC_RECORD_TYPES.includes(recordType))
      throw new Error('This record type is not syncable.');
    if (!recordId || recordId.length > 160)
      throw new Error('A stable account record ID is required.');
    const local = await this.store.read(userId);
    const existing = local.records[keyFor(recordId)];
    const existingPending = local.pending[keyFor(recordId)];
    const existingConflict = local.conflicts[keyFor(recordId)];
    const baseVersion =
      existingConflict?.remote.version ?? existingPending?.baseVersion ?? existing?.version ?? 0;
    const now = new Date().toISOString();
    local.records[keyFor(recordId)] = {
      recordId,
      recordType,
      payload: null,
      version: existing?.version ?? baseVersion,
      updatedAt: now,
      updatedByDeviceId: this.getDeviceId(),
      deletedAt: now,
      localOnly: true,
    };
    local.pending[keyFor(recordId)] = {
      recordId,
      recordType,
      payload: null,
      baseVersion,
      updatedAt: now,
      deleted: true,
      deviceId: this.getDeviceId(),
      attempts: existingPending?.attempts ?? 0,
    };
    delete local.conflicts[keyFor(recordId)];
    await this.store.write(userId, local);
    this.statusFor(
      userId,
      'pending',
      local,
      'Deletion saved locally. Waiting for account synchronization.',
    );
    return this.status;
  }

  async restore(userId: string): Promise<AccountSyncStatus> {
    const previous = this.inFlight.get(`restore:${userId}`);
    if (previous) return previous;
    const operation = this.restoreInternal(userId).finally(() =>
      this.inFlight.delete(`restore:${userId}`),
    );
    this.inFlight.set(`restore:${userId}`, operation);
    return operation;
  }

  private async restoreInternal(userId: string): Promise<AccountSyncStatus> {
    this.activeUserId = userId;
    let local = await this.store.read(userId);
    this.statusFor(userId, 'restoring', local);
    if (isOffline()) {
      return this.statusFor(
        userId,
        Object.keys(local.pending).length ? 'pending' : 'ready',
        local,
        'Offline. Account-owned settings remain available locally and will retry when you reconnect.',
      );
    }
    try {
      await this.authenticated(userId);
      const remote = (await this.transport.pull(userId)).map(normalizeRemote);
      local = await this.mergeRemote(userId, local, remote);
      await this.store.write(userId, local);
      return this.flushInternal(userId, local);
    } catch (error) {
      const message = isRevokedError(error)
        ? 'This account session is no longer authorized. Sign in again to synchronize.'
        : isNetworkError(error)
          ? 'The account is unreachable. Local changes remain pending and will retry.'
          : 'Account settings could not be synchronized; local changes were kept.';
      return this.statusFor(
        userId,
        isRevokedError(error) ? 'revoked' : isNetworkError(error) ? 'pending' : 'error',
        local,
        message,
      );
    }
  }

  private async mergeRemote(
    userId: string,
    local: AccountSyncStoreState,
    remote: RemoteAccountRecord[],
  ): Promise<AccountSyncStoreState> {
    for (const incoming of remote) {
      const key = keyFor(incoming.recordId);
      const pending = local.pending[key];
      const current = local.records[key];
      if (pending) {
        // Equal means this is the version the pending change was based on and
        // may be attempted. Newer means an explicit conflict; never replace
        // the local value with the remote one here.
        if (incoming.version > pending.baseVersion) {
          local.conflicts[key] = { local: current, remote: incoming };
        }
        continue;
      }
      if (!current || incoming.version >= current.version) {
        local.records[key] = { ...incoming, localOnly: false };
      }
    }
    await this.store.write(userId, local);
    return local;
  }

  async flush(userId: string): Promise<AccountSyncStatus> {
    const existing = this.inFlight.get(`flush:${userId}`);
    if (existing) return existing;
    const operation = (async () => {
      const local = await this.store.read(userId);
      return this.flushInternal(userId, local);
    })().finally(() => this.inFlight.delete(`flush:${userId}`));
    this.inFlight.set(`flush:${userId}`, operation);
    return operation;
  }

  private async flushInternal(
    userId: string,
    local: AccountSyncStoreState,
  ): Promise<AccountSyncStatus> {
    if (isOffline()) {
      return this.statusFor(
        userId,
        Object.keys(local.pending).length ? 'pending' : 'ready',
        local,
        'Offline; synchronization will retry automatically.',
      );
    }
    try {
      await this.authenticated(userId);
      for (const key of Object.keys(local.pending)) {
        const change = local.pending[key];
        if (local.conflicts[key]) continue;
        change.attempts += 1;
        await this.store.write(userId, local);
        const result = await this.transport.push(userId, change);
        if (!result.accepted) {
          if (result.record) {
            local.conflicts[key] = {
              local: local.records[key],
              remote: normalizeRemote(result.record),
            };
          }
          continue;
        }
        const confirmed = normalizeRemote(result.record);
        local.records[key] = { ...confirmed, localOnly: false };
        delete local.pending[key];
        delete local.conflicts[key];
      }
      local.lastSyncedAt = new Date().toISOString();
      await this.store.write(userId, local);
      const hasConflict = Object.keys(local.conflicts).length > 0;
      const hasPending = Object.keys(local.pending).length > 0;
      return this.statusFor(
        userId,
        hasConflict ? 'conflict' : hasPending ? 'pending' : 'ready',
        local,
        hasConflict
          ? 'A newer account value exists. Choose which value to keep before retrying.'
          : hasPending
            ? 'Some account changes remain pending.'
            : 'Account settings synchronized.',
      );
    } catch (error) {
      const message = isRevokedError(error)
        ? 'This account session is revoked. Sign in again to synchronize.'
        : isNetworkError(error)
          ? 'The account is unreachable. Changes remain pending.'
          : 'Synchronization failed. Changes remain pending locally.';
      return this.statusFor(
        userId,
        isRevokedError(error) ? 'revoked' : isNetworkError(error) ? 'pending' : 'error',
        local,
        message,
      );
    }
  }

  async resolveConflict(
    userId: string,
    recordId: string,
    choice: 'local' | 'remote',
  ): Promise<AccountSyncStatus> {
    const local = await this.store.read(userId);
    const conflict = local.conflicts[keyFor(recordId)];
    if (!conflict) throw new Error('No account synchronization conflict exists for this record.');
    if (choice === 'remote') {
      local.records[keyFor(recordId)] = { ...conflict.remote, localOnly: false };
      delete local.pending[keyFor(recordId)];
      delete local.conflicts[keyFor(recordId)];
      await this.store.write(userId, local);
      return this.statusFor(
        userId,
        Object.keys(local.pending).length ? 'pending' : 'ready',
        local,
        'The newer account value was kept.',
      );
    }
    const now = new Date().toISOString();
    local.pending[keyFor(recordId)] = {
      ...local.pending[keyFor(recordId)],
      recordId,
      recordType: conflict.local.recordType,
      payload: conflict.local.payload,
      baseVersion: conflict.remote.version,
      updatedAt: now,
      deleted: Boolean(conflict.local.deletedAt),
      deviceId: this.getDeviceId(),
    };
    delete local.conflicts[keyFor(recordId)];
    await this.store.write(userId, local);
    return this.flush(userId);
  }

  getRecord<T extends AccountSyncPayload>(userId: string, recordId: string): Promise<T | null> {
    return this.store
      .read(userId)
      .then((state) => (state.records[keyFor(recordId)]?.payload as T | null) ?? null);
  }

  async lock(): Promise<void> {
    this.activeUserId = null;
    this.setStatus({
      state: 'signed_out',
      pendingCount: 0,
      conflictCount: 0,
      message: 'Account synchronization session ended.',
    });
  }

  async clearUser(userId: string): Promise<void> {
    await this.store.clear(userId);
    if (this.activeUserId === userId) await this.lock();
  }

  getActiveUserId(): string | null {
    return this.activeUserId;
  }
}

function defaultDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const value = `account-device-${
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    }`;
    localStorage.setItem(DEVICE_ID_KEY, value);
    return value;
  } catch {
    return `account-device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data as T;
}

function createSupabaseTransport(): AccountSyncTransport {
  return {
    async currentUserId() {
      const { data, error } = await supabase.auth.getUser();
      if (error) return null;
      return data.user?.id ?? null;
    },
    async pull() {
      const result = await rpc<RemoteAccountRecord[]>('pharmatrack_account_sync_pull', {});
      return Array.isArray(result) ? result : [];
    },
    async push(_userId, change) {
      const result = await rpc<{
        accepted: boolean;
        conflict?: boolean;
        record?: RemoteAccountRecord | null;
      }>('pharmatrack_account_sync_push', {
        p_record_id: change.recordId,
        p_record_type: change.recordType,
        p_payload: change.payload,
        p_base_version: change.baseVersion,
        p_deleted: change.deleted,
        p_device_id: change.deviceId,
      });
      if (result.accepted && result.record) return { accepted: true, record: result.record };
      return { accepted: false, conflict: true, record: result.record ?? null };
    },
  };
}

export const accountSyncEngine = new AccountSyncEngine(
  createSupabaseTransport(),
  new IndexedDbAccountSyncStore(),
);

export function getAccountSyncStatus(): AccountSyncStatus {
  return accountSyncEngine.getStatus();
}

export function subscribeAccountSync(listener: (status: AccountSyncStatus) => void): () => void {
  return accountSyncEngine.subscribe(listener);
}

export function restoreAccountSync(userId: string): Promise<AccountSyncStatus> {
  return accountSyncEngine.restore(userId);
}

export function queueAccountRecord(
  userId: string,
  recordId: string,
  recordType: AccountSyncRecordType,
  payload: AccountSyncPayload,
): Promise<AccountSyncStatus> {
  return accountSyncEngine.queue(userId, recordId, recordType, payload);
}

export function removeAccountRecord(
  userId: string,
  recordId: string,
  recordType: AccountSyncRecordType,
): Promise<AccountSyncStatus> {
  return accountSyncEngine.remove(userId, recordId, recordType);
}

export function flushAccountSync(userId: string): Promise<AccountSyncStatus> {
  return accountSyncEngine.flush(userId);
}

export function resolveAccountSyncConflict(
  userId: string,
  recordId: string,
  choice: 'local' | 'remote',
): Promise<AccountSyncStatus> {
  return accountSyncEngine.resolveConflict(userId, recordId, choice);
}

export function getAccountRecord<T extends AccountSyncPayload>(
  userId: string,
  recordId: string,
): Promise<T | null> {
  return accountSyncEngine.getRecord<T>(userId, recordId);
}

export function lockAccountSync(): Promise<void> {
  return accountSyncEngine.lock();
}

export function clearAccountSyncData(userId: string): Promise<void> {
  return accountSyncEngine.clearUser(userId);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    const userId = accountSyncEngine.getActiveUserId();
    if (userId) void accountSyncEngine.flush(userId);
  });
}
