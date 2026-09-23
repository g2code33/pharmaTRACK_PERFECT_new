/**
 * Storage Manager, recovery, and versioned migration.
 *
 * The app must fail safely and explain what happened. It must not clear
 * storage to apply an update, and it must not overwrite a file it cannot read.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { saveState, initialState, isWorkspacePersistBlocked } from '../utils/storage';
import { isSemesterOwnedIdbKey } from '../utils/semesterArchive';
import type { AppState } from '../types';

const { idbStore, flags } = vi.hoisted(() => ({
  idbStore: new Map<string, unknown>(),
  flags: { failBackup: false, failCredential: false, failKeys: false, cleared: false },
}));

vi.mock('idb-keyval', () => ({
  get: async (k: string) => idbStore.get(k),
  set: async (k: string, v: unknown) => {
    if (flags.failBackup && k.startsWith('pharmatrack_migration_backup_')) {
      throw new DOMException('quota', 'QuotaExceededError');
    }
    if (flags.failCredential && k === 'pharmatrack_ai_credentials') {
      throw new Error('credential store unavailable');
    }
    idbStore.set(k, v);
  },
  del: async (k: string) => { idbStore.delete(k); },
  delMany: async (keys: string[]) => { keys.forEach((k) => idbStore.delete(k)); },
  keys: async () => {
    if (flags.failKeys) throw new Error('IndexedDB unavailable');
    return [...idbStore.keys()];
  },
  clear: async () => { flags.cleared = true; idbStore.clear(); },
}));

import {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_KEY,
  classifyStorageKey,
  discardIncompleteArchive,
  discardInterruptedImports,
  ensureSchema,
  inspectStorage,
  recheckArchive,
  resetStorageNotice,
  restoreSafetyBackup,
  retryMigration,
} from '../utils/storageManager';
import StorageManager from '../pages/StorageManager';
import StorageNoticeBanner from '../components/StorageNoticeBanner';

const SECRET = 'AIzaSy-test-key-123456';

const stampCurrent = () => {
  localStorage.setItem(SCHEMA_KEY, JSON.stringify({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    status: 'current',
    updatedAt: '2026-01-01T00:00:00.000Z',
    history: [],
  }));
};

beforeEach(() => {
  idbStore.clear();
  flags.failBackup = false;
  flags.failCredential = false;
  flags.failKeys = false;
  flags.cleared = false;
  localStorage.clear();
  resetStorageNotice();
});

describe('versioned migration', () => {
  it('migrates an old schema without dropping fields, courses, or timetable entries', async () => {
    const clearLs = vi.spyOn(Storage.prototype, 'clear');
    const raw = JSON.stringify({
      student: { id: 'u1', name: 'Ama', level: '300', semester: '1st' },
      courses: [{ id: 'c1', courseName: 'Pharmacology' }],
      timetables: [{ id: 'tt1', type: 'exam', subject: 'PHA301' }],
      clinicalCases: [{ id: 'case-1', title: 'Asthma' }],
      openAIKey: SECRET,
    });
    localStorage.setItem('pharmatrack_state', raw);

    const result = await ensureSchema();

    expect(result.persist).toBe(true);
    expect(result.notice).toBeNull();
    expect(result.state.courses).toHaveLength(1);
    expect(result.state.courses[0].id).toBe('c1');
    expect(result.state.student?.id).toBe('u1');
    expect(result.state.timetables.exam).toHaveLength(1);
    expect(result.state.notes).toEqual([]);
    expect((result.state as AppState & { clinicalCases?: { id: string }[] }).clinicalCases).toEqual([{ id: 'case-1', title: 'Asthma' }]);
    expect(result.state.openAIKey).toBe('');

    const saved = JSON.parse(localStorage.getItem('pharmatrack_state')!) as { openAIKey?: string; clinicalCases?: unknown };
    expect(saved.openAIKey).toBe('');
    expect(saved.clinicalCases).toEqual([{ id: 'case-1', title: 'Asthma' }]);
    expect(JSON.stringify(saved)).not.toContain(SECRET);

    const schema = JSON.parse(localStorage.getItem(SCHEMA_KEY)!);
    expect(schema.schemaVersion).toBe(3);
    expect(schema.status).toBe('current');

    const creds = idbStore.get('pharmatrack_ai_credentials') as { gemini?: { apiKey?: string } };
    expect(creds.gemini?.apiKey).toBe(SECRET);

    const backups = [...idbStore.keys()].filter((k) => k.startsWith('pharmatrack_migration_backup_'));
    expect(backups).toHaveLength(1);
    expect(String((idbStore.get(backups[0]) as { stateJson?: string }).stateJson)).toContain(SECRET);

    const report = await inspectStorage();
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(flags.cleared).toBe(false);
    expect(clearLs).not.toHaveBeenCalled();
  });

  it('rolls an interrupted migration back to the safety copy and does not retry by itself', async () => {
    const good = JSON.stringify({
      student: { id: 'u1', name: 'Ama' },
      courses: [{ id: 'c1', courseName: 'Pharmacology' }],
      openAIKey: '',
    });
    localStorage.setItem('pharmatrack_state', '{"courses":');
    localStorage.setItem(SCHEMA_KEY, JSON.stringify({
      schemaVersion: 1,
      status: 'migrating',
      safetyBackupId: 'bak1',
      updatedAt: '2026-01-01T00:00:00.000Z',
      history: [],
    }));
    idbStore.set('pharmatrack_migration_backup_bak1', {
      id: 'bak1',
      fromVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      stateJson: good,
      schemaJson: null,
      aiSettingsJson: null,
    });

    const result = await ensureSchema();

    expect(localStorage.getItem('pharmatrack_state')).toBe(good);
    expect(result.state.courses).toHaveLength(1);
    expect(result.notice?.explanation).toMatch(/interrupted/i);
    expect(result.notice?.explanation).toMatch(/nothing was deleted/i);
    expect(JSON.parse(localStorage.getItem(SCHEMA_KEY)!).status).toBe('rolled-back');

    const second = await ensureSchema();
    expect(second.state.courses).toHaveLength(1);
    expect(localStorage.getItem('pharmatrack_state')).toBe(good);
    expect(JSON.parse(localStorage.getItem(SCHEMA_KEY)!).status).toBe('rolled-back');
    expect([...idbStore.keys()].filter((k) => k.startsWith('pharmatrack_migration_backup_'))).toHaveLength(1);
    expect(flags.cleared).toBe(false);
  });

  it('restores a safety copy when the semester file is unreadable, and keeps both copies', async () => {
    const good = JSON.stringify({ courses: [{ id: 'c1', courseName: 'Pharmacology' }], openAIKey: '' });
    localStorage.setItem('pharmatrack_state', '{not json');
    localStorage.setItem(SCHEMA_KEY, JSON.stringify({
      schemaVersion: 1,
      status: 'rolled-back',
      safetyBackupId: 'bak1',
      updatedAt: '2026-01-01T00:00:00.000Z',
      history: [],
    }));
    idbStore.set('pharmatrack_migration_backup_bak1', {
      id: 'bak1',
      fromVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      stateJson: good,
      schemaJson: null,
      aiSettingsJson: null,
    });

    const report = await inspectStorage();
    expect(report.issues.some((issue) => issue.code === 'SAFETY_BACKUP_AVAILABLE')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('{not json');

    const result = await restoreSafetyBackup();
    expect(result.ok).toBe(true);
    expect(result.explanation).toMatch(/nothing was deleted/i);
    expect(localStorage.getItem('pharmatrack_state')).toBe(good);
    expect(idbStore.has('pharmatrack_migration_backup_bak1')).toBe(true);
    expect([...idbStore.keys()].some((k) => k.includes('quarantine_'))).toBe(true);
  });

  it('does not overwrite a corrupted semester file, and saveState refuses too', async () => {
    localStorage.setItem('pharmatrack_state', '{not json');

    const result = await ensureSchema();

    expect(result.persist).toBe(false);
    expect(result.notice?.explanation).toMatch(/has not been overwritten/i);
    expect(localStorage.getItem('pharmatrack_state')).toBe('{not json');
    expect(isWorkspacePersistBlocked()).toBe(true);

    saveState({ ...initialState, courses: [{ id: 'new' } as AppState['courses'][number]] });
    expect(localStorage.getItem('pharmatrack_state')).toBe('{not json');
    expect(flags.cleared).toBe(false);
  });

  it('treats truncated JSON as malformed and leaves the bytes alone', async () => {
    const truncated = '{"courses":[{"id":"c1"}]';
    localStorage.setItem('pharmatrack_state', truncated);

    const result = await ensureSchema();

    expect(result.persist).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'MALFORMED_STATE')).toBe(true);
    expect(result.notice?.explanation).toMatch(/not valid JSON/);
    expect(result.notice?.explanation).toMatch(/has not been overwritten/i);
    expect(localStorage.getItem('pharmatrack_state')).toBe(truncated);
    saveState(initialState);
    expect(localStorage.getItem('pharmatrack_state')).toBe(truncated);
  });

  it('leaves data unchanged when there is not enough storage for the safety copy', async () => {
    flags.failBackup = true;
    const raw = JSON.stringify({
      student: { id: 'u1', name: 'Ama' },
      courses: [{ id: 'c1', courseName: 'Pharmacology' }],
      openAIKey: SECRET,
    });
    localStorage.setItem('pharmatrack_state', raw);

    const result = await ensureSchema();

    expect(localStorage.getItem('pharmatrack_state')).toBe(raw);
    expect(localStorage.getItem(SCHEMA_KEY)).toBeNull();
    expect(result.notice?.explanation).toMatch(/not enough free storage/i);
    expect(result.notice?.explanation).toMatch(/exactly as it was/i);
    expect(result.state.courses).toHaveLength(1);
    expect(result.state.openAIKey).toBe(SECRET);
    expect(flags.cleared).toBe(false);
  });

  it('restores the previous semester file when the key copy cannot be verified', async () => {
    flags.failCredential = true;
    const raw = JSON.stringify({
      student: { id: 'u1', name: 'Ama' },
      courses: [{ id: 'c1' }],
      openAIKey: SECRET,
    });
    localStorage.setItem('pharmatrack_state', raw);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await ensureSchema();

    expect(JSON.parse(localStorage.getItem('pharmatrack_state')!).openAIKey).toBe(SECRET);
    expect(JSON.parse(localStorage.getItem(SCHEMA_KEY)!).status).toBe('rolled-back');
    expect(result.notice?.explanation).toMatch(/restored/i);
    expect(result.notice?.explanation).toMatch(/nothing was deleted/i);
    expect(result.notice?.explanation).not.toContain(SECRET);
    expect(flags.cleared).toBe(false);
  });

  it('can retry a rolled-back update once storage can hold the key', async () => {
    flags.failCredential = true;
    localStorage.setItem('pharmatrack_state', JSON.stringify({
      courses: [{ id: 'c1' }],
      openAIKey: SECRET,
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await ensureSchema();
    expect(JSON.parse(localStorage.getItem(SCHEMA_KEY)!).status).toBe('rolled-back');

    flags.failCredential = false;
    const retried = await retryMigration();

    expect(retried.ok).toBe(true);
    expect(retried.explanation).toMatch(/nothing was deleted/i);
    expect(JSON.parse(localStorage.getItem(SCHEMA_KEY)!).schemaVersion).toBe(3);
    expect(JSON.parse(localStorage.getItem('pharmatrack_state')!).openAIKey).toBe('');
    expect((idbStore.get('pharmatrack_ai_credentials') as { gemini?: { apiKey?: string } }).gemini?.apiKey).toBe(SECRET);
  });
});

describe('storage inspection and recovery', () => {
  it('reports a missing IndexedDB file and does not delete the slide', async () => {
    stampCurrent();
    localStorage.setItem('pharmatrack_state', JSON.stringify({
      ...initialState,
      slides: [{
        id: 's1', topicId: 't1', slideNumber: 1, title: 'Autonomic Pharmacology',
        contentText: '', fileUrl: 'local:missing-file', fileType: 'pdf', status: 'not_started', createdAt: '2026-01-01',
      }],
    }));

    const report = await inspectStorage();

    const issue = report.issues.find((item) => item.code === 'MISSING_BINARY');
    expect(issue?.explanation).toMatch(/Autonomic Pharmacology/);
    expect(issue?.explanation).toMatch(/nothing was deleted/i);
    expect(JSON.parse(localStorage.getItem('pharmatrack_state')!).slides).toHaveLength(1);
    expect(flags.cleared).toBe(false);
  });

  it('explains an IndexedDB outage without pretending usage is zero and without deleting', async () => {
    stampCurrent();
    localStorage.setItem('pharmatrack_state', JSON.stringify({ courses: [{ id: 'c1' }] }));
    idbStore.set('file_keep', new Blob(['keep']));
    flags.failKeys = true;

    const report = await inspectStorage();

    expect(report.indexedDbAvailable).toBe(false);
    expect(report.indexedDbBytes).toBeNull();
    const issue = report.issues.find((item) => item.code === 'INDEXEDDB_UNAVAILABLE');
    expect(issue?.explanation).toMatch(/not deleted/i);
    expect(idbStore.has('file_keep')).toBe(true);
  });

  it('explains a localStorage outage and does not write', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });

    const result = await ensureSchema();

    expect(result.persist).toBe(false);
    expect(result.notice?.title).toMatch(/unavailable/i);
    expect(result.notice?.explanation).toMatch(/will not overwrite/i);
  });

  it('keeps categories separate and never puts a key value in the report', async () => {
    stampCurrent();
    localStorage.setItem('pharmatrack_state', JSON.stringify({ courses: [{ id: 'c1' }], openAIKey: '' }));
    localStorage.setItem('pharmatrack_ai_settings', JSON.stringify({ providers: [] }));
    localStorage.setItem('sb-project-auth-token', 'session-token-not-a-category');
    idbStore.set('file_lecture', new Blob(['pdf-bytes']));
    idbStore.set('slidetext_s1', 'extracted lecture text');
    idbStore.set('semester_archive_archive_keep01', {
      meta: {
        id: 'archive_keep01', status: 'verified', title: 'Level 300 — Semester 1',
        level: '300', semester: '1', completedAt: '2026-01-01', createdAt: '2026-01-01',
        version: 1, itemCount: 1, fileCount: 0, totalBytes: 4,
      },
      snapshot: { courses: [{ id: 'old' }] },
      manifest: [],
    });
    idbStore.set('pharmatrack_ai_credentials', { gemini: { apiKey: SECRET } });
    idbStore.set('pharmatrack_ai_conversation_c1', { title: 'Beta blockers', messages: [{ content: 'hello' }] });
    idbStore.set('pharmatrack_ai_conversations_index', [{ id: 'c1' }]);
    idbStore.set('pharmatrack_search_index', { s1: 'digoxin' });
    idbStore.set('semester_import_abc', { importId: 'abc' });

    const report = await inspectStorage();

    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(report.categories.find((c) => c.id === 'ai-configuration')!.bytes).toBeGreaterThan(0);
    expect(report.categories.find((c) => c.id === 'academic-archives')!.bytes).toBeGreaterThan(0);
    expect(report.categories.find((c) => c.id === 'uploaded-materials')!.bytes).toBeGreaterThan(0);
    expect(report.categories.find((c) => c.id === 'ai-conversations')!.bytes).toBeGreaterThan(0);
    expect(report.categories.find((c) => c.id === 'current-semester')!.bytes).toBeGreaterThan(0);
    expect(report.categories.find((c) => c.id === 'application-settings')!.bytes).toBeGreaterThan(0);
    expect(report.recoveryBytes).toBeGreaterThan(0);
    expect(report.archiveCount).toBe(1);
    expect(report.uploadedFileCount).toBe(1);

    const accounted = report.categories.reduce((n, c) => n + c.bytes, 0) + report.recoveryBytes;
    expect(accounted).toBe((report.localStorageBytes ?? 0) + (report.indexedDbBytes ?? 0));

    expect(classifyStorageKey('idb', 'pharmatrack_ai_credentials')).toBe('ai-configuration');
    expect(classifyStorageKey('idb', 'semester_archive_archive_keep01')).toBe('academic-archives');
    expect(classifyStorageKey('idb', 'semester_import_abc')).toBe('recovery');
    expect(classifyStorageKey('local', 'pharmatrack_state')).toBe('current-semester');
    expect(classifyStorageKey('local', 'pharmatrack_ai_settings')).toBe('ai-configuration');
  });

  it('discards an interrupted import without touching archives, files, or credentials', async () => {
    idbStore.set('semester_import_abc', { importId: 'abc' });
    idbStore.set('semester_import_file_abc_f1', new Blob(['pdf']));
    idbStore.set('semester_archive_archive_keep01', { meta: { id: 'archive_keep01', status: 'verified', title: 'Kept' }, snapshot: { courses: [] } });
    idbStore.set('file_keep', new Blob(['keep']));
    idbStore.set('pharmatrack_ai_credentials', { gemini: { apiKey: SECRET } });

    const before = await inspectStorage();
    expect(before.issues.some((issue) => issue.code === 'INTERRUPTED_IMPORT')).toBe(true);
    expect(before.issues.find((issue) => issue.code === 'INTERRUPTED_IMPORT')?.explanation).toMatch(/without affecting your current semester or your archives/i);

    const result = await discardInterruptedImports();

    expect(result.ok).toBe(true);
    expect(result.explanation).toMatch(/not changed/i);
    expect([...idbStore.keys()].some((k) => k.startsWith('semester_import_'))).toBe(false);
    expect(idbStore.has('semester_archive_archive_keep01')).toBe(true);
    expect(idbStore.has('file_keep')).toBe(true);
    expect(idbStore.has('pharmatrack_ai_credentials')).toBe(true);
    expect(flags.cleared).toBe(false);
  });

  it('reports corrupt archive metadata and will not delete a verified archive to fix it', async () => {
    idbStore.set('semester_archive_archive_bad01', {
      meta: { id: 'archive_bad01', status: 'verified', title: 'Broken record' },
    });
    idbStore.set('semester_archive_archive_keep01', {
      meta: { id: 'archive_keep01', status: 'verified', title: 'Level 300 — Semester 1', level: '300', semester: '1', completedAt: '2026-01-01', createdAt: '2026-01-01', version: 1, itemCount: 0, fileCount: 0, totalBytes: 0 },
      snapshot: { courses: [{ id: 'c1' }], student: { id: 'u1' } },
      manifest: [],
    });

    const report = await inspectStorage();
    const issue = report.issues.find((item) => item.code === 'CORRUPT_ARCHIVE_METADATA');
    expect(issue?.explanation).toMatch(/kept|not deleted/i);
    expect(issue?.explanation).not.toMatch(/clear all/i);

    const refused = await discardIncompleteArchive('archive_bad01');
    expect(refused.ok).toBe(false);
    expect(refused.explanation).toMatch(/verified/i);
    expect(idbStore.has('semester_archive_archive_bad01')).toBe(true);
    expect(idbStore.has('semester_archive_archive_keep01')).toBe(true);
  });

  it('rechecks an interrupted archive write without deleting the snapshot', async () => {
    idbStore.set('semester_archive_archive_new01', {
      meta: {
        id: 'archive_new01', status: 'creating', title: 'Level 100 — Semester 2',
        level: '100', semester: '2', completedAt: '2026-01-01', createdAt: '2026-01-01',
        version: 1, itemCount: 1, fileCount: 0, totalBytes: 0,
      },
      snapshot: { courses: [{ id: 'c1' }] },
      manifest: [],
    });

    const report = await inspectStorage();
    expect(report.issues.some((issue) => issue.code === 'INCOMPLETE_WRITE')).toBe(true);

    const result = await recheckArchive('archive_new01');
    expect(result.explanation).toMatch(/kept|not deleted/i);
    const after = idbStore.get('semester_archive_archive_new01') as { snapshot?: { courses?: unknown[] } };
    expect(after.snapshot?.courses).toHaveLength(1);
  });

  it('removes only an unreadable archive record', async () => {
    idbStore.set('semester_archive_archive_junk1', 'not-an-archive');
    idbStore.set('semester_archive_archive_keep01', {
      meta: { id: 'archive_keep01', status: 'verified', title: 'Kept' },
      snapshot: { courses: [] },
    });
    idbStore.set('file_keep', new Blob(['keep']));

    const report = await inspectStorage();
    expect(report.issues.some((issue) => issue.code === 'CORRUPT_ARCHIVE_METADATA' && /not deleted/i.test(issue.explanation))).toBe(true);

    const result = await discardIncompleteArchive('archive_junk1');
    expect(result.ok).toBe(true);
    expect(idbStore.has('semester_archive_archive_junk1')).toBe(false);
    expect(idbStore.has('semester_archive_archive_keep01')).toBe(true);
    expect(idbStore.has('file_keep')).toBe(true);
  });

  it('reports a missing archived file and keeps the archive', async () => {
    idbStore.set('semester_archive_archive_miss01', {
      meta: {
        id: 'archive_miss01', status: 'verified', title: 'Level 200 — Semester 1',
        level: '200', semester: '1', completedAt: '2026-01-01', createdAt: '2026-01-01',
        version: 1, itemCount: 0, fileCount: 1, totalBytes: 4,
      },
      snapshot: { courses: [], student: { id: 'u1' } },
      manifest: [{ sourceKey: 'file_gone', archiveKey: 'semester_archive_file_archive_miss01_gone', kind: 'file', size: 4 }],
    });

    const report = await inspectStorage();
    const issue = report.issues.find((item) => item.code === 'MISSING_ARCHIVE_FILE');
    expect(issue?.explanation).toMatch(/Level 200 — Semester 1/);
    expect(issue?.explanation).toMatch(/not deleted/i);
    expect(idbStore.has('semester_archive_archive_miss01')).toBe(true);
  });

  it('warns when the browser reports low storage and does not delete anything', async () => {
    stampCurrent();
    localStorage.setItem('pharmatrack_state', JSON.stringify({ courses: [{ id: 'c1' }] }));
    idbStore.set('file_keep', new Blob(['keep']));
    const original = Object.getOwnPropertyDescriptor(navigator, 'storage');
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ quota: 1000, usage: 900 }) },
    });

    const report = await inspectStorage();

    expect(report.issues.some((issue) => issue.code === 'LOW_STORAGE')).toBe(true);
    expect(report.availableBytes).toBe(100);
    expect(report.issues.find((issue) => issue.code === 'LOW_STORAGE')?.explanation).toMatch(/nothing was deleted/i);
    expect(idbStore.has('file_keep')).toBe(true);

    if (original) Object.defineProperty(navigator, 'storage', original);
    else delete (navigator as { storage?: unknown }).storage;
  });

  it('does not treat migration backups or import stages as semester data', () => {
    expect(isSemesterOwnedIdbKey('pharmatrack_migration_backup_mig_1')).toBe(false);
    expect(isSemesterOwnedIdbKey('semester_import_abc')).toBe(false);
    expect(isSemesterOwnedIdbKey('pharmatrack_ai_credentials')).toBe(false);
    expect(isSemesterOwnedIdbKey('file_lecture')).toBe(true);
    expect(isSemesterOwnedIdbKey('pharmatrack_ai_conversation_c1')).toBe(true);
  });
});

describe('Storage Manager explains a failure', () => {
  it('shows the unreadable-file explanation and does not offer a global wipe', async () => {
    localStorage.setItem('pharmatrack_state', '{not json');
    await ensureSchema();

    render(
      <MemoryRouter>
        <StorageNoticeBanner />
        <StorageManager />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('storage-notice').textContent).toMatch(/has not been overwritten/i);
    expect(await screen.findByTestId('storage-issue-MALFORMED_STATE')).toBeTruthy();
    expect(screen.getAllByText(/has not been overwritten/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/clear all/i)).toBeNull();
    expect(screen.getByTestId('storage-available').textContent).toMatch(/not reported/i);
  });
});
