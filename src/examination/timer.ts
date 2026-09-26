import type { AttemptTimerState, TimerAdjustment } from './types';

export function createAttemptTimer(
  durationMinutes: number,
  authoritativeStartedAt: string,
  authorityEpoch = 1,
): AttemptTimerState {
  const started = new Date(authoritativeStartedAt).getTime();
  const deadline = new Date(started + durationMinutes * 60_000).toISOString();
  return {
    originalDurationMinutes: durationMinutes,
    authoritativeStartedAt,
    authoritativeDeadlineAt: deadline,
    lastAuthorityAt: authoritativeStartedAt,
    authorityEpoch,
    accumulatedPauseMilliseconds: 0,
    adjustments: [],
  };
}

export function remainingMilliseconds(timer: AttemptTimerState, authoritativeNow: string): number {
  const now = new Date(authoritativeNow).getTime();
  const deadline = new Date(timer.authoritativeDeadlineAt).getTime();
  if (timer.pausedAt) return Math.max(0, deadline - new Date(timer.pausedAt).getTime());
  return Math.max(0, deadline - now);
}

export function pauseAttemptTimer(
  timer: AttemptTimerState,
  authoritativeAt: string,
): AttemptTimerState {
  if (timer.pausedAt) return { ...timer, lastAuthorityAt: authoritativeAt };
  return { ...timer, pausedAt: authoritativeAt, lastAuthorityAt: authoritativeAt };
}

export function resumeAttemptTimer(
  timer: AttemptTimerState,
  authoritativeAt: string,
): AttemptTimerState {
  if (!timer.pausedAt) return { ...timer, lastAuthorityAt: authoritativeAt };
  const pausedFor = Math.max(
    0,
    new Date(authoritativeAt).getTime() - new Date(timer.pausedAt).getTime(),
  );
  return {
    ...timer,
    pausedAt: undefined,
    accumulatedPauseMilliseconds: timer.accumulatedPauseMilliseconds + pausedFor,
    authoritativeDeadlineAt: new Date(
      new Date(timer.authoritativeDeadlineAt).getTime() + pausedFor,
    ).toISOString(),
    lastAuthorityAt: authoritativeAt,
  };
}

export function adjustAttemptTimer(
  timer: AttemptTimerState,
  minutes: number,
  adminId: string,
  reason: string,
  authoritativeAt: string,
): AttemptTimerState {
  const previousDeadlineAt = timer.authoritativeDeadlineAt;
  const newDeadlineAt = new Date(
    new Date(previousDeadlineAt).getTime() + minutes * 60_000,
  ).toISOString();
  const adjustment: TimerAdjustment = {
    id: `${adminId}:${authoritativeAt}:${timer.adjustments.length + 1}`,
    minutes,
    at: authoritativeAt,
    adminId,
    reason,
    previousDeadlineAt,
    newDeadlineAt,
  };
  return {
    ...timer,
    authoritativeDeadlineAt: newDeadlineAt,
    lastAuthorityAt: authoritativeAt,
    adjustments: [...timer.adjustments, adjustment],
  };
}

export function timerFromLegacyAttempt(
  startedAt: string,
  deadlineAt: string,
  durationMinutes: number,
  authorityEpoch = 1,
): AttemptTimerState {
  return {
    originalDurationMinutes: durationMinutes,
    authoritativeStartedAt: startedAt,
    authoritativeDeadlineAt: deadlineAt,
    lastAuthorityAt: startedAt,
    authorityEpoch,
    accumulatedPauseMilliseconds: 0,
    adjustments: [],
  };
}
