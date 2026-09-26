import type { LanExamTransport } from './network';
import { chooseLatestAttempt } from './network';
import type { ExaminationRepository } from './service';
import type { ExamAnswer, StudentAttempt } from './types';

export type AnswerReconciliation = { winner: ExamAnswer; conflict: boolean; reason: string };

export function reconcileAnswer(local: ExamAnswer, incoming: ExamAnswer): AnswerReconciliation {
  if (local.eventId && incoming.eventId && local.eventId === incoming.eventId)
    return { winner: local, conflict: false, reason: 'Duplicate event is idempotent.' };
  if (incoming.revision > local.revision)
    return { winner: incoming, conflict: false, reason: 'Incoming answer has a newer revision.' };
  if (local.revision > incoming.revision)
    return { winner: local, conflict: false, reason: 'Local answer has a newer revision.' };
  if (local.answer === incoming.answer && local.questionId === incoming.questionId)
    return {
      winner: local,
      conflict: false,
      reason: 'Equal answer revisions contain the same value.',
    };
  const localAt = new Date(local.answeredAt).getTime();
  const incomingAt = new Date(incoming.answeredAt).getTime();
  if (incomingAt > localAt)
    return {
      winner: incoming,
      conflict: true,
      reason: 'Equal revisions differ; the later timestamp is selected for manual review.',
    };
  return {
    winner: local,
    conflict: true,
    reason: 'Equal revisions differ; local value is retained for manual review.',
  };
}

export function reconcileAttempt(local: StudentAttempt, incoming: StudentAttempt): StudentAttempt {
  const base = chooseLatestAttempt(local, incoming);
  const answers = new Map<string, ExamAnswer>();
  for (const answer of [...local.answers, ...incoming.answers]) {
    const current = answers.get(answer.questionId);
    answers.set(answer.questionId, current ? reconcileAnswer(current, answer).winner : answer);
  }
  return { ...base, answers: [...answers.values()] };
}

export interface SyncResult {
  ok: boolean;
  queued: number;
  applied: number;
  conflicts: string[];
  state: 'SYNCHRONIZED' | 'DEGRADED' | 'RECOVERY_PENDING';
}

/**
 * Incremental examination synchronizer. Only pending events are sent; the
 * package, question bank, and complete attempt are never retransmitted for an
 * ordinary answer save.
 */
export class ExaminationSyncEngine {
  private readonly repository: ExaminationRepository;
  private readonly transport: LanExamTransport;
  private readonly sessionId: string;
  private consecutiveFailures = 0;

  constructor(repository: ExaminationRepository, transport: LanExamTransport, sessionId: string) {
    this.repository = repository;
    this.transport = transport;
    this.sessionId = sessionId;
  }

  async flush(): Promise<SyncResult> {
    const events = this.repository.pendingSyncEvents(this.sessionId);
    if (!events.length)
      return { ok: true, queued: 0, applied: 0, conflicts: [], state: 'SYNCHRONIZED' };
    try {
      const result = await this.transport.sync(this.sessionId, events);
      const appliedIds =
        result.acknowledgedEventIds || events.slice(0, result.applied).map((event) => event.id);
      await this.repository.acknowledgeSyncEvents(this.sessionId, appliedIds, result.revision);
      await this.repository.logSecurityEvent({
        sessionId: this.sessionId,
        type: 'RECONNECTED',
        severity: 'info',
        details: `Applied ${appliedIds.length} incremental examination event(s).`,
      });
      await this.repository.logSecurityEvent({
        sessionId: this.sessionId,
        type: 'SYNC_RECONCILED',
        severity: result.conflicts.length ? 'warning' : 'info',
        details: result.conflicts.length
          ? `Synchronization completed with ${result.conflicts.length} conflict(s).`
          : 'Queued events reconciled without conflict.',
      });
      this.consecutiveFailures = 0;
      return {
        ok: result.ok,
        queued: events.length,
        applied: result.applied,
        conflicts: result.conflicts,
        state: result.conflicts.length ? 'DEGRADED' : 'SYNCHRONIZED',
      };
    } catch (error) {
      this.consecutiveFailures += 1;
      const pendingTooLong = this.consecutiveFailures >= 3;
      await this.repository.markSynchronizationUnavailable(
        this.sessionId,
        error instanceof Error ? error.message : 'LAN synchronization failed.',
        pendingTooLong,
      );
      return {
        ok: false,
        queued: events.length,
        applied: 0,
        conflicts: [],
        state: pendingTooLong ? 'RECOVERY_PENDING' : 'DEGRADED',
      };
    }
  }

  resetFailures(): void {
    this.consecutiveFailures = 0;
  }
}
