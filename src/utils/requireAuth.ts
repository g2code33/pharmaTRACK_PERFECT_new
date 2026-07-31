import { supabase } from './supabase';

/**
 * Gate for the handful of features that genuinely need the cloud.
 *
 * PharmaTRACK is offline-first: courses, slides, notes and progress all live in
 * localStorage + IndexedDB and must keep working with no account and no
 * internet. Only sync/backup actually needs an account, so instead of blocking
 * the whole app behind a login wall, those few call sites ask here first.
 *
 * Returns the signed-in user, or null if the action can't proceed. When it
 * returns null it has already explained why to the user.
 */
export type AuthGateResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'offline' | 'signed-out' };

/**
 * Checks whether a cloud action can run right now.
 *
 * Deliberately does NOT throw: callers treat a failure as "skip the cloud part,
 * carry on locally", which is the whole point of the offline-first model.
 */
export const checkCloudAccess = async (): Promise<AuthGateResult> => {
  if (!navigator.onLine) return { ok: false, reason: 'offline' };

  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return { ok: false, reason: 'signed-out' };

  return { ok: true, userId: session.user.id };
};

/** Wording shared by every cloud action, so the promise to the user is consistent. */
export const CLOUD_MESSAGES = {
  offline:
    "You're offline right now.\n\nThis feature needs internet. Your work is safely saved on this device and nothing has been lost.",
  signedOut:
    'Sign in to sync this to the cloud.\n\nYour courses, slides and notes are already saved on this device — signing in just adds a backup you can restore on another computer.\n\nSign in now?',
} as const;

/**
 * Runs a cloud action if possible, otherwise explains why not.
 *
 * @param action     what to do once we know we have a signed-in, online user
 * @param onSignIn   called if the user chooses to sign in (navigate to /login)
 * @returns          true if the action ran
 */
export const withCloudAccess = async (
  action: (userId: string) => Promise<void>,
  onSignIn: () => void,
): Promise<boolean> => {
  const access = await checkCloudAccess();

  if (access.ok === false) {
    if (access.reason === 'offline') {
      window.alert(CLOUD_MESSAGES.offline);
    } else if (window.confirm(CLOUD_MESSAGES.signedOut)) {
      onSignIn();
    }
    return false;
  }

  await action(access.userId);
  return true;
};
