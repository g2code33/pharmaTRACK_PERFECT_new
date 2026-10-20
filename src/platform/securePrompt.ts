import { nativeInvoke } from './runtime';

/**
 * A `window.prompt()` wrapped with a notice to the native host (a no-op
 * outside Tauri) that this focus change was caused on purpose by the app
 * itself, not an attempt to leave the secure exam. The native secure-exam
 * focus-loss handler briefly suppresses its own aggressive
 * fullscreen/focus re-assertion while this is open, so it never fights the
 * dialog for input focus — the lock itself (window close/app-switch
 * suppression) is unaffected either way.
 */
export async function secureWindowPrompt(message: string): Promise<string | null> {
  await nativeInvoke('begin_native_dialog');
  try {
    return window.prompt(message);
  } finally {
    await nativeInvoke('end_native_dialog');
  }
}
