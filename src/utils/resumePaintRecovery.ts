/**
 * Resume-from-background paint recovery.
 *
 * Some Android/PWA/desktop WebViews come back from being hidden (switched
 * away from, minimized, or left idle) with a stale or genuinely blank GPU
 * surface: the app is still running, but the compositor has nothing valid to
 * show until something forces a fresh paint. An earlier fix nudged the page
 * to repaint on resume, which fixed the Linux desktop build getting
 * permanently stuck blank — but during the brief window before that repaint
 * actually lands, the user still sees whatever the stale/blank surface was
 * already showing: a visible flash of blank content before the app reappears.
 *
 * This installs an opaque cover — matching the app's current theme
 * background — the instant a resume is detected, and only removes it once a
 * real frame has actually been drawn underneath (or after a hard timeout).
 * The flash becomes a seamless continuation of the themed background instead
 * of a blank or stale frame for a few hundred milliseconds.
 *
 * Pulled out of the App component so the timing/DOM logic can be unit tested
 * without mounting the rest of the app.
 */

export const RESUME_COVER_ID = 'pharmatrack-resume-cover';
export const RESUME_EVENT = 'pharmatrack:resume';

const SETTLE_MS = 600;
const NUDGE_A_MS = 90;
const NUDGE_B_MS = 260;
const GUARD_MS = 1200;

const DEFAULT_LIGHT_BG = '#F8FAFC';
const DEFAULT_DARK_BG = '#0f172a';

function isUsableColor(value: string): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== 'transparent' && normalized !== 'rgba(0, 0, 0, 0)';
}

/** Creates (once) and returns the full-viewport resume cover element. */
export function getResumeCover(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null;
  let cover = document.getElementById(RESUME_COVER_ID) as HTMLDivElement | null;
  if (!cover) {
    cover = document.createElement('div');
    cover.id = RESUME_COVER_ID;
    cover.setAttribute('aria-hidden', 'true');
    cover.style.position = 'fixed';
    cover.style.inset = '0';
    cover.style.zIndex = '2147483647';
    // Purely visual — never intercepts input, so a bug here can never trap
    // the user behind an invisible blocking layer.
    cover.style.pointerEvents = 'none';
    cover.style.display = 'none';
    (document.body || document.documentElement).appendChild(cover);
  }
  return cover;
}

/**
 * Shows the cover using whatever background color the app is actually
 * rendering right now (so it matches light or dark mode), falling back to
 * the known light/dark defaults if the computed value is unusable (e.g. a
 * test environment with no real layout/paint).
 */
export function showResumeCover(): void {
  const cover = getResumeCover();
  if (!cover) return;
  let computed = '';
  try {
    computed = window.getComputedStyle(document.body).backgroundColor;
  } catch {
    computed = '';
  }
  const isDark = document.documentElement.classList.contains('dark');
  cover.style.backgroundColor = isUsableColor(computed)
    ? computed
    : isDark
      ? DEFAULT_DARK_BG
      : DEFAULT_LIGHT_BG;
  cover.style.display = 'block';
}

export function hideResumeCover(): void {
  if (typeof document === 'undefined') return;
  const cover = document.getElementById(RESUME_COVER_ID);
  if (cover) cover.style.display = 'none';
}

/**
 * Installs the resume-paint recovery listeners and returns a cleanup
 * function.
 */
export function installResumePaintRecovery(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  let settleTimer: number | undefined;
  let guardTimer: number | undefined;
  let nudgeTimerA: number | undefined;
  let nudgeTimerB: number | undefined;
  let firstFrame: number | undefined;
  let secondFrame: number | undefined;

  const cancelFrames = () => {
    if (firstFrame !== undefined) window.cancelAnimationFrame(firstFrame);
    if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
    firstFrame = undefined;
    secondFrame = undefined;
  };
  const cancelNudges = () => {
    window.clearTimeout(nudgeTimerA);
    window.clearTimeout(nudgeTimerB);
    nudgeTimerA = undefined;
    nudgeTimerB = undefined;
  };

  /** Forces a fresh rasterisation of the root layer and nudges the viewers. */
  const forceSurfaceRefresh = () => {
    const root = document.getElementById('root');
    if (!root) return;
    // Dropping the compositing layer and immediately re-creating it forces
    // the webview to rasterise this content into a NEW texture. Re-applying
    // the same translateZ(0) on its own is a no-op the compositor is free to
    // skip, which is why a lost/blank surface could survive the old version
    // of this recovery (the Linux desktop build's black screen on resume).
    document.documentElement.classList.add('pharmatrack-resume-paint');
    root.style.transform = 'none';
    root.getBoundingClientRect();
    root.style.transform = 'translateZ(0)';
    // Opacity marks the layer's contents dirty without affecting layout, and
    // unlike a filter it does not become a containing block for the app's
    // fixed headers, so nothing shifts while it is applied.
    root.style.opacity = '0.999';
    root.getBoundingClientRect();
    window.dispatchEvent(new CustomEvent(RESUME_EVENT));
  };

  /** True once the root actually has something real to show. */
  const hasRealContent = (root: HTMLElement) => {
    if (!root.childElementCount) return false;
    const style = window.getComputedStyle(root);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };

  const repaint = () => {
    const root = document.getElementById('root');
    if (!root) return;
    window.clearTimeout(settleTimer);
    window.clearTimeout(guardTimer);
    cancelFrames();
    cancelNudges();

    // Cover whatever the compositor is currently showing — stale content or
    // genuinely blank — before doing anything else, so the gap before a real
    // frame lands reads as "themed background" rather than "blank flash".
    showResumeCover();
    forceSurfaceRefresh();

    const restore = () => {
      // If the root still has nothing real to show, uncovering it now would
      // recreate exactly the blank flash this is meant to prevent. Leave the
      // cover up — the nudges and the hard guard timeout below are still
      // running and will either produce real content or reload.
      if (!hasRealContent(root)) return;
      root.style.transform = '';
      root.style.opacity = '';
      document.documentElement.classList.remove('pharmatrack-resume-paint');
      hideResumeCover();
      window.clearTimeout(settleTimer);
      window.clearTimeout(guardTimer);
      cancelFrames();
      // If the surface already drew cleanly there is nothing left to nudge.
      cancelNudges();
    };

    // Release on the frame after the repaint actually lands rather than
    // after a fixed delay, so the window is back to normal as soon as it is
    // drawn.
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(restore);
    });
    // Frames are not delivered to a window that is still unmapped; the timer
    // guarantees the styles — and the cover — never get stuck on.
    settleTimer = window.setTimeout(restore, SETTLE_MS);

    // Some WebViews discard the very first frame after resume, so the single
    // refresh above never becomes pixels and the window stays blank until
    // something else draws. Two extra nudges inside the first quarter second
    // — while the document is actually visible — make the surface recover
    // immediately instead of "blank for a moment, then it snaps back". The
    // cover is already up for the whole span, so neither nudge is visible.
    nudgeTimerA = window.setTimeout(() => {
      if (document.visibilityState === 'visible') forceSurfaceRefresh();
    }, NUDGE_A_MS);
    nudgeTimerB = window.setTimeout(() => {
      if (document.visibilityState === 'visible') forceSurfaceRefresh();
    }, NUDGE_B_MS);

    guardTimer = window.setTimeout(() => {
      if (!hasRealContent(root)) {
        // Still nothing after 1.2s of trying — the cover stays up (instead
        // of being cleared first) so the reload's own blank instant is
        // masked for as long as the outgoing document survives.
        window.location.reload();
      } else {
        // Content is there after all (a slow settle) — stop covering it.
        root.style.transform = '';
        root.style.opacity = '';
        document.documentElement.classList.remove('pharmatrack-resume-paint');
        hideResumeCover();
      }
    }, GUARD_MS);
  };

  const onVisible = () => { if (document.visibilityState === 'visible') repaint(); };
  window.addEventListener('pageshow', repaint);
  window.addEventListener('focus', repaint);
  document.addEventListener('visibilitychange', onVisible);
  // The native shell fires this from the Rust side on every platform
  // (WebKitGTK and the Android WebView alike): a webview can come back with
  // a blank surface without ever delivering a focus event to the page, which
  // is how the window ends up blank after switching away.
  window.addEventListener('pharmatrack:native-resume', repaint);

  return () => {
    window.clearTimeout(settleTimer);
    window.clearTimeout(guardTimer);
    cancelFrames();
    cancelNudges();
    hideResumeCover();
    window.removeEventListener('pageshow', repaint);
    window.removeEventListener('focus', repaint);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pharmatrack:native-resume', repaint);
  };
}
