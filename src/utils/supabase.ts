import { createClient } from '@supabase/supabase-js';

// Only the public/publishable Supabase client key belongs in a browser build.
// Service-role and database credentials must remain in Supabase server-side
// functions/configuration and are never read by this module.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://ltpwedxcvbejiywmwrwc.supabase.co';
const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_VYF1gRvyI3EMCfon1hHK4A_vbWgPknx';

const supabaseHost = (() => {
  try {
    return new URL(supabaseUrl).host;
  } catch {
    return '';
  }
})();

let supabaseCircuitUntil = 0;
let supabaseCircuitWarnedAt = 0;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isSupabaseRequest(input: RequestInfo | URL): boolean {
  if (!supabaseHost) return false;
  try {
    return new URL(requestUrl(input)).host === supabaseHost;
  } catch {
    return false;
  }
}

function offlineResponse(status = 503): Response {
  return new Response(
    JSON.stringify({
      error: 'pharmatrack_offline',
      message: 'PharmaTRACK is using local data because Supabase is currently unreachable.',
    }),
    {
      status,
      headers: {
        'content-type': 'application/json',
        'x-pharmatrack-offline': '1',
      },
    },
  );
}

function markSupabaseUnreachable(): void {
  const now = Date.now();
  supabaseCircuitUntil = now + 60_000;
  // One warning per minute is enough context for debugging without flooding the
  // WebView console while auth refresh/profile sync retries in the background.
  if (now - supabaseCircuitWarnedAt > 60_000) {
    supabaseCircuitWarnedAt = now;
    console.warn(
      'Supabase is unreachable right now. PharmaTRACK will continue in local-first mode and retry later.',
    );
  }
}

async function resilientSupabaseFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (isSupabaseRequest(input)) {
    const now = Date.now();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return offlineResponse();
    }
    if (supabaseCircuitUntil > now) {
      return offlineResponse();
    }
  }

  try {
    return await fetch(input, init);
  } catch (err) {
    if (isSupabaseRequest(input)) {
      markSupabaseUnreachable();
      return offlineResponse();
    }
    throw err;
  }
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: {
    fetch: resilientSupabaseFetch,
  },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // PKCE works with HashRouter because the OAuth code stays in the query
    // string while the application route remains in the hash.
    flowType: 'pkce',
  },
});

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
