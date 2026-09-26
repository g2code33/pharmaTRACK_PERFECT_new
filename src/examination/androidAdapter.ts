import {
  createBrowserKioskAdapter,
  createCapabilityMatrix,
  type KioskAdapter,
  type KioskRestrictionPolicy,
  type KioskViolation,
} from './kioskAdapter';
import { createTauriKioskAdapter } from './nativeKiosk';
import { detectDeviceFamily, detectRuntimePlatform, hasAndroidNativeBridge } from '../platform/runtime';
import type { PlatformCapabilityMatrix } from './types';

/** Optional bridge implemented by the Android host. The web build never assumes it exists. */
export interface AndroidKioskBridge {
  enterLockTask?: () => Promise<boolean> | boolean;
  exitLockTask?: () => Promise<boolean> | boolean;
  setImmersiveMode?: (enabled: boolean) => Promise<boolean> | boolean;
  setScreenCaptureBlocked?: (blocked: boolean) => Promise<boolean> | boolean;
  restrictExternalIntents?: (restricted: boolean) => Promise<boolean> | boolean;
  /** Native Android intent boundary may hand a verified file byte array to the web layer. */
  getPendingPharmaExam?: () => Promise<number[] | Uint8Array | undefined> | number[] | Uint8Array | undefined;
  onPharmaExamLaunch?: (handler: (bytes: number[] | Uint8Array) => void) => (() => void) | void;
  capabilityStatus?: () =>
    Promise<Partial<Record<string, boolean>>> | Partial<Record<string, boolean>>;
}

function bridgeFromWindow(): AndroidKioskBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { PharmaTRACKAndroidKiosk?: AndroidKioskBridge })
    .PharmaTRACKAndroidKiosk;
}

/**
 * Android intent delivery is deliberately optional. The browser cannot invent
 * an OS file association; an Android host must implement this bridge method.
 */
export async function consumeAndroidPharmaExamLaunch(
  onBytes: (bytes: Uint8Array) => void,
  bridge: AndroidKioskBridge | undefined = bridgeFromWindow(),
): Promise<() => void> {
  if (!bridge?.getPendingPharmaExam && !bridge?.onPharmaExamLaunch) return () => undefined;
  const remove = bridge.onPharmaExamLaunch?.((pending) =>
    onBytes(pending instanceof Uint8Array ? pending : new Uint8Array(pending)),
  );
  if (bridge.getPendingPharmaExam) {
    const pending = await bridge.getPendingPharmaExam();
    if (pending) onBytes(pending instanceof Uint8Array ? pending : new Uint8Array(pending));
  }
  return typeof remove === 'function' ? remove : () => undefined;
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
  policy: KioskRestrictionPolicy = {},
): Promise<KioskAdapter> {
  const matrix: PlatformCapabilityMatrix = createCapabilityMatrix(
    bridge ? 'ANDROID_NATIVE' : 'ANDROID_WEB',
    requiredIds,
  );
  const fileAssociation = matrix.capabilities.find(
    (item) => item.id === 'pharmaexam-file-association',
  );
  if (fileAssociation && (bridge?.getPendingPharmaExam || bridge?.onPharmaExamLaunch)) {
    fileAssociation.supported = true;
    fileAssociation.enforceable = true;
    fileAssociation.detected = true;
    fileAssociation.supportLevel = 'SUPPORTED';
    fileAssociation.notes = 'Android host intent delivery is exposed through PharmaTRACKAndroidKiosk.';
  }
  if (bridge?.capabilityStatus) {
    const status = await bridge.capabilityStatus();
    for (const capability of matrix.capabilities) {
      if (status[capability.id] !== undefined) {
        capability.supported = Boolean(status[capability.id]);
        capability.enforceable = Boolean(status[capability.id]);
        capability.supportLevel = status[capability.id] ? 'SUPPORTED' : 'UNAVAILABLE';
        capability.detected = true;
      }
    }
  }
  const browser = createBrowserKioskAdapter(onViolation, requiredIds, policy);
  return {
    matrix,
    install: () => {
      const cleanup = browser.install();
      return () => {
        cleanup();
        void bridge?.exitLockTask?.();
      };
    },
    requestFullscreen: async () => {
      const lockTask = bridge?.enterLockTask ? await bridge.enterLockTask() : false;
      const immersive = bridge?.setImmersiveMode ? await bridge.setImmersiveMode(true) : false;
      if (bridge?.setScreenCaptureBlocked) await bridge.setScreenCaptureBlocked(true);
      if (bridge?.restrictExternalIntents) await bridge.restrictExternalIntents(true);
      return lockTask || immersive || browser.requestFullscreen();
    },
  };
}

export async function createPlatformKioskAdapter(
  onViolation: (event: KioskViolation) => void,
  requiredIds: string[] = [],
  policy: KioskRestrictionPolicy = {},
): Promise<KioskAdapter> {
  const runtime = detectRuntimePlatform();
  if (runtime === 'native-pc') return createTauriKioskAdapter(onViolation, requiredIds, policy);
  if (runtime === 'android-native' || hasAndroidNativeBridge()) {
    return createAndroidKioskAdapter(onViolation, requiredIds, bridgeFromWindow(), policy);
  }
  return createBrowserKioskAdapter(onViolation, requiredIds, policy, 'web');
}
