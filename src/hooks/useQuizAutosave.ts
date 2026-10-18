import { useEffect, useRef } from 'react';

const DEFAULT_DELAY_MS = 400;

/**
 * Keeps an in-progress quiz attempt on the device at all times.
 *
 * Saving only when the component unmounts loses everything on a refresh, an
 * app kill or a crash, so the snapshot is written shortly after every change
 * and flushed immediately whenever the page can disappear (tab hidden, app
 * backgrounded, reload, navigation). Identical snapshots are skipped so a
 * long quiz never writes the same payload twice.
 *
 * Pass `null` while nothing should be saved (quiz not started, already
 * submitted, or explicitly paused) and the hook stays completely idle.
 */
export function useQuizAutosave<T>(
  snapshot: T | null,
  persist: (snapshot: T, serialized: string) => void,
  options: { delayMs?: number } = {},
): void {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const snapshotRef = useRef<T | null>(snapshot);
  const persistRef = useRef(persist);
  const lastSerializedRef = useRef<string | null>(null);

  snapshotRef.current = snapshot;
  persistRef.current = persist;

  const flush = useRef(() => {
    const current = snapshotRef.current;
    if (current === null || current === undefined) return;
    let serialized: string;
    try {
      serialized = JSON.stringify(current);
    } catch {
      return;
    }
    if (serialized === lastSerializedRef.current) return;
    lastSerializedRef.current = serialized;
    persistRef.current(current, serialized);
  });

  // Debounced write: typing or tapping through questions saves a moment later
  // instead of on every keystroke.
  useEffect(() => {
    if (snapshot === null || snapshot === undefined) return undefined;
    if (typeof window === 'undefined') return undefined;
    const timer = window.setTimeout(() => flush.current(), delayMs);
    return () => window.clearTimeout(timer);
  }, [snapshot, delayMs]);

  // Immediate write whenever this page may be about to go away.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const flushNow = () => flush.current();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushNow();
    };
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      flushNow();
    };
  }, []);
}
