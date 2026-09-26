import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  detectDeviceFamily,
  detectRuntimeCapabilities,
  detectRuntimePlatform,
  hasAndroidNativeBridge,
  isTauriRuntime,
  listenNative,
  nativeInvoke,
} from '../platform/runtime';
import {
  BROWSER_MATERIAL_ACCEPT,
  BROWSER_PHARMAEXAM_ACCEPT,
  hasPharmaExamExtension,
  isBrowserPharmaExamSelection,
} from '../platform/fileSelection';

const runtimeWindow = window as Window & {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
  PharmaTRACKAndroidKiosk?: unknown;
};

const originalAgent = navigator.userAgent;

function setUserAgent(value: string): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value });
}

describe('web runtime capability boundary', () => {
  beforeEach(() => {
    delete runtimeWindow.__TAURI__;
    delete runtimeWindow.__TAURI_INTERNALS__;
    delete runtimeWindow.PharmaTRACKAndroidKiosk;
    setUserAgent(originalAgent);
  });

  afterEach(() => {
    delete runtimeWindow.__TAURI__;
    delete runtimeWindow.__TAURI_INTERNALS__;
    delete runtimeWindow.PharmaTRACKAndroidKiosk;
    setUserAgent(originalAgent);
  });

  it('boots as web without Tauri and never calls a missing native API', async () => {
    expect(isTauriRuntime()).toBe(false);
    expect(hasAndroidNativeBridge()).toBe(false);
    expect(detectRuntimePlatform()).toBe('web');
    expect(detectRuntimeCapabilities().nativeHost).toBe(false);
    expect(await nativeInvoke('restart_application')).toBeUndefined();
    expect(await listenNative('native-event', () => undefined)).toBeUndefined();
  });

  it('reports PC native only when the Tauri bridge is present', () => {
    runtimeWindow.__TAURI_INTERNALS__ = {};
    expect(detectRuntimePlatform()).toBe('native-pc');
    expect(detectRuntimeCapabilities().nativeWebview).toBe(true);
  });

  it('keeps Android browser web-safe and detects the optional Android host bridge', () => {
    setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36');
    expect(detectDeviceFamily()).toBe('android');
    expect(detectRuntimePlatform()).toBe('web');

    runtimeWindow.PharmaTRACKAndroidKiosk = {};
    expect(detectRuntimePlatform()).toBe('android-native');
    expect(detectRuntimeCapabilities().nativeFileAssociation).toBe(true);
  });
});

describe('browser file selection', () => {
  it('offers explicit browser filters for study files and .pharmaexam packages', () => {
    expect(BROWSER_MATERIAL_ACCEPT).toContain('.pdf');
    expect(BROWSER_MATERIAL_ACCEPT).toContain('.docx');
    expect(BROWSER_MATERIAL_ACCEPT).toContain('.pptx');
    expect(BROWSER_MATERIAL_ACCEPT).toContain('image/*');
    expect(BROWSER_MATERIAL_ACCEPT).toContain('.txt');
    expect(BROWSER_PHARMAEXAM_ACCEPT).toContain('.pharmaexam');
  });

  it('identifies the extension without pretending the browser has a file association', () => {
    expect(hasPharmaExamExtension('exam.PHARMAEXAM')).toBe(true);
    expect(isBrowserPharmaExamSelection({ name: 'exam.pharmaexam' })).toBe(true);
    expect(hasPharmaExamExtension('exam.zip')).toBe(false);
  });
});
