/**
 * Semester Completion + Local Academic Archive.
 *
 * Completing a semester is a two-phase, failure-safe operation:
 *
 *   1. ARCHIVE  — snapshot the whole workspace, COPY every binary it
 *      references (uploaded files + offloaded slide text + the full-text
 *      search index) into the archive's own IndexedDB namespace, verify the
 *      archive (records, file presence, sizes, checksum, relationships),
 *      and only then mark it `verified`.
 *   2. RESET    — persist a genuinely fresh workspace (identity + preferences
 *      only), prune the old workspace's IndexedDB records (now safe: the
 *      archive owns its own copies), and clear the search index.
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
  BackupManifestFile,
  StagedBackup,
  Student,
} from '../types';
import { initialState, saveState } from './storage';
import { getSearchIndexRaw, setSearchIndexRaw, clearSearchIndex, type IndexShape } from './searchIndex';

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
const META_PREFIX = 'semester_archive_';
const META_FILE_PREFIX = 'semester_archive_file_';
const META_TEXT_PREFIX = 'semester_archive_text_';

export const archiveFileKey = (archiveId: string, fileId: string) => `${META_FILE_PREFIX}${archiveId}_${fileId}`;
export const archiveTextKey = (archiveId: string, slideId: string) => `${META_TEXT_PREFIX}${archiveId}_${slideId}`;

export interface ArchiveRecord {
  meta: SemesterArchiveMeta;
  snapshot: SemesterSnapshot;
  /** The full-text search index at capture time (null when empty). */
  index: IndexShape | null;
  /** Copied records: source key, archive key, kind, byte size. */
  manifest: { sourceKey: string; archiveKey: string; kind: 'file' | 'slidetext'; size: number }[];
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
  courses: state.courses.length,
  topics: state.topics.length,
  slides: state.slides.length,
  notes: state.notes.length,
  questions: state.examQuestions.length,
  quizzes: state.quizHistory.length,
});

export const itemCountOf = (state: AppState): number => {
  const c = collectionCounts(state);
  return (
    c.courses + c.topics + c.slides + c.notes + c.questions + c.quizzes +
    state.learningObjectives.length + state.studyPlans.length + state.examDates.length +
    state.activities.length + state.chatHistory.length + state.highlights.length +
    state.savedInsights.length + state.timetables.class.length + state.timetables.quiz.length + state.timetables.exam.length
  );
};

export const buildSnapshot = (state: AppState): SemesterSnapshot => ({
  student: state.student as Student,
  courses: state.courses,
  topics: state.topics,
  slides: state.slides,
  learningObjectives: state.learningObjectives,
  examQuestions: state.examQuestions,
  quizHistory: state.quizHistory,
  studyPlans: state.studyPlans,
  notes: state.notes,
  examDates: state.examDates,
  activities: state.activities,
  chatHistory: state.chatHistory,
  highlights: state.highlights,
  savedInsights: state.savedInsights,
  timetables: state.timetables,
  timetablePdf: state.timetablePdf,
  capturedAt: new Date().toISOString(),
});

/** Does this workspace hold anything a user would care to keep? */
export const hasWorkspaceContent = (state: AppState): boolean =>
  state.courses.length > 0 || state.topics.length > 0 || state.slides.length > 0 ||
  state.notes.length > 0 || state.examQuestions.length > 0 || state.quizHistory.length > 0 ||
  state.studyPlans.length > 0 || state.examDates.length > 0 || state.highlights.length > 0 ||
  state.savedInsights.length > 0 || state.learningObjectives.length > 0 || state.chatHistory.length > 0 ||
  state.timetables.class.length > 0 || state.timetables.quiz.length > 0 || state.timetables.exam.length > 0 ||
  state.timetablePdf !== null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  try {
    onProgress?.({ phase: 'files', current: 0, total: refs.length, copiedBytes: 0, message: 'Copying files…' });
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const value = await idb.get(ref.sourceKey);
      if (value === undefined || value === null) continue; // never offloaded — nothing to copy
      const targetKey = ref.kind === 'file' ? archiveFileKey(id, ref.id) : archiveTextKey(id, ref.id);
      await idb.set(targetKey, value); // structured clone — the archive owns its copy
      const size = sizeOf(value);
      totalBytes += size;
      manifest.push({ sourceKey: ref.sourceKey, archiveKey: targetKey, kind: ref.kind, size });
      onProgress?.({ phase: 'files', current: i + 1, total: refs.length, copiedBytes: totalBytes, message: `Copying files… ${i + 1}/${refs.length}` });
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
    const partial = keys.filter(
      (k) => k === META_PREFIX + id ||
        k.startsWith(META_FILE_PREFIX + id) ||
        k.startsWith(META_TEXT_PREFIX + id),
    );
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
  const metaKeys = allKeys.filter(
    (k) => k.startsWith(META_PREFIX) && !k.startsWith(META_FILE_PREFIX) && !k.startsWith(META_TEXT_PREFIX),
  );
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

/** Deletes an archive and all its records. Only for verified/failed archives the user asked to remove. */
export const deleteArchive = async (archiveId: string): Promise<void> => {
  const keys = await idb.keys<string>();
  const toDelete = keys.filter(
    (k) => k === META_PREFIX + archiveId ||
      k.startsWith(META_FILE_PREFIX + archiveId) ||
      k.startsWith(META_TEXT_PREFIX + archiveId),
  );
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
  openAIKey: state.openAIKey,
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
  const orphans = allKeys.filter(
    (k) => (k.startsWith('file_') || k.startsWith('slidetext_')) && !keep.has(k),
  );
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
export const completeSemester = async (
  state: AppState,
  next: { level: string; semester: string; academicYear?: string },
  onProgress?: ProgressFn,
): Promise<CompleteSemesterResult> => {
  const archive = await createSemesterArchive(state, { ...next, onProgress });
  if (archive.status !== 'verified') {
    throw new ArchiveError('The archive did not reach verified status — nothing was changed.');
  }

  onProgress?.({ phase: 'reset', message: 'Starting fresh workspace…' });
  const fresh = buildFreshWorkspace(state, next);

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

  onProgress?.({ phase: 'done', message: 'Semester completed 🎓' });
  return { archive, fresh };
};

// ---------------------------------------------------------------------------
// Portable backup export (ZIP)
//
//   PharmaTRACK_Backup/
//     manifest.json       version + integrity checksum + file list
//     semester.json       identity & academic position at completion
//     courses.json topics.json slides.json objectives.json notes.json
//     questions.json quizzes.json studyPlans.json examDates.json
//     activities.json chatHistory.json highlights.json insights.json
//     timetable.json      class/quiz/exam entries + timetable PDF
//     searchIndex.json    full per-page text index (when present)
//     files/<fileId>      uploaded binaries, verbatim
//     slideText/<slideId>.txt
// ---------------------------------------------------------------------------

export const SUPPORTED_BACKUP_VERSIONS: number[] = [1];
const BACKUP_APP = 'pharmatrack';
const BACKUP_FORMAT = 'semester-backup';

const canonicalForBackup = (counts: { itemCount: number; fileCount: number; totalBytes: number }, files: BackupManifestFile[]): string =>
  JSON.stringify({
    counts,
    files: files.map((f) => [f.name, f.size, f.type]).sort(),
  });

/** Collects snapshot + binary refs from either an archive or the live state. */
const collectBackupSource = async (
  source: { kind: 'archive'; archiveId: string } | { kind: 'live'; state: AppState },
): Promise<{
  meta: Pick<SemesterArchiveMeta, 'id' | 'level' | 'semester' | 'title' | 'academicYear' | 'completedAt' | 'counts'>;
  snapshot: SemesterSnapshot;
  index: IndexShape | null;
  files: { key: string; zipName: string; value: Blob | string; type: string }[];
}> => {
  if (source.kind === 'archive') {
    const rec = await loadArchive(source.archiveId);
    if (!rec) throw new ArchiveError('Archive not found.');
    const files: { key: string; zipName: string; value: Blob | string; type: string }[] = [];
    for (const entry of rec.manifest) {
      const value = await idb.get(entry.archiveKey);
      if (value === undefined || value === null) continue;
      files.push({
        key: entry.sourceKey,
        zipName: entry.kind === 'file' ? `files/${entry.archiveKey.slice(META_FILE_PREFIX.length + source.archiveId.length + 1)}` : `slideText/${entry.archiveKey.slice(META_TEXT_PREFIX.length + source.archiveId.length + 1)}.txt`,
        value,
        type: typeof value === 'string' ? 'text/plain' : value instanceof Blob ? value.type || 'application/octet-stream' : 'application/octet-stream',
      });
    }
    return { meta: rec.meta, snapshot: rec.snapshot, index: rec.index, files };
  }

  const { state } = source;
  const files: { key: string; zipName: string; value: Blob | string; type: string }[] = [];
  for (const ref of collectFileRefs(state)) {
    const value = await idb.get(ref.sourceKey);
    if (value === undefined || value === null) continue;
    files.push({
      key: ref.sourceKey,
      zipName: ref.kind === 'file' ? `files/${ref.id}` : `slideText/${ref.id}.txt`,
      value,
      type: typeof value === 'string' ? 'text/plain' : value instanceof Blob ? value.type || 'application/octet-stream' : 'application/octet-stream',
    });
  }
  return {
    meta: {
      id: 'live',
      level: String(parseLevel(state.student?.level || '')),
      semester: String(parseSemester(state.student?.semester || '')),
      title: `Level ${parseLevel(state.student?.level || '')} — Semester ${parseSemester(state.student?.semester || '')} (current)`,
      academicYear: defaultAcademicYear(),
      completedAt: undefined as unknown as string,
      counts: collectionCounts(state),
    },
    snapshot: buildSnapshot(state),
    index: await getSearchIndexRaw(),
    files,
  };
};

/**
 * Builds a portable ZIP backup. Returns a Blob ready to download; nothing is
 * modified. `source` is either an archive or the live workspace (the latter
 * is the escape hatch when device storage is too full to archive).
 */
export const exportBackup = async (
  source: { kind: 'archive'; archiveId: string } | { kind: 'live'; state: AppState },
  onProgress?: ProgressFn,
): Promise<Blob> => {
  onProgress?.({ phase: 'snapshot', message: 'Packaging backup…' });
  const { meta, snapshot, index, files } = await collectBackupSource(source);

  const totalBytes = files.reduce((sum, f) => sum + sizeOf(f.value), 0);
  const manifestFiles: BackupManifestFile[] = files.map((f) => ({
    name: f.zipName,
    size: sizeOf(f.value),
    type: f.type,
  }));
  const manifest: BackupManifest = {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    backupVersion: 1,
    created: new Date().toISOString(),
    source: source.kind,
    archiveId: source.kind === 'archive' ? source.archiveId : undefined,
    title: meta.title,
    level: meta.level,
    semester: meta.semester,
    academicYear: meta.academicYear,
    completedAt: meta.completedAt,
    checksum: '',
    itemCount: itemCountOf(snapshot as unknown as AppState),
    fileCount: files.length,
    totalBytes,
    counts: meta.counts,
    files: manifestFiles,
  };
  manifest.checksum = checksumOf(canonicalForBackup(
    { itemCount: manifest.itemCount, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes },
    manifestFiles,
  ));

  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('semester.json', JSON.stringify({
    student: snapshot.student,
    level: meta.level,
    semester: meta.semester,
    academicYear: meta.academicYear,
    title: meta.title,
    completedAt: meta.completedAt,
  }, null, 2));
  zip.file('courses.json', JSON.stringify(snapshot.courses));
  zip.file('topics.json', JSON.stringify(snapshot.topics));
  zip.file('slides.json', JSON.stringify(snapshot.slides));
  zip.file('objectives.json', JSON.stringify(snapshot.learningObjectives));
  zip.file('notes.json', JSON.stringify(snapshot.notes));
  zip.file('questions.json', JSON.stringify(snapshot.examQuestions));
  zip.file('quizzes.json', JSON.stringify(snapshot.quizHistory));
  zip.file('studyPlans.json', JSON.stringify(snapshot.studyPlans));
  zip.file('examDates.json', JSON.stringify(snapshot.examDates));
  zip.file('activities.json', JSON.stringify(snapshot.activities));
  zip.file('chatHistory.json', JSON.stringify(snapshot.chatHistory));
  zip.file('highlights.json', JSON.stringify(snapshot.highlights));
  zip.file('insights.json', JSON.stringify(snapshot.savedInsights));
  zip.file('timetable.json', JSON.stringify({ timetables: snapshot.timetables, timetablePdf: snapshot.timetablePdf }));
  if (index && Object.keys(index).length) zip.file('searchIndex.json', JSON.stringify(index));

  onProgress?.({ phase: 'files', current: 0, total: files.length, message: 'Writing files…' });
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    zip.file(f.zipName, f.value);
    if (files.length > 0 && (i + 1) % 5 === 0) {
      onProgress?.({ phase: 'files', current: i + 1, total: files.length, message: `Writing files… ${i + 1}/${files.length}` });
    }
  }

  onProgress?.({ phase: 'done', message: 'Backup ready' });
  return zip.generateAsync({ type: 'blob' });
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

export const backupFileName = (meta: { title: string; level: string; semester: string; academicYear?: string }): string => {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'semester';
  return `PharmaTRACK_${slug(meta.title)}_${slug(meta.academicYear || meta.level + '-' + meta.semester)}.zip`;
};

// ---------------------------------------------------------------------------
// Import (stage + validate) and restore
// ---------------------------------------------------------------------------

export type ParseResult = { ok: true; staged: StagedBackup } | { ok: false; reason: string };

const readZipJson = async (zip: JSZip, name: string): Promise<unknown> => {
  const entry = zip.file(name);
  if (!entry) throw new ArchiveError(`Missing ${name} in backup.`);
  return JSON.parse(await entry.async('string'));
};

/**
 * Parses and fully validates a backup ZIP. Returns a STAGED backup — nothing
 * is applied until applyStagedBackup() runs, and only after the current
 * workspace has been protected by its own verified archive.
 */
export const parseBackup = async (buffer: ArrayBuffer | Uint8Array): Promise<ParseResult> => {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { ok: false, reason: 'This file is not a valid backup archive (could not open it as a ZIP).' };
  }

  let manifest: BackupManifest;
  try {
    manifest = (await readZipJson(zip, 'manifest.json')) as BackupManifest;
  } catch (err) {
    return { ok: false, reason: `Invalid backup: ${(err as Error).message}` };
  }

  if (manifest.app !== BACKUP_APP) return { ok: false, reason: 'Not a PharmaTRACK backup file.' };
  if (manifest.format !== BACKUP_FORMAT) return { ok: false, reason: 'Unrecognised backup format.' };
  if (!SUPPORTED_BACKUP_VERSIONS.includes(manifest.backupVersion)) {
    return {
      ok: false,
      reason: `Unsupported backup version ${manifest.backupVersion} (this app supports: ${SUPPORTED_BACKUP_VERSIONS.join(', ')}).`,
    };
  }
  for (const field of ['title', 'level', 'semester', 'checksum'] as const) {
    if (!manifest[field]) return { ok: false, reason: `Invalid backup: manifest is missing "${field}".` };
  }

  // JSON parts.
  let semester: { student: Student };
  let courses: AppState['courses'];
  let topics: AppState['topics'];
  let slides: AppState['slides'];
  let notes: AppState['notes'];
  let questions: AppState['examQuestions'];
  let quizzes: AppState['quizHistory'];
  let objectives: AppState['learningObjectives'];
  let studyPlans: AppState['studyPlans'];
  let examDates: AppState['examDates'];
  let activities: AppState['activities'];
  let chatHistory: AppState['chatHistory'];
  let highlights: AppState['highlights'];
  let insights: AppState['savedInsights'];
  let timetable: { timetables: AppState['timetables']; timetablePdf: string | null };
  let index: StagedBackup['index'] = null;

  try {
    semester = (await readZipJson(zip, 'semester.json')) as { student: Student };
    courses = (await readZipJson(zip, 'courses.json')) as AppState['courses'];
    topics = (await readZipJson(zip, 'topics.json')) as AppState['topics'];
    slides = (await readZipJson(zip, 'slides.json')) as AppState['slides'];
    notes = (await readZipJson(zip, 'notes.json')) as AppState['notes'];
    questions = (await readZipJson(zip, 'questions.json')) as AppState['examQuestions'];
    quizzes = (await readZipJson(zip, 'quizzes.json')) as AppState['quizHistory'];
    objectives = (await readZipJson(zip, 'objectives.json')) as AppState['learningObjectives'];
    studyPlans = (await readZipJson(zip, 'studyPlans.json')) as AppState['studyPlans'];
    examDates = (await readZipJson(zip, 'examDates.json')) as AppState['examDates'];
    activities = (await readZipJson(zip, 'activities.json')) as AppState['activities'];
    chatHistory = (await readZipJson(zip, 'chatHistory.json')) as AppState['chatHistory'];
    highlights = (await readZipJson(zip, 'highlights.json')) as AppState['highlights'];
    insights = (await readZipJson(zip, 'insights.json')) as AppState['savedInsights'];
    timetable = (await readZipJson(zip, 'timetable.json')) as { timetables: AppState['timetables']; timetablePdf: string | null };
    if (zip.file('searchIndex.json')) index = (await readZipJson(zip, 'searchIndex.json')) as StagedBackup['index'];
  } catch (err) {
    return { ok: false, reason: `Corrupt backup: ${(err as Error).message}` };
  }

  // Structural checks.
  const arrays = [courses, topics, slides, notes, questions, quizzes, objectives, studyPlans, examDates, activities, chatHistory, highlights, insights];
  if (arrays.some((a) => !Array.isArray(a))) return { ok: false, reason: 'Corrupt backup: a collection is not a list.' };
  if (!semester?.student?.id || !semester.student.name) return { ok: false, reason: 'Corrupt backup: semester.json has no student profile.' };
  if (slides.some((s) => !s.id || !s.topicId)) return { ok: false, reason: 'Corrupt backup: slides reference missing ids.' };

  const snapshot: SemesterSnapshot = {
    student: semester.student,
    courses, topics, slides,
    learningObjectives: objectives,
    examQuestions: questions,
    quizHistory: quizzes,
    studyPlans,
    notes,
    examDates,
    activities,
    chatHistory,
    highlights,
    savedInsights: insights,
    timetables: timetable.timetables ?? { class: [], quiz: [], exam: [] },
    timetablePdf: timetable.timetablePdf ?? null,
    capturedAt: manifest.completedAt || manifest.created,
  };

  // Files: read the declared entries into memory (still staged — nothing
  // applied), verifying each one's ACTUAL size against the manifest.
  const files = new Map<string, { value: Blob | string; kind: 'file' | 'slidetext' }>();
  const actual: { name: string; size: number; type: string }[] = [];
  for (const declared of manifest.files) {
    const entry = zip.file(declared.name);
    if (!entry) return { ok: false, reason: `Corrupt backup: missing file "${declared.name}".` };
    const value = declared.name.startsWith('slideText/')
      ? await entry.async('string')
      : await entry.async('blob');
    const actualSize = typeof value === 'string'
      ? new TextEncoder().encode(value).length
      : value.size;
    if (actualSize !== declared.size) {
      return { ok: false, reason: `Corrupt backup: file "${declared.name}" has the wrong size.` };
    }
    actual.push({ name: declared.name, size: actualSize, type: declared.type });
    const key = declared.name.startsWith('slideText/')
      ? declared.name.slice('slideText/'.length).replace(/\.txt$/, '')
      : declared.name.slice('files/'.length);
    files.set(key, { value, kind: declared.name.startsWith('slideText/') ? 'slidetext' : 'file' });
  }

  // Integrity: the checksum recomputed from the ACTUAL entries must match the
  // manifest — this is what rejects corrupted or tampered backups.
  const recomputed = checksumOf(canonicalForBackup(
    { itemCount: manifest.itemCount, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes },
    actual,
  ));
  if (recomputed !== manifest.checksum) {
    return { ok: false, reason: 'Corrupt backup: file integrity check failed (checksum mismatch).' };
  }

  const totalBytes = manifest.files.reduce((s, f) => s + f.size, 0);
  return {
    ok: true,
    staged: {
      manifest: { ...manifest, totalBytes },
      snapshot,
      index,
      files,
    },
  };
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
  const currentRecords = currentKeys.filter((k) => k.startsWith('file_') || k.startsWith('slidetext_'));
  if (currentRecords.length) await idb.delMany(currentRecords);

  // 2. Materialise the incoming binaries.
  let i = 0;
  for (const [key, entry] of staged.files) {
    const targetKey = entry.kind === 'file' ? `file_${key}` : `slidetext_${key}`;
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

  const fresh: AppState = {
    ...initialState,
    isLoggedIn: current.isLoggedIn,
    openAIKey: current.openAIKey,
    student,
    courses: incoming.courses,
    topics: incoming.topics,
    slides: incoming.slides,
    learningObjectives: incoming.learningObjectives,
    examQuestions: incoming.examQuestions,
    quizHistory: incoming.quizHistory,
    studyPlans: incoming.studyPlans,
    notes: incoming.notes,
    examDates: incoming.examDates,
    activities: incoming.activities,
    chatHistory: incoming.chatHistory,
    highlights: incoming.highlights,
    savedInsights: incoming.savedInsights,
    timetables: incoming.timetables,
    timetablePdf: incoming.timetablePdf,
  };

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
  const files = new Map<string, { value: Blob | string; kind: 'file' | 'slidetext' }>();
  for (const entry of record.manifest) {
    const value = await idb.get(entry.archiveKey);
    if (value === undefined || value === null) continue;
    const key = entry.kind === 'file'
      ? entry.archiveKey.slice(META_FILE_PREFIX.length + archiveId.length + 1)
      : entry.archiveKey.slice(META_TEXT_PREFIX.length + archiveId.length + 1);
    files.set(key, { value, kind: entry.kind });
  }

  const staged: StagedBackup = {
    manifest: {
      app: BACKUP_APP,
      format: BACKUP_FORMAT,
      backupVersion: 1,
      created: new Date().toISOString(),
      source: 'archive',
      archiveId,
      title: record.meta.title,
      level: record.meta.level,
      semester: record.meta.semester,
      academicYear: record.meta.academicYear,
      completedAt: record.meta.completedAt,
      checksum: record.meta.checksum || '',
      itemCount: record.meta.itemCount,
      fileCount: record.meta.fileCount,
      totalBytes: record.meta.totalBytes,
      counts: record.meta.counts,
      files: record.manifest.map((e) => ({ name: e.archiveKey, size: e.size, type: e.kind === 'file' ? 'application/octet-stream' : 'text/plain' })),
    },
    snapshot: record.snapshot,
    index: record.index,
    files,
  };

  const fresh = await applyWorkspaceSource(staged, current, onProgress);
  return { fresh, guardArchive, restoredFrom: archiveId };
};
