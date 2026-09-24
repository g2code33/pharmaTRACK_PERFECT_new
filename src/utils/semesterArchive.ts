/**
 * Semester Completion + Local Academic Archive.
 *
 * Completing a semester is a two-phase, failure-safe operation:
 *
 *   1. ARCHIVE  — snapshot the whole workspace (every semester field, not a
 *      hand-maintained list), COPY every semester-owned IndexedDB record
 *      (uploaded files, offloaded/OCR text, AI conversations, the search
 *      index, and any future store) into the archive's own namespace, verify
 *      it, and only then mark it `verified`. Credentials are never copied.
 *   2. RESET    — persist a genuinely fresh workspace (identity only), release
 *      the old workspace's IndexedDB records (now safe: the archive owns its
 *      own copies). The archive is labelled with the semester that just
 *      ended — never the one that is about to start.
 *
 * The reset is strictly ordered AFTER verification. Any failure in phase 1
 * leaves the live workspace byte-for-byte untouched and marks the partial
 * archive `failed` (and best-effort cleans it up), so the user can retry.
 *
 * Everything here is local-first: no Supabase, no network, works offline.
 */
import * as idb from 'idb-keyval';
import JSZip from 'jszip';
import { v4 as uuidv4 } from 'uuid';
import type {
  AppState,
  SemesterArchiveMeta,
  SemesterSnapshot,
  SemesterArchiveCounts,
  BackupManifest,
  StagedBackup,
  Student,
} from '../types';
import { initialState, saveState } from './storage';
import { scrubSecretsDeep } from '../ai/credentials';
import { getSearchIndexRaw, setSearchIndexRaw, clearSearchIndex, type IndexShape } from './searchIndex';
import type {
  PharmaTrackBackupManifest,
  BackupSummary,
  StagedDegreeBackup,
  ImportDiagnostic,
} from '../types';
import pkg from '../../package.json';

/** App version embedded in every backup manifest (cross-device provenance). */
export const APP_VERSION: string = String((pkg as { version?: string }).version || '0.0.0');

// ---------------------------------------------------------------------------
// Key layout
//
//   semester_archive_<id>                        main record (meta + snapshot
//                                                + index + manifest)
//   semester_archive_file_<id>_<fileId>          copy of file_<fileId>
//   semester_archive_text_<id>_<slideId>         copy of slidetext_<slideId>
//
// The main record is the only key that is neither a `file_` nor a `text_`
// key, which is how listArchives() distinguishes them.
// ---------------------------------------------------------------------------
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_KEY_PREFIX = 'semester_archive_';
const META_PREFIX = ARCHIVE_KEY_PREFIX;
const META_FILE_PREFIX = 'semester_archive_file_';
const META_TEXT_PREFIX = 'semester_archive_text_';
const META_RECORD_PREFIX = 'semester_archive_record_';

export const archiveFileKey = (archiveId: string, fileId: string) => `${META_FILE_PREFIX}${archiveId}_${fileId}`;
export const archiveTextKey = (archiveId: string, slideId: string) => `${META_TEXT_PREFIX}${archiveId}_${slideId}`;
/** Other semester-owned IndexedDB records (AI conversations, future stores). */
export const archiveRecordKey = (archiveId: string, sourceKey: string) => `${META_RECORD_PREFIX}${archiveId}__${sourceKey}`;

/**
 * IndexedDB keys that are app infrastructure, not semester academic data.
 * Never copied into an archive, never deleted when a semester rolls over,
 * and never written into a `.pharmatrack` backup.
 */
export const PROTECTED_IDB_KEYS = new Set<string>([
  'pharmatrack_ai_credentials',
  'pharmatrack_ai_settings',
  // Derived AI retrieval index. Rebuilt from academic data; never archived.
  'pharmatrack_ai_rag_index',
  // Derived search catalogs. Rebuilt from academic data; not semester content.
  'pharmatrack_archive_search_catalog',
  'pharmatrack_conversation_search',
]);

/**
 * Safety copies made before a schema migration. Not semester data: never
 * archived, never exported, never deleted when a semester rolls over.
 * The Storage Manager owns this namespace.
 */
export const MIGRATION_BACKUP_PREFIX = 'pharmatrack_migration_backup_';

/** True for the archive namespace itself — listing/cleanup must not treat these as live data. */
export const isArchiveNamespaceKey = (key: string): boolean => key.startsWith(META_PREFIX);

/**
 * A live IndexedDB key that belongs to the current semester. This is a
 * denylist (archives + secrets + migration safety copies + interrupted
 * import stages), not an allowlist, so a store added later is captured
 * without a code change.
 *
 * Import stages (`semester_import_*`) are unfinished work. They are discarded
 * only by the import flow or by an explicit Storage Manager action — never as
 * a side effect of archiving or replacing the workspace.
 */
export const isSemesterOwnedIdbKey = (key: string): boolean =>
  Boolean(key) &&
  !PROTECTED_IDB_KEYS.has(key) &&
  !isArchiveNamespaceKey(key) &&
  !key.startsWith(MIGRATION_BACKUP_PREFIX) &&
  !key.startsWith('semester_import_');

const isArchiveMetaKey = (key: string): boolean =>
  key.startsWith(META_PREFIX) &&
  !key.startsWith(META_FILE_PREFIX) &&
  !key.startsWith(META_TEXT_PREFIX) &&
  !key.startsWith(META_RECORD_PREFIX);

const keysBelongingToArchive = (keys: string[], archiveId: string): string[] =>
  keys.filter((k) =>
    k === META_PREFIX + archiveId ||
    k.startsWith(META_FILE_PREFIX + archiveId) ||
    k.startsWith(META_TEXT_PREFIX + archiveId) ||
    k.startsWith(META_RECORD_PREFIX + archiveId),
  );

/** Session flags and secrets — not academic data, so a snapshot never carries them. */
const NON_SEMESTER_STATE_KEYS = new Set(['isLoggedIn', 'openAIKey']);

export interface ArchiveRecord {
  meta: SemesterArchiveMeta;
  snapshot: SemesterSnapshot;
  /** The full-text search index at capture time (null when empty). */
  index: IndexShape | null;
  /** Copied records: source key, archive key, kind, byte size. */
  manifest: { sourceKey: string; archiveKey: string; kind: 'file' | 'slidetext' | 'record'; size: number }[];
}

export class ArchiveError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/** True when the underlying failure was an IndexedDB/localStorage quota error. */
export const isQuotaError = (err: unknown): boolean =>
  err instanceof DOMException &&
  (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------
export interface ArchiveProgress {
  phase: 'snapshot' | 'files' | 'verify' | 'reset' | 'protect' | 'done';
  current?: number;
  total?: number;
  copiedBytes?: number;
  /** 0..100 — set while packaging a backup (JSZip compress). */
  percent?: number;
  message?: string;
}
type ProgressFn = (p: ArchiveProgress) => void;

// ---------------------------------------------------------------------------
// Academic progression
// ---------------------------------------------------------------------------

/** "Level 300" | "300" | "level 200" -> 300 / 200 / 0 when unparseable. */
export const parseLevel = (value: string): number => {
  const m = /(\d{3})/.exec(value || '');
  return m ? parseInt(m[1], 10) : 0;
};

/** "1st Semester" | "1st" | "2nd" -> 1 | 2 (defaults to 1). */
export const parseSemester = (value: string): number => {
  const m = /(\d)/.exec(value || '');
  return m ? parseInt(m[1], 10) : 1;
};

const ordinal = (n: number) => (n === 1 ? '1st Semester' : n === 2 ? '2nd Semester' : `${n}th Semester`);

/**
 * The next academic position after completing `level`/`semester`.
 * Levels are 100..600 with two semesters each (the app's own model); the
 * result is always editable in the completion UI, so odd programmes can be
 * adjusted by hand instead of being hard-coded.
 */
export const computeNextProgression = (level: string, semester: string): { level: string; semester: string } => {
  const L = parseLevel(level) || 100;
  const S = parseSemester(semester) || 1;
  if (S <= 1) return { level: `Level ${L}`, semester: ordinal(2) };
  if (L < 600) return { level: `Level ${L + 100}`, semester: ordinal(1) };
  // Already at the final position: keep it; the user confirms in the UI.
  return { level: `Level ${L}`, semester: ordinal(2) };
};

/** Academic year label (Sept–June style, e.g. "2026/2027"). */
export const defaultAcademicYear = (date: Date = new Date()): string => {
  const y = date.getFullYear();
  const start = date.getMonth() >= 8 ? y : y - 1;
  return `${start}/${start + 1}`;
};

// ---------------------------------------------------------------------------
// Snapshot & file references
// ---------------------------------------------------------------------------

/**
 * Every IndexedDB record the semester depends on.
 *
 * Slides reference their binary via `fileUrl`, which exists in two historical
 * conventions: `local:<id>` (slide modal) and the bare id (FileUploader).
 * Both resolve to `file_<id>`. Offloaded slide text (slides whose text was
 * longer than the 2000-char inline cap) lives in `slidetext_<slideId>` —
 * referenced for every slide; copies of keys that were never written are
 * simply skipped.
 */
export interface ArchiveFileRef {
  id: string;
  kind: 'file' | 'slidetext';
  sourceKey: string;
}

export const collectFileRefs = (state: AppState): ArchiveFileRef[] => {
  const seen = new Set<string>();
  const refs: ArchiveFileRef[] = [];
  for (const slide of state.slides) {
    const fileId = (slide.fileUrl || '').replace(/^local:/, '');
    if (fileId && !seen.has(`file:${fileId}`)) {
      seen.add(`file:${fileId}`);
      refs.push({ id: fileId, kind: 'file', sourceKey: `file_${fileId}` });
    }
    if (!seen.has(`text:${slide.id}`)) {
      seen.add(`text:${slide.id}`);
      refs.push({ id: slide.id, kind: 'slidetext', sourceKey: `slidetext_${slide.id}` });
    }
  }
  return refs;
};

const collectionCounts = (state: AppState): SemesterArchiveCounts => ({
  courses: state.courses?.length ?? 0,
  topics: state.topics?.length ?? 0,
  slides: state.slides?.length ?? 0,
  notes: state.notes?.length ?? 0,
  questions: state.examQuestions?.length ?? 0,
  quizzes: state.quizHistory?.length ?? 0,
});

/**
 * Counts every collection on the snapshot, including ones this file does not
 * name. Nested timetable buckets are counted the same way they always were,
 * so archives written before this change still verify.
 */
export const itemCountOf = (state: AppState | SemesterSnapshot): number => {
  let n = 0;
  for (const [key, value] of Object.entries(state)) {
    if (key === 'student' || key === 'capturedAt' || key === 'timetablePdf') continue;
    if (NON_SEMESTER_STATE_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      n += value.length;
      continue;
    }
    if (key === 'timetables' && value && typeof value === 'object') {
      for (const bucket of Object.values(value as Record<string, unknown>)) {
        if (Array.isArray(bucket)) n += bucket.length;
      }
    }
  }
  return n;
};

/**
 * The whole semester, minus session flags and secrets. Future AppState fields
 * are copied automatically — there is no collection allowlist to go stale.
 * The result is scrubbed so a pasted API key inside a note cannot ride along.
 */
export const buildSnapshot = (state: AppState): SemesterSnapshot => {
  const raw: Record<string, unknown> = { capturedAt: new Date().toISOString() };
  for (const [key, value] of Object.entries(state)) {
    if (NON_SEMESTER_STATE_KEYS.has(key)) continue;
    raw[key] = value;
  }
  return scrubSecretsDeep(raw) as SemesterSnapshot;
};

/** Fields the app has always had. Anything else on the object is semester data too. */
const KNOWN_STATE_KEYS = new Set([
  'isLoggedIn', 'student', 'courses', 'topics', 'slides', 'learningObjectives',
  'examQuestions', 'quizHistory', 'studyPlans', 'notes', 'examDates', 'activities',
  'chatHistory', 'highlights', 'savedInsights', 'learningRecords', 'learningSettings',
  'clinicalCases', 'clinicalAttempts', 'openAIKey', 'timetables', 'timetablePdf',
]);

/** Does this workspace hold anything a user would care to keep? */
export const hasWorkspaceContent = (state: AppState): boolean => {
  if (itemCountOf(state) > 0 || state.timetablePdf) return true;
  for (const [key, value] of Object.entries(state)) {
    if (KNOWN_STATE_KEYS.has(key) || NON_SEMESTER_STATE_KEYS.has(key)) continue;
    if (value == null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isBinaryValue = (value: unknown): boolean =>
  (typeof Blob !== 'undefined' && value instanceof Blob) ||
  value instanceof Uint8Array ||
  (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer);

const sizeOf = (value: unknown): number => {
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  if (typeof value === 'string') return new TextEncoder().encode(value).length;
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) return (value as ArrayBufferView).byteLength;
  return JSON.stringify(value)?.length ?? 0;
};

/** FNV-1a 32-bit — deterministic, no crypto dependency (works in every webview). */
export const checksumOf = (canonical: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

const canonicalForArchive = (meta: SemesterArchiveMeta, manifest: ArchiveRecord['manifest']): string =>
  JSON.stringify({
    version: meta.version,
    id: meta.id,
    itemCount: meta.itemCount,
    fileCount: meta.fileCount,
    totalBytes: meta.totalBytes,
    files: manifest.map((f) => [f.kind, f.sourceKey, f.size]).sort(),
  });

// ---------------------------------------------------------------------------
// Archive creation
// ---------------------------------------------------------------------------

export interface CreateArchiveOptions {
  level: string;
  semester: string;
  academicYear?: string;
  title?: string;
  onProgress?: ProgressFn;
}

/**
 * Creates and verifies an archive of `state`. On ANY failure the live
 * workspace is untouched: the partial archive is marked `failed` (and
 * best-effort deleted) and an ArchiveError is thrown.
 */
export const createSemesterArchive = async (state: AppState, opts: CreateArchiveOptions): Promise<SemesterArchiveMeta> => {
  const { onProgress } = opts;
  if (!state.student) throw new ArchiveError('No student profile found — complete onboarding first.');

  const L = parseLevel(opts.level);
  const S = parseSemester(opts.semester);
  const academicYear = opts.academicYear || defaultAcademicYear();
  const [y1, y2] = academicYear.split('/');
  const id = `archive_${L}_${S}_${y1}_${y2}_${uuidv4().slice(0, 8)}`;
  const now = new Date().toISOString();
  const title = opts.title || `Level ${L} — Semester ${S}`;

  onProgress?.({ phase: 'snapshot', message: 'Capturing semester data…' });

  const snapshot = buildSnapshot(state);
  const index = await getSearchIndexRaw();
  const refs = collectFileRefs(state);
  const itemCount = itemCountOf(state);

  const baseMeta: SemesterArchiveMeta = {
    id,
    level: String(L),
    semester: String(S),
    title,
    academicYear,
    completedAt: now,
    createdAt: now,
    status: 'creating',
    version: ARCHIVE_VERSION,
    itemCount,
    fileCount: 0,
    totalBytes: 0,
    counts: collectionCounts(state),
  };

  // Persist a `creating` marker first so the archive is visible (and can be
  // cleaned up) even if the process dies mid-copy.
  const marker: ArchiveRecord = { meta: baseMeta, snapshot, index, manifest: [] };
  try {
    await idb.set(META_PREFIX + id, marker);
  } catch (err) {
    throw toArchiveError(err, 'Could not start the archive (storage unavailable).');
  }

  const manifest: ArchiveRecord['manifest'] = [];
  let totalBytes = 0;
  const copiedSources = new Set<string>();

  const remember = async (
    sourceKey: string,
    targetKey: string,
    kind: ArchiveRecord['manifest'][number]['kind'],
    value: unknown,
  ): Promise<void> => {
    // Binaries are copied as-is. Structured records are scrubbed so a pasted
    // key cannot land in the archive. The live value is never mutated.
    const stored = kind === 'record' && !isBinaryValue(value) ? scrubSecretsDeep(value) : value;
    await idb.set(targetKey, stored);
    const size = sizeOf(stored);
    totalBytes += size;
    manifest.push({ sourceKey, archiveKey: targetKey, kind, size });
    copiedSources.add(sourceKey);
  };

  try {
    onProgress?.({ phase: 'files', current: 0, total: refs.length, copiedBytes: 0, message: 'Copying files…' });
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const value = await idb.get(ref.sourceKey);
      if (value === undefined || value === null) continue; // never offloaded — nothing to copy
      const targetKey = ref.kind === 'file' ? archiveFileKey(id, ref.id) : archiveTextKey(id, ref.id);
      await remember(ref.sourceKey, targetKey, ref.kind, value);
      onProgress?.({ phase: 'files', current: i + 1, total: refs.length, copiedBytes: totalBytes, message: `Copying files… ${i + 1}/${refs.length}` });
    }

    // Everything else the semester owns in IndexedDB: unreferenced uploads,
    // AI conversations, the search index, and any store added later. Secrets
    // and the archive namespace itself are excluded by isSemesterOwnedIdbKey.
    const allKeys = await idb.keys<string>();
    for (const key of allKeys) {
      if (!isSemesterOwnedIdbKey(key) || copiedSources.has(key)) continue;
      const value = await idb.get(key);
      if (value === undefined || value === null) continue;
      if (key.startsWith('file_')) {
        await remember(key, archiveFileKey(id, key.slice('file_'.length)), 'file', value);
      } else if (key.startsWith('slidetext_')) {
        await remember(key, archiveTextKey(id, key.slice('slidetext_'.length)), 'slidetext', value);
      } else {
        await remember(key, archiveRecordKey(id, key), 'record', value);
      }
    }

    onProgress?.({ phase: 'verify', message: 'Verifying archive…' });
    const meta: SemesterArchiveMeta = { ...baseMeta, fileCount: manifest.length, totalBytes };
    meta.checksum = checksumOf(canonicalForArchive(meta, manifest));
    const record: ArchiveRecord = { meta, snapshot, index, manifest };
    await idb.set(META_PREFIX + id, record);

    const verified = await verifySemesterArchive(id);
    if (verified.status !== 'verified') {
      throw new ArchiveError(`Archive verification failed: ${verified.error || 'unknown reason'}`);
    }
    onProgress?.({ phase: 'done', message: 'Backup verified ✓' });
    return verified;
  } catch (err) {
    await failArchive(id, err);
    throw err instanceof ArchiveError ? err : toArchiveError(err, archiveErrorMessage(err));
  }
};

const archiveErrorMessage = (err: unknown): string =>
  isQuotaError(err)
    ? 'Device storage is full, so the archive could not be completed. Your current semester is untouched — free up space (or export a backup to your device) and try again.'
    : `The archive could not be completed: ${err instanceof Error ? err.message : String(err)}. Your current semester is untouched.`;

const toArchiveError = (err: unknown, message: string): ArchiveError => new ArchiveError(message, err);

/** Marks the archive failed (best-effort) and removes its partial records. */
const failArchive = async (id: string, err: unknown): Promise<void> => {
  try {
    const record = await idb.get<ArchiveRecord>(META_PREFIX + id);
    if (record) {
      record.meta = {
        ...record.meta,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
      await idb.set(META_PREFIX + id, record);
    }
    // Best-effort cleanup of the partial copy so retries don't pile up.
    const keys = await idb.keys<string>();
    const partial = keysBelongingToArchive(keys, id);
    if (partial.length) await idb.delMany(partial);
  } catch (cleanupErr) {
    console.error('Failed-archive cleanup failed (safe to ignore):', cleanupErr);
  }
};

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Re-reads the archive from IndexedDB and proves it is complete: metadata,
 * counts, every copied record present with the recorded size, checksum, and
 * collection relationships. Never mutates the archive on success; records the
 * problem and throws on failure.
 */
export const verifySemesterArchive = async (archiveId: string): Promise<SemesterArchiveMeta> => {
  const record = await idb.get<ArchiveRecord>(META_PREFIX + archiveId);
  if (!record) throw new ArchiveError('Archive record not found.');

  const { meta, snapshot } = record;
  const fail = async (reason: string): Promise<SemesterArchiveMeta> => {
    const failed: SemesterArchiveMeta = { ...meta, status: 'failed', error: reason };
    try { await idb.set(META_PREFIX + archiveId, { ...record, meta: failed }); } catch { /* best-effort */ }
    throw new ArchiveError(`Archive verification failed: ${reason}`);
  };

  try {
    // 1. Metadata sanity.
    if (!meta.id || meta.version !== ARCHIVE_VERSION) return fail(`Unsupported archive version: ${meta.version}`);
    if (!snapshot || !snapshot.student) return fail('Snapshot is missing its student profile.');

    // 2. JSON round-trip proves the record is fully serialisable (what a
    //    future export/restore will depend on).
    const roundTrip: ArchiveRecord = JSON.parse(JSON.stringify(record));
    if (roundTrip.snapshot.courses.length !== snapshot.courses.length) return fail('Snapshot did not round-trip.');

    // 3. Counts match the snapshot.
    if (meta.itemCount !== itemCountOf(roundTrip.snapshot as unknown as AppState)) return fail('Record counts do not match the snapshot.');
    const cc = collectionCounts(roundTrip.snapshot as unknown as AppState);
    if (meta.counts && (
      meta.counts.courses !== cc.courses || meta.counts.topics !== cc.topics ||
      meta.counts.slides !== cc.slides || meta.counts.notes !== cc.notes ||
      meta.counts.questions !== cc.questions || meta.counts.quizzes !== cc.quizzes
    )) return fail('Archive counts do not match the snapshot collections.');

    // 4. Checksum.
    if (!meta.checksum || meta.checksum !== checksumOf(canonicalForArchive(meta, roundTrip.manifest))) {
      return fail('Checksum mismatch — the archive content does not match its manifest.');
    }

    // 5. Every declared record exists with the declared size.
    for (const entry of roundTrip.manifest) {
      const value = await idb.get(entry.archiveKey);
      if (value === undefined || value === null) return fail(`Missing archived record: ${entry.sourceKey}`);
      if (sizeOf(value) !== entry.size) return fail(`Size mismatch for archived record: ${entry.sourceKey}`);
    }

    // 6. Relationships: no orphaned references.
    const courseIds = new Set(snapshot.courses.map((c) => c.id));
    const topicIds = new Set(snapshot.topics.map((t) => t.id));
    const slideIds = new Set(snapshot.slides.map((s) => s.id));
    if (snapshot.topics.some((t) => !courseIds.has(t.courseId))) return fail('Topic references a missing course.');
    if (snapshot.slides.some((s) => !topicIds.has(s.topicId))) return fail('Material references a missing topic.');
    if (snapshot.notes.some((n) => !topicIds.has(n.topicId))) return fail('Note references a missing topic.');
    if (snapshot.examQuestions.some((q) => !courseIds.has(q.courseId) || !topicIds.has(q.topicId))) {
      return fail('Question references a missing course or topic.');
    }
    if (snapshot.quizHistory.some((q) => !courseIds.has(q.courseId))) return fail('Quiz history references a missing course.');
    if (snapshot.studyPlans.some((p) => !courseIds.has(p.courseId))) return fail('Study plan references a missing course.');
    if (snapshot.examDates.some((d) => !courseIds.has(d.courseId))) return fail('Exam date references a missing course.');
    if (snapshot.highlights.some((h) => h.materialId && !slideIds.has(h.materialId))) {
      return fail('Highlight references a missing material.');
    }

    // 7. Mark verified (idempotent).
    if (meta.status !== 'verified') {
      const verified: SemesterArchiveMeta = { ...meta, status: 'verified', error: undefined };
      await idb.set(META_PREFIX + archiveId, { ...record, meta: verified });
      return verified;
    }
    return meta;
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError(`Archive verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ---------------------------------------------------------------------------
// Listing / loading / deleting archives
// ---------------------------------------------------------------------------

export const listArchives = async (): Promise<SemesterArchiveMeta[]> => {
  const allKeys = await idb.keys<string>();
  const metaKeys = allKeys.filter(isArchiveMetaKey);
  const records = await Promise.all(metaKeys.map((k) => idb.get<ArchiveRecord>(k)));
  return records
    .map((r) => r?.meta)
    .filter((m): m is SemesterArchiveMeta => !!m)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
};

export const loadArchive = async (archiveId: string): Promise<ArchiveRecord | null> => {
  try {
    return (await idb.get<ArchiveRecord>(META_PREFIX + archiveId)) ?? null;
  } catch (err) {
    console.error(`Error loading archive ${archiveId}:`, err);
    return null;
  }
};

/** A binary (or offloaded text) previously copied into an archive. */
export const loadArchivedFile = async (archiveId: string, fileId: string): Promise<Blob | Uint8Array | string | null> => {
  try {
    return (await idb.get(archiveFileKey(archiveId, fileId))) ?? null;
  } catch (err) {
    console.error(`Error loading archived file ${fileId}:`, err);
    return null;
  }
};

export const loadArchivedSlideText = async (archiveId: string, slideId: string): Promise<string | null> => {
  try {
    const v = await idb.get<string>(archiveTextKey(archiveId, slideId));
    return typeof v === 'string' ? v : null;
  } catch (err) {
    console.error(`Error loading archived slide text ${slideId}:`, err);
    return null;
  }
};

/** Other semester-owned IndexedDB records captured with the archive (AI chats, future stores). */
export const loadArchivedRecords = async (
  archiveId: string,
): Promise<{ sourceKey: string; value: unknown }[]> => {
  const record = await loadArchive(archiveId);
  if (!record) return [];
  const out: { sourceKey: string; value: unknown }[] = [];
  for (const entry of record.manifest) {
    if (entry.kind !== 'record') continue;
    try {
      out.push({ sourceKey: entry.sourceKey, value: (await idb.get(entry.archiveKey)) ?? null });
    } catch (err) {
      console.error(`Error loading archived record ${entry.sourceKey}:`, err);
    }
  }
  return out;
};

/** Deletes an archive and all its records. Only for verified/failed archives the user asked to remove. */
export const deleteArchive = async (archiveId: string): Promise<void> => {
  const keys = await idb.keys<string>();
  const toDelete = keysBelongingToArchive(keys, archiveId);
  if (toDelete.length) await idb.delMany(toDelete);
};

// ---------------------------------------------------------------------------
// Fresh workspace & reset
// ---------------------------------------------------------------------------

/**
 * The fresh workspace after a semester completes: identity (with the new
 * academic position) and app preferences only. Every semester-specific
 * collection is genuinely empty.
 */
export const buildFreshWorkspace = (state: AppState, next: { level: string; semester: string }): AppState => ({
  ...initialState,
  isLoggedIn: state.isLoggedIn,
  // v4: a semester rollover carries academic identity only. The legacy
  // `openAIKey` field is NOT copied forward — API keys are provider
  // configuration owned by the AI engine (IndexedDB credential store), not
  // academic data, so a fresh workspace never inherits a secret.
  openAIKey: '',
  student: state.student ? { ...state.student, level: next.level, semester: next.semester } : null,
});

/**
 * Deletes IndexedDB records that the given workspace no longer references.
 * Called only AFTER the (verified) archive owns copies of every record the
 * old workspace had — so this can never destroy unique data.
 */
export const pruneWorkspaceFiles = async (state: AppState): Promise<void> => {
  const keep = new Set<string>();
  for (const slide of state.slides) {
    const fileId = (slide.fileUrl || '').replace(/^local:/, '');
    if (fileId) keep.add(`file_${fileId}`);
    keep.add(`slidetext_${slide.id}`);
  }
  const allKeys = await idb.keys<string>();
  // Release every semester-owned record the fresh workspace does not reference.
  // Archives and credentials are not semester-owned, so they stay.
  const orphans = allKeys.filter((k) => isSemesterOwnedIdbKey(k) && !keep.has(k));
  if (orphans.length) await idb.delMany(orphans);
};

// ---------------------------------------------------------------------------
// Complete Semester — the failure-safe orchestration
// ---------------------------------------------------------------------------

export interface CompleteSemesterResult {
  archive: SemesterArchiveMeta;
  /** The fresh workspace — the caller dispatches LOAD_STATE with it. */
  fresh: AppState;
}

/**
 * Runs the full flow: archive → verify → fresh workspace → prune.
 *
 * Guarantees:
 *  - the live workspace is only rewritten after the archive is VERIFIED;
 *  - the fresh state is persisted to localStorage BEFORE any IndexedDB
 *    record is deleted (a crash mid-prune can orphan bytes, never data);
 *  - any failure before that point throws without touching the workspace.
 */
export interface CompleteSemesterOptions {
  /** Academic position the NEW workspace starts at. Never used as the archive label. */
  nextLevel: string;
  nextSemester: string;
  /**
   * Academic year of the semester being closed. Stored on the archive only —
   * the fresh workspace does not inherit a year, because Student has no year
   * field and the next semester may fall in a different year.
   */
  academicYear?: string;
  onProgress?: ProgressFn;
}

export const completeSemester = async (
  state: AppState,
  options: CompleteSemesterOptions,
): Promise<CompleteSemesterResult> => {
  if (!state.student) throw new ArchiveError('No student profile found — complete onboarding first.');

  // The archive is the semester that just ended, read from the live profile.
  // The caller's level/semester is where the student is going next.
  const archive = await createSemesterArchive(state, {
    level: state.student.level,
    semester: state.student.semester,
    academicYear: options.academicYear,
    onProgress: options.onProgress,
  });
  if (archive.status !== 'verified') {
    throw new ArchiveError('The archive did not reach verified status — nothing was changed.');
  }

  options.onProgress?.({ phase: 'reset', message: 'Starting fresh workspace…' });
  const fresh = buildFreshWorkspace(state, { level: options.nextLevel, semester: options.nextSemester });

  // Persist the new workspace first: from this instant the active semester is
  // the empty one on disk, and everything the old semester owned exists in
  // the verified archive.
  saveState(fresh);
  try {
    await pruneWorkspaceFiles(fresh);
  } catch (err) {
    // The archive is verified and the new state is saved; a failed prune only
    // leaves orphan bytes, not data loss. Report, don't abort.
    console.error('Orphan cleanup after semester completion failed (data is safe in the archive):', err);
  }
  try {
    await clearSearchIndex();
  } catch (err) {
    console.error('Search index reset failed (data is safe in the archive):', err);
  }

  options.onProgress?.({ phase: 'done', message: 'Semester completed 🎓' });
  return { archive, fresh };
};

// ---------------------------------------------------------------------------
// Portable backup — the `pharmatrack-semester-backup` format (v1)
//
//   PharmaTRACK_Level-200_Semester-2_2025-2026.pharmatrack   (ZIP inside)
//     manifest.json              versioned manifest + integrity checksum
//     semester/
//       student.json  courses.json  topics.json  slides.json
//       learning-objectives.json  exam-questions.json  quiz-history.json
//       study-plans.json  notes.json  exam-dates.json  activities.json
//       chat-history.json  highlights.json  saved-insights.json
//       semester.json             identity (archive id, year, level, semester)
//       timetable.json  search-index.json (when present)  workspace.json
//     materials/<fileId>.json    material metadata (which slide owns the file)
//     files/<fileId>.<ext>       the ACTUAL uploaded binaries (PDF/PPTX/…)
//     text/<slideId>.txt         offloaded slide / OCR text (verbatim)
//     metadata/checksums.json    per-entry size + content hash (FNV-1a 32)
//
// Degree bundle:
//   PharmaTRACK_Full-Academic-Record_<date>.pharmatrack
//     manifest.json (format: pharmatrack-degree-backup)
//     semesters/*.pharmatrack    one full semester package per archive
//
// Everything needed to reconstruct a semester ships inside the package —
// application state AND IndexedDB data. Nothing is keyed to a device path,
// browser profile or machine, and nothing is uploaded anywhere.
// ---------------------------------------------------------------------------

export const BACKUP_FORMAT = 'pharmatrack-semester-backup';
export const DEGREE_BACKUP_FORMAT = 'pharmatrack-degree-backup';
/** Format versions this build can read. Future versions fail safe. */
export const SUPPORTED_BACKUP_VERSIONS: number[] = [1];

/**
 * Migration handlers for older format versions. Today only v1 exists; when
 * v2 ships, add e.g. `1: migrateBackupV1ToV2` so old backups still import.
 */
const SEMESTER_FORMAT_MIGRATORS: Record<number, (m: PharmaTrackBackupManifest) => PharmaTrackBackupManifest> = {
  1: (m) => m,
};

/** Legacy export format (kept importable for backups made before v1). */
const LEGACY_BACKUP_FORMAT = 'semester-backup';
const LEGACY_APP = 'pharmatrack';

/** FNV-1a 32-bit over raw bytes — used for per-entry content hashes. */
const fnv1aBytes = (seed: number, bytes: Uint8Array): string => {
  let h = seed;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

/** jsdom's Blob lacks arrayBuffer(); FileReader works everywhere. */
const readBlobBytes = (blob: Blob): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

/** Maps a MIME type (or slide.fileType) to a file extension. */
export const extForMime = (mime: string, fallbackType?: string): string => {
  const m = (mime || '').toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('presentationml')) return 'pptx';
  if (m.includes('wordprocessingml')) return 'docx';
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg')) return 'jpg';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webp')) return 'webp';
  if (m.startsWith('image/')) return 'img';
  const f = (fallbackType || '').toLowerCase();
  return ['pdf', 'pptx', 'docx', 'png', 'jpg', 'jpeg', 'gif', 'webp'].includes(f) ? f : 'bin';
};

/** "2025/2026" → "2025-2026"; anything unsafe becomes a dash-run. */
const fileNameSafe = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * PharmaTRACK-specific backup filename, e.g.
 * PharmaTRACK_Level-200_Semester-2_2025-2026.pharmatrack
 * Pass `suffix` (e.g. today's date) to disambiguate repeated exports.
 */
export const semesterBackupFileName = (level: string, semester: string, academicYear?: string, suffix?: string): string => {
  const L = parseLevel(level);
  const S = parseSemester(semester);
  const year = academicYear ? `_${fileNameSafe(academicYear)}` : '';
  const extra = suffix ? `_${suffix}` : '';
  return `PharmaTRACK_Level-${L || '000'}_Semester-${S || 1}${year}${extra}.pharmatrack`;
};

export const degreeBackupFileName = (date: Date = new Date()): string =>
  `PharmaTRACK_Full-Academic-Record_${date.toISOString().slice(0, 10)}.pharmatrack`;

interface PackedFile {
  /** fileId, slideId, or the original IndexedDB key for kind 'record'. */
  key: string;
  kind: 'file' | 'slidetext' | 'record';
  value: Blob | string | unknown;
  type: string;
  /** For kind 'file': the slide that owns this binary. */
  slide?: { id: string; title: string; fileType?: string };
}

/** Collects snapshot + binary refs from either an archive or the live state. */
const collectBackupSource = async (
  source: { kind: 'archive'; archiveId: string } | { kind: 'live'; state: AppState },
): Promise<{
  meta: { archiveId?: string; level: string; semester: string; title: string; academicYear?: string; completedAt?: string; source: 'archive' | 'live' };
  snapshot: SemesterSnapshot;
  index: IndexShape | null;
  files: PackedFile[];
}> => {
  let snapshot: SemesterSnapshot;
  let index: IndexShape | null;
  let meta: { archiveId?: string; level: string; semester: string; title: string; academicYear?: string; completedAt?: string; source: 'archive' | 'live' };

  if (source.kind === 'archive') {
    const rec = await loadArchive(source.archiveId);
    if (!rec) throw new ArchiveError('Archive not found.');
    snapshot = rec.snapshot;
    index = rec.index;
    meta = {
      archiveId: rec.meta.id,
      level: rec.meta.level,
      semester: rec.meta.semester,
      title: rec.meta.title,
      academicYear: rec.meta.academicYear,
      completedAt: rec.meta.completedAt,
      source: 'archive',
    };
  } else {
    const { state } = source;
    snapshot = buildSnapshot(state);
    index = await getSearchIndexRaw();
    meta = {
      archiveId: undefined,
      level: String(parseLevel(state.student?.level || '') || 0),
      semester: String(parseSemester(state.student?.semester || '') || 1),
      title: `Level ${parseLevel(state.student?.level || '')} — Semester ${parseSemester(state.student?.semester || '')} (current)`,
      academicYear: defaultAcademicYear(),
      completedAt: undefined,
      source: 'live',
    };
  }

  const valueType = (v: unknown): string =>
    typeof v === 'string' ? 'text/plain' : v instanceof Blob ? v.type || 'application/octet-stream' : 'application/octet-stream';

  const files: PackedFile[] = [];
  const slideForFile = (fileId: string) =>
    snapshot.slides.find((s) => (s.fileUrl || '').replace(/^local:/, '') === fileId);

  const pushLive = (key: string, kind: PackedFile['kind'], value: unknown, slide?: PackedFile['slide']) => {
    files.push({ key, kind, value, type: kind === 'slidetext' ? 'text/plain' : valueType(value), slide });
  };

  if (source.kind === 'archive') {
    for (const entry of (await loadArchive(source.archiveId))!.manifest) {
      const value = await idb.get(entry.archiveKey);
      if (value === undefined || value === null) continue;
      if (entry.kind === 'record') {
        pushLive(entry.sourceKey, 'record', value);
      } else if (entry.kind === 'file') {
        const fileId = entry.sourceKey.startsWith('file_') ? entry.sourceKey.slice('file_'.length) : entry.archiveKey.slice(META_FILE_PREFIX.length + source.archiveId.length + 1);
        pushLive(fileId, 'file', value, slideForFile(fileId));
      } else {
        const slideId = entry.sourceKey.startsWith('slidetext_') ? entry.sourceKey.slice('slidetext_'.length) : entry.archiveKey.slice(META_TEXT_PREFIX.length + source.archiveId.length + 1);
        pushLive(slideId, 'slidetext', value);
      }
    }
  } else {
    const seen = new Set<string>();
    for (const ref of collectFileRefs(snapshot as unknown as AppState)) {
      const value = await idb.get(ref.sourceKey);
      seen.add(ref.sourceKey);
      if (value === undefined || value === null) continue;
      pushLive(ref.id, ref.kind, value, ref.kind === 'file' ? slideForFile(ref.id) : undefined);
    }
    const allKeys = await idb.keys<string>();
    for (const key of allKeys) {
      if (!isSemesterOwnedIdbKey(key) || seen.has(key)) continue;
      const value = await idb.get(key);
      if (value === undefined || value === null) continue;
      if (key.startsWith('file_')) pushLive(key.slice('file_'.length), 'file', value, slideForFile(key.slice('file_'.length)));
      else if (key.startsWith('slidetext_')) pushLive(key.slice('slidetext_'.length), 'slidetext', value);
      else pushLive(key, 'record', value);
    }
  }
  return { meta, snapshot, index, files };
};

/** Every entry that ships inside a semester package (name + value + kind). */
interface PackageEntry {
  name: string;
  value: Blob | string;
  type: string;
}

const buildPackageEntries = (
  meta: Awaited<ReturnType<typeof collectBackupSource>>['meta'],
  snapshot: SemesterSnapshot,
  index: IndexShape | null,
  files: PackedFile[],
): PackageEntry[] => {
  // Every JSON entry is scrubbed on the way out. AI credentials live in a
  // separate store and are never in the snapshot to begin with, but this is the
  // belt-and-braces guard: if a future field, an imported archive or a legacy
  // `openAIKey` ever carries key material, it leaves as [redacted] instead of
  // riding along inside a file the student emails to a classmate.
  const sem = (name: string, value: unknown): PackageEntry => ({
    name: `semester/${name}`,
    value: JSON.stringify(scrubSecretsDeep(value), null, 2),
    type: 'application/json',
  });
  const entries: PackageEntry[] = [
    sem('student.json', snapshot.student),
    sem('courses.json', snapshot.courses),
    sem('topics.json', snapshot.topics),
    sem('slides.json', snapshot.slides),
    sem('learning-objectives.json', snapshot.learningObjectives),
    sem('exam-questions.json', snapshot.examQuestions),
    sem('quiz-history.json', snapshot.quizHistory),
    sem('study-plans.json', snapshot.studyPlans),
    sem('notes.json', snapshot.notes),
    sem('exam-dates.json', snapshot.examDates),
    sem('activities.json', snapshot.activities),
    sem('chat-history.json', snapshot.chatHistory),
    sem('highlights.json', snapshot.highlights),
    sem('saved-insights.json', snapshot.savedInsights),
    sem('timetable.json', { timetables: snapshot.timetables, timetablePdf: snapshot.timetablePdf }),
    sem('semester.json', {
      archiveId: meta.archiveId,
      academicYear: meta.academicYear,
      level: meta.level,
      semester: meta.semester,
      title: meta.title,
      completedAt: meta.completedAt,
      source: meta.source,
    }),
    // Full snapshot, including collections this build does not name. Importers
    // keep reading the named files above; unknown keys are merged from here.
    sem('workspace.json', snapshot),
  ];
  if (index && Object.keys(index).length) entries.push(sem('search-index.json', index));

  for (const f of files) {
    if (f.kind === 'record') {
      const text = JSON.stringify(scrubSecretsDeep(f.value));
      entries.push({ name: `records/${encodeURIComponent(f.key)}.json`, value: text, type: 'application/json' });
      continue;
    }
    if (f.kind === 'file') {
      const ext = extForMime(f.type, f.slide?.fileType);
      entries.push({
        name: `files/${f.key}.${ext}`,
        value: f.value as Blob | string,
        type: f.type,
      });
      entries.push({
        name: `materials/${f.key}.json`,
        value: JSON.stringify(scrubSecretsDeep({
          fileId: f.key,
          slideId: f.slide?.id,
          materialTitle: f.slide?.title,
          slideFileType: f.slide?.fileType,
          mimeType: f.type,
        }), null, 2),
        type: 'application/json',
      });
    } else {
      entries.push({ name: `text/${f.key}.txt`, value: f.value as string, type: 'text/plain' });
    }
  }
  void meta;
  return entries;
};

const entrySize = (v: Blob | string): number =>
  typeof v === 'string' ? new TextEncoder().encode(v).length : v.size;

const canonicalForBackupV1 = (
  m: { formatVersion: number; title: string; level?: string; semester?: string; archiveId?: string },
  totalBytes: number,
  entries: { name: string; size: number; hash: string }[],
): string =>
  JSON.stringify({
    formatVersion: m.formatVersion,
    title: m.title,
    level: m.level,
    semester: m.semester,
    archiveId: m.archiveId,
    totalBytes,
    entries: entries.map((e) => [e.name, e.size, e.hash]).sort(),
  });

const hashEntry = async (name: string, value: Blob | string): Promise<string> => {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const size = entrySize(value);
  for (let i = 0; i < String(size).length; i++) { h ^= String(size).charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  } else if (value instanceof Blob) {
    h = parseInt(fnv1aBytes(h, await readBlobBytes(value)), 16);
  }
  return h.toString(16).padStart(8, '0');
};

/**
 * Builds a portable semester backup (format v1). Pure: reads local storage,
 * writes nothing, returns a Blob ready to download.
 */
export const exportBackup = async (
  source: { kind: 'archive'; archiveId: string } | { kind: 'live'; state: AppState },
  onProgress?: ProgressFn,
): Promise<Blob> => {
  onProgress?.({ phase: 'snapshot', message: 'Preparing backup…' });
  const { meta, snapshot, index, files } = await collectBackupSource(source);

  onProgress?.({ phase: 'files', current: 0, total: files.length, message: 'Hashing files…' });
  const entries = buildPackageEntries(meta, snapshot, index, files);

  // Per-entry content hashes (files + text + every JSON).
  const hashed: { name: string; size: number; hash: string }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    hashed.push({ name: e.name, size: entrySize(e.value), hash: await hashEntry(e.name, e.value) });
    if (i % 10 === 9 || i === entries.length - 1) {
      onProgress?.({ phase: 'files', current: i + 1, total: entries.length, percent: Math.round(((i + 1) / entries.length) * 30), message: `Preparing backup… ${i + 1}/${entries.length}` });
    }
  }

  const totalBytes = hashed.reduce((s, e) => s + e.size, 0);
  const materialIds = new Set(snapshot.slides.map((s) => (s.fileUrl || '').replace(/^local:/, '')).filter(Boolean));
  const manifest: PharmaTrackBackupManifest = {
    app: 'pharmatrack',
    format: BACKUP_FORMAT,
    formatVersion: 1,
    appVersion: APP_VERSION,
    archiveId: meta.archiveId,
    academicYear: meta.academicYear,
    level: meta.level,
    semester: meta.semester,
    title: meta.title,
    createdAt: new Date().toISOString(),
    completedAt: meta.completedAt,
    source: meta.source,
    recordCounts: {
      courses: snapshot.courses.length,
      topics: snapshot.topics.length,
      slides: snapshot.slides.length,
      notes: snapshot.notes.length,
      questions: snapshot.examQuestions.length,
      quizzes: snapshot.quizHistory.length,
      studyPlans: snapshot.studyPlans.length,
      examDates: snapshot.examDates.length,
      activities: snapshot.activities.length,
      materials: materialIds.size,
      files: files.length,
    },
    totalBytes,
    integrity: {
      algorithm: 'fnv1a-32',
      checksum: '',
    },
  };
  manifest.integrity.checksum = checksumOf(canonicalForBackupV1(
    { formatVersion: 1, title: manifest.title, level: manifest.level, semester: manifest.semester, archiveId: manifest.archiveId },
    totalBytes,
    hashed,
  ));

  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  for (const e of entries) zip.file(e.name, e.value);
  zip.file('metadata/checksums.json', JSON.stringify({
    algorithm: 'fnv1a-32',
    totalBytes,
    entries: hashed,
  }, null, 2));

  onProgress?.({ phase: 'verify', message: 'Packaging…' });
  return zip.generateAsync({ type: 'blob' }, (m) => {
    onProgress?.({ phase: 'verify', percent: 30 + Math.round(m.percent * 0.7), message: `Packaging… ${Math.round(m.percent)}%` });
  });
};

/**
 * Bundles every completed semester into one degree archive — a ZIP of
 * individual `.pharmatrack` semester packages (each independently importable).
 */
export const exportDegreeBackup = async (onProgress?: ProgressFn): Promise<Blob> => {
  const archives = await listArchives();
  if (archives.length === 0) throw new ArchiveError('No completed semesters to export yet.');

  const outer = new JSZip();
  const semesters: { name: string; title: string; archiveId?: string; size: number }[] = [];
  for (let i = 0; i < archives.length; i++) {
    const meta = archives[i];
    const name = semesterBackupFileName(meta.level, meta.semester, meta.academicYear);
    onProgress?.({ phase: 'files', current: i, total: archives.length, message: `Packaging ${meta.title} (${i + 1}/${archives.length})…` });
    const inner = await exportBackup({ kind: 'archive', archiveId: meta.id });
    outer.file(`semesters/${name}`, await new Promise<ArrayBuffer>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(inner);
    }));
    semesters.push({ name, title: meta.title, archiveId: meta.id, size: inner.size });
    onProgress?.({ phase: 'files', current: i + 1, total: archives.length, message: `Packaged ${meta.title} (${i + 1}/${archives.length})` });
  }

  const manifest: PharmaTrackBackupManifest = {
    app: 'pharmatrack',
    format: DEGREE_BACKUP_FORMAT,
    formatVersion: 1,
    appVersion: APP_VERSION,
    title: 'Full Academic Record',
    createdAt: new Date().toISOString(),
    source: 'archive',
    totalBytes: semesters.reduce((s, x) => s + x.size, 0),
    integrity: {
      algorithm: 'fnv1a-32',
      checksum: checksumOf(JSON.stringify({ semesters: semesters.map((x) => [x.name, x.size]).sort() })),
    },
    semesters,
  };
  outer.file('manifest.json', JSON.stringify(manifest, null, 2));
  onProgress?.({ phase: 'verify', message: 'Packaging…' });
  return outer.generateAsync({ type: 'blob' }, (m) => {
    onProgress?.({ phase: 'verify', percent: Math.round(m.percent), message: `Packaging… ${Math.round(m.percent)}%` });
  });
};

/** Triggers a browser download of `blob` with `name`. */
export const downloadBlob = (blob: Blob, name: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

/** Downloads the validation log after a failed import (local only). */
export const exportDiagnostic = (reason: string, diagnostics: ImportDiagnostic[]): void => {
  const blob = new Blob([JSON.stringify({
    app: 'pharmatrack',
    appVersion: APP_VERSION,
    event: 'import-failed',
    reason,
    diagnostics,
    generatedAt: new Date().toISOString(),
  }, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `pharmatrack-import-diagnostic_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
};

// ---------------------------------------------------------------------------
// Import (stage + validate) — supports the v1 format AND the legacy format
// ---------------------------------------------------------------------------

export type ParsedBackup =
  | { kind: 'semester'; staged: StagedBackup }
  | { kind: 'degree'; degree: StagedDegreeBackup };

export type ParseResult =
  | { ok: true; parsed: ParsedBackup }
  | { ok: false; reason: string; diagnostics: ImportDiagnostic[] };

const readZipJson = async (zip: JSZip, name: string): Promise<unknown> => {
  const entry = zip.file(name);
  if (!entry) throw new ArchiveError(`Missing ${name} in backup.`);
  return JSON.parse(await entry.async('string'));
};

const REQUIRED_SEMESTER_PARTS = [
  'semester/student.json', 'semester/courses.json', 'semester/topics.json',
  'semester/slides.json', 'semester/learning-objectives.json',
  'semester/exam-questions.json', 'semester/quiz-history.json',
  'semester/study-plans.json', 'semester/notes.json', 'semester/exam-dates.json',
  'semester/activities.json', 'semester/chat-history.json',
  'semester/highlights.json', 'semester/saved-insights.json', 'semester/timetable.json',
] as const;

const LEGACY_SEMESTER_PARTS = [
  'semester.json', 'courses.json', 'topics.json', 'slides.json',
  'objectives.json', 'notes.json', 'questions.json', 'quizzes.json',
  'studyPlans.json', 'examDates.json', 'activities.json',
  'chatHistory.json', 'highlights.json', 'insights.json', 'timetable.json',
] as const;

const checkRelationships = (snapshot: SemesterSnapshot): string | null => {
  const courseIds = new Set(snapshot.courses.map((c) => c.id));
  const topicIds = new Set(snapshot.topics.map((t) => t.id));
  const slideIds = new Set(snapshot.slides.map((s) => s.id));
  if (snapshot.topics.some((t) => !courseIds.has(t.courseId))) return 'Topic references a missing course.';
  if (snapshot.slides.some((s) => !topicIds.has(s.topicId))) return 'Material references a missing topic.';
  if (snapshot.notes.some((n) => !topicIds.has(n.topicId))) return 'Note references a missing topic.';
  if (snapshot.examQuestions.some((q) => !courseIds.has(q.courseId) || !topicIds.has(q.topicId))) {
    return 'Question references a missing course or topic.';
  }
  if (snapshot.quizHistory.some((q) => !courseIds.has(q.courseId))) return 'Quiz history references a missing course.';
  if (snapshot.studyPlans.some((p) => !courseIds.has(p.courseId))) return 'Study plan references a missing course.';
  if (snapshot.examDates.some((d) => !courseIds.has(d.courseId))) return 'Exam date references a missing course.';
  if (snapshot.highlights.some((h) => h.materialId && !slideIds.has(h.materialId))) {
    return 'Highlight references a missing material.';
  }
  return null;
};

/** Validates the relationships inside a freshly parsed snapshot. */
const validatedSnapshot = (snapshot: SemesterSnapshot): { ok: true } | { ok: false; reason: string } => {
  if (!snapshot.student?.id || !snapshot.student.name) return { ok: false, reason: 'The backup has no student profile.' };
  for (const name of ['courses', 'topics', 'slides', 'notes', 'examQuestions', 'quizHistory', 'studyPlans', 'examDates', 'activities', 'chatHistory', 'highlights', 'savedInsights', 'learningObjectives'] as const) {
    if (!Array.isArray(snapshot[name])) return { ok: false, reason: `Corrupt backup: "${name}" is not a list.` };
  }
  if (snapshot.slides.some((s) => !s.id || !s.topicId)) return { ok: false, reason: 'Corrupt backup: slides reference missing ids.' };
  const rel = checkRelationships(snapshot);
  if (rel) return { ok: false, reason: `Corrupt backup: ${rel}` };
  return { ok: true };
};

/**
 * Parses and fully validates a backup file. Returns a STAGED result — nothing
 * is applied until an explicit import action runs.
 *
 * Validation order (each failure short-circuits with diagnostics):
 *   ZIP readable → manifest present → format known → version supported (or
 *   migratable) → required parts present → JSON structure → relationships →
 *   per-entry size + content hash → manifest checksum.
 */
export const parseBackup = async (buffer: ArrayBuffer | Uint8Array): Promise<ParseResult> => {
  const diagnostics: ImportDiagnostic[] = [];
  const fail = (reason: string): ParseResult => { diagnostics.push({ check: 'result', ok: false, detail: reason }); return { ok: false, reason, diagnostics }; };

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
    diagnostics.push({ check: 'zip-readable', ok: true });
  } catch {
    return fail('This file is not a valid backup (could not open it as a ZIP package).');
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = await readZipJson(zip, 'manifest.json');
    diagnostics.push({ check: 'manifest-present', ok: true });
  } catch (err) {
    return fail(`Invalid backup: ${(err as Error).message}`);
  }
  const manifest = manifestRaw as (PharmaTrackBackupManifest | BackupManifest);
  if (!manifest || manifest.app !== 'pharmatrack') {
    return fail('Not a PharmaTRACK backup file (manifest is missing or not from PharmaTRACK).');
  }
  const fmt = manifest.format;
  if (fmt !== BACKUP_FORMAT && fmt !== DEGREE_BACKUP_FORMAT && fmt !== LEGACY_BACKUP_FORMAT) {
    return fail(`Unrecognised backup format: "${fmt}".`);
  }

  // ---- Degree bundle -------------------------------------------------------
  if (fmt === DEGREE_BACKUP_FORMAT) {
    if (!SUPPORTED_BACKUP_VERSIONS.includes(manifest.formatVersion)) {
      return fail(`Unsupported degree-backup version ${manifest.formatVersion} (supported: ${SUPPORTED_BACKUP_VERSIONS.join(', ')}).`);
    }
    const semesters: StagedBackup[] = [];
    for (const entry of manifest.semesters || []) {
      const inner = zip.file(`semesters/${entry.name}`);
      if (!inner) return fail(`Corrupt degree backup: missing semester package "${entry.name}".`);
      const innerResult = await parseBackup(await inner.async('arraybuffer'));
      if (!innerResult.ok) return fail(`Corrupt degree backup: ${innerResult.reason}`);
      if (innerResult.parsed.kind !== 'semester') return fail(`Corrupt degree backup: "${entry.name}" is not a semester package.`);
      semesters.push(innerResult.parsed.staged);
    }
    if (semesters.length === 0) return fail('This degree backup contains no semesters.');
    diagnostics.push({ check: 'degree-verified', ok: true, detail: `${semesters.length} semesters` });
    return {
      ok: true,
      parsed: {
        kind: 'degree',
        degree: { title: manifest.title || 'Full Academic Record', totalBytes: manifest.totalBytes || 0, semesters },
      },
    };
  }

  // ---- Legacy format (kept importable) -------------------------------------
  if (fmt === LEGACY_BACKUP_FORMAT) {
    const legacy = manifest as unknown as BackupManifest;
    if (legacy.app !== LEGACY_APP) return fail('Not a PharmaTRACK backup file.');
    if (!SUPPORTED_BACKUP_VERSIONS.includes(legacy.backupVersion)) {
      return fail(`Unsupported backup version ${legacy.backupVersion} (supported: ${SUPPORTED_BACKUP_VERSIONS.join(', ')}).`);
    }
    for (const field of ['title', 'level', 'semester', 'checksum'] as const) {
      if (!legacy[field]) return fail(`Invalid backup: manifest is missing "${field}".`);
    }
    for (const part of LEGACY_SEMESTER_PARTS) {
      if (!zip.file(part)) return fail(`Corrupt backup: missing ${part}.`);
    }
    let snapshot: SemesterSnapshot;
    try {
      const semester = (await readZipJson(zip, 'semester.json')) as { student: Student };
      const timetable = (await readZipJson(zip, 'timetable.json')) as { timetables: AppState['timetables']; timetablePdf: string | null };
      snapshot = {
        student: semester.student,
        courses: (await readZipJson(zip, 'courses.json')) as AppState['courses'],
        topics: (await readZipJson(zip, 'topics.json')) as AppState['topics'],
        slides: (await readZipJson(zip, 'slides.json')) as AppState['slides'],
        learningObjectives: (await readZipJson(zip, 'objectives.json')) as AppState['learningObjectives'],
        examQuestions: (await readZipJson(zip, 'questions.json')) as AppState['examQuestions'],
        quizHistory: (await readZipJson(zip, 'quizzes.json')) as AppState['quizHistory'],
        studyPlans: (await readZipJson(zip, 'studyPlans.json')) as AppState['studyPlans'],
        notes: (await readZipJson(zip, 'notes.json')) as AppState['notes'],
        examDates: (await readZipJson(zip, 'examDates.json')) as AppState['examDates'],
        activities: (await readZipJson(zip, 'activities.json')) as AppState['activities'],
        chatHistory: (await readZipJson(zip, 'chatHistory.json')) as AppState['chatHistory'],
        highlights: (await readZipJson(zip, 'highlights.json')) as AppState['highlights'],
        savedInsights: (await readZipJson(zip, 'insights.json')) as AppState['savedInsights'],
        timetables: timetable.timetables ?? { class: [], quiz: [], exam: [] },
        timetablePdf: timetable.timetablePdf ?? null,
        capturedAt: legacy.completedAt || legacy.created,
      };
    } catch (err) {
      return fail(`Corrupt backup: ${(err as Error).message}`);
    }
    const struct = validatedSnapshot(snapshot);
    if (!struct.ok) return fail(struct.reason);

    let legacyIndex: StagedBackup['index'] = null;
    if (zip.file('searchIndex.json')) {
      try { legacyIndex = JSON.parse(await zip.file('searchIndex.json')!.async('string')); } catch { legacyIndex = null; }
    }

    const files = new Map<string, { value: Blob | string | unknown; kind: 'file' | 'slidetext' | 'record' }>();
    const actual: { name: string; size: number; type: string }[] = [];
    for (const declared of legacy.files) {
      const entry = zip.file(declared.name);
      if (!entry) return fail(`Corrupt backup: missing file "${declared.name}".`);
      const value = declared.name.startsWith('slideText/')
        ? await entry.async('string')
        : await entry.async('blob');
      const actualSize = typeof value === 'string' ? new TextEncoder().encode(value).length : value.size;
      if (actualSize !== declared.size) return fail(`Corrupt backup: file "${declared.name}" has the wrong size.`);
      actual.push({ name: declared.name, size: actualSize, type: declared.type });
      const key = declared.name.startsWith('slideText/')
        ? declared.name.slice('slideText/'.length).replace(/\.txt$/, '')
        : declared.name.slice('files/'.length);
      files.set(key, { value, kind: declared.name.startsWith('slideText/') ? 'slidetext' : 'file' });
    }
    const recomputed = checksumOf(JSON.stringify({
      counts: { itemCount: legacy.itemCount, fileCount: legacy.fileCount, totalBytes: legacy.totalBytes },
      files: actual.map((f) => [f.name, f.size, f.type]).sort(),
    }));
    if (recomputed !== legacy.checksum) {
      return fail('Corrupt backup: file integrity check failed (checksum mismatch).');
    }
    diagnostics.push({ check: 'legacy-verified', ok: true });
    return { ok: true, parsed: { kind: 'semester', staged: { manifest: legacy, snapshot, index: legacyIndex, files } } };
  }

  // ---- Current format (pharmatrack-semester-backup) -------------------------
  let current = manifest as PharmaTrackBackupManifest;
  const migrator = SEMESTER_FORMAT_MIGRATORS[current.formatVersion];
  if (!migrator) {
    return fail(`Unsupported backup format version ${current.formatVersion} (supported: ${SUPPORTED_BACKUP_VERSIONS.join(', ')}). A newer PharmaTRACK may be required.`);
  }
  current = migrator(current);
  diagnostics.push({ check: `format-version-${current.formatVersion}`, ok: true });

  for (const field of ['title', 'level', 'semester', 'integrity'] as const) {
    if (!current[field]) return fail(`Invalid backup: manifest is missing "${field}".`);
  }
  if (!current.integrity?.checksum || !current.integrity.algorithm) {
    return fail('Invalid backup: manifest integrity block is incomplete.');
  }
  if (current.source === 'archive') {
    if (!isValidArchiveId(current.archiveId)) {
      return fail('Invalid backup: archive ID is missing or not a PharmaTRACK archive id.');
    }
    diagnostics.push({ check: 'archive-id', ok: true, detail: current.archiveId });
  } else {
    diagnostics.push({ check: 'archive-id', ok: true, detail: 'live export — no archive id required' });
  }
  for (const part of REQUIRED_SEMESTER_PARTS) {
    if (!zip.file(part)) {
      diagnostics.push({ check: `part:${part}`, ok: false });
      return fail(`Corrupt backup: missing ${part}.`);
    }
  }

  let snapshot: SemesterSnapshot;
  let index: StagedBackup['index'] = null;
  try {
    const timetable = (await readZipJson(zip, 'semester/timetable.json')) as { timetables: AppState['timetables']; timetablePdf: string | null };
    const indexEntry = zip.file('semester/search-index.json');
    if (indexEntry) {
      const raw = await indexEntry.async('string');
      if (raw.trim()) index = JSON.parse(raw);
    }
    snapshot = {
      student: (await readZipJson(zip, 'semester/student.json')) as Student,
      courses: (await readZipJson(zip, 'semester/courses.json')) as AppState['courses'],
      topics: (await readZipJson(zip, 'semester/topics.json')) as AppState['topics'],
      slides: (await readZipJson(zip, 'semester/slides.json')) as AppState['slides'],
      learningObjectives: (await readZipJson(zip, 'semester/learning-objectives.json')) as AppState['learningObjectives'],
      examQuestions: (await readZipJson(zip, 'semester/exam-questions.json')) as AppState['examQuestions'],
      quizHistory: (await readZipJson(zip, 'semester/quiz-history.json')) as AppState['quizHistory'],
      studyPlans: (await readZipJson(zip, 'semester/study-plans.json')) as AppState['studyPlans'],
      notes: (await readZipJson(zip, 'semester/notes.json')) as AppState['notes'],
      examDates: (await readZipJson(zip, 'semester/exam-dates.json')) as AppState['examDates'],
      activities: (await readZipJson(zip, 'semester/activities.json')) as AppState['activities'],
      chatHistory: (await readZipJson(zip, 'semester/chat-history.json')) as AppState['chatHistory'],
      highlights: (await readZipJson(zip, 'semester/highlights.json')) as AppState['highlights'],
      savedInsights: (await readZipJson(zip, 'semester/saved-insights.json')) as AppState['savedInsights'],
      timetables: timetable.timetables ?? { class: [], quiz: [], exam: [] },
      timetablePdf: timetable.timetablePdf ?? null,
      capturedAt: current.completedAt || current.createdAt,
    };
    // Future collections travel in workspace.json. Named files above stay
    // authoritative for the fields this build already knows.
    const workspaceEntry = zip.file('semester/workspace.json');
    if (workspaceEntry) {
      const full = JSON.parse(await workspaceEntry.async('string')) as Record<string, unknown>;
      for (const [key, value] of Object.entries(full)) {
        if (key in snapshot || NON_SEMESTER_STATE_KEYS.has(key)) continue;
        (snapshot as Record<string, unknown>)[key] = value;
      }
    }
    const semesterInfo = zip.file('semester/semester.json');
    if (semesterInfo) {
      const info = JSON.parse(await semesterInfo.async('string')) as {
        archiveId?: string; level?: string; semester?: string; academicYear?: string;
      };
      if (info.archiveId && current.archiveId && info.archiveId !== current.archiveId) {
        return fail('Invalid backup: semester.json archive ID does not match the manifest.');
      }
      if (info.level && String(parseLevel(String(info.level))) !== String(parseLevel(current.level || ''))) {
        return fail('Invalid backup: semester.json level does not match the manifest.');
      }
      if (info.semester && String(parseSemester(String(info.semester))) !== String(parseSemester(current.semester || ''))) {
        return fail('Invalid backup: semester.json semester does not match the manifest.');
      }
      if (info.academicYear && current.academicYear && info.academicYear !== current.academicYear) {
        return fail('Invalid backup: semester.json academic year does not match the manifest.');
      }
    }
  } catch (err) {
    return fail(`Corrupt backup: ${(err as Error).message}`);
  }
  diagnostics.push({ check: 'json-structure', ok: true });

  const struct = validatedSnapshot(snapshot);
  if (!struct.ok) return fail(struct.reason);
  diagnostics.push({ check: 'relationships', ok: true });

  // Record counts vs manifest.
  const actualCounts = {
    courses: snapshot.courses.length,
    topics: snapshot.topics.length,
    slides: snapshot.slides.length,
    notes: snapshot.notes.length,
    questions: snapshot.examQuestions.length,
    quizzes: snapshot.quizHistory.length,
    studyPlans: snapshot.studyPlans.length,
    examDates: snapshot.examDates.length,
    activities: snapshot.activities.length,
  };
  if (current.recordCounts) {
    for (const [k, v] of Object.entries(actualCounts) as [keyof typeof actualCounts, number][]) {
      if (current.recordCounts[k] !== v) {
        return fail(`Corrupt backup: manifest declares ${current.recordCounts[k]} ${k}, but the package contains ${v}.`);
      }
    }
  }
  diagnostics.push({ check: 'record-counts', ok: true });

  // Per-entry size + content hash (from metadata/checksums.json when present,
  // otherwise straight from the zip listing).
  interface ChecksumsFile { algorithm: string; totalBytes?: number; entries: { name: string; size: number; hash: string }[] }
  let checksums: ChecksumsFile | null = null;
  try {
    checksums = (await readZipJson(zip, 'metadata/checksums.json')) as ChecksumsFile;
  } catch {
    checksums = null;
  }

  const zipNames = new Set<string>();
  zip.forEach((path) => { if (!path.endsWith('/')) zipNames.add(path); });
  const declaredNames = new Set(checksums?.entries.map((e) => e.name) ?? []);
  const expectedNames = declaredNames.size > 0 ? [...declaredNames] : [...zipNames];
  for (const name of expectedNames) {
    if (!zipNames.has(name)) {
      diagnostics.push({ check: `entry:${name}`, ok: false });
      return fail(`Corrupt backup: missing entry "${name}".`);
    }
  }
  // Any extra, undeclared entry means the package was tampered with.
  if (declaredNames.size > 0) {
    for (const name of zipNames) {
      if (name === 'manifest.json' || name === 'metadata/checksums.json') continue;
      if (!declaredNames.has(name)) {
        return fail(`Corrupt backup: package contains an undeclared entry "${name}".`);
      }
    }
  }

  const files = new Map<string, { value: Blob | string | unknown; kind: 'file' | 'slidetext' | 'record' }>();
  const verified: { name: string; size: number; hash: string }[] = [];
  let materialCount = 0;
  try {
    for (const name of expectedNames) {
      if (name === 'manifest.json' || name === 'metadata/checksums.json') continue;
      const declared = checksums?.entries.find((e) => e.name === name);
      if (name.startsWith('materials/')) {
        // Material metadata: must parse, and counts toward integrity like any entry.
        const raw = await zip.file(name)!.async('string');
        JSON.parse(raw);
        materialCount++;
        const size = new TextEncoder().encode(raw).length;
        if (declared && declared.size !== size) return fail(`Corrupt backup: entry "${name}" has the wrong size.`);
        const hash = await hashEntry(name, raw);
        if (declared && declared.hash !== hash) return fail(`Corrupt backup: entry "${name}" failed its content check.`);
        verified.push({ name, size, hash });
        continue;
      }
      const entry = zip.file(name)!;
      if (name.startsWith('text/')) {
        const value = await entry.async('string');
        if (declared && declared.size !== new TextEncoder().encode(value).length) {
          return fail(`Corrupt backup: entry "${name}" has the wrong size.`);
        }
        const hash = await hashEntry(name, value);
        if (declared && declared.hash !== hash) return fail(`Corrupt backup: entry "${name}" failed its content check.`);
        verified.push({ name, size: new TextEncoder().encode(value).length, hash });
        files.set(name.slice('text/'.length).replace(/\.txt$/, ''), { value, kind: 'slidetext' });
      } else if (name.startsWith('files/')) {
        const value: Blob = await entry.async('blob');
        if (declared && declared.size !== value.size) return fail(`Corrupt backup: entry "${name}" has the wrong size.`);
        const hash = await hashEntry(name, value);
        if (declared && declared.hash !== hash) return fail(`Corrupt backup: entry "${name}" failed its content check.`);
        verified.push({ name, size: value.size, hash });
        const key = name.slice('files/'.length).replace(/\.(pdf|pptx|docx|png|jpe?g|gif|webp|img|bin)$/i, '');
        files.set(key, { value, kind: 'file' });
      } else if (name.startsWith('records/')) {
        const raw = await entry.async('string');
        if (declared && declared.size !== new TextEncoder().encode(raw).length) {
          return fail(`Corrupt backup: entry "${name}" has the wrong size.`);
        }
        const hash = await hashEntry(name, raw);
        if (declared && declared.hash !== hash) return fail(`Corrupt backup: entry "${name}" failed its content check.`);
        verified.push({ name, size: new TextEncoder().encode(raw).length, hash });
        const sourceKey = decodeURIComponent(name.slice('records/'.length).replace(/\.json$/, ''));
        let parsed: unknown = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep the raw string */ }
        files.set(sourceKey, { value: parsed, kind: 'record' });
      } else {
        const value = await entry.async('string');
        if (declared && declared.size !== new TextEncoder().encode(value).length) {
          return fail(`Corrupt backup: entry "${name}" has the wrong size.`);
        }
        const hash = await hashEntry(name, value);
        if (declared && declared.hash !== hash) return fail(`Corrupt backup: entry "${name}" failed its content check.`);
        verified.push({ name, size: new TextEncoder().encode(value).length, hash });
      }
    }
  } catch (err) {
    return fail(`Corrupt backup: ${(err as Error).message}`);
  }
  diagnostics.push({ check: 'entry-sizes-and-hashes', ok: true, detail: `${verified.length} entries, ${materialCount} material records` });

  // Manifest checksum over the verified entries. (The export canonical sums
  // the package entries only — the manifest itself is not in that list.)
  const totalBytes = verified.reduce((s, e) => s + e.size, 0);
  const recomputed = checksumOf(canonicalForBackupV1(
    { formatVersion: current.formatVersion, title: current.title, level: current.level, semester: current.semester, archiveId: current.archiveId },
    totalBytes,
    verified,
  ));
  if (recomputed !== current.integrity.checksum) {
    return fail('Corrupt backup: integrity check failed (checksum mismatch — the file may be incomplete or tampered with).');
  }
  diagnostics.push({ check: 'manifest-checksum', ok: true });

  return {
    ok: true,
    parsed: { kind: 'semester', staged: { manifest: current, snapshot, index, files } },
  };
};

/** Normalised, display-ready summary of a staged backup (either format). */
export const stagedSummary = (staged: StagedBackup): BackupSummary => {
  const snap = staged.snapshot;
  if (staged.manifest.format === BACKUP_FORMAT) {
    const m = staged.manifest as PharmaTrackBackupManifest;
    const rc = m.recordCounts;
    return {
      title: m.title,
      level: m.level,
      semester: m.semester,
      academicYear: m.academicYear,
      completedAt: m.completedAt,
      createdAt: m.createdAt,
      source: m.source,
      versionLabel: `format v${m.formatVersion}`,
      archiveId: m.archiveId,
      counts: {
        courses: rc?.courses ?? snap.courses.length,
        topics: rc?.topics ?? snap.topics.length,
        slides: rc?.slides ?? snap.slides.length,
        notes: rc?.notes ?? snap.notes.length,
        questions: rc?.questions ?? snap.examQuestions.length,
        quizzes: rc?.quizzes ?? snap.quizHistory.length,
        studyPlans: rc?.studyPlans ?? snap.studyPlans.length,
        examDates: rc?.examDates ?? snap.examDates.length,
        activities: rc?.activities ?? snap.activities.length,
        files: rc?.files ?? staged.files.size,
      },
      totalBytes: m.totalBytes ?? 0,
      integrityAlgorithm: m.integrity?.algorithm,
      integrityVerified: true, // only validated backups reach the UI
    };
  }
  const m = staged.manifest as BackupManifest;
  const lc = m.counts;
  return {
    title: m.title,
    level: m.level,
    semester: m.semester,
    academicYear: m.academicYear,
    completedAt: m.completedAt,
    createdAt: m.created,
    source: m.source,
    versionLabel: `legacy format v${m.backupVersion}`,
    archiveId: m.archiveId,
    counts: {
      courses: lc?.courses ?? snap.courses.length,
      topics: lc?.topics ?? snap.topics.length,
      slides: lc?.slides ?? snap.slides.length,
      notes: lc?.notes ?? snap.notes.length,
      questions: lc?.questions ?? snap.examQuestions.length,
      quizzes: lc?.quizzes ?? snap.quizHistory.length,
      studyPlans: snap.studyPlans.length,
      examDates: snap.examDates.length,
      activities: snap.activities.length,
      files: m.fileCount ?? staged.files.size,
    },
    totalBytes: m.totalBytes ?? 0,
    integrityAlgorithm: 'fnv1a-32 (size + list checksum)',
    integrityVerified: true,
  };
};

// ---------------------------------------------------------------------------
// Import actions — the staged backup only touches this device here
// ---------------------------------------------------------------------------

export type ImportArchiveMode = 'archive' | 'copy' | 'replace';

/** Temporary namespace. Never listed as an archive. Promoted only after validation. */
export const IMPORT_NAMESPACE_PREFIX = 'semester_import_';

/** A PharmaTRACK archive id, e.g. archive_300_1_2026_2027_ab12cd34. */
export const isValidArchiveId = (id: string | undefined | null): id is string =>
  typeof id === 'string' && /^archive_[A-Za-z0-9_-]{4,80}$/.test(id);

const importMetaKey = (importId: string) => `${IMPORT_NAMESPACE_PREFIX}${importId}`;
const importFileKey = (importId: string, fileId: string) => `${IMPORT_NAMESPACE_PREFIX}file_${importId}_${fileId}`;
const importTextKey = (importId: string, slideId: string) => `${IMPORT_NAMESPACE_PREFIX}text_${importId}_${slideId}`;
const importRecordKey = (importId: string, sourceKey: string) => `${IMPORT_NAMESPACE_PREFIX}record_${importId}__${sourceKey}`;

interface ImportStageManifestEntry {
  sourceKey: string;
  importKey: string;
  kind: 'file' | 'slidetext' | 'record';
  /** fileId / slideId, or the original IndexedDB key for kind 'record'. */
  fileId: string;
  size: number;
}

interface ImportStageRecord {
  importId: string;
  snapshot: SemesterSnapshot;
  index: IndexShape | null;
  manifest: ImportStageManifestEntry[];
  checksum: string;
}

const keysBelongingToImport = (keys: string[], importId: string): string[] =>
  keys.filter((k) =>
    k === importMetaKey(importId) ||
    k.startsWith(`${IMPORT_NAMESPACE_PREFIX}file_${importId}_`) ||
    k.startsWith(`${IMPORT_NAMESPACE_PREFIX}text_${importId}_`) ||
    k.startsWith(`${IMPORT_NAMESPACE_PREFIX}record_${importId}__`),
  );

const discardImport = async (importId: string): Promise<void> => {
  try {
    const keys = await idb.keys<string>();
    const partial = keysBelongingToImport(keys, importId);
    if (partial.length) await idb.delMany(partial);
  } catch (err) {
    console.error('Import staging cleanup failed (safe to ignore):', err);
  }
};

const stageChecksum = (manifest: ImportStageManifestEntry[]): string =>
  checksumOf(JSON.stringify({
    files: manifest.map((f) => [f.kind, f.sourceKey, f.size]).sort(),
  }));

/**
 * Writes a validated backup into `semester_import_<importId>` and proves the
 * bytes landed. Does not touch any permanent archive or the live workspace.
 */
const stageBackupImport = async (
  importId: string,
  staged: StagedBackup,
  onProgress?: ProgressFn,
): Promise<ImportStageRecord> => {
  const manifest: ImportStageManifestEntry[] = [];
  let i = 0;
  const total = staged.files.size;
  onProgress?.({ phase: 'files', current: 0, total, message: 'Staging import…' });
  for (const [key, entry] of staged.files) {
    const importKey = entry.kind === 'file'
      ? importFileKey(importId, key)
      : entry.kind === 'slidetext'
        ? importTextKey(importId, key)
        : importRecordKey(importId, key);
    await idb.set(importKey, entry.value);
    const sourceKey = entry.kind === 'file' ? `file_${key}` : entry.kind === 'slidetext' ? `slidetext_${key}` : key;
    manifest.push({ sourceKey, importKey, kind: entry.kind, fileId: key, size: sizeOf(entry.value) });
    i++;
    onProgress?.({ phase: 'files', current: i, total, message: `Staging import… ${i}/${total}` });
  }
  const record: ImportStageRecord = {
    importId,
    snapshot: staged.snapshot,
    index: staged.index ?? null,
    manifest,
    checksum: stageChecksum(manifest),
  };
  await idb.set(importMetaKey(importId), record);
  return record;
};

/** Re-reads the staged namespace and refuses to promote anything incomplete. */
const validateStagedImport = async (importId: string): Promise<ImportStageRecord> => {
  const record = await idb.get<ImportStageRecord>(importMetaKey(importId));
  if (!record || record.importId !== importId) {
    throw new ArchiveError('Staged import not found — nothing was added to Academic Archive.');
  }
  if (record.checksum !== stageChecksum(record.manifest)) {
    throw new ArchiveError('Staged import checksum mismatch — nothing was added to Academic Archive.');
  }
  const structure = validatedSnapshot(record.snapshot);
  if (!structure.ok) throw new ArchiveError(`${structure.reason} Nothing was added to Academic Archive.`);
  for (const entry of record.manifest) {
    const value = await idb.get(entry.importKey);
    if (value === undefined || value === null) {
      throw new ArchiveError(`Staged import is missing ${entry.sourceKey}. Nothing was added to Academic Archive.`);
    }
    if (sizeOf(value) !== entry.size) {
      throw new ArchiveError(`Staged import size mismatch for ${entry.sourceKey}. Nothing was added to Academic Archive.`);
    }
  }
  return record;
};

/** Copies a validated stage into the permanent archive namespace. */
const promoteStagedImport = async (
  stage: ImportStageRecord,
  targetId: string,
  title: string,
  baseMeta: SemesterArchiveMeta,
): Promise<SemesterArchiveMeta> => {
  const manifest: ArchiveRecord['manifest'] = [];
  let totalBytes = 0;
  for (const entry of stage.manifest) {
    const value = await idb.get(entry.importKey);
    if (value === undefined || value === null) {
      throw new ArchiveError(`Staged import lost ${entry.sourceKey} before it could be saved.`);
    }
    const archiveKey = entry.kind === 'file'
      ? archiveFileKey(targetId, entry.fileId)
      : entry.kind === 'slidetext'
        ? archiveTextKey(targetId, entry.fileId)
        : archiveRecordKey(targetId, entry.sourceKey);
    await idb.set(archiveKey, value);
    totalBytes += entry.size;
    manifest.push({ sourceKey: entry.sourceKey, archiveKey, kind: entry.kind, size: entry.size });
  }
  const meta: SemesterArchiveMeta = {
    ...baseMeta,
    id: targetId,
    title,
    status: 'creating',
    fileCount: manifest.length,
    totalBytes,
    itemCount: itemCountOf(stage.snapshot as unknown as AppState),
    counts: collectionCounts(stage.snapshot as unknown as AppState),
  };
  meta.checksum = checksumOf(canonicalForArchive(meta, manifest));
  const record: ArchiveRecord = { meta, snapshot: stage.snapshot, index: stage.index, manifest };
  await idb.set(META_PREFIX + targetId, record);
  const verified = await verifySemesterArchive(targetId);
  if (verified.status !== 'verified') {
    throw new ArchiveError(`The imported archive did not verify (${verified.error || 'unknown reason'}). Nothing was added.`);
  }
  return verified;
};

/**
 * Collision detection: is this semester already on this device?
 *  - byId: the backup carries the exact archiveId of an existing archive
 *  - byPosition: same level + semester (+ academic year when both known)
 */
export const findCollidingArchives = async (staged: StagedBackup): Promise<{ byId: SemesterArchiveMeta | null; byPosition: SemesterArchiveMeta | null }> => {
  const m = staged.manifest as PharmaTrackBackupManifest;
  const archives = await listArchives();
  const byId = m.archiveId ? archives.find((a) => a.id === m.archiveId) ?? null : null;
  const byPosition = byId ?? (m.level && m.semester
    ? archives.find((a) =>
        String(parseLevel(a.level)) === String(parseLevel(m.level || '')) &&
        String(parseSemester(a.semester)) === String(parseSemester(m.semester || '')) &&
        (!m.academicYear || !a.academicYear || a.academicYear === m.academicYear)) ?? null
    : null);
  return { byId, byPosition };
};

/**
 * Imports a validated, staged backup INTO THE ACADEMIC ARCHIVE (the safe
 * default — never touches the current workspace).
 *
 *  mode 'archive'  — keep the backup's identity; a live export gets a fresh id
 *  mode 'copy'     — always a fresh id + " (Copy)" title
 *  mode 'replace'  — overwrite `existingId` in place (explicit user choice)
 *
 * The archive is only committed after its own verification passes; on any
 * failure every partial record is removed and the error is thrown.
 */
export const importBackupIntoArchive = async (
  staged: StagedBackup,
  mode: ImportArchiveMode,
  existingId?: string,
  onProgress?: ProgressFn,
): Promise<SemesterArchiveMeta> => {
  const m = staged.manifest as PharmaTrackBackupManifest;
  const snapshot = staged.snapshot;
  const L = parseLevel(m.level || '') || 100;
  const S = parseSemester(m.semester || '') || 1;
  const year = m.academicYear || defaultAcademicYear();
  const [y1, y2] = year.split('/');
  const freshId = () => `archive_${L}_${S}_${y1}_${y2}_${uuidv4().slice(0, 8)}`;

  const id = mode === 'replace' && existingId ? existingId
    : mode === 'copy' ? freshId()
    : (m.archiveId && m.archiveId !== 'live' && isValidArchiveId(m.archiveId) ? m.archiveId : freshId());
  const title = mode === 'copy' ? `${m.title || `Level ${L} — Semester ${S}`} (Copy)` : (m.title || `Level ${L} — Semester ${S}`);
  const baseMeta: SemesterArchiveMeta = {
    id,
    level: String(L),
    semester: String(S),
    title,
    academicYear: year,
    completedAt: m.completedAt || m.createdAt,
    createdAt: m.createdAt || new Date().toISOString(),
    status: 'creating',
    version: ARCHIVE_VERSION,
    itemCount: itemCountOf(snapshot as unknown as AppState),
    fileCount: staged.files.size,
    totalBytes: 0,
    counts: collectionCounts(snapshot as unknown as AppState),
  };

  // Stage first, under a namespace listArchives() cannot see. The permanent
  // archive — including one being replaced — is not touched until this copy
  // has been re-read and validated.
  const importId = uuidv4().slice(0, 8);
  let promoted = false;
  // Hold of the archive being replaced, captured only after staging validates,
  // so a staging failure cannot have moved it.
  let hold: Map<string, unknown> | null = null;
  try {
    await stageBackupImport(importId, staged, onProgress);
    onProgress?.({ phase: 'verify', message: 'Validating staged import…' });
    const stage = await validateStagedImport(importId);

    if (mode === 'replace' && existingId) {
      const existingKeys = keysBelongingToArchive(await idb.keys<string>(), existingId);
      hold = new Map();
      for (const key of existingKeys) hold.set(key, await idb.get(key));
    }

    onProgress?.({ phase: 'files', message: 'Saving into Academic Archive…' });
    const verified = await promoteStagedImport(stage, id, title, baseMeta);
    promoted = true;

    if (hold) {
      const written = new Set(keysBelongingToArchive(await idb.keys<string>(), id));
      const orphans = [...hold.keys()].filter((key) => !written.has(key));
      if (orphans.length) await idb.delMany(orphans);
    }
    await discardImport(importId);
    onProgress?.({ phase: 'done', message: 'Imported into Academic Archive ✓' });
    return verified;
  } catch (err) {
    if (hold && !promoted) {
      // Put the previous archive back. New keys that were not part of it go.
      try {
        const now = keysBelongingToArchive(await idb.keys<string>(), id);
        const extras = now.filter((key) => !hold!.has(key));
        if (extras.length) await idb.delMany(extras);
        for (const [key, value] of hold) await idb.set(key, value);
      } catch (rollbackErr) {
        console.error('Could not fully roll back a failed replace (the staged import was discarded):', rollbackErr);
      }
    } else if (!promoted) {
      try {
        const partial = keysBelongingToArchive(await idb.keys<string>(), id);
        if (partial.length) await idb.delMany(partial);
      } catch { /* best-effort */ }
    }
    await discardImport(importId);
    throw err instanceof ArchiveError ? err : toArchiveError(err, `The backup could not be imported: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`);
  }
};

/**
 * Restores a validated, staged backup AS THE CURRENT WORKSPACE (explicit,
 * protected choice):
 *   1. if the current workspace has content → it is archived first and the
 *      guard archive must verify, otherwise the import aborts with nothing
 *      changed;
 *   2. only then is the imported semester staged in as the live workspace;
 *   3. the previous semester stays available in the Academic Archive.
 */
export const importBackupAsWorkspace = async (
  staged: StagedBackup,
  current: AppState,
  onProgress?: ProgressFn,
): Promise<RestoreResult> => {
  let guardArchive: SemesterArchiveMeta | null = null;
  if (hasWorkspaceContent(current)) {
    onProgress?.({ phase: 'protect', message: 'Backing up your current semester first…' });
    const guard = await createSemesterArchive(current, {
      level: current.student?.level || '100',
      semester: current.student?.semester || '1',
      title: (current.student ? `Level ${parseLevel(current.student.level)} — Semester ${parseSemester(current.student.semester)}` : 'Current') + ' (auto-backup before import)',
      onProgress: (p) => onProgress?.({ ...p, phase: p.phase === 'done' ? 'protect' : p.phase, message: `Backing up current semester: ${p.message || ''}` }),
    });
    if (guard.status !== 'verified') {
      throw new ArchiveError('Backing up the current semester failed, so the restore was aborted. Nothing was changed.');
    }
    guardArchive = guard;
  }

  // Stage and re-validate the incoming semester before the live workspace moves.
  const importId = uuidv4().slice(0, 8);
  try {
    await stageBackupImport(importId, staged, onProgress);
    onProgress?.({ phase: 'verify', message: 'Validating staged import…' });
    await validateStagedImport(importId);
    const fresh = await applyWorkspaceSource(staged, current, onProgress);
    await discardImport(importId);
    return { fresh, guardArchive, restoredFrom: (staged.manifest as PharmaTrackBackupManifest).archiveId || 'import' };
  } catch (err) {
    await discardImport(importId);
    throw err instanceof ArchiveError ? err : toArchiveError(err, `The backup could not be restored: ${err instanceof Error ? err.message : String(err)}. Your previous semester is still in Academic Archive if it was backed up.`);
  }
};


/**
 * Applies a staged backup (or restored archive) as the new live workspace.
 * The caller MUST have protected the current workspace first (restoreArchive
 * and the import flow both enforce this before calling here).
 */
export const applyWorkspaceSource = async (staged: StagedBackup, current: AppState, onProgress?: ProgressFn): Promise<AppState> => {
  onProgress?.({ phase: 'reset', message: 'Replacing workspace…' });

  // 1. Clear the current workspace's IndexedDB records (the caller already
  //    archived them — or the current workspace was empty).
  const currentKeys = await idb.keys<string>();
  const currentRecords = currentKeys.filter((k) => isSemesterOwnedIdbKey(k));
  if (currentRecords.length) await idb.delMany(currentRecords);

  // 2. Materialise the incoming binaries and any other captured records.
  let i = 0;
  for (const [key, entry] of staged.files) {
    const targetKey = entry.kind === 'file' ? `file_${key}` : entry.kind === 'slidetext' ? `slidetext_${key}` : key;
    await idb.set(targetKey, entry.value);
    i++;
    if (staged.files.size > 0 && i % 5 === 0) {
      onProgress?.({ phase: 'files', current: i, total: staged.files.size, message: `Restoring files… ${i}/${staged.files.size}` });
    }
  }

  // 3. Restore the per-page text index (null clears any stale entries).
  await setSearchIndexRaw(staged.index ?? null);

  // 4. Build the new state: the archived semester's data, with the CURRENT
  //    student's identity (same person — only the academic position changes).
  const incoming = staged.snapshot;
  const student: Student = current.student
    ? {
        ...incoming.student,
        id: current.student.id,
        createdAt: current.student.createdAt,
        avatar_url: current.student.avatar_url,
      }
    : incoming.student;

  // Every semester field on the snapshot, including ones added after this
  // file was written. Session flags and secrets are never taken from an import.
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'capturedAt' || key === 'student' || NON_SEMESTER_STATE_KEYS.has(key)) continue;
    payload[key] = value;
  }
  const fresh: AppState = {
    ...initialState,
    ...payload,
    isLoggedIn: current.isLoggedIn,
    // The archive never carries credentials; this copies whatever the live
    // workspace has (post-migration: an already-migrated empty string), never
    // something that arrived inside the imported file.
    openAIKey: current.openAIKey,
    student,
  } as AppState;

  saveState(fresh);
  onProgress?.({ phase: 'done', message: 'Workspace restored' });
  return fresh;
};

export interface RestoreResult {
  fresh: AppState;
  /** The guard archive of the previous current semester (null when it was empty). */
  guardArchive: SemesterArchiveMeta | null;
  restoredFrom: string;
}

/**
 * Restores an archived semester:
 *   1. the current workspace (if it has content) is archived first and must be
 *      VERIFIED — otherwise the restore is aborted and nothing changes;
 *   2. the selected (verified) archive becomes the live workspace;
 *   3. the old archive itself is never deleted — it remains in the list.
 */
export const restoreArchive = async (
  current: AppState,
  archiveId: string,
  onProgress?: ProgressFn,
): Promise<RestoreResult> => {
  const record = await loadArchive(archiveId);
  if (!record) throw new ArchiveError('Archive not found.');
  if (record.meta.status !== 'verified') {
    throw new ArchiveError(`This archive is ${record.meta.status} — only verified archives can be restored. Nothing was changed.`);
  }

  let guardArchive: SemesterArchiveMeta | null = null;
  if (hasWorkspaceContent(current)) {
    onProgress?.({ phase: 'protect', message: 'Backing up your current semester first…' });
    const guard = await createSemesterArchive(current, {
      level: current.student?.level || '100',
      semester: current.student?.semester || '1',
      title: (current.student ? `Level ${parseLevel(current.student.level)} — Semester ${parseSemester(current.student.semester)}` : 'Current') + ' (auto-backup before restore)',
      onProgress: (p) => onProgress?.({ ...p, phase: p.phase === 'done' ? 'done' : 'protect', message: `Backing up current semester: ${p.message || ''}` }),
    });
    if (guard.status !== 'verified') {
      throw new ArchiveError('Backing up the current semester failed, so the restore was aborted. Nothing was changed.');
    }
    guardArchive = guard;
  }

  // Archive record → staged shape (no ZIP round-trip).
  const files = new Map<string, { value: Blob | string | unknown; kind: 'file' | 'slidetext' | 'record' }>();
  for (const entry of record.manifest) {
    const value = await idb.get(entry.archiveKey);
    if (value === undefined || value === null) continue;
    const key = entry.kind === 'record'
      ? entry.sourceKey
      : entry.kind === 'file'
        ? (entry.sourceKey.startsWith('file_') ? entry.sourceKey.slice('file_'.length) : entry.archiveKey.slice(META_FILE_PREFIX.length + archiveId.length + 1))
        : (entry.sourceKey.startsWith('slidetext_') ? entry.sourceKey.slice('slidetext_'.length) : entry.archiveKey.slice(META_TEXT_PREFIX.length + archiveId.length + 1));
    files.set(key, { value, kind: entry.kind });
  }

  // Internal staged manifest (new format) — only the snapshot/index/files are
  // consumed downstream; the manifest documents provenance.
  const staged: StagedBackup = {
    manifest: {
      app: 'pharmatrack',
      format: BACKUP_FORMAT,
      formatVersion: 1,
      appVersion: APP_VERSION,
      source: 'archive',
      archiveId,
      title: record.meta.title,
      level: record.meta.level,
      semester: record.meta.semester,
      academicYear: record.meta.academicYear,
      completedAt: record.meta.completedAt,
      createdAt: record.meta.createdAt,
      recordCounts: {
        courses: record.meta.counts?.courses ?? record.snapshot.courses.length,
        topics: record.meta.counts?.topics ?? record.snapshot.topics.length,
        slides: record.meta.counts?.slides ?? record.snapshot.slides.length,
        notes: record.meta.counts?.notes ?? record.snapshot.notes.length,
        questions: record.meta.counts?.questions ?? record.snapshot.examQuestions.length,
        quizzes: record.meta.counts?.quizzes ?? record.snapshot.quizHistory.length,
        studyPlans: record.snapshot.studyPlans.length,
        examDates: record.snapshot.examDates.length,
        activities: record.snapshot.activities.length,
        materials: 0,
        files: record.meta.fileCount,
      },
      totalBytes: record.meta.totalBytes,
      integrity: { algorithm: 'fnv1a-32', checksum: record.meta.checksum || '' },
    },
    snapshot: record.snapshot,
    index: record.index,
    files,
  };

  const fresh = await applyWorkspaceSource(staged, current, onProgress);
  return { fresh, guardArchive, restoredFrom: archiveId };
};
