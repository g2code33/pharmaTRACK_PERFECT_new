/**
 * Storage Manager — measure, explain, and recover local data without wiping it.
 *
 * Categories stay separate: current semester, academic archives, uploaded
 * materials, AI configuration, AI conversations, application settings.
 *
 * A schema update never starts by clearing storage. It writes a safety copy,
 * checks that copy, migrates, checks the result, and only then marks the
 * update complete. If any step fails, the previous bytes are put back.
 *
 * Schema versions:
 *   1  unversioned `pharmatrack_state` (everything written before this module)
 *   2  collections and timetables normalised; unknown fields kept
 *   3  a legacy API key leaves the semester file only after IndexedDB holds
 *      the same key. A different saved key is never overwritten.
 */
import * as idb from 'idb-keyval';
import type { AppState } from '../types';
import {
  allowWorkspacePersist,
  blockWorkspacePersist,
  initialState,
  readWorkspaceRaw,
  type WorkspaceRawStatus,
} from './storage';
import {
  ARCHIVE_KEY_PREFIX,
  IMPORT_NAMESPACE_PREFIX,
  MIGRATION_BACKUP_PREFIX,
  deleteArchive,
  verifySemesterArchive,
} from './semesterArchive';
import {
  AI_SETTINGS_KEY,
  findLegacyKey,
  loadAISettings,
  migrateLegacySettings,
  providerForLegacyKey,
  saveAISettings,
} from '../ai/settings';
import { saveCredentials, scrubSecretsDeep, storedApiKey } from '../ai/credentials';

export const CURRENT_SCHEMA_VERSION = 3;
export const SCHEMA_KEY = 'pharmatrack_schema';
const STATE_KEY = 'pharmatrack_state';
const SEARCH_INDEX_KEY = 'pharmatrack_search_index';
const AI_CRED_KEY = 'pharmatrack_ai_credentials';
const AI_CONV_INDEX = 'pharmatrack_ai_conversations_index';
const AI_CONV_PREFIX = 'pharmatrack_ai_conversation';
const LARGE_FILE_BYTES = 256 * 1024;
const LOCALSTORAGE_WARN_BYTES = 4 * 1024 * 1024;
const ARCHIVE_ID = /^archive_[A-Za-z0-9_-]{4,80}$/;

const ARRAY_FIELDS = [
  'courses', 'topics', 'slides', 'learningObjectives', 'examQuestions',
  'quizHistory', 'studyPlans', 'notes', 'examDates', 'activities',
  'chatHistory', 'highlights', 'savedInsights',
] as const;

export type StorageCategory =
  | 'current-semester'
  | 'academic-archives'
  | 'uploaded-materials'
  | 'ai-configuration'
  | 'ai-conversations'
  | 'application-settings';

export interface StorageNotice {
  severity: 'error' | 'warning';
  title: string;
  explanation: string;
}

export interface StorageIssue {
  code: string;
  severity: 'error' | 'warning';
  title: string;
  explanation: string;
  recoveryId?: string;
  recoveryLabel?: string;
  targetId?: string;
}

export interface CategoryUsage {
  id: StorageCategory;
  label: string;
  description: string;
  bytes: number;
  items: number;
}

export interface StorageReport {
  generatedAt: string;
  categories: CategoryUsage[];
  currentWorkspaceBytes: number;
  archiveCount: number;
  archiveBytes: number;
  archives: { id: string; title: string; status: string; bytes: number }[];
  uploadedFileCount: number;
  documentBytes: number;
  indexedDbBytes: number | null;
  indexedDbAvailable: boolean;
  localStorageBytes: number | null;
  localStorageAvailable: boolean;
  quotaBytes: number | null;
  usageBytes: number | null;
  availableBytes: number | null;
  largeFiles: { fileId: string; title: string; bytes: number }[];
  recoveryBytes: number;
  issues: StorageIssue[];
  schemaVersion: number | null;
  schemaStatus: string;
  persistBlocked: boolean;
}

export interface SchemaHistoryEntry {
  from: number;
  to: number;
  at: string;
  ok: boolean;
  note?: string;
}

export interface SchemaRecord {
  schemaVersion: number;
  status: 'current' | 'migrating' | 'rolled-back';
  updatedAt: string;
  safetyBackupId?: string;
  error?: string;
  history: SchemaHistoryEntry[];
}

interface MigrationBackup {
  id: string;
  fromVersion: number;
  createdAt: string;
  stateJson: string | null;
  schemaJson: string | null;
  aiSettingsJson: string | null;
}

export interface SchemaEnsureResult {
  state: AppState;
  persist: boolean;
  schemaVersion: number;
  notice: StorageNotice | null;
  issues: StorageIssue[];
}

export interface RecoveryResult {
  ok: boolean;
  explanation: string;
  reload?: boolean;
}

const CATEGORY_COPY: { id: StorageCategory; label: string; description: string }[] = [
  { id: 'current-semester', label: 'Current Semester', description: 'The workspace you are studying now. Not mixed with archives or AI keys.' },
  { id: 'academic-archives', label: 'Academic Archives', description: 'Completed semesters stored on this device.' },
  { id: 'uploaded-materials', label: 'Uploaded Materials', description: 'Slide files and extracted text. Archive copies are counted separately.' },
  { id: 'ai-configuration', label: 'AI Configuration', description: 'Provider settings and credentials. Key values are never shown.' },
  { id: 'ai-conversations', label: 'AI Conversations', description: 'Chats with PharmaTRACK AI, kept apart from the semester file.' },
  { id: 'application-settings', label: 'Application Settings', description: 'Data version, sign-in session, and other app preferences.' },
];

// ---------------------------------------------------------------------------
// Notices (banner)
// ---------------------------------------------------------------------------

let notice: StorageNotice | null = null;
const listeners = new Set<() => void>();

export function getStorageNotice(): StorageNotice | null {
  return notice;
}

export function subscribeStorageNotice(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function publishStorageNotice(next: StorageNotice | null): void {
  notice = next;
  listeners.forEach((cb) => cb());
}

export function resetStorageNotice(): void {
  publishStorageNotice(null);
}

function explain(err: unknown, fallback: string): string {
  const raw = err instanceof Error && err.message ? err.message : fallback;
  const scrubbed = scrubSecretsDeep(raw);
  return typeof scrubbed === 'string' && scrubbed.trim() ? scrubbed : fallback;
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = 'name' in err ? String((err as { name?: string }).name) : '';
  const message = err instanceof Error ? err.message : '';
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota/i.test(message);
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return 'Not reported';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function sizeOf(value: unknown): number {
  try {
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
    if (typeof value === 'string') return new TextEncoder().encode(value).length;
    if (value instanceof Uint8Array) return value.byteLength;
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return value.byteLength;
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) return (value as ArrayBufferView).byteLength;
    const json = JSON.stringify(value);
    return json ? new TextEncoder().encode(json).length : 0;
  } catch {
    return 0;
  }
}

function localBytes(key: string, value: string): number {
  return (key.length + value.length) * 2;
}

export function classifyStorageKey(store: 'local' | 'idb', key: string): StorageCategory | 'recovery' {
  if (store === 'local') {
    if (key === STATE_KEY) return 'current-semester';
    if (key === AI_SETTINGS_KEY || key.startsWith('pharmatrack_ai_')) return 'ai-configuration';
    return 'application-settings';
  }
  if (key.startsWith(IMPORT_NAMESPACE_PREFIX)) return 'recovery';
  if (key.startsWith(ARCHIVE_KEY_PREFIX)) return 'academic-archives';
  if (key.startsWith('file_') || key.startsWith('slidetext_')) return 'uploaded-materials';
  if (key === AI_CRED_KEY || key === AI_SETTINGS_KEY) return 'ai-configuration';
  if (key === AI_CONV_INDEX || key.startsWith(AI_CONV_PREFIX)) return 'ai-conversations';
  if (key.startsWith(MIGRATION_BACKUP_PREFIX) || key === SCHEMA_KEY) return 'application-settings';
  if (key === SEARCH_INDEX_KEY) return 'current-semester';
  return 'current-semester';
}

function isArchiveId(id: string): boolean {
  return ARCHIVE_ID.test(id);
}

function archiveIdFromMetaKey(key: string): string | null {
  if (!key.startsWith(ARCHIVE_KEY_PREFIX)) return null;
  if (key.startsWith(`${ARCHIVE_KEY_PREFIX}file_`)) return null;
  if (key.startsWith(`${ARCHIVE_KEY_PREFIX}text_`)) return null;
  if (key.startsWith(`${ARCHIVE_KEY_PREFIX}record_`)) return null;
  const id = key.slice(ARCHIVE_KEY_PREFIX.length);
  return id || null;
}

function keysForArchive(allKeys: string[], archiveId: string): string[] {
  return allKeys.filter((k) =>
    k === ARCHIVE_KEY_PREFIX + archiveId ||
    k.startsWith(`${ARCHIVE_KEY_PREFIX}file_${archiveId}_`) ||
    k.startsWith(`${ARCHIVE_KEY_PREFIX}text_${archiveId}_`) ||
    k.startsWith(`${ARCHIVE_KEY_PREFIX}record_${archiveId}__`),
  );
}

// ---------------------------------------------------------------------------
// Schema record
// ---------------------------------------------------------------------------

function readSchema(): { raw: string | null; record: SchemaRecord | null; corrupt: boolean } {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SCHEMA_KEY);
  } catch {
    return { raw: null, record: null, corrupt: true };
  }
  if (!raw) return { raw: null, record: null, corrupt: false };
  try {
    const parsed = JSON.parse(raw) as SchemaRecord;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.schemaVersion !== 'number') {
      return { raw, record: null, corrupt: true };
    }
    return { raw, record: parsed, corrupt: false };
  } catch {
    return { raw, record: null, corrupt: true };
  }
}

function writeSchema(record: SchemaRecord): void {
  localStorage.setItem(SCHEMA_KEY, JSON.stringify(record));
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

function countTimetableItems(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return ['class', 'quiz', 'exam'].reduce((n, k) => n + (Array.isArray(v[k]) ? (v[k] as unknown[]).length : 0), 0);
  }
  return 0;
}

function normalizeTimetables(value: unknown): { class: unknown[]; quiz: unknown[]; exam: unknown[] } {
  const out = { class: [] as unknown[], quiz: [] as unknown[], exam: [] as unknown[] };
  if (Array.isArray(value)) {
    for (const item of value) {
      const type = item && typeof item === 'object'
        ? String((item as { type?: string; timetableType?: string }).type || (item as { timetableType?: string }).timetableType || '')
        : '';
      const bucket = type === 'quiz' || type === 'exam' ? type : 'class';
      out[bucket].push(item);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    out.class = Array.isArray(v.class) ? [...v.class] : [];
    out.quiz = Array.isArray(v.quiz) ? [...v.quiz] : [];
    out.exam = Array.isArray(v.exam) ? [...v.exam] : [];
  }
  return out;
}

function migrateV1ToV2(value: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...value };
  for (const key of ARRAY_FIELDS) {
    if (!Array.isArray(next[key])) next[key] = [];
  }
  next.timetables = normalizeTimetables(value.timetables);
  return next;
}

async function migrateV2ToV3(value: Record<string, unknown>): Promise<{ value: Record<string, unknown>; note: string }> {
  const legacy = findLegacyKey(value);
  if (!legacy) {
    return { value, note: 'No legacy API key was stored in the semester file.' };
  }
  const providerId = providerForLegacyKey(legacy.key).kind;
  const already = await storedApiKey(providerId);
  if (already && already !== legacy.key) {
    return {
      value,
      note: 'A different API key was already saved for that provider, so the semester file was left unchanged and the saved key was not overwritten.',
    };
  }
  if (already === legacy.key) {
    return {
      value: { ...value, openAIKey: '' },
      note: 'The legacy API key was already in AI settings. It was removed from the semester file only after that was confirmed.',
    };
  }

  const migrated = migrateLegacySettings(loadAISettings(), legacy.key);
  saveAISettings(migrated.settings);
  let enabled = false;
  try {
    const raw = localStorage.getItem(AI_SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) as { providers?: { id?: string; enabled?: boolean }[] } : null;
    enabled = !!parsed?.providers?.some((p) => p.id === migrated.providerId && p.enabled);
  } catch {
    enabled = false;
  }
  if (!enabled) {
    throw new Error('AI settings could not be saved, so the legacy key was left in the semester file.');
  }
  const { saveCredentials } = await import('../ai/credentials');
  await saveCredentials(migrated.providerId, { apiKey: legacy.key });
  if ((await storedApiKey(migrated.providerId)) !== legacy.key) {
    throw new Error('The API key copy could not be verified, so it was left in the semester file.');
  }
  return {
    value: { ...value, openAIKey: '' },
    note: 'The legacy API key was copied into AI settings and removed from the semester file only after the copy was verified.',
  };
}

async function assertMigrationSafe(beforeRaw: string | null, after: Record<string, unknown>): Promise<void> {
  if (!after || typeof after !== 'object' || Array.isArray(after)) {
    throw new Error('Migrated data is not a workspace object.');
  }
  if (!beforeRaw) return;
  const before = JSON.parse(beforeRaw) as Record<string, unknown>;
  for (const key of ARRAY_FIELDS) {
    if (!Array.isArray(after[key])) throw new Error(`${key} is missing after the update.`);
    if (Array.isArray(before[key]) && (after[key] as unknown[]).length < (before[key] as unknown[]).length) {
      throw new Error(`${key} lost items during the update.`);
    }
  }
  if (before.student && typeof before.student === 'object') {
    const id = (before.student as { id?: string }).id;
    const nextId = after.student && typeof after.student === 'object' ? (after.student as { id?: string }).id : undefined;
    if (id && nextId !== id) throw new Error('Student identity changed during the update.');
  }
  for (const key of Object.keys(before)) {
    if (key === 'openAIKey' || key === 'timetables') continue;
    if (!(key in after)) throw new Error(`Field "${key}" was dropped during the update.`);
  }
  const tt = after.timetables as { class?: unknown; quiz?: unknown; exam?: unknown } | undefined;
  if (!tt || !Array.isArray(tt.class) || !Array.isArray(tt.quiz) || !Array.isArray(tt.exam)) {
    throw new Error('Timetable entries were not preserved.');
  }
  if (tt.class.length + tt.quiz.length + tt.exam.length < countTimetableItems(before.timetables)) {
    throw new Error('Timetable entries were lost during the update.');
  }
  const legacy = typeof before.openAIKey === 'string' ? before.openAIKey.trim() : '';
  const afterKey = typeof after.openAIKey === 'string' ? after.openAIKey.trim() : '';
  if (legacy && !afterKey && (await storedApiKey(providerForLegacyKey(legacy).kind)) !== legacy) {
    throw new Error('Refusing to remove the legacy API key because the copy was not verified.');
  }
}

function toAppState(value: Record<string, unknown>): AppState {
  return { ...initialState, ...value, timetables: normalizeTimetables(value.timetables) } as AppState;
}

function writableState(): AppState {
  const { raw, status } = readWorkspaceRaw();
  if (status === 'ok' && raw) {
    try { return toAppState(JSON.parse(raw) as Record<string, unknown>); } catch { /* fall through */ }
  }
  return { ...initialState };
}

async function writeSafetyBackup(
  fromVersion: number,
  stateJson: string | null,
  schemaJson: string | null,
  aiSettingsJson: string | null,
): Promise<{ ok: true; id: string } | { ok: false; code: string; explanation: string }> {
  const id = `mig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const record: MigrationBackup = {
    id,
    fromVersion,
    createdAt: nowIso(),
    stateJson,
    schemaJson,
    aiSettingsJson,
  };
  const key = MIGRATION_BACKUP_PREFIX + id;
  try {
    await idb.set(key, record);
    const stored = await idb.get<MigrationBackup>(key);
    if (!stored || stored.stateJson !== stateJson || stored.schemaJson !== schemaJson || stored.aiSettingsJson !== aiSettingsJson) {
      return {
        ok: false,
        code: 'BACKUP_MISMATCH',
        explanation: 'The safety copy did not match your data, so the update was not applied. Your semester data is unchanged.',
      };
    }
    return { ok: true, id };
  } catch (err) {
    if (isQuotaError(err)) {
      return {
        ok: false,
        code: 'INSUFFICIENT_STORAGE',
        explanation: 'There is not enough free storage to make the safety copy this update requires, so your data was left exactly as it was.',
      };
    }
    return {
      ok: false,
      code: 'INDEXEDDB_UNAVAILABLE',
      explanation: 'IndexedDB could not store the safety copy, so the update was not applied. Your semester data is unchanged.',
    };
  }
}

function restoreExact(backup: MigrationBackup): void {
  const put = (key: string, value: string | null) => {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  };
  put(STATE_KEY, backup.stateJson);
  put(SCHEMA_KEY, backup.schemaJson);
  put(AI_SETTINGS_KEY, backup.aiSettingsJson);
}

function resultFromState(notice: StorageNotice | null, issues: StorageIssue[] = []): SchemaEnsureResult {
  const { status } = readWorkspaceRaw();
  const persist = status === 'ok' || status === 'missing';
  if (!persist) {
    blockWorkspacePersist(notice?.explanation || 'Saved semester data could not be read, so it will not be overwritten.');
  } else {
    allowWorkspacePersist();
  }
  publishStorageNotice(notice);
  const schema = readSchema().record;
  return {
    state: persist ? writableState() : { ...initialState },
    persist,
    schemaVersion: schema?.schemaVersion ?? 0,
    notice,
    issues,
  };
}

async function rollbackTo(backup: MigrationBackup, explanation: string, title: string): Promise<SchemaEnsureResult> {
  restoreExact(backup);
  const record: SchemaRecord = {
    schemaVersion: backup.fromVersion || 1,
    status: 'rolled-back',
    updatedAt: nowIso(),
    safetyBackupId: backup.id,
    error: explanation,
    history: readSchema().record?.history ?? [],
  };
  try { writeSchema(record); } catch { /* the semester bytes are already back; the banner still explains */ }
  return resultFromState({ severity: 'error', title, explanation }, [{
    code: 'MIGRATION_FAILED',
    severity: 'error',
    title,
    explanation,
    recoveryId: 'retry-migration',
    recoveryLabel: 'Retry update',
  }]);
}

async function runMigrations(fromVersion: number): Promise<SchemaEnsureResult> {
  const stateRead = readWorkspaceRaw();
  if (stateRead.status === 'malformed' || stateRead.status === 'unavailable') {
    return malformedResult(stateRead.status);
  }
  const schemaRead = readSchema();
  let aiSettingsJson: string | null = null;
  try { aiSettingsJson = localStorage.getItem(AI_SETTINGS_KEY); } catch { aiSettingsJson = null; }

  const backup = await writeSafetyBackup(fromVersion, stateRead.raw, schemaRead.raw, aiSettingsJson);
  if (!backup.ok) {
    const notice = {
      severity: 'error' as const,
      title: backup.code === 'INSUFFICIENT_STORAGE' ? 'Not enough storage' : 'Update paused',
      explanation: backup.explanation,
    };
    return resultFromState(notice, [{
      code: backup.code,
      severity: 'error',
      title: notice.title,
      explanation: backup.explanation,
    }]);
  }

  const migrating: SchemaRecord = {
    schemaVersion: fromVersion,
    status: 'migrating',
    updatedAt: nowIso(),
    safetyBackupId: backup.id,
    history: schemaRead.record?.history ?? [],
  };
  try {
    writeSchema(migrating);
  } catch (err) {
    const explanation = isQuotaError(err)
      ? 'There is not enough free storage to record the update, so your data was left exactly as it was.'
      : 'The update could not be recorded, so your data was left exactly as it was.';
    return resultFromState({ severity: 'error', title: 'Update paused', explanation }, [{
      code: isQuotaError(err) ? 'INSUFFICIENT_STORAGE' : 'LOCALSTORAGE_UNAVAILABLE',
      severity: 'error',
      title: 'Update paused',
      explanation,
    }]);
  }

  try {
    let value: Record<string, unknown> = stateRead.raw ? JSON.parse(stateRead.raw) as Record<string, unknown> : {};
    let version = fromVersion;
    const history: SchemaHistoryEntry[] = [...(schemaRead.record?.history ?? [])];
    if (version < 2) {
      value = migrateV1ToV2(value);
      history.push({ from: 1, to: 2, at: nowIso(), ok: true, note: 'Normalized collections. No data was removed.' });
      version = 2;
    }
    if (version < 3) {
      const step = await migrateV2ToV3(value);
      value = step.value;
      history.push({ from: 2, to: 3, at: nowIso(), ok: true, note: step.note });
      version = 3;
    }
    await assertMigrationSafe(stateRead.raw, value);
    const migratedJson = JSON.stringify(value);
    const roundTrip = JSON.parse(migratedJson) as Record<string, unknown>;
    if (!roundTrip || typeof roundTrip !== 'object' || Array.isArray(roundTrip)) {
      throw new Error('Migrated data could not be saved.');
    }
    localStorage.setItem(STATE_KEY, migratedJson);
    if (localStorage.getItem(STATE_KEY) !== migratedJson) {
      throw new Error('The saved update did not match what was checked, so it was not kept.');
    }
    const complete: SchemaRecord = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      status: 'current',
      updatedAt: nowIso(),
      safetyBackupId: backup.id,
      history: history.slice(-12),
    };
    writeSchema(complete);
    const checked = readSchema().record;
    if (!checked || checked.status !== 'current' || checked.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error('The update could not be marked complete.');
    }
    return resultFromState(null);
  } catch (err) {
    let stored: MigrationBackup | undefined;
    try { stored = await idb.get<MigrationBackup>(MIGRATION_BACKUP_PREFIX + backup.id); } catch { stored = undefined; }
    const source = stored && stored.stateJson === stateRead.raw ? stored : {
      id: backup.id,
      fromVersion,
      createdAt: nowIso(),
      stateJson: stateRead.raw,
      schemaJson: schemaRead.raw,
      aiSettingsJson,
    };
    const explanation = `${explain(err, 'The update failed.')} Your previous data was restored. Nothing was deleted.`;
    return rollbackTo(source, explanation, 'Update rolled back');
  }
}

function malformedResult(status: WorkspaceRawStatus): SchemaEnsureResult {
  const explanation = status === 'unavailable'
    ? 'localStorage could not be read. PharmaTRACK will not overwrite whatever is still stored.'
    : 'Your semester file could not be read (the saved data is not valid JSON). It has not been overwritten. PharmaTRACK will not save over it until you recover the file or explicitly set it aside.';
  const notice = {
    severity: 'error' as const,
    title: status === 'unavailable' ? 'Storage unavailable' : 'Semester file unreadable',
    explanation,
  };
  blockWorkspacePersist(explanation);
  publishStorageNotice(notice);
  return {
    state: { ...initialState },
    persist: false,
    schemaVersion: readSchema().record?.schemaVersion ?? 0,
    notice,
    issues: [{
      code: status === 'unavailable' ? 'LOCALSTORAGE_UNAVAILABLE' : 'MALFORMED_STATE',
      severity: 'error',
      title: notice.title,
      explanation,
      recoveryId: status === 'malformed' ? 'quarantine-unreadable-state' : undefined,
      recoveryLabel: status === 'malformed' ? 'Set the file aside' : undefined,
    }],
  };
}

async function resumeInterrupted(schema: SchemaRecord): Promise<SchemaEnsureResult> {
  if (!schema.safetyBackupId) {
    const explanation = 'An update was interrupted and no safety copy was recorded. Your current semester file was not deleted.';
    return resultFromState({ severity: 'error', title: 'Update interrupted', explanation }, [{
      code: 'MIGRATION_INTERRUPTED',
      severity: 'error',
      title: 'Update interrupted',
      explanation,
      recoveryId: 'retry-migration',
      recoveryLabel: 'Retry update',
    }]);
  }
  let backup: MigrationBackup | undefined;
  try {
    backup = await idb.get<MigrationBackup>(MIGRATION_BACKUP_PREFIX + schema.safetyBackupId);
  } catch {
    backup = undefined;
  }
  if (!backup) {
    const explanation = 'An update was interrupted and its safety copy could not be found. Your current semester file was not deleted.';
    return resultFromState({ severity: 'error', title: 'Update interrupted', explanation }, [{
      code: 'MIGRATION_INTERRUPTED',
      severity: 'error',
      title: 'Update interrupted',
      explanation,
    }]);
  }
  return rollbackTo(
    backup,
    'An update was interrupted before it finished. Your previous data was restored from the safety copy. Nothing was deleted.',
    'Update interrupted',
  );
}

let inflight: Promise<SchemaEnsureResult> | null = null;

async function ensureSchemaOnce(): Promise<SchemaEnsureResult> {
  const stateRead = readWorkspaceRaw();
  if (stateRead.status === 'unavailable') return malformedResult('unavailable');

  const schemaRead = readSchema();
  if (schemaRead.record?.status === 'migrating') {
    return resumeInterrupted(schemaRead.record);
  }
  if (stateRead.status === 'malformed') return malformedResult('malformed');

  if (schemaRead.corrupt) {
    const explanation = 'The data-version record could not be read. Your semester file was not changed.';
    return resultFromState({ severity: 'warning', title: 'Data version unreadable', explanation }, [{
      code: 'SCHEMA_UNREADABLE',
      severity: 'warning',
      title: 'Data version unreadable',
      explanation,
      recoveryId: 'retry-migration',
      recoveryLabel: 'Retry update',
    }]);
  }

  if (!stateRead.raw && !schemaRead.record) {
    try {
      writeSchema({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        status: 'current',
        updatedAt: nowIso(),
        history: [],
      });
    } catch {
      /* a brand-new install can still run; the next launch will stamp the version */
    }
    return resultFromState(null);
  }

  if (schemaRead.record?.status === 'rolled-back') {
    const explanation = schemaRead.record.error
      || 'The last update was rolled back. Your previous data is still here. Nothing was deleted.';
    return resultFromState({ severity: 'warning', title: 'Update rolled back', explanation }, [{
      code: 'MIGRATION_FAILED',
      severity: 'warning',
      title: 'Update rolled back',
      explanation,
      recoveryId: 'retry-migration',
      recoveryLabel: 'Retry update',
    }]);
  }

  const version = schemaRead.record?.schemaVersion ?? 1;
  if (version >= CURRENT_SCHEMA_VERSION && schemaRead.record?.status === 'current') {
    return resultFromState(null);
  }
  if (version >= CURRENT_SCHEMA_VERSION && !schemaRead.record) {
    return resultFromState(null);
  }
  return runMigrations(version);
}

/** Boot hook. Safe to call more than once; a second call waits for the first. */
export function ensureSchema(): Promise<SchemaEnsureResult> {
  if (!inflight) {
    inflight = ensureSchemaOnce().finally(() => { inflight = null; });
  }
  return inflight;
}

export async function retryMigration(): Promise<RecoveryResult> {
  const stateRead = readWorkspaceRaw();
  if (stateRead.status === 'malformed' || stateRead.status === 'unavailable') {
    const blocked = malformedResult(stateRead.status);
    return { ok: false, explanation: blocked.notice?.explanation || 'The semester file could not be read, so the update was not retried.' };
  }
  const schema = readSchema().record;
  if (schema?.status === 'current' && schema.schemaVersion >= CURRENT_SCHEMA_VERSION) {
    return { ok: true, explanation: 'Your data is already on the current version. Nothing was changed.' };
  }
  const from = schema?.schemaVersion && schema.schemaVersion > 0 ? schema.schemaVersion : 1;
  const result = await runMigrations(from);
  if (result.notice) return { ok: false, explanation: result.notice.explanation };
  return {
    ok: true,
    reload: true,
    explanation: 'The update finished. Your data was checked before it was marked complete. Nothing was deleted.',
  };
}

// ---------------------------------------------------------------------------
// Inspection (read-only)
// ---------------------------------------------------------------------------

async function estimateQuota(): Promise<{ quota: number | null; usage: number | null }> {
  try {
    const estimate = navigator.storage?.estimate;
    if (typeof estimate !== 'function') return { quota: null, usage: null };
    const result = await navigator.storage.estimate();
    return {
      quota: typeof result.quota === 'number' ? result.quota : null,
      usage: typeof result.usage === 'number' ? result.usage : null,
    };
  } catch {
    return { quota: null, usage: null };
  }
}

function slideTitle(state: Record<string, unknown> | null, fileId: string): string {
  const slides = state && Array.isArray(state.slides) ? state.slides as { title?: string; fileUrl?: string }[] : [];
  const match = slides.find((s) => (s.fileUrl || '').replace(/^local:/, '') === fileId);
  return match?.title?.trim() || 'Uploaded file';
}

export async function inspectStorage(): Promise<StorageReport> {
  const issues: StorageIssue[] = [];
  const categories = new Map<StorageCategory | 'recovery', { bytes: number; items: number }>();
  for (const cat of CATEGORY_COPY) categories.set(cat.id, { bytes: 0, items: 0 });
  categories.set('recovery', { bytes: 0, items: 0 });

  const add = (cat: StorageCategory | 'recovery', bytes: number) => {
    const row = categories.get(cat)!;
    row.bytes += bytes;
    row.items += 1;
  };

  let localStorageAvailable = true;
  let localStorageBytes = 0;
  const localEntries: { key: string; value: string; bytes: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const value = localStorage.getItem(key) ?? '';
      const bytes = localBytes(key, value);
      localStorageBytes += bytes;
      localEntries.push({ key, value, bytes });
      add(classifyStorageKey('local', key), bytes);
    }
  } catch (err) {
    localStorageAvailable = false;
    localStorageBytes = 0;
    issues.push({
      code: 'LOCALSTORAGE_UNAVAILABLE',
      severity: 'error',
      title: 'localStorage could not be read',
      explanation: `${explain(err, 'localStorage could not be read.')} PharmaTRACK will not overwrite whatever is still stored.`,
    });
  }

  const stateRead = readWorkspaceRaw();
  let workspace: Record<string, unknown> | null = null;

  if (stateRead.status === 'malformed') {
    issues.push({
      code: 'MALFORMED_STATE',
      severity: 'error',
      title: 'Semester file unreadable',
      explanation: 'Your semester file could not be read (the saved data is not valid JSON). It has not been overwritten. PharmaTRACK will not save over it until you recover the file or explicitly set it aside.',
      recoveryId: 'quarantine-unreadable-state',
      recoveryLabel: 'Set the file aside',
    });
  } else if (stateRead.status === 'ok' && stateRead.raw) {
    try { workspace = JSON.parse(stateRead.raw) as Record<string, unknown>; } catch { workspace = null; }
  }

  let indexedDbAvailable = true;
  let indexedDbBytes = 0;
  const idbEntries: { key: string; bytes: number; value: unknown }[] = [];
  try {
    const keys = await idb.keys<string>();
    for (const key of keys) {
      let value: unknown;
      try {
        value = await idb.get(key);
      } catch (err) {
        issues.push({
          code: 'INDEXEDDB_ERROR',
          severity: 'error',
          title: 'A stored record could not be read',
          explanation: `${key} could not be read (${explain(err, 'IndexedDB read failed')}). It was not deleted.`,
        });
        add(classifyStorageKey('idb', key), 0);
        continue;
      }
      const bytes = sizeOf(value);
      indexedDbBytes += bytes;
      idbEntries.push({ key, bytes, value });
      add(classifyStorageKey('idb', key), bytes);
    }
  } catch (err) {
    indexedDbAvailable = false;
    indexedDbBytes = 0;
    issues.push({
      code: 'INDEXEDDB_UNAVAILABLE',
      severity: 'error',
      title: 'IndexedDB could not be read',
      explanation: `IndexedDB could not be read (${explain(err, 'storage unavailable')}). Sizes that live there are not shown. Your saved data was not deleted.`,
    });
  }

  const idbKeySet = new Set(idbEntries.map((e) => e.key));
  const schemaForRecovery = readSchema();
  if (
    stateRead.status === 'malformed' &&
    schemaForRecovery.record?.safetyBackupId &&
    idbKeySet.has(MIGRATION_BACKUP_PREFIX + schemaForRecovery.record.safetyBackupId)
  ) {
    issues.push({
      code: 'SAFETY_BACKUP_AVAILABLE',
      severity: 'warning',
      title: 'A safety copy is available',
      explanation: 'A copy made before the last update is still on this device. Restoring it does not delete that copy. Your current file is set aside first if there is room.',
      recoveryId: 'restore-safety-backup',
      recoveryLabel: 'Restore safety copy',
    });
  }
  const fileEntries = idbEntries.filter((e) => e.key.startsWith('file_'));
  const textEntries = idbEntries.filter((e) => e.key.startsWith('slidetext_'));
  const documentBytes = [...fileEntries, ...textEntries].reduce((n, e) => n + e.bytes, 0);

  const largeFiles = fileEntries
    .filter((e) => e.bytes >= LARGE_FILE_BYTES)
    .map((e) => ({
      fileId: e.key.slice('file_'.length),
      title: slideTitle(workspace, e.key.slice('file_'.length)),
      bytes: e.bytes,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  if (workspace && Array.isArray(workspace.slides)) {
    for (const slide of workspace.slides as { title?: string; fileUrl?: string }[]) {
      const fileId = (slide.fileUrl || '').replace(/^local:/, '');
      if (!fileId || slide.fileUrl?.startsWith('blob:') || slide.fileUrl?.startsWith('http')) continue;
      if (!idbKeySet.has(`file_${fileId}`)) {
        const title = slide.title?.trim() || 'A slide';
        issues.push({
          code: 'MISSING_BINARY',
          severity: 'warning',
          title: 'Uploaded file missing',
          explanation: `${title} is missing its uploaded file. The slide record is still here. Re-upload the file to open it again. Nothing was deleted.`,
        });
      }
    }
    if (findLegacyKey(workspace)) {
      issues.push({
        code: 'LEGACY_KEY_IN_SEMESTER',
        severity: 'warning',
        title: 'An old API key is still in the semester file',
        explanation: 'It was left there on purpose so it would not be overwritten or deleted. The key itself is not shown here. You can move it from Settings → AI when you are ready.',
      });
    }
  }

  const archives: StorageReport['archives'] = [];
  for (const entry of idbEntries) {
    const archiveId = archiveIdFromMetaKey(entry.key);
    if (!archiveId) continue;
    const owned = keysForArchive(idbEntries.map((e) => e.key), archiveId);
    const bytes = idbEntries.filter((e) => owned.includes(e.key)).reduce((n, e) => n + e.bytes, 0);
    const record = entry.value as { meta?: { title?: string; status?: string; id?: string }; snapshot?: unknown; manifest?: { kind?: string; sourceKey?: string; archiveKey?: string }[] } | null;
    if (!record || typeof record !== 'object') {
      archives.push({ id: archiveId, title: 'Unreadable archive', status: 'unreadable', bytes });
      issues.push({
        code: 'CORRUPT_ARCHIVE_METADATA',
        severity: 'error',
        title: 'Archive record unreadable',
        explanation: `An archive record (${archiveId}) is not readable. It was not deleted. Your current semester and other archives were not changed.`,
        recoveryId: isArchiveId(archiveId) ? 'discard-incomplete-archive' : undefined,
        recoveryLabel: 'Remove unreadable record',
        targetId: archiveId,
      });
      continue;
    }
    const status = record.meta?.status || 'unknown';
    const title = record.meta?.title || archiveId;
    archives.push({ id: archiveId, title, status, bytes });
    if (!record.snapshot || !record.meta) {
      issues.push({
        code: 'CORRUPT_ARCHIVE_METADATA',
        severity: 'warning',
        title: 'Archive details incomplete',
        explanation: `${title} is missing part of its archive record. The record was kept so nothing unique is deleted. Re-check it before treating it as a completed semester.`,
        recoveryId: isArchiveId(archiveId) ? 'recheck-archive' : undefined,
        recoveryLabel: 'Re-check archive',
        targetId: archiveId,
      });
    } else if (status === 'creating') {
      issues.push({
        code: 'INCOMPLETE_WRITE',
        severity: 'warning',
        title: 'Archive write was interrupted',
        explanation: `${title} was still being written when it stopped. It was kept. Re-checking it will not delete the saved semester.`,
        recoveryId: isArchiveId(archiveId) ? 'recheck-archive' : undefined,
        recoveryLabel: 'Re-check archive',
        targetId: archiveId,
      });
    } else if (status === 'failed') {
      issues.push({
        code: 'FAILED_ARCHIVE',
        severity: 'warning',
        title: 'Archive could not be verified',
        explanation: `${title} is marked failed. The record was kept. Re-checking it will not delete files.`,
        recoveryId: isArchiveId(archiveId) ? 'recheck-archive' : undefined,
        recoveryLabel: 'Re-check archive',
        targetId: archiveId,
      });
    }
    if (Array.isArray(record.manifest)) {
      for (const item of record.manifest) {
        if (!item?.archiveKey || idbKeySet.has(item.archiveKey)) continue;
        issues.push({
          code: 'MISSING_ARCHIVE_FILE',
          severity: 'warning',
          title: 'Archived file missing',
          explanation: `${title} is missing a saved file (${item.sourceKey || 'unknown file'}). The archive record was kept. It was not deleted to hide the gap.`,
        });
      }
    }
  }

  const importEntries = idbEntries.filter((e) => e.key.startsWith(IMPORT_NAMESPACE_PREFIX));
  if (importEntries.length) {
    const bytes = importEntries.reduce((n, e) => n + e.bytes, 0);
    issues.push({
      code: 'INTERRUPTED_IMPORT',
      severity: 'warning',
      title: 'Import was interrupted',
      explanation: `An import was interrupted before it finished (${formatBytes(bytes)} still staged). The unfinished import can be discarded without affecting your current semester or your archives.`,
      recoveryId: 'discard-interrupted-imports',
      recoveryLabel: 'Discard unfinished import',
    });
  }

  const schema = readSchema();
  if (schema.corrupt) {
    issues.push({
      code: 'SCHEMA_UNREADABLE',
      severity: 'warning',
      title: 'Data version unreadable',
      explanation: 'The data-version record could not be read. Your semester file was not changed.',
      recoveryId: 'retry-migration',
      recoveryLabel: 'Retry update',
    });
  } else if (schema.record?.status === 'migrating') {
    issues.push({
      code: 'MIGRATION_INTERRUPTED',
      severity: 'error',
      title: 'Update interrupted',
      explanation: 'An update was interrupted before it finished. Open the app again to restore the safety copy. Nothing is deleted by this check.',
      recoveryId: 'retry-migration',
      recoveryLabel: 'Restore and retry',
    });
  } else if (schema.record?.status === 'rolled-back') {
    issues.push({
      code: 'MIGRATION_FAILED',
      severity: 'warning',
      title: 'Update rolled back',
      explanation: schema.record.error || 'The last update was rolled back. Your previous data is still here. Nothing was deleted.',
      recoveryId: 'retry-migration',
      recoveryLabel: 'Retry update',
    });
  }

  const quota = await estimateQuota();
  const availableBytes = quota.quota != null && quota.usage != null ? Math.max(0, quota.quota - quota.usage) : null;
  if (quota.quota && quota.usage != null && quota.usage / quota.quota >= 0.8) {
    issues.push({
      code: 'LOW_STORAGE',
      severity: 'warning',
      title: 'Device storage is low',
      explanation: `About ${formatBytes(availableBytes)} is free of ${formatBytes(quota.quota)}. Export a backup before adding large files. Nothing was deleted.`,
    });
  }
  if (localStorageAvailable && localStorageBytes >= LOCALSTORAGE_WARN_BYTES) {
    issues.push({
      code: 'LOCALSTORAGE_NEAR_CAP',
      severity: 'warning',
      title: 'Semester file is close to the browser limit',
      explanation: `localStorage is using about ${formatBytes(localStorageBytes)} of its usual 5 MB. Large slide text already lives in IndexedDB. Nothing was deleted.`,
    });
  }

  const workspaceEntry = localEntries.find((e) => e.key === STATE_KEY);
  const searchEntry = idbEntries.find((e) => e.key === SEARCH_INDEX_KEY);
  const verifiedCount = archives.filter((a) => a.status === 'verified').length;

  return {
    generatedAt: nowIso(),
    categories: CATEGORY_COPY.map((cat) => ({ ...cat, ...categories.get(cat.id)! })),
    currentWorkspaceBytes: (workspaceEntry?.bytes ?? 0) + (searchEntry?.bytes ?? 0),
    archiveCount: verifiedCount,
    archiveBytes: categories.get('academic-archives')!.bytes,
    archives,
    uploadedFileCount: fileEntries.length,
    documentBytes,
    indexedDbBytes: indexedDbAvailable ? indexedDbBytes : null,
    indexedDbAvailable,
    localStorageBytes: localStorageAvailable ? localStorageBytes : null,
    localStorageAvailable,
    quotaBytes: quota.quota,
    usageBytes: quota.usage,
    availableBytes,
    largeFiles,
    recoveryBytes: categories.get('recovery')!.bytes,
    issues,
    schemaVersion: schema.record?.schemaVersion ?? null,
    schemaStatus: schema.corrupt ? 'unreadable' : schema.record?.status ?? (stateRead.raw ? 'unversioned' : 'empty'),
    persistBlocked: stateRead.status === 'malformed' || stateRead.status === 'unavailable',
  };
}

// ---------------------------------------------------------------------------
// Recovery — each action is scoped. None of them call localStorage.clear()
// or idb.clear().
// ---------------------------------------------------------------------------

export async function discardInterruptedImports(): Promise<RecoveryResult> {
  let keys: string[] = [];
  try {
    keys = await idb.keys<string>();
  } catch (err) {
    return { ok: false, explanation: `IndexedDB could not be read (${explain(err, 'storage unavailable')}). Nothing was discarded.` };
  }
  const staged = keys.filter((k) => k.startsWith(IMPORT_NAMESPACE_PREFIX));
  if (!staged.length) return { ok: true, explanation: 'No unfinished import was found. Nothing was changed.' };
  try {
    await idb.delMany(staged);
  } catch (err) {
    return { ok: false, explanation: `The unfinished import could not be discarded (${explain(err, 'storage error')}). Your semester and archives were not changed.` };
  }
  const left = (await idb.keys<string>()).filter((k) => k.startsWith(IMPORT_NAMESPACE_PREFIX));
  if (left.length) {
    return { ok: false, explanation: 'Some unfinished import records are still there. Your semester and archives were not changed.' };
  }
  return { ok: true, explanation: 'The unfinished import was discarded. Your current semester and your archives were not changed.' };
}

export async function discardIncompleteArchive(archiveId: string): Promise<RecoveryResult> {
  if (!isArchiveId(archiveId)) {
    return { ok: false, explanation: 'That archive id is not valid, so nothing was deleted.' };
  }
  let record: unknown;
  try {
    record = await idb.get(ARCHIVE_KEY_PREFIX + archiveId);
  } catch (err) {
    return { ok: false, explanation: `The archive could not be read (${explain(err, 'IndexedDB error')}). Nothing was deleted.` };
  }
  if (record && typeof record === 'object' && (record as { meta?: { status?: string } }).meta?.status === 'verified') {
    return { ok: false, explanation: 'This archive is verified. It was not deleted.' };
  }
  try {
    await deleteArchive(archiveId);
  } catch (err) {
    return { ok: false, explanation: `The archive record could not be removed (${explain(err, 'storage error')}). Nothing else was changed.` };
  }
  return { ok: true, explanation: 'The unreadable archive record was removed. Your current semester and other archives were not changed.' };
}

export async function recheckArchive(archiveId: string): Promise<RecoveryResult> {
  if (!isArchiveId(archiveId)) {
    return { ok: false, explanation: 'That archive id is not valid, so nothing was changed.' };
  }
  const key = ARCHIVE_KEY_PREFIX + archiveId;
  let before: unknown;
  try {
    before = await idb.get(key);
  } catch (err) {
    return { ok: false, explanation: `The archive could not be read (${explain(err, 'IndexedDB error')}). Nothing was changed.` };
  }
  if (!before || typeof before !== 'object') {
    return { ok: false, explanation: 'This archive record is not readable. It was not deleted. Your current semester is unchanged.' };
  }
  const snapshotBefore = JSON.stringify((before as { snapshot?: unknown }).snapshot ?? null);
  try {
    const meta = await verifySemesterArchive(archiveId);
    return {
      ok: meta.status === 'verified',
      explanation: meta.status === 'verified'
        ? `${meta.title || 'The archive'} checked out. It is marked verified. No files were deleted.`
        : 'The archive was re-checked. No files were deleted.',
    };
  } catch (err) {
    let after: unknown;
    try { after = await idb.get(key); } catch { after = before; }
    const snapshotAfter = after && typeof after === 'object'
      ? JSON.stringify((after as { snapshot?: unknown }).snapshot ?? null)
      : null;
    const kept = snapshotAfter === snapshotBefore;
    return {
      ok: false,
      explanation: kept
        ? `The archive could not be verified (${explain(err, 'it is incomplete')}). The saved semester was kept. Nothing was deleted.`
        : `The archive could not be verified (${explain(err, 'it is incomplete')}). The original record was left in place if it could not be updated.`,
    };
  }
}

export async function restoreSafetyBackup(): Promise<RecoveryResult> {
  const schema = readSchema().record;
  const backupId = schema?.safetyBackupId;
  if (!backupId) return { ok: false, explanation: 'No safety copy was found, so nothing was changed.' };
  let backup: MigrationBackup | undefined;
  try {
    backup = await idb.get<MigrationBackup>(MIGRATION_BACKUP_PREFIX + backupId);
  } catch (err) {
    return { ok: false, explanation: `The safety copy could not be read (${explain(err, 'IndexedDB error')}). Your semester file was not changed.` };
  }
  if (!backup) return { ok: false, explanation: 'The safety copy could not be found, so your semester file was not changed.' };

  let current: string | null = null;
  try { current = localStorage.getItem(STATE_KEY); } catch {
    return { ok: false, explanation: 'localStorage could not be read, so nothing was changed.' };
  }
  if (current != null && current !== backup.stateJson) {
    const qid = `quarantine_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const aside: MigrationBackup = {
      id: qid,
      fromVersion: schema?.schemaVersion ?? 1,
      createdAt: nowIso(),
      stateJson: current,
      schemaJson: (() => { try { return localStorage.getItem(SCHEMA_KEY); } catch { return null; } })(),
      aiSettingsJson: (() => { try { return localStorage.getItem(AI_SETTINGS_KEY); } catch { return null; } })(),
    };
    try {
      await idb.set(MIGRATION_BACKUP_PREFIX + qid, aside);
      const check = await idb.get<MigrationBackup>(MIGRATION_BACKUP_PREFIX + qid);
      if (!check || check.stateJson !== current) throw new Error('mismatch');
    } catch (err) {
      return {
        ok: false,
        explanation: isQuotaError(err)
          ? 'There is not enough free storage to copy your current file aside, so it was not replaced.'
          : 'Your current file could not be copied aside first, so it was not replaced.',
      };
    }
  }
  try {
    restoreExact(backup);
    writeSchema({
      schemaVersion: backup.fromVersion || 1,
      status: 'rolled-back',
      updatedAt: nowIso(),
      safetyBackupId: backup.id,
      error: 'Restored the safety copy from before the last update. Nothing was deleted.',
      history: schema?.history ?? [],
    });
  } catch (err) {
    return { ok: false, explanation: `The safety copy could not be restored (${explain(err, 'storage error')}).` };
  }
  const restored = readWorkspaceRaw();
  if (backup.stateJson != null && restored.raw !== backup.stateJson) {
    return { ok: false, explanation: 'The restored file did not match the safety copy, so treat it as unverified before studying from it.' };
  }
  if (restored.status === 'ok' || restored.status === 'missing') allowWorkspacePersist();
  return { ok: true, reload: true, explanation: 'The safety copy was restored. Nothing was deleted before the copy was checked.' };
}

export async function quarantineUnreadableState(): Promise<RecoveryResult> {
  const stateRead = readWorkspaceRaw();
  if (stateRead.status === 'unavailable') {
    return { ok: false, explanation: 'localStorage could not be read, so nothing was changed.' };
  }
  if (stateRead.status !== 'malformed' || stateRead.raw == null) {
    return { ok: false, explanation: 'The semester file is readable, so it was not set aside.' };
  }
  const id = `quarantine_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const record: MigrationBackup = {
    id,
    fromVersion: 1,
    createdAt: nowIso(),
    stateJson: stateRead.raw,
    schemaJson: (() => { try { return localStorage.getItem(SCHEMA_KEY); } catch { return null; } })(),
    aiSettingsJson: (() => { try { return localStorage.getItem(AI_SETTINGS_KEY); } catch { return null; } })(),
  };
  try {
    await idb.set(MIGRATION_BACKUP_PREFIX + id, record);
    const stored = await idb.get<MigrationBackup>(MIGRATION_BACKUP_PREFIX + id);
    if (!stored || stored.stateJson !== stateRead.raw) {
      return { ok: false, explanation: 'The unreadable file could not be copied aside, so it was not replaced.' };
    }
  } catch (err) {
    return {
      ok: false,
      explanation: isQuotaError(err)
        ? 'There is not enough free storage to keep a copy of the unreadable file, so it was not replaced.'
        : 'The unreadable file could not be copied aside, so it was not replaced.',
    };
  }
  const fresh = JSON.stringify({ ...initialState });
  try {
    localStorage.setItem(STATE_KEY, fresh);
    if (localStorage.getItem(STATE_KEY) !== fresh) throw new Error('mismatch');
    writeSchema({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      status: 'current',
      updatedAt: nowIso(),
      safetyBackupId: id,
      history: [{
        from: 1,
        to: CURRENT_SCHEMA_VERSION,
        at: nowIso(),
        ok: true,
        note: 'Unreadable semester file was set aside in a safety copy. It was not deleted.',
      }],
    });
  } catch {
    try { localStorage.setItem(STATE_KEY, stateRead.raw); } catch { /* the safety copy still holds it */ }
    return { ok: false, explanation: 'The new workspace could not be saved. Your unreadable file was put back if that was still possible. The safety copy was kept.' };
  }
  allowWorkspacePersist();
  publishStorageNotice(null);
  return {
    ok: true,
    reload: true,
    explanation: 'The unreadable file was copied aside and an empty workspace was started. The copy is still on this device. Nothing was deleted before that copy was checked.',
  };
}
