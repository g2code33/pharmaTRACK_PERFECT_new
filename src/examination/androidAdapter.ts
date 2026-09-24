import {
  createBrowserKioskAdapter,
  createCapabilityMatrix,
  type KioskAdapter,
  type KioskViolation,
} from './kioskAdapter';
import type { PlatformCapabilityMatrix } from './types';

/** Optional bridge implemented by the Android host. The web build never assumes it exists. */
export interface AndroidKioskBridge {
  enterLockTask?: () => Promise<boolean> | boolean;
  exitLockTask?: () => Promise<boolean> | boolean;
  setImmersiveMode?: (enabled: boolean) => Promise<boolean> | boolean;
  setScreenCaptureBlocked?: (blocked: boolean) => Promise<boolean> | boolean;
  restrictExternalIntents?: (restricted: boolean) => Promise<boolean> | boolean;
  capabilityStatus?: () =>
    Promise<Partial<Record<string, boolean>>> | Partial<Record<string, boolean>>;
}

function bridgeFromWindow(): AndroidKioskBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { PharmaTRACKAndroidKiosk?: AndroidKioskBridge })
    .PharmaTRACKAndroidKiosk;
}

/**
 * Android-specific controls are isolated here. A browser-only Android install
 * receives honest web capability reporting; an approved native host can expose
 * lock-task, immersive, capture, and intent controls through this bridge.
 */
export async function createAndroidKioskAdapter(
  onViolation: (event: KioskViolation) => void,
  requiredIds: string[] = [],
  bridge: AndroidKioskBridge | undefined = bridgeFromWindow(),
): Promise<KioskAdapter> {
  const matrix: PlatformCapabilityMatrix = createCapabilityMatrix(
    bridge ? 'ANDROID_NATIVE' : 'ANDROID_WEB',
    requiredIds,
  );
  if (bridge?.capabilityStatus) {
    const status = await bridge.capabilityStatus();
    for (const capability of matrix.capabilities) {
      if (status[capability.id] !== undefined) {
        capability.supported = Boolean(status[capability.id]);
        capability.enforceable = Boolean(status[capability.id]);
        capability.detected = true;
      }
    }
  }
  const browser = createBrowserKioskAdapter(onViolation, requiredIds);
  return {
    matrix,
    install: browser.install,
    requestFullscreen: async () => {
      const immersive = bridge?.setImmersiveMode ? await bridge.setImmersiveMode(true) : false;
      return immersive || browser.requestFullscreen();
    },
  };
}

export async function createPlatformKioskAdapter(
  onViolation: (event: KioskViolation) => void,
  requiredIds: string[] = [],
): Promise<KioskAdapter> {
  const isAndroid = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
  return isAndroid
    ? createAndroidKioskAdapter(onViolation, requiredIds)
    : {
        ...createBrowserKioskAdapter(onViolation, requiredIds),
      };
}
