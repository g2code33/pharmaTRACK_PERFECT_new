import { digestJson, randomId, sha256 } from './crypto';
import { buildExamPackageDraft, type ExaminationRepository } from './service';
import type {
  ExamAnswer,
  ExamSession,
  ExamVersion,
  RecoveryState,
  StudentAttempt,
  SyncEvent,
} from './types';

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
  lastKnownGoodAt?: string;
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
  serverNowAt?: string;
}

export interface LanConnection {
  ok: boolean;
  server: ExamServerIdentity;
  session?: ExamSession;
  deviceSessionId?: string;
  sessionToken?: string;
}

export interface LanPackageResponse {
  ok: boolean;
  sessionId: string;
  examVersionId: string;
  package: Record<string, unknown>;
  version?: ExamVersion;
  checksum?: string;
}

export interface LanAttemptResponse {
  ok: boolean;
  attempt?: StudentAttempt;
  revision: number;
  continued?: boolean;
}

export interface LanResultSummary {
  attemptId: string;
  studentId: string;
  status: string;
  submittedAt?: string;
  answered: number;
  serverRevision: number;
}

export interface LanExamTransport {
  health(): Promise<LanHealth>;
  connect(
    sessionId: string,
    deviceId: string,
    role: 'STUDENT' | 'ADMIN',
    options?: { studentId?: string; authProof?: string },
  ): Promise<LanConnection>;
  submitAnswer(
    sessionId: string,
    attemptId: string,
    answer: ExamAnswer,
  ): Promise<{ ok: boolean; revision: number }>;
  sync(
    sessionId: string,
    events: SyncEvent[],
  ): Promise<{
    ok: boolean;
    applied: number;
    conflicts: string[];
    revision: number;
    acknowledgedEventIds?: string[];
  }>;
  recover(
    sessionId: string,
    attemptId: string,
    state: RecoveryState,
  ): Promise<{ ok: boolean; attempt?: StudentAttempt; revision: number }>;
  heartbeat?(
    sessionId: string,
    deviceSessionId: string,
  ): Promise<{ ok: boolean; lastSeenAt: string }>;
  fetchPackage?(sessionId: string): Promise<LanPackageResponse>;
  createAttempt?(
    sessionId: string,
    studentId: string,
    deviceSessionId: string,
  ): Promise<LanAttemptResponse>;
  submitAttempt?(
    sessionId: string,
    attemptId: string,
    deviceSessionId?: string,
  ): Promise<LanAttemptResponse>;
  state?(sessionId: string): Promise<{
    ok: boolean;
    server: ExamServerIdentity;
    connections: Array<Record<string, unknown>>;
    attempts: Array<Record<string, unknown>>;
    securityEvents: Array<Record<string, unknown>>;
    revision: number;
  }>;
  fetchResults?(
    sessionId: string,
  ): Promise<{ ok: boolean; revision: number; results: LanResultSummary[] }>;
}

export interface LanExamClientOptions {
  token?: string;
  deviceSessionId?: string;
  studentId?: string;
}

export class LanExamClient implements LanExamTransport {
  private readonly baseUrl: string;
  private readonly request: typeof fetch;
  private token?: string;
  private deviceSessionId?: string;
  private studentId?: string;

  constructor(baseUrl: string, request: typeof fetch = fetch, options: LanExamClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.request = request;
    this.token = options.token;
    this.deviceSessionId = options.deviceSessionId;
    this.studentId = options.studentId;
  }

  setSession(options: LanExamClientOptions): void {
    this.token = options.token ?? this.token;
    this.deviceSessionId = options.deviceSessionId ?? this.deviceSessionId;
    this.studentId = options.studentId ?? this.studentId;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.token) {
      headers['x-pharma-exam-token'] = this.token;
      const body = typeof init.body === 'string' ? init.body : '';
      headers['x-pharma-exam-signature'] = await sha256(
        `${this.token}:${init.method || 'GET'}:${path}:${body}`,
      );
    }
    if (this.deviceSessionId) headers['x-pharma-device-session'] = this.deviceSessionId;
    const response = await this.request(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      let detail = `LAN examination authority returned ${response.status}.`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        // Preserve the deterministic HTTP error when the response is not JSON.
      }
      throw new Error(detail);
    }
    return response.json() as Promise<T>;
  }

  health(): Promise<LanHealth> {
    return this.call<LanHealth>('/pharmaexam/v1/health');
  }

  connect(
    sessionId: string,
    deviceId: string,
    role: 'STUDENT' | 'ADMIN',
    options: { studentId?: string; authProof?: string } = {},
  ) {
    return this.call<LanConnection>(
      `/pharmaexam/v1/sessions/${encodeURIComponent(sessionId)}/connect`,
      {
        method: 'POST',
        body: JSON.stringify({
          deviceId,
          role,
          studentId: options.studentId || this.studentId,
          authProof: options.authProof,
          protocolVersion: EXAMINATION_PROTOCOL_VERSION,
        }),
      },
    ).then((connection) => {
      this.setSession({
        token: connection.sessionToken,
        deviceSessionId: connection.deviceSessionId,
      });
      return connection;
    });
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
    return this.call<{
      ok: boolean;
      applied: number;
      conflicts: string[];
      revision: number;
      acknowledgedEventIds?: string[];
    }>(`/pharmaexam/v1/sessions/${encodeURIComponent(sessionId)}/sync`, {
      method: 'POST',
      body: JSON.stringify({ events, protocolVersion: EXAMINATION_PROTOCOL_VERSION }),
    });
  }

  heartbeat(sessionId: string, deviceSessionId = this.deviceSessionId || '') {
    return this.call<{ ok: boolean; lastSeenAt: string }>(
      `/pharmaexam/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
      {
        method: 'POST',
        body: JSON.stringify({ deviceSessionId, protocolVersion: EXAMINATION_PROTOCOL_VERSION }),
      },
    );
  }

  fetchPackage(sessionId: string) {
    return this.call<LanPackageResponse>(
      `/pharmaexam/v1/sessions/${encodeURIComponent(sessionId)}/package`,
    );
  }

  createAttempt(sessionId: string, studentId: string, deviceSessionId: string) {
    return this.call<LanAttemptResponse>(
      `/pharmaexam/v1/sessions/${encodeURIComponent(sessionId)}/attempts`,
      {
        method: 'POST',
        body: JSON.stringify({
          studentId,
          deviceSessionId,
          protocolVersion: EXAMINATION_PROTOCOL_VERSION,
        }),
      },
    );
  }

  state(sessionId: string) {
    return this.call<{
      ok: boolean;
      server: ExamServerIdentity;
      connections: Array<Record<string, unknown>>;
      attempts: Array<Record<string, unknown>>;
      securityEvents: Array<Record<string, unknown>>;
      revision: number;
    }>(`/pharmaexam/v1/sessions/${encodeURIComponent(sessionId)}/state`);
  }

  fetchResults(sessionId: string) {
    return this.call<{ ok: boolean; revision: number; results: LanResultSummary[] }>(
      `/pharmaexam/v1/sessions/${encodeURIComponent(sessionId)}/results`,
    );
  }

  submitAttempt(sessionId: string, attemptId: string, deviceSessionId = this.deviceSessionId) {
    return this.call<LanAttemptResponse>(
      `/pharmaexam/v1/sessions/${encodeURIComponent(sessionId)}/attempts/${encodeURIComponent(attemptId)}/submit`,
      {
        method: 'POST',
        body: JSON.stringify({ deviceSessionId, protocolVersion: EXAMINATION_PROTOCOL_VERSION }),
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
      serverNowAt: new Date().toISOString(),
    };
  }

  async connect(
    sessionId: string,
    deviceId: string,
    role: 'STUDENT' | 'ADMIN',
    options: { studentId?: string } = {},
  ) {
    const snapshot = this.repository.snapshot;
    const session = snapshot.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error('Examination session was not found on this authority.');
    const existing = snapshot.deviceSessions.find(
      (item) =>
        item.deviceId === deviceId && item.sessionId === sessionId && item.status === 'CONNECTED',
    );
    const device =
      existing ||
      (await this.repository.createDeviceSession({
        deviceId,
        studentId: options.studentId,
        role,
        sessionId,
        capabilities: ['encrypted-local-state', 'offline-recovery', 'lan-authenticated'],
      }));
    return {
      ok: true,
      server: this.identity,
      session,
      deviceSessionId: device.id,
      sessionToken: `local:${session.id}:${device.id}`,
    };
  }

  async submitAnswer(sessionId: string, attemptId: string, answer: ExamAnswer) {
    const attempt = this.repository.snapshot.attempts.find((item) => item.id === attemptId);
    if (!attempt || attempt.sessionId !== sessionId)
      throw new Error('Attempt does not belong to this session.');
    const event: SyncEvent = {
      id: answer.eventId || randomId('sync_event'),
      eventId: answer.eventId || randomId('answer_event'),
      sessionId,
      entity: 'ANSWER',
      entityId: answer.eventId || answer.questionId,
      sourceServerId: 'local-device',
      authorityEpoch:
        this.repository.snapshot.sessions.find((item) => item.id === sessionId)?.authorityEpoch ||
        1,
      revision: Math.max(1, answer.revision || 1),
      at: answer.answeredAt || new Date().toISOString(),
      direction: 'LOCAL_TO_SERVER',
      status: 'PENDING',
      questionId: answer.questionId,
      answerRevision: Math.max(1, answer.revision || 1),
      payload: {
        attemptId,
        answer: answer.answer,
        selectedOption: answer.selectedOption,
        deviceSessionId: answer.deviceSessionId,
        isFinal: answer.isFinal,
      },
    };
    const result = await this.repository.processIncomingSyncEvents(sessionId, [event]);
    if (!result.ok && !result.acknowledgedEventIds.includes(event.id))
      throw new Error(result.conflicts[0] || 'Answer was rejected by the examination authority.');
    this.identity = {
      ...this.identity,
      revision: result.revision,
      lastHeartbeatAt: new Date().toISOString(),
    };
    return { ok: true, revision: result.revision };
  }

  async sync(sessionId: string, events: SyncEvent[]) {
    const result = await this.repository.processIncomingSyncEvents(sessionId, events);
    this.identity = {
      ...this.identity,
      revision: result.revision,
      lastHeartbeatAt: new Date().toISOString(),
    };
    return result;
  }

  async heartbeat(sessionId: string, deviceSessionId: string) {
    const lastSeenAt = await this.repository.heartbeatDeviceSession(deviceSessionId, sessionId);
    this.identity = { ...this.identity, lastHeartbeatAt: lastSeenAt };
    return { ok: true, lastSeenAt };
  }

  async fetchPackage(sessionId: string): Promise<LanPackageResponse> {
    const session = this.repository.snapshot.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error('Examination session was not found on this authority.');
    const version = this.repository.snapshot.versions.find(
      (item) => item.id === session.examVersionId,
    );
    if (!version) throw new Error('The immutable examination version was not found.');
    return {
      ok: true,
      sessionId,
      examVersionId: version.id,
      package: buildExamPackageDraft(version),
      version,
      checksum: version.versionHash,
    };
  }

  async createAttempt(sessionId: string, studentId: string, deviceSessionId: string) {
    const result = await this.repository.createAttempt(sessionId, studentId, deviceSessionId);
    return {
      ok: true,
      attempt: result.attempt,
      continued: result.continued,
      revision: result.attempt.serverRevision,
    };
  }

  async submitAttempt(sessionId: string, attemptId: string, deviceSessionId?: string) {
    const attempt = this.repository.snapshot.attempts.find((item) => item.id === attemptId);
    if (!attempt || attempt.sessionId !== sessionId)
      throw new Error('Attempt does not belong to this session.');
    const submitted = await this.repository.submitAttempt(attemptId, false, deviceSessionId);
    return { ok: true, attempt: submitted, revision: submitted.serverRevision };
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
    lastKnownGoodAt: input.lastKnownGoodAt,
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
