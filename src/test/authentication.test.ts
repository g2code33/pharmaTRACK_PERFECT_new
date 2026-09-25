import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  auth: {
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    signInWithOAuth: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    updateUser: vi.fn(),
    getSession: vi.fn(),
    getUser: vi.fn(),
    signOut: vi.fn(),
    onAuthStateChange: vi.fn(),
  },
  from: vi.fn(),
  rpc: vi.fn(),
  purgeStoredSession: vi.fn(),
}));

vi.mock('../utils/supabase', () => ({
  supabase: authMocks,
  purgeStoredSession: authMocks.purgeStoredSession,
}));

import {
  deleteCurrentAccount,
  getAuthenticatedUser,
  onAuthChange,
  requestPasswordReset,
  restoreSession,
  signInWithOAuth,
  signInWithPassword,
  signOutEverywhereOnThisDevice,
  signUpWithPassword,
  updatePassword,
} from '../auth/authService';
import {
  inspectLocalWorkspaceMigration,
  linkLocalWorkspaceToAccount,
  studentForAuthenticatedUser,
} from '../auth/migration';

describe('normal account authentication contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'account-1' } }, error: null });
    authMocks.auth.signUp.mockResolvedValue({ data: { user: { id: 'account-1' }, session: null }, error: null });
    authMocks.auth.signInWithOAuth.mockResolvedValue({ data: { provider: 'google', url: 'https://accounts.example.test' }, error: null });
    authMocks.auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    authMocks.auth.updateUser.mockResolvedValue({ data: { user: { id: 'account-1' } }, error: null });
    authMocks.auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'account-1' } } }, error: null });
    authMocks.auth.getUser.mockResolvedValue({ data: { user: { id: 'account-1' } }, error: null });
    authMocks.auth.signOut.mockResolvedValue({ error: null });
    authMocks.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
    authMocks.rpc.mockResolvedValue({ data: null, error: null });
    authMocks.from.mockReturnValue({
      upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
  });

  it('uses Supabase email/password APIs for an existing account', async () => {
    await signInWithPassword('  ama@example.com ', 'correct horse battery staple');
    expect(authMocks.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'ama@example.com',
      password: 'correct horse battery staple',
    });
  });

  it('creates a password account without fabricating a second identity', async () => {
    await signUpWithPassword('new@example.com', 'a strong password', {
      fullName: 'Ama Mensah',
      level: 'Level 300',
    });
    expect(authMocks.auth.signUp).toHaveBeenCalledWith(expect.objectContaining({
      email: 'new@example.com',
      password: 'a strong password',
      options: expect.objectContaining({
        data: { full_name: 'Ama Mensah', level: 'Level 300' },
      }),
    }));
  });

  it.each(['google', 'github'] as const)('supports %s OAuth through the official client API', async (provider) => {
    await signInWithOAuth(provider);
    expect(authMocks.auth.signInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({
      provider,
      options: expect.objectContaining({ redirectTo: expect.stringContaining('/login') }),
    }));
  });

  it('supports restoration, token validation, password reset, and password update', async () => {
    await expect(restoreSession()).resolves.toMatchObject({ user: { id: 'account-1' } });
    await expect(getAuthenticatedUser()).resolves.toMatchObject({ id: 'account-1' });
    await requestPasswordReset(' ama@example.com ');
    expect(authMocks.auth.resetPasswordForEmail).toHaveBeenCalledWith(
      'ama@example.com',
      expect.objectContaining({ redirectTo: expect.stringContaining('/reset-password') }),
    );
    await updatePassword('new strong password');
    expect(authMocks.auth.updateUser).toHaveBeenCalledWith({ password: 'new strong password' });
  });

  it('validates a cloud user before account deletion and calls only the safe RPC', async () => {
    await deleteCurrentAccount();
    expect(authMocks.auth.getUser).toHaveBeenCalledTimes(1);
    expect(authMocks.rpc).toHaveBeenCalledWith('delete_my_account');
    expect(authMocks.auth).not.toHaveProperty('admin');
    expect(authMocks.purgeStoredSession).toHaveBeenCalledTimes(1);
  });

  it('uses local sign-out scope and purges browser auth storage even when the request fails', async () => {
    authMocks.auth.signOut.mockResolvedValueOnce({ error: new Error('offline') });
    await expect(signOutEverywhereOnThisDevice()).rejects.toThrow('offline');
    expect(authMocks.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(authMocks.purgeStoredSession).toHaveBeenCalledTimes(1);
  });

  it('forwards validated auth events without using Kiosk credentials', () => {
    const callback = vi.fn();
    onAuthChange(callback);
    const registered = authMocks.auth.onAuthStateChange.mock.calls[0][0];
    registered('SIGNED_IN', { user: { id: 'account-1' } });
    expect(callback).toHaveBeenCalledWith('SIGNED_IN', { user: { id: 'account-1' } });
    expect(authMocks.auth.onAuthStateChange).toHaveBeenCalledTimes(1);
  });
});

describe('explicit local workspace linking', () => {
  const localStudent = {
    id: 'device-student-1',
    name: 'Ama Mensah',
    university: 'UCC',
    level: 'Level 300',
    program: 'Pharmacy',
    semester: '1st Semester',
    createdAt: '2026-01-01',
  };

  beforeEach(() => {
    authMocks.from.mockReturnValue({
      upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
    localStorage.setItem('pharmatrack_state', JSON.stringify({
      student: localStudent,
      courses: [{ id: 'course-1' }],
      topics: [], slides: [], learningObjectives: [], examQuestions: [], quizHistory: [],
      studyPlans: [], notes: [], examDates: [], activities: [], chatHistory: [],
      highlights: [], savedInsights: [], openAIKey: '',
      timetables: { class: [], quiz: [], exam: [] }, timetablePdf: null,
    }));
  });

  it('detects a mismatched local ID instead of silently attaching it', () => {
    expect(inspectLocalWorkspaceMigration('supabase-account-1')).toMatchObject({
      required: true,
      hasAcademicData: true,
      student: localStudent,
    });
    expect(studentForAuthenticatedUser('supabase-account-1', localStudent).id).toBe('supabase-account-1');
    expect(localStudent.id).toBe('device-student-1');
  });

  it('links only after explicit invocation and keys the profile by auth.users.id', async () => {
    const linked = await linkLocalWorkspaceToAccount('supabase-account-1', localStudent);
    expect(linked.id).toBe('supabase-account-1');
    expect(authMocks.from).toHaveBeenCalledWith('profiles');
    expect(authMocks.from.mock.results[0].value.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'supabase-account-1' }),
      { onConflict: 'id' },
    );
    expect(JSON.parse(localStorage.getItem('pharmatrack_state')!).student.id).toBe('supabase-account-1');
  });
});

describe('Supabase SQL and Kiosk/account separation contract', () => {
  const authSql = readFileSync('supabase/authentication.sql', 'utf8');
  const rlsSql = readFileSync('supabase/security-rls.sql', 'utf8');

  it('keys profiles and cleanup to auth.users.id, while roles stay server controlled', () => {
    expect(authSql).toContain('references auth.users(id) on delete cascade');
    expect(authSql).toContain("check (role in ('student', 'staff', 'admin'))");
    expect(authSql).toContain('revoke insert (role), update (role)');
    expect(authSql).toContain('create or replace function public.delete_my_account()');
    expect(authSql).toContain('grant execute on function public.delete_my_account() to authenticated');
    expect(authSql).not.toContain('service_role');
  });

  it('keeps normal account RLS separate from the examination Kiosk identity', () => {
    expect(authSql).toContain('normal accounts use auth.users.id');
    expect(authSql).toContain('Kiosk uses First Name + Level + RX30');
    expect(rlsSql).toContain('auth.uid() = id');
    expect(rlsSql).not.toContain('kioskPassword');
  });
});
