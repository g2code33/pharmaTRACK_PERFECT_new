import { createClient } from '@supabase/supabase-js';

// Forcefully use your real Supabase URL as the fallback!
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://ltpwedxcvbejiywmwrwc.supabase.co";

// REPLACE THE TEXT BELOW WITH YOUR ACTUAL SUPABASE ANON KEY!
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_VYF1gRvyI3EMCfon1hHK4A_vbWgPknx";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// The localStorage key supabase-js persists the session under. It derives this
// from the project URL as `sb-<project-ref>-auth-token`.
export const AUTH_STORAGE_KEY = (() => {
  try {
    return `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  } catch {
    return 'supabase.auth.token';
  }
})();

/**
 * Removes the persisted Supabase session from localStorage.
 *
 * `supabase.auth.signOut()` always POSTs to /logout first, and when that request
 * fails (offline — the normal case for this app) auth-js returns early and never
 * clears the stored token. The session then survives, and `getSession()` keeps
 * handing back a valid user, which silently re-authenticates the user.
 * This purge guarantees sign-out sticks whether or not the network call worked.
 */
export const purgeStoredSession = (): void => {
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(`${AUTH_STORAGE_KEY}-code-verifier`);
    // Sweep any tokens left behind by a previous project ref / older key format.
    Object.keys(localStorage)
      .filter((k) => /^sb-.*-auth-token/.test(k) || k === 'supabase.auth.token')
      .forEach((k) => localStorage.removeItem(k));
  } catch (err) {
    console.error('Failed to purge stored Supabase session:', err);
  }
};
