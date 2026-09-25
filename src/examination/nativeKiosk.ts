import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  createBrowserKioskAdapter,
  createCapabilityMatrix,
  KIOSK_CAPABILITY_IDS,
  type KioskAdapter,
  type KioskRestrictionPolicy,
  type KioskViolation,
} from './kioskAdapter';
import type { PlatformCapability, PlatformCapabilityMatrix } from './types';

const NATIVE_EVENT = 'pharmatrack://secure-exam-native-event';

interface NativeSecureExamSession {
  sessionToken: string;
  capabilities: PlatformCapability[];
}

interface NativeSecureExamEvent {
  kind:
    | 'focus_lost'
    | 'focus_restored'
    | 'close_blocked'
    | 'navigation_blocked'
    | 'external_link_blocked'
    | 'window_state_blocked';
  detail: string;
}

/** Tauri's global is intentionally feature-detected so the web build stays a normal web app. */
export async function consumePharmaExamLaunches(
  onPath: (path: string) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  let unlisten: UnlistenFn | undefined;
  try {
    unlisten = await listen<string[] | string>('pharmaexam-file-opened', (event) => {
      const paths = Array.isArray(event.payload) ? event.payload : [event.payload];
      paths.filter((path) => path.toLowerCase().endsWith('.pharmaexam')).forEach(onPath);
    });
    const pending = await invoke<string[]>('get_pending_pharmaexam_files');
    pending
      .filter((path) => path.toLowerCase().endsWith('.pharmaexam'))
      .forEach(onPath);
  } catch {
    // The web build and older native hosts simply have no external-file route.
  }
  return () => unlisten?.();
}

export async function readPharmaExamLaunch(path: string): Promise<Uint8Array> {
  const bytes = await invoke<number[]>('read_pharmaexam_file', { path });
  return new Uint8Array(bytes);
}

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const candidate = window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(candidate.__TAURI__ || candidate.__TAURI_INTERNALS__);
}

function nativeMatrix(requiredIds: string[]): PlatformCapabilityMatrix {
  const matrix = createCapabilityMatrix('TAURI_PC', requiredIds);
  const set = (
    id: string,
    values: Partial<Pick<PlatformCapability, 'supported' | 'enforceable' | 'detected' | 'supportLevel' | 'notes'>>,
  ) => {
    const capability = matrix.capabilities.find((item) => item.id === id);
    if (capability) Object.assign(capability, values);
  };

  set(KIOSK_CAPABILITY_IDS.devTools, {
    supported: true,
    enforceable: true,
    detected: true,
    supportLevel: 'SUPPORTED',
    notes:
      'Native command authorization denies the Tauri devtools command while secure mode is active; OS-level debugging tools are outside the application boundary.',
  });
  set(KIOSK_CAPABILITY_IDS.windowControls, {
    supported: true,
    enforceable: true,
    detected: true,
    supportLevel: 'PARTIAL',
    notes:
      'The native host disables resize, minimize, maximize, decorations, and close through the strongest Tauri window APIs available; task switching and OS termination are not guaranteed.',
  });
  set(KIOSK_CAPABILITY_IDS.immersive, {
    supported: true,
    enforceable: true,
    detected: true,
    supportLevel: 'PARTIAL',
    notes:
      'Native fullscreen is requested and restored by Tauri; operating-system shortcuts or another desktop session can still escape it.',
  });
  set(KIOSK_CAPABILITY_IDS.focus, {
    supported: true,
    enforceable: false,
    detected: true,
    supportLevel: 'NOT_GUARANTEED',
    notes:
      'Native focus events are recorded for review; losing focus is observable, not proof of misconduct.',
  });
  set(KIOSK_CAPABILITY_IDS.screenCapture, {
    supported: false,
    enforceable: false,
    detected: true,
    supportLevel: 'NOT_GUARANTEED',
    notes:
      'Tauri does not provide a portable OS screenshot or capture-prevention guarantee.',
  });
  set(KIOSK_CAPABILITY_IDS.lockTask, {
    supported: false,
    enforceable: false,
    detected: true,
    supportLevel: 'NOT_GUARANTEED',
    notes:
      'PC desktop task-switching and operating-system lockdown are not claimed; use a managed OS policy if required.',
  });
  set(KIOSK_CAPABILITY_IDS.fileAssociation, {
    supported: true,
    enforceable: true,
    detected: true,
    supportLevel: 'SUPPORTED',
    notes:
      'The Tauri bundle registers .pharmaexam and the native startup queue passes only that extension to the Kiosk route.',
  });
  return matrix;
}

/**
 * Tauri adapter: browser event prevention remains active, while the native host
 * owns the secure window session and vetoes application close requests.
 */
export function createTauriKioskAdapter(
  onViolation: (event: KioskViolation) => void,
  requiredIds: string[] = [],
  policy: KioskRestrictionPolicy = {},
): KioskAdapter {
  const browser = createBrowserKioskAdapter(onViolation, requiredIds, policy);
  const matrix = nativeMatrix(requiredIds);
  let sessionToken: string | undefined;
  let unlisten: UnlistenFn | undefined;
  let disposed = false;

  return {
    matrix,
    install: () => {
      const cleanupBrowser = browser.install();
      disposed = false;
      void listen<NativeSecureExamEvent>(NATIVE_EVENT, (event) => {
        const nativeEvent = event.payload;
        if (nativeEvent.kind === 'focus_lost') {
          onViolation({
            violation: 'FOCUS_LOST',
            detail: nativeEvent.detail,
            prevented: false,
          });
        } else if (nativeEvent.kind === 'focus_restored') {
          onViolation({
            violation: 'RECOVERY',
            detail: nativeEvent.detail,
            prevented: false,
          });
        } else if (nativeEvent.kind === 'navigation_blocked') {
          onViolation({
            violation: 'ATTEMPTED_NAVIGATION',
            detail: nativeEvent.detail,
            prevented: true,
          });
        } else if (nativeEvent.kind === 'external_link_blocked') {
          onViolation({
            violation: 'EXTERNAL_LINK_ATTEMPT',
            detail: nativeEvent.detail,
            prevented: true,
          });
        } else {
          onViolation({
            violation: nativeEvent.kind === 'close_blocked' ? 'ATTEMPTED_EXIT' : 'SUSPICIOUS_STATE_TRANSITION',
            detail: nativeEvent.detail,
            prevented: nativeEvent.kind === 'close_blocked',
          });
        }
      }).then((remove) => {
        if (disposed) remove();
        else unlisten = remove;
      }).catch(() => undefined);
      return () => {
        disposed = true;
        unlisten?.();
        unlisten = undefined;
        cleanupBrowser();
      };
    },
    enterSecureMode: async (attemptId: string) => {
      if (!attemptId.trim()) return false;
      try {
        const session = await invoke<NativeSecureExamSession>('enter_secure_exam_mode', {
          attemptId,
        });
        sessionToken = session.sessionToken;
        for (const nativeCapability of session.capabilities) {
          const local = matrix.capabilities.find((item) => item.id === nativeCapability.id);
          if (local) Object.assign(local, nativeCapability, { required: requiredIds.includes(local.id) });
        }
        return true;
      } catch (error) {
        onViolation({
          violation: 'SUSPICIOUS_STATE_TRANSITION',
          detail: `Native secure-exam entry was refused: ${error instanceof Error ? error.message : String(error)}`,
          prevented: true,
        });
        return false;
      }
    },
    exitSecureMode: async () => {
      if (!sessionToken) return false;
      const token = sessionToken;
      sessionToken = undefined;
      try {
        await invoke('exit_secure_exam_mode', { sessionToken: token });
        return true;
      } catch (error) {
        // Put the handle back so cleanup/recovery can retry rather than losing
        // the native restoration capability after a transient invoke failure.
        sessionToken = token;
        onViolation({
          violation: 'SUSPICIOUS_STATE_TRANSITION',
          detail: `Native secure-exam restoration failed: ${error instanceof Error ? error.message : String(error)}`,
          prevented: false,
        });
        return false;
      }
    },
    requestFullscreen: async () => Boolean(sessionToken),
  };
}