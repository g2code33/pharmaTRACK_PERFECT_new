import { isTauriRuntime } from '../platform/runtime';

/**
 * Copy text without ever falling back to a native dialog.
 *
 * `navigator.clipboard` is missing or rejects with NotAllowedError inside the
 * desktop shells (tauri://localhost is not a secure context for every webview)
 * and in some Android WebViews, which used to surface as the native
 * "The request is not allowed by the user agent or the platform" error box.
 * The textarea + execCommand path still works in those runtimes.
 */
export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  if (!text) return false;

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy copy path below.
    }
  }

  if (typeof document === 'undefined') return false;

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'true');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '-9999px';
    area.style.opacity = '0';
    document.body.appendChild(area);

    const selection = document.getSelection();
    const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);

    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }

    area.remove();
    if (selection && previousRange) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    return copied;
  } catch {
    return false;
  }
};

/**
 * The Web Share API is only used where it really works. Desktop webviews
 * expose `navigator.share` and then reject it with NotAllowedError, so the
 * share sheet is reserved for phones and tablets in a normal browser.
 */
export const canUseWebShare = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  if (typeof (navigator as Navigator & { share?: unknown }).share !== 'function') return false;
  if (isTauriRuntime()) return false;
  return true;
};

export type ShareLinkResult = 'shared' | 'copied' | 'cancelled' | 'manual';

/**
 * Hand a link to the system share sheet when that is possible, copy it when it
 * is not, and report `manual` so the caller can show the link for a manual
 * copy instead of raising a browser dialog.
 */
export const shareOrCopyLink = async (options: {
  url: string;
  title?: string;
  text?: string;
}): Promise<ShareLinkResult> => {
  const { url, title, text } = options;

  if (canUseWebShare()) {
    try {
      await (navigator as Navigator & {
        share: (data: { title?: string; text?: string; url: string }) => Promise<void>;
      }).share({ title, text, url });
      return 'shared';
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
      // NotAllowedError and friends simply mean this runtime cannot share.
    }
  }

  return (await copyTextToClipboard(url)) ? 'copied' : 'manual';
};
