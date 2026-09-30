type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type RequestIdleCallback = (
  cb: (deadline: IdleDeadlineLike) => void,
  opts?: { timeout?: number },
) => number;

export type BackgroundWorkOptions = {
  /** Wait this long before the first attempt. */
  delay?: number;
  /** Browser idle timeout / maximum age before timeout-aware work may run. */
  timeout?: number;
  /** Wait this long before re-checking after input or a short idle slice. */
  retryDelay?: number;
  /** Require this many milliseconds with no pointer/key/wheel/touch input. */
  quietWindowMs?: number;
  /** Minimum idle time slice required when the callback was not timed out. */
  minTimeRemaining?: number;
  /** Allow the callback to run after timeout even if the user recently interacted. */
  runWhenTimedOut?: boolean;
};

const INPUT_EVENTS = [
  'pointerdown',
  'pointermove',
  'mousedown',
  'keydown',
  'wheel',
  'touchstart',
  'touchmove',
  'scroll',
] as const;

const HIGH_FREQUENCY_INPUT_EVENTS = new Set<string>([
  'pointermove',
  'wheel',
  'touchmove',
  'scroll',
]);

const HIGH_FREQUENCY_INPUT_THROTTLE_MS = 120;
const ACTIVE_INPUT_CLASS = 'pharmatrack-input-active';
const ACTIVE_INPUT_HOLD_MS = 220;

let trackingStarted = false;
let lastInputAt = 0;
let activeInputTimer: number | undefined;

const now = () => Date.now();

const markActiveInput = () => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root.classList.contains(ACTIVE_INPUT_CLASS)) root.classList.add(ACTIVE_INPUT_CLASS);
  if (activeInputTimer !== undefined) window.clearTimeout(activeInputTimer);
  activeInputTimer = window.setTimeout(() => {
    root.classList.remove(ACTIVE_INPUT_CLASS);
    activeInputTimer = undefined;
  }, ACTIVE_INPUT_HOLD_MS);
};

const markInput = (event?: Event) => {
  const t = now();
  // Pointer/scroll/wheel events can fire dozens of times per second. The app
  // only needs to know that input happened recently, not every pixel delta;
  // throttling this global capture listener keeps it from becoming part of the
  // scroll/mouse-move cost on slower WebViews. We deliberately listen to
  // pointermove but not the duplicate mousemove event, so mouse movement still
  // delays background work without registering two global handlers per frame.
  if (event && HIGH_FREQUENCY_INPUT_EVENTS.has(event.type) && t - lastInputAt < HIGH_FREQUENCY_INPUT_THROTTLE_MS) return;
  lastInputAt = t;
  markActiveInput();
};

export const startInputTracking = (): void => {
  if (trackingStarted || typeof window === 'undefined') return;
  trackingStarted = true;
  const opts: AddEventListenerOptions = { passive: true, capture: true };
  for (const eventName of INPUT_EVENTS) {
    window.addEventListener(eventName, markInput, opts);
  }
};

export const hasRecentUserInput = (quietWindowMs = 1200): boolean => {
  startInputTracking();
  return lastInputAt > 0 && now() - lastInputAt < quietWindowMs;
};

export const isInputPending = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const scheduling = (navigator as Navigator & {
    scheduling?: { isInputPending?: (options?: { includeContinuous?: boolean }) => boolean };
  }).scheduling;
  try {
    return scheduling?.isInputPending?.({ includeContinuous: true }) === true;
  } catch {
    return false;
  }
};

const canRunBackgroundWork = (
  deadline: IdleDeadlineLike | undefined,
  options: Required<Pick<BackgroundWorkOptions, 'quietWindowMs' | 'minTimeRemaining' | 'runWhenTimedOut'>>,
): boolean => {
  const timedOut = deadline?.didTimeout === true;
  if (isInputPending()) return false;
  if (hasRecentUserInput(options.quietWindowMs) && !(timedOut && options.runWhenTimedOut)) return false;
  if (deadline && !timedOut && deadline.timeRemaining() < options.minTimeRemaining) return false;
  return true;
};

export const scheduleBackgroundWork = (
  callback: () => void,
  options: BackgroundWorkOptions = {},
): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  startInputTracking();

  const delay = options.delay ?? 0;
  const timeout = options.timeout ?? 5000;
  const retryDelay = options.retryDelay ?? 650;
  const quietWindowMs = options.quietWindowMs ?? 1200;
  const minTimeRemaining = options.minTimeRemaining ?? 12;
  const runWhenTimedOut = options.runWhenTimedOut ?? false;

  let cancelled = false;
  let timeoutId: number | undefined;
  let idleId: number | undefined;
  const startedAt = now();

  const ric = (window as unknown as { requestIdleCallback?: RequestIdleCallback }).requestIdleCallback;
  const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;

  const clearTimers = () => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    timeoutId = undefined;
    if (idleId !== undefined) cic?.(idleId);
    idleId = undefined;
  };

  const request = () => {
    if (cancelled) return;
    if (typeof ric === 'function') {
      idleId = ric(run, { timeout });
      return;
    }
    timeoutId = window.setTimeout(() => {
      run({ didTimeout: now() - startedAt >= timeout, timeRemaining: () => 50 });
    }, 0);
  };

  const retry = () => {
    if (cancelled) return;
    timeoutId = window.setTimeout(request, retryDelay);
  };

  function run(deadline?: IdleDeadlineLike) {
    if (cancelled) return;
    idleId = undefined;
    timeoutId = undefined;
    const timedOutDeadline = deadline
      ? { ...deadline, didTimeout: deadline.didTimeout || now() - startedAt >= timeout }
      : { didTimeout: now() - startedAt >= timeout, timeRemaining: () => 0 };
    if (!canRunBackgroundWork(timedOutDeadline, { quietWindowMs, minTimeRemaining, runWhenTimedOut })) {
      retry();
      return;
    }
    callback();
  }

  timeoutId = window.setTimeout(request, delay);

  return () => {
    cancelled = true;
    clearTimers();
  };
};

export const __testing = {
  markInput,
  trackedInputEvents: () => [...INPUT_EVENTS],
  resetInputTracking: () => {
    lastInputAt = 0;
    if (activeInputTimer !== undefined && typeof window !== 'undefined') window.clearTimeout(activeInputTimer);
    activeInputTimer = undefined;
    if (typeof document !== 'undefined') document.documentElement.classList.remove(ACTIVE_INPUT_CLASS);
  },
};
