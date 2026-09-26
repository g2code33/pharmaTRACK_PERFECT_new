import {
  createBrowserKioskAdapter,
  createCapabilityMatrix,
  type KioskAdapter,
  type KioskRestrictionPolicy,
  type KioskViolation,
} from './kioskAdapter';
import { createTauriKioskAdapter } from './nativeKiosk';
import {
  detectDeviceFamily,
  detectRuntimePlatform,
  hasAndroidNativeBridge,
  isIOSPWA,
  isIOSSafari,
} from '../platform/runtime';
import type { PlatformCapabilityMatrix, KioskPlatform } from './types';

/** Optional bridge implemented by the Android host. The web build never assumes it exists. */
export interface AndroidKioskBridge {
  enterLockTask?: () => Promise<boolean> | boolean;
  exitLockTask?: () => Promise<boolean> | boolean;
  setImmersiveMode?: (enabled: boolean) => Promise<boolean> | boolean;
  setScreenCaptureBlocked?: (blocked: boolean) => Promise<boolean> | boolean;
  restrictExternalIntents?: (restricted: boolean) => Promise<boolean> | boolean;
  /** Native Android intent boundary may hand a verified file byte array or base64 string to the web layer. */
  getPendingPharmaExam?: () =>
    | Promise<number[] | Uint8Array | string | undefined>
    | number[]
    | Uint8Array
    | string
    | undefined;
  onPharmaExamLaunch?: (handler: (bytes: number[] | Uint8Array | string) => void) => (() => void) | void;
  capabilityStatus?: () =>
    | Promise<Partial<Record<string, boolean>>>
    | Partial<Record<string, boolean>>
    | string;
}

function toUint8Array(data: string | number[] | Uint8Array | undefined): Uint8Array | undefined {
  if (!data) return undefined;
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(data);
  if (typeof data === 'string') {
    try {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      return new TextEncoder().encode(data);
    }
  }
  return undefined;
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
  const remove = bridge.onPharmaExamLaunch?.((pending) => {
    const bytes = toUint8Array(pending);
    if (bytes) onBytes(bytes);
  });
  if (bridge.getPendingPharmaExam) {
    const pending = await bridge.getPendingPharmaExam();
    const bytes = toUint8Array(pending);
    if (bytes) onBytes(bytes);
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
  if (bridge?.setScreenCaptureBlocked) {
    const screenCapture = matrix.capabilities.find(
      (item) => item.id === 'screen-capture-restriction',
    );
    if (screenCapture) {
      screenCapture.supported = true;
      screenCapture.enforceable = true;
      screenCapture.detected = true;
      screenCapture.supportLevel = 'SUPPORTED';
      screenCapture.notes = 'Android WindowManager.LayoutParams.FLAG_SECURE blocks screenshots and screen recording.';
    }
    const screenRecording = matrix.capabilities.find(
      (item) => item.id === 'screen-recording-restriction',
    );
    if (screenRecording) {
      screenRecording.supported = true;
      screenRecording.enforceable = true;
      screenRecording.detected = true;
      screenRecording.supportLevel = 'SUPPORTED';
      screenRecording.notes = 'Android WindowManager.LayoutParams.FLAG_SECURE blocks screen recording.';
    }
  }
  if (bridge?.capabilityStatus) {
    let rawStatus = await bridge.capabilityStatus();
    if (typeof rawStatus === 'string') {
      try {
        rawStatus = JSON.parse(rawStatus);
      } catch {
        rawStatus = {};
      }
    }
    const status = rawStatus as Record<string, boolean>;
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

  const onBackBlocked = (event: Event) => {
    const detail =
      (event as CustomEvent<string>).detail ||
      'Hardware back button navigation was prevented by the Android kiosk bridge.';
    onViolation({
      violation: 'ATTEMPTED_NAVIGATION',
      detail,
      prevented: true,
    });
  };

  const onExternalLinkBlocked = (event: Event) => {
    const detail =
      (event as CustomEvent<string>).detail ||
      'External navigation was blocked by the Android kiosk webview client.';
    onViolation({
      violation: 'EXTERNAL_LINK_ATTEMPT',
      detail,
      prevented: true,
    });
  };

  return {
    matrix,
    install: () => {
      const cleanup = browser.install();
      if (typeof window !== 'undefined') {
        window.addEventListener('pharmatrack:back-blocked', onBackBlocked);
        window.addEventListener('pharmatrack:external-link-blocked', onExternalLinkBlocked);
      }
      return () => {
        if (typeof window !== 'undefined') {
          window.removeEventListener('pharmatrack:back-blocked', onBackBlocked);
          window.removeEventListener('pharmatrack:external-link-blocked', onExternalLinkBlocked);
        }
        cleanup();
        void bridge?.exitLockTask?.();
      };
    },
    enterSecureMode: async (_attemptId: string) => {
      const lockTask = bridge?.enterLockTask ? await bridge.enterLockTask() : true;
      const immersive = bridge?.setImmersiveMode ? await bridge.setImmersiveMode(true) : true;
      if (bridge?.setScreenCaptureBlocked) await bridge.setScreenCaptureBlocked(true);
      if (bridge?.restrictExternalIntents) await bridge.restrictExternalIntents(true);
      return Boolean(lockTask && immersive);
    },
    exitSecureMode: async () => {
      const exitLock = bridge?.exitLockTask ? await bridge.exitLockTask() : true;
      if (bridge?.setImmersiveMode) await bridge.setImmersiveMode(false);
      if (bridge?.setScreenCaptureBlocked) await bridge.setScreenCaptureBlocked(false);
      if (bridge?.restrictExternalIntents) await bridge.restrictExternalIntents(false);
      return Boolean(exitLock);
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
  const platformKind: KioskPlatform = isIOSPWA()
    ? 'IOS_PWA'
    : isIOSSafari()
      ? 'IOS_SAFARI'
      : detectDeviceFamily() === 'android'
        ? 'ANDROID_WEB'
        : 'web';
  return createBrowserKioskAdapter(onViolation, requiredIds, policy, platformKind);
}
