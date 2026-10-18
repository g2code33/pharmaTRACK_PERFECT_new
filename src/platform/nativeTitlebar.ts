/**
 * Keeps the desktop window's decorations in step with the app's own title bar.
 *
 * The desktop windows are created undecorated so Windows and Linux look
 * identical, which means the app's own strip provides the only minimize,
 * maximize and close buttons. If a screen does not draw that strip the window
 * would have no controls at all, so the app tells the native side whenever its
 * title bar appears or disappears and the native side puts the system title
 * bar back whenever it is absent.
 *
 * Disappearance is debounced because route changes unmount one title bar and
 * mount the next one in the same tick; without it the system bar would flash
 * on every navigation.
 */
import { isTauriRuntime, nativeInvoke } from './runtime';

const HIDE_DEBOUNCE_MS = 450;

let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let reported: boolean | undefined;

function apply(custom: boolean): void {
  if (reported === custom) return;
  reported = custom;
  void nativeInvoke('set_native_titlebar', { custom });
}

/** Called by the title bar component as it mounts (true) and unmounts (false). */
export function reportNativeTitlebar(custom: boolean): void {
  if (!isTauriRuntime()) return;
  if (pendingTimer !== undefined) {
    clearTimeout(pendingTimer);
    pendingTimer = undefined;
  }
  if (custom) {
    apply(true);
    return;
  }
  pendingTimer = setTimeout(() => {
    pendingTimer = undefined;
    apply(false);
  }, HIDE_DEBOUNCE_MS);
}

/** Test seam: forgets what was last reported. */
export function resetNativeTitlebarReportingForTests(): void {
  if (pendingTimer !== undefined) clearTimeout(pendingTimer);
  pendingTimer = undefined;
  reported = undefined;
}
