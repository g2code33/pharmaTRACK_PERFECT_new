import type { KioskLifecycleState } from './types';

export interface SecureKioskState {
  /** Explicit application mode consumed by the central route gate. */
  mode: 'NORMAL' | 'SECURE_EXAM_ACTIVE';
  active: boolean;
  fullLockdown: boolean;
  /** Route prefixes blocked by administrator-selected controls. */
  blockedRoutes: string[];
  attemptId?: string;
  lifecycle: KioskLifecycleState;
}

type Listener = (state: SecureKioskState) => void;

const KIOSK_SESSION_KEY = 'pharmatrack_secure_exam_active_v1';

function restoredState(): SecureKioskState {
  try {
    if (typeof sessionStorage === 'undefined') throw new Error('session storage unavailable');
    const stored = JSON.parse(sessionStorage.getItem(KIOSK_SESSION_KEY) || 'null') as SecureKioskState | null;
    if (stored?.active && stored.attemptId)
      return {
        ...stored,
        mode: 'SECURE_EXAM_ACTIVE',
        blockedRoutes: stored.blockedRoutes || [],
        lifecycle: stored.lifecycle || 'ACTIVE',
      };
  } catch {
    // A browser without sessionStorage still gets the in-memory route gate.
  }
  return {
    mode: 'NORMAL',
    active: false,
    fullLockdown: false,
    blockedRoutes: [],
    lifecycle: 'NOT_ENTERED',
  };
}

let state: SecureKioskState = restoredState();
const listeners = new Set<Listener>();
let blockedNavigationHandler: ((path: string) => void) | undefined;

export function getSecureKioskState(): SecureKioskState {
  return state;
}

export function subscribeSecureKiosk(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

function publish(next: SecureKioskState): void {
  state = next;
  try {
    if (typeof sessionStorage !== 'undefined') {
      if (next.active) sessionStorage.setItem(KIOSK_SESSION_KEY, JSON.stringify(next));
      else sessionStorage.removeItem(KIOSK_SESSION_KEY);
    }
  } catch {
    // Route enforcement remains available in memory when storage is unavailable.
  }
  listeners.forEach((listener) => listener(state));
}

export function enterSecureKiosk(
  attemptId: string,
  fullLockdown: boolean,
  blockedRoutes: string[] = [],
): void {
  publish({
    mode: 'SECURE_EXAM_ACTIVE',
    active: true,
    fullLockdown,
    blockedRoutes,
    attemptId,
    lifecycle: 'ACTIVE',
  });
}

export function markSecureKioskSubmitting(): void {
  if (!state.active) return;
  publish({ ...state, lifecycle: 'SUBMITTING' });
}

export function releaseSecureKiosk(): void {
  if (!state.active) return;
  publish({ mode: 'NORMAL', active: false, fullLockdown: false, blockedRoutes: [], lifecycle: 'RELEASED' });
  blockedNavigationHandler = undefined;
}

export function recordBlockedKioskNavigation(path: string): void {
  blockedNavigationHandler?.(path);
}

export function onBlockedKioskNavigation(handler: (path: string) => void): () => void {
  blockedNavigationHandler = handler;
  return () => {
    if (blockedNavigationHandler === handler) blockedNavigationHandler = undefined;
  };
}
