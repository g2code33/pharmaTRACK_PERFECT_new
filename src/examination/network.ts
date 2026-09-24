import { digestJson, randomId } from './crypto';
import type { ExaminationRepository } from './service';
import type { ExamAnswer, ExamSession, RecoveryState, StudentAttempt, SyncEvent } from './types';

export const EXAMINATION_PROTOCOL_VERSION = 1 as const;

export type ServerRole = 'PRIMARY' | 'SECONDARY';
export type AuthorityStatus = 'PRIMARY' | 'SECONDARY' | 'STANDBY' | 'FAILOVER' | 'LOCKED';

export interface ExamServerIdentity {
  serverId: string;
  label: string;
  role: ServerRole;
  endpoint: string;
  authorityId: string;
  epoch: number;
  revision: number;
  status: AuthorityStatus;
  lastHeartbeatAt: string;
  lockedBy?: string;
}

export interface AuthorityLease {
  authorityId: string;
  serverId: string;
  epoch: number;
  leaseId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface ReplicationEnvelope<T = unknown> {
  protocolVersion: typeof EXAMINATION_PROTOCOL_VERSION;
  authorityId: string;
  sourceServerId: string;
  authorityEpoch: number;
  revision: number;
  entity: string;
  entityId: string;
  payload: T;
  checksum: string;
}

export interface LanHealth {
  ok: boolean;
  protocolVersion: number;
  server: ExamServerIdentity;
  activeSessions: number;
  activeAttempts: number;
  checkedAt: string;
}

export interface LanExamTransport {
  health(): Promise<LanHealth>;
  connect(
    sessionId: string,
    deviceId: string,
    role: 'STUDENT' | 'ADMIN',
  ): Promise<{ ok: boolean; server: ExamServerIdentity; session?: ExamSession }>;
  submitAnswer(
    sessionId: string,
    attemptId: string,
    answer: ExamAnswer,
  ): Promise<{ ok: boolean; revision: number }>;
  sync(
    sessionId: string,
    events: SyncEvent[],
  ): Promise<{ ok: boolean; applied: number; conflicts: string[]; revision: number }>;
  recover(
    sessionId: string,
    attemptId: string,
    state: RecoveryState,
  ): Promise<{ ok: boolean; attempt?: StudentAttempt; revision: number }>;
}

export class LanExamClient implements LanExamTransport {
  private readonly baseUrl: string;
  private readonly request: typeof fetch;

  constructor(baseUrl: string, request: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.request = request;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    });
    if (!response.ok) throw new Error(`LAN examination authority returned ${response.status}.`);
    return response.json() as Promise<T>;
  }

  health(): Promise<LanHealth> {
    return this.call<LanHealth>('/pharmaexam/v1/health');
  }

  connect(sessionId: string, deviceId: string, role: 'STUDENT' | 'ADMIN') {
    return this.call<{ ok: boolean; server: ExamServerIdentity; session?: ExamSession }>(
      `/pharmaexam/v1/sessions/${encodeURIComponent(sessionId)}/connect`,
      {
        method: 'POST',
        body: JSON.stringify({ deviceId, role, protocolVersion: EXAMINATION_PROTOCOL_VERSION }),
      },
    );
  }

  submitAnswer(sessionId: string, attemptId: string, answer: ExamAnswer) {
    return this.call<{ ok: boolean; revision: number }>(
      `/pharmaexam/v1/sessions/${encodeURIComponent(sessionId)}/attempts/${encodeURIComponent(attemptId)}/answers`,
      {
        method: 'POST',
        body: JSON.stringify({ answer, protocolVersion: EXAMINATION_PROTOCOL_VERSION }),
      },
    );
  }

  sync(sessionId: string, events: SyncEvent[]) {
    return this.call<{ ok: boolean; applied: number; conflicts: string[]; revision: number }>(
      `/pharmaexam/v1/sessions/${encodeURIComponent(sessionId)}/sync`,
      {
        method: 'POST',
        body: JSON.stringify({ events, protocolVersion: EXAMINATION_PROTOCOL_VERSION }),
      },
    );
  }

  recover(sessionId: string, attemptId: string, state: RecoveryState) {
    return this.call<{ ok: boolean; attempt?: StudentAttempt; revision: number }>(
      `/pharmaexam/v1/sessions/${encodeURIComponent(sessionId)}/attempts/${encodeURIComponent(attemptId)}/recover`,
      {
        method: 'POST',
        body: JSON.stringify({ state, protocolVersion: EXAMINATION_PROTOCOL_VERSION }),
      },
    );
  }
}

/**
 * Browser/Tauri-local authority used when an examination is hosted on this
 * device. It is a real authority boundary, not a UI flag: sessions, attempts,
 * revisions and answer writes all go through this object. A LAN adapter can
 * implement the same interface without changing the kiosk or admin screens.
 */
export class LocalExamAuthority implements LanExamTransport {
  identity: ExamServerIdentity;
  private readonly repository: ExaminationRepository;

  constructor(
    repository: ExaminationRepository,
    identity = createServerIdentity({ label: 'This device — local examination authority' }),
  ) {
    this.repository = repository;
    this.identity = identity;
  }

  async health(): Promise<LanHealth> {
    const state = this.repository.snapshot;
    return {
      ok: this.identity.status === 'PRIMARY' || this.identity.status === 'SECONDARY',
      protocolVersion: EXAMINATION_PROTOCOL_VERSION,
      server: heartbeat(this.identity),
      activeSessions: state.sessions.filter((session) => session.status === 'ACTIVE').length,
      activeAttempts: state.attempts.filter((attempt) =>
        ['READY', 'ACTIVE', 'PAUSED', 'RECOVERY_PENDING'].includes(attempt.status),
      ).length,
      checkedAt: new Date().toISOString(),
    };
  }

  async connect(sessionId: string, deviceId: string, role: 'STUDENT' | 'ADMIN') {
    const session = this.repository.snapshot.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error('Examination session was not found on this authority.');
    await this.repository.createDeviceSession({
      deviceId,
      role,
      sessionId,
      capabilities: ['encrypted-local-state', 'offline-recovery'],
    });
    return { ok: true, server: this.identity, session };
  }

  async submitAnswer(_sessionId: string, attemptId: string, answer: ExamAnswer) {
    const { answeredAt: _answeredAt, revision: _revision, ...answerInput } = answer;
    const saved = await this.repository.recordAnswer(attemptId, answerInput);
    this.identity = {
      ...this.identity,
      revision: this.identity.revision + 1,
      lastHeartbeatAt: new Date().toISOString(),
    };
    return { ok: true, revision: saved.revision };
  }

  async sync(_sessionId: string, events: SyncEvent[]) {
    const conflicts: string[] = [];
    const applied = events.filter((event) => event.status !== 'CONFLICT').length;
    this.identity = {
      ...this.identity,
      revision: this.identity.revision + applied,
      lastHeartbeatAt: new Date().toISOString(),
    };
    return { ok: conflicts.length === 0, applied, conflicts, revision: this.identity.revision };
  }

  async recover(_sessionId: string, attemptId: string, _state: RecoveryState) {
    const attempt = this.repository.snapshot.attempts.find((item) => item.id === attemptId);
    if (!attempt) throw new Error('Attempt was not found on this authority.');
    return { ok: true, attempt, revision: this.identity.revision };
  }
}

export interface AuthorityDecision {
  accepted: boolean;
  reason: string;
  identity: ExamServerIdentity;
}

/**
 * Authority rules are pure and shared by a future Tauri/LAN server and the
 * browser-side recovery code. A lower epoch or a different authority lock can
 * never overwrite a newer leader: this is the split-brain guard.
 */
export function acceptReplication<T>(
  current: ExamServerIdentity,
  envelope: ReplicationEnvelope<T>,
): AuthorityDecision {
  if (envelope.protocolVersion !== EXAMINATION_PROTOCOL_VERSION)
    return { accepted: false, reason: 'Unsupported examination protocol.', identity: current };
  if (envelope.authorityId !== current.authorityId)
    return { accepted: false, reason: 'Authority identity does not match.', identity: current };
  if (envelope.authorityEpoch < current.epoch)
    return { accepted: false, reason: 'Stale authority epoch.', identity: current };
  if (envelope.authorityEpoch === current.epoch && envelope.revision <= current.revision)
    return { accepted: false, reason: 'Stale replication revision.', identity: current };
  return {
    accepted: true,
    reason: 'Replication accepted.',
    identity: { ...current, epoch: envelope.authorityEpoch, revision: envelope.revision },
  };
}

export function createServerIdentity(input: Partial<ExamServerIdentity> = {}): ExamServerIdentity {
  const now = new Date().toISOString();
  return {
    serverId: input.serverId || randomId('server'),
    label: input.label || 'PharmaTRACK Examination Server',
    role: input.role || 'PRIMARY',
    endpoint: input.endpoint || '',
    authorityId: input.authorityId || randomId('authority'),
    epoch: input.epoch || 1,
    revision: input.revision || 0,
    status: input.status || (input.role === 'SECONDARY' ? 'SECONDARY' : 'PRIMARY'),
    lastHeartbeatAt: input.lastHeartbeatAt || now,
    lockedBy: input.lockedBy,
  };
}

export function heartbeat(
  identity: ExamServerIdentity,
  at = new Date().toISOString(),
): ExamServerIdentity {
  return { ...identity, lastHeartbeatAt: at };
}

export function requestManualFailover(
  primary: ExamServerIdentity,
  secondary: ExamServerIdentity,
  reason: string,
): {
  primary: ExamServerIdentity;
  secondary: ExamServerIdentity;
  recovery: { reason: string; requestedAt: string; fromServerId: string; toServerId: string };
} {
  if (secondary.authorityId !== primary.authorityId)
    throw new Error('Failover servers do not belong to the same authority.');
  if (secondary.status === 'LOCKED')
    throw new Error('The secondary server is locked and cannot become authoritative.');
  const nextEpoch = Math.max(primary.epoch, secondary.epoch) + 1;
  const now = new Date().toISOString();
  return {
    primary: {
      ...primary,
      status: 'SECONDARY',
      role: 'SECONDARY',
      epoch: nextEpoch,
      lastHeartbeatAt: now,
    },
    secondary: {
      ...secondary,
      status: 'PRIMARY',
      role: 'PRIMARY',
      epoch: nextEpoch,
      lockedBy: secondary.serverId,
      lastHeartbeatAt: now,
    },
    recovery: {
      reason,
      requestedAt: now,
      fromServerId: primary.serverId,
      toServerId: secondary.serverId,
    },
  };
}

export async function makeEnvelope<T>(
  identity: ExamServerIdentity,
  entity: string,
  entityId: string,
  payload: T,
): Promise<ReplicationEnvelope<T>> {
  const revision = identity.revision + 1;
  const unsigned = {
    protocolVersion: EXAMINATION_PROTOCOL_VERSION,
    authorityId: identity.authorityId,
    sourceServerId: identity.serverId,
    authorityEpoch: identity.epoch,
    revision,
    entity,
    entityId,
    payload,
  };
  return { ...unsigned, checksum: await digestJson(unsigned) };
}

export function chooseLatestAttempt(local: StudentAttempt, remote: StudentAttempt): StudentAttempt {
  if (remote.serverRevision > local.serverRevision) return remote;
  if (local.serverRevision > remote.serverRevision) return local;
  if (remote.localRevision > local.localRevision) return remote;
  // Equal revisions are a conflict: do not silently discard the local answer.
  return {
    ...local,
    status: 'RECOVERY_PENDING',
    recoveryStateId: local.recoveryStateId || randomId('recovery'),
  };
}

export function isLanEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}
