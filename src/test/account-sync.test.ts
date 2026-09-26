import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AccountSyncEngine,
  MemoryAccountSyncStore,
  sanitizeAccountPayload,
  type AccountSyncTransport,
  type PendingAccountChange,
  type RemoteAccountRecord,
} from '../account/sync';

class FakeAccountServer implements AccountSyncTransport {
  currentUser = 'user-a';
  readonly rows = new Map<string, Map<string, RemoteAccountRecord>>();
  pullCount = 0;

  async currentUserId(): Promise<string | null> {
    return this.currentUser;
  }

  async pull(userId: string): Promise<RemoteAccountRecord[]> {
    this.pullCount += 1;
    return [...(this.rows.get(userId)?.values() ?? [])].map((row) => ({ ...row }));
  }

  async push(userId: string, change: PendingAccountChange) {
    const userRows = this.rows.get(userId) ?? new Map<string, RemoteAccountRecord>();
    this.rows.set(userId, userRows);
    const current = userRows.get(change.recordId);
    if ((current ? current.version : 0) !== change.baseVersion) {
      return {
        accepted: false as const,
        conflict: true as const,
        record: current ? { ...current } : null,
      };
    }
    const version = (current?.version ?? 0) + 1;
    const record: RemoteAccountRecord = {
      recordId: change.recordId,
      recordType: change.recordType,
      payload: change.deleted ? null : change.payload,
      version,
      updatedAt: new Date().toISOString(),
      updatedByDeviceId: change.deviceId,
      deletedAt: change.deleted ? new Date().toISOString() : null,
    };
    userRows.set(change.recordId, record);
    return { accepted: true as const, record };
  }

  deleteUser(userId: string): void {
    this.rows.delete(userId);
  }
}

function online(value: boolean): () => void {
  const original = navigator.onLine;
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
  return () => Object.defineProperty(navigator, 'onLine', { configurable: true, value: original });
}

function engine(
  server: FakeAccountServer,
  store = new MemoryAccountSyncStore(),
): AccountSyncEngine {
  let device = 0;
  return new AccountSyncEngine(server, store, () => `device-${++device}`);
}

describe('normal account synchronization', () => {
  it('restores only the account-owned profile from Device A to Device B', async () => {
    const server = new FakeAccountServer();
    const deviceA = engine(server);
    await deviceA.queue('user-a', 'profile', 'profile_preferences', {
      fullName: 'Ama Mensah',
      university: 'UCC',
      level: 'Level 300',
      program: 'Pharm.D',
      semester: '1st Semester',
    });
    expect((await deviceA.flush('user-a')).state).toBe('ready');

    const deviceB = engine(server);
    const restored = await deviceB.restore('user-a');
    expect(restored.state).toBe('ready');
    expect(await deviceB.getRecord('user-a', 'profile')).toMatchObject({
      fullName: 'Ama Mensah',
      level: 'Level 300',
    });
    expect(await deviceB.getRecord('user-a', 'courses')).toBeNull();
  });

  it('keeps an offline local change pending and confirms it after recovery', async () => {
    const server = new FakeAccountServer();
    const device = engine(server);
    const restore = online(false);
    try {
      expect(
        (await device.queue('user-a', 'application', 'application_settings', { theme: 'dark' }))
          .state,
      ).toBe('pending');
      expect((await device.flush('user-a')).state).toBe('pending');
      expect(server.pullCount).toBe(0);
    } finally {
      restore();
    }
    expect((await device.flush('user-a')).state).toBe('ready');
    expect(await device.getRecord('user-a', 'application')).toMatchObject({ theme: 'dark' });
  });

  it('detects a cross-device conflict without silently overwriting either value', async () => {
    const server = new FakeAccountServer();
    const deviceA = engine(server);
    const deviceB = engine(server);
    await deviceA.restore('user-a');
    await deviceB.restore('user-a');
    await deviceA.queue('user-a', 'profile', 'profile_preferences', { fullName: 'Device A' });
    expect((await deviceA.flush('user-a')).state).toBe('ready');

    await deviceB.queue('user-a', 'profile', 'profile_preferences', { fullName: 'Device B' });
    const result = await deviceB.flush('user-a');
    expect(result.state).toBe('conflict');
    expect(await deviceB.getRecord('user-a', 'profile')).toMatchObject({ fullName: 'Device B' });
    expect(server.rows.get('user-a')?.get('profile')?.payload).toMatchObject({
      fullName: 'Device A',
    });
    expect((await deviceB.resolveConflict('user-a', 'profile', 'remote')).state).toBe('ready');
    expect(await deviceB.getRecord('user-a', 'profile')).toMatchObject({ fullName: 'Device A' });
  });

  it('does not restore another account and reports a revoked session', async () => {
    const server = new FakeAccountServer();
    const deviceA = engine(server);
    await deviceA.queue('user-a', 'profile', 'profile_preferences', { fullName: 'Private A' });
    await deviceA.flush('user-a');
    const deviceB = engine(server);
    server.currentUser = 'user-a';
    const status = await deviceB.restore('user-b');
    expect(status.state).toBe('revoked');
    expect(await deviceB.getRecord('user-b', 'profile')).toBeNull();
    expect(server.pullCount).toBe(0);
  });

  it('retains a user-namespaced pending queue across logout/login and clears it on deletion', async () => {
    const server = new FakeAccountServer();
    const store = new MemoryAccountSyncStore();
    const device = engine(server, store);
    const restore = online(false);
    try {
      await device.queue('user-a', 'permitted', 'permitted_data', {
        kind: 'study_preferences',
        values: { dailyGoalMinutes: 45 },
      });
    } finally {
      restore();
    }
    await device.lock();
    server.currentUser = 'user-a';
    expect((await device.restore('user-a')).state).toBe('ready');
    expect(await device.getRecord('user-a', 'permitted')).toMatchObject({
      kind: 'study_preferences',
    });
    server.deleteUser('user-a');
    await device.clearUser('user-a');
    expect(await device.getRecord('user-a', 'permitted')).toBeNull();
  });

  it('rejects academic and examination-shaped payloads at the client allowlist', () => {
    expect(() => sanitizeAccountPayload('application_settings', { courses: [] })).toThrow();
    expect(() =>
      sanitizeAccountPayload('permitted_data', {
        kind: 'study_preferences',
        values: { notes: [] },
      }),
    ).toThrow();
    expect(sanitizeAccountPayload('ai_profile_selection', { activeProfileId: 'study' })).toEqual({
      activeProfileId: 'study',
    });
  });
});

describe('normal account synchronization SQL contract', () => {
  const sql = readFileSync('supabase/account-sync.sql', 'utf8');

  it('uses authenticated ownership, version checks, and update USING plus WITH CHECK policies', () => {
    expect(sql).toContain('references auth.users(id) on delete cascade');
    expect(sql).toContain(
      'alter table public.pharmatrack_account_sync_records enable row level security',
    );
    expect(sql).toContain(
      'alter table public.pharmatrack_account_sync_cursors enable row level security',
    );
    expect(sql).toContain('using (auth.uid() = user_id)');
    expect(sql).toContain('with check (auth.uid() = user_id)');
    expect(sql).toContain('p_base_version < row.version or p_base_version > row.version');
    expect(sql).toContain(
      'revoke all on table public.pharmatrack_account_sync_records from anon, authenticated',
    );
    expect(sql).toContain('auth.uid()');
  });

  it('does not define academic workspace or examination record types', () => {
    const recordTypeDeclaration = sql.slice(
      sql.indexOf('record_type text not null'),
      sql.indexOf('payload jsonb not null'),
    );
    expect(recordTypeDeclaration).not.toMatch(/courses|topics|slides|notes|quiz|exam/i);
    expect(sql).toContain('pharmatrack_validate_account_sync_payload');
  });
});
