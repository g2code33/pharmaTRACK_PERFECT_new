import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import { supabase, purgeStoredSession } from '../utils/supabase';

export type OAuthProvider = 'google' | 'github';

export interface AuthResult<T> {
  data: T | null;
  error: Error | null;
}

export function authRedirectUrl(route = '/login'): string {
  if (typeof window === 'undefined') return route;
  const path = window.location.pathname || '/';
  const query = window.location.search || '';
  return `${window.location.origin}${path}${query}#${route}`;
}

export async function signInWithPassword(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email: email.trim(), password });
}

export async function signUpWithPassword(
  email: string,
  password: string,
  profile: { fullName?: string; level?: string } = {},
) {
  // Metadata is used only to pre-fill a profile display name. It is never an
  // authorization or role source; the auth user ID remains the stable key.
  return supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: {
        full_name: profile.fullName?.trim() || undefined,
        level: profile.level || undefined,
      },
      emailRedirectTo: authRedirectUrl('/login'),
    },
  });
}

export async function signInWithOAuth(provider: OAuthProvider) {
  return supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: authRedirectUrl('/login'),
      queryParams: provider === 'google' ? { access_type: 'offline', prompt: 'consent' } : undefined,
    },
  });
}

export async function requestPasswordReset(email: string) {
  return supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: authRedirectUrl('/reset-password'),
  });
}

export async function updatePassword(password: string) {
  return supabase.auth.updateUser({ password });
}

/**
 * getSession restores the SDK session and can refresh it. It is not used as an
 * authorization decision for cloud data; callers that need proof use
 * getAuthenticatedUser(), which asks Supabase to validate the access token.
 */
export async function restoreSession(): Promise<Session | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function getAuthenticatedUser(): Promise<User | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user;
}

export function onAuthChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
): { unsubscribe: () => void } {
  const { data } = supabase.auth.onAuthStateChange(callback);
  return data.subscription;
}

export async function signOutEverywhereOnThisDevice(): Promise<void> {
  // Local scope is deliberate: signing out one device must not unexpectedly
  // terminate a student's other active devices.
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  purgeStoredSession();
  if (error) throw error;
}

/**
 * Account deletion is performed by an authenticated SECURITY DEFINER function
 * in Supabase. A browser must never receive a service-role key or call the
 * admin API directly.
 */
export async function deleteCurrentAccount(): Promise<void> {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Your session has expired. Sign in again before deleting the account.');

  const { error } = await supabase.rpc('delete_my_account');
  if (error) throw error;
  purgeStoredSession();
}
