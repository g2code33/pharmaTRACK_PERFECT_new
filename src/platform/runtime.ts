/**
 * Runtime capabilities shared by the web shell and examination adapters.
 *
 * This module is deliberately based on feature detection.  User-agent checks
 * are used only to describe the device family; a browser must never be treated
 * as a native host just because it is running on Android or desktop.
 */
export type RuntimePlatform = 'web' | 'native-pc' | 'android-native';
export type DeviceFamily = 'desktop' | 'android' | 'ios' | 'other';

export interface RuntimeCapabilities {
  platform: RuntimePlatform;
  device: DeviceFamily;
  /** True only when the native Tauri bridge is actually present. */
  nativeHost: boolean;
  /** The embedded desktop browser panel is a Tauri-only feature. */
  nativeWebview: boolean;
  /** Native OS file associations / Android intents are not browser features. */
  nativeFileAssociation: boolean;
  /** Browser APIs that the shared web examination adapter can use. */
  browserStorage: boolean;
  browserCrypto: boolean;
  browserFullscreen: boolean;
}

type RuntimeWindow = Window & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
  PharmaTRACKAndroidKiosk?: unknown;
};

function windowSnapshot(): RuntimeWindow | undefined {
  return typeof window === 'undefined' ? undefined : (window as RuntimeWindow);
}

export function isTauriRuntime(): boolean {
  const candidate = windowSnapshot();
  return Boolean(candidate?.__TAURI__ || candidate?.__TAURI_INTERNALS__);
}

export function hasAndroidNativeBridge(): boolean {
  return Boolean(windowSnapshot()?.PharmaTRACKAndroidKiosk);
}

export function detectDeviceFamily(): DeviceFamily {
  if (typeof navigator === 'undefined') return 'other';
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes('android')) return 'android';
  if (/iphone|ipad|ipod/.test(agent)) return 'ios';
  if (/windows|macintosh|linux|cros/.test(agent)) return 'desktop';
  return 'other';
}

export function detectRuntimePlatform(): RuntimePlatform {
  if (hasAndroidNativeBridge()) return 'android-native';
  if (isTauriRuntime()) return 'native-pc';
  return 'web';
}

/**
 * Return a stable capability snapshot for UI/reporting.  It is safe to call at
 * module load in a browser, jsdom, SSR pre-render, or a Tauri webview.
 */
export function detectRuntimeCapabilities(): RuntimeCapabilities {
  const platform = detectRuntimePlatform();
  const nativeHost = platform !== 'web';
  return {
    platform,
    device: detectDeviceFamily(),
    nativeHost,
    nativeWebview: platform === 'native-pc',
    nativeFileAssociation: platform !== 'web',
    browserStorage: typeof localStorage !== 'undefined' && typeof indexedDB !== 'undefined',
    browserCrypto: typeof crypto !== 'undefined' && Boolean(crypto.subtle),
    browserFullscreen:
      typeof document !== 'undefined' && typeof document.documentElement?.requestFullscreen === 'function',
  };
}

export const runtimeCapabilities = detectRuntimeCapabilities;

/**
 * Native operations are loaded only after a native bridge is detected.  This
 * keeps the regular web bundle usable when Tauri APIs are absent or blocked by
 * a browser content-security policy.
 */
export async function nativeInvoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | undefined> {
  if (!isTauriRuntime()) return undefined;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(command, args);
  } catch (error) {
    // Native features are optional from the web shell's point of view. Callers
    // can decide whether a failed command should be user-visible.
    console.warn(`Native command ${command} is unavailable`, error);
    return undefined;
  }
}

type NativeUnlisten = () => void;

export async function listenNative<T>(
  eventName: string,
  handler: (event: { payload: T }) => void,
): Promise<NativeUnlisten | undefined> {
  if (!isTauriRuntime()) return undefined;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen<T>(eventName, handler);
  } catch (error) {
    console.warn(`Native event ${eventName} is unavailable`, error);
    return undefined;
  }
}

export interface NativeUpdate {
  version: string;
  downloadAndInstall: (onEvent?: (event: unknown) => void) => Promise<void>;
}

export async function getApplicationVersion(fallback: string): Promise<string> {
  if (!isTauriRuntime()) return fallback;
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return fallback;
  }
}

export async function checkNativeUpdate(): Promise<NativeUpdate | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    return (await check()) as NativeUpdate | null;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function restartNativeApplication(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('restart_application');
    return true;
  } catch (error) {
    console.warn('Native restart is unavailable', error);
    return false;
  }
}
