import { digestJson, randomId } from './crypto';
import { createServerIdentity, requestManualFailover, type ExamServerIdentity } from './network';
import type { ExaminationRepository } from './service';
import type {
  ExamAuthorityLeaseRecord,
  ExamAuthorityRecord,
  ExamReplicationPayload,
  ExamReplicationSnapshot,
  ExamSession,
  ExaminationState,
  StudentAttempt,
  SyncEvent,
} from './types';

export type ReplicationState = 'CURRENT' | 'STALE' | 'INTERRUPTED' | 'PROMOTED';

export interface AuthorityStatusView {
  authorityId: string;
  primary: ExamAuthorityRecord;
  secondary: ExamAuthorityRecord;
  activeServerId: string;
  lease?: ExamAuthorityLeaseRecord;
  lastSnapshot?: ExamReplicationSnapshot;
  replicationState: ReplicationState;
  automaticFailover: false;
}

export interface HighAvailabilityOptions {
  primary?: Partial<ExamServerIdentity>;
  secondary?: Partial<ExamServerIdentity>;
}

export interface StudentReconnectResult {
  attempt: StudentAttempt;
  continued: boolean;
  applied: number;
  conflicts: string[];
  authorityEpoch: number;
  serverRevision: number;
}

function record(identity: ExamServerIdentity): ExamAuthorityRecord {
  return {
    authorityId: identity.authorityId,
    serverId: identity.serverId,
    label: identity.label,
    role: identity.role,
    endpoint: identity.endpoint,
    status: identity.status,
    epoch: identity.epoch,
    revision: identity.revision,
    lastHeartbeatAt: identity.lastHeartbeatAt,
    lastKnownGoodAt: identity.lastKnownGoodAt,
  };
}

function identity(saved: ExamAuthorityRecord): ExamServerIdentity {
  return { ...saved };
}

function activeIdentity(
  primary: ExamServerIdentity,
  secondary: ExamServerIdentity,
): ExamServerIdentity {
  return primary.status === 'PRIMARY' ? primary : secondary;
}

/**
 * Controlled high-availability coordinator.
 *
 * `authorityRepository` and `standbyRepository` are deliberately separate
 * repository views when a real secondary is available. The default constructor
 * keeps the existing single-repository behavior for local/browser operation and
 * existing callers. Promotion swaps repository authority only after the new
 * epoch is created; the old primary is retained as a standby identity.
 */
export class ExaminationHighAvailability {
  private readonly originalPrimaryRepository: ExaminationRepository;
  private readonly originalSecondaryRepository: ExaminationRepository;
  private authorityRepository: ExaminationRepository;
  private standbyRepository: ExaminationRepository;
  private primary!: ExamServerIdentity;
  private secondary!: ExamServerIdentity;
  private lease?: ExamAuthorityLeaseRecord;
  private replicationState: ReplicationState = 'STALE';

  constructor(
    repository: ExaminationRepository,
    secondaryRepository = repository,
    options: HighAvailabilityOptions = {},
  ) {
    this.originalPrimaryRepository = repository;
    this.originalSecondaryRepository = secondaryRepository;
    this.authorityRepository = repository;
    this.standbyRepository = secondaryRepository;
    this.options = options;
  }

  private readonly options: HighAvailabilityOptions;

  async initialize(): Promise<AuthorityStatusView> {
    const primarySaved = this.authorityRepository.snapshot.authorities.find(
      (item) => item.role === 'PRIMARY',
    );
    const secondarySaved = this.standbyRepository.snapshot.authorities.find(
      (item) => item.role === 'SECONDARY',
    );
    const authorityId =
      this.options.primary?.authorityId ||
      primarySaved?.authorityId ||
      secondarySaved?.authorityId ||
      randomId('authority');
    this.primary = primarySaved
      ? identity(primarySaved)
      : createServerIdentity({
          ...this.options.primary,
          authorityId,
          label: this.options.primary?.label || 'Primary examination server',
          role: 'PRIMARY',
          status: 'PRIMARY',
        });
    this.secondary = secondarySaved
      ? identity(secondarySaved)
      : createServerIdentity({
          ...this.options.secondary,
          authorityId,
          label: this.options.secondary?.label || 'Secondary examination server',
          role: 'SECONDARY',
          status: 'SECONDARY',
        });
    if (this.primary.authorityId !== this.secondary.authorityId)
      throw new Error('Primary and secondary servers must share one authority identity.');

    this.lease = this.authorityRepository.snapshot.authorityLeases.find(
      (item) => item.serverId === this.activeServerId(),
    );
    if (!this.lease)
      await this.acquireLease(
        activeIdentity(this.primary, this.secondary),
        new Date().toISOString(),
      );
    this.replicationState = this.latestSnapshot() ? 'CURRENT' : 'STALE';
    await this.persistAuthorityRecords();
    return this.status();
  }

  async heartbeat(serverId: string, at = new Date().toISOString()): Promise<AuthorityStatusView> {
    this.requireInitialized();
    const target = this.find(serverId);
    target.lastHeartbeatAt = at;
    target.revision += 1;
    if (target.serverId === this.activeServerId()) target.status = 'PRIMARY';
    await this.persistAuthorityRecords();
    if (target.serverId === this.activeServerId()) await this.acquireLease(target, at);
    return this.status();
  }

  async replicateToSecondary(
    sessionId: string,
    at = new Date().toISOString(),
  ): Promise<ExamReplicationSnapshot> {
    this.requireInitialized();
    const active = activeIdentity(this.primary, this.secondary);
    if (active.serverId !== this.activeServerId() || active.role !== 'PRIMARY')
      throw new Error('Only the current primary may send replication data.');
    const state = this.authorityRepository.snapshot;
    if (!state.sessions.some((session) => session.id === sessionId))
      throw new Error('Cannot replicate an unknown examination session.');
    const payload = this.replicationPayload(state);
    const snapshot = await this.buildSnapshot(payload, sessionId, active, at);
    await this.authorityRepository.saveReplicationSnapshot(snapshot);
    try {
      await this.standbyRepository.installReplicatedState(payload, snapshot);
    } catch (error) {
      this.replicationState = 'INTERRUPTED';
      throw error;
    }
    const standby = this.standbyIdentity();
    standby.revision = Math.max(standby.revision, active.revision);
    standby.lastHeartbeatAt = at;
    standby.lastKnownGoodAt = at;
    this.replicationState = 'CURRENT';
    await this.persistAuthorityRecords();
    return snapshot;
  }

  async promoteSecondary(
    adminId: string,
    adminDeviceSessionId: string,
    reason: string,
    confirmed: boolean,
    now = new Date().toISOString(),
  ): Promise<AuthorityStatusView> {
    this.requireInitialized();
    if (!confirmed) throw new Error('Failover requires explicit administrator confirmation.');
    if (this.replicationState === 'INTERRUPTED')
      throw new Error('The last replication was interrupted; promotion requires reconciliation.');
    if (!this.latestSnapshot())
      throw new Error('The secondary has no durable last-known-good examination snapshot.');
    const adminDevice = this.findAdminDevice(adminDeviceSessionId);
    if (!adminDevice)
      throw new Error('Administrator device session is not authenticated or connected.');
    if (this.secondary.status === 'LOCKED')
      throw new Error('The secondary server is locked and cannot be promoted.');
    const active = activeIdentity(this.primary, this.secondary);
    const staleFor = new Date(now).getTime() - new Date(active.lastHeartbeatAt).getTime();
    if (staleFor < 5_000)
      throw new Error('Primary heartbeat is still healthy; controlled failover was not started.');

    await this.authorityRepository.logSecurityEvent({
      type: 'FAILOVER_REQUESTED',
      severity: 'warning',
      details: `${adminId} requested controlled failover: ${reason}`,
    });
    const transition = requestManualFailover(this.primary, this.secondary, reason);
    // Keep primary/secondary fields compatible with the existing admin UI: the
    // old primary is still exposed as `primary`, while activeServerId points to
    // the promoted secondary. Repository authority is swapped separately.
    this.primary = transition.primary;
    this.secondary = transition.secondary;
    const previousAuthorityRepository = this.authorityRepository;
    this.authorityRepository = this.standbyRepository;
    this.standbyRepository = previousAuthorityRepository;
    this.lease = undefined;
    await this.acquireLease(this.secondary, now);

    for (const session of this.authorityRepository.snapshot.sessions.filter(
      (item) => !['CLOSED', 'CLOSING'].includes(item.status),
    )) {
      await this.authorityRepository.applyAuthorityTakeover(
        session.id,
        this.secondary.serverId,
        this.secondary.epoch,
        now,
      );
    }
    this.replicationState = 'PROMOTED';
    await this.persistAuthorityRecords();
    await this.authorityRepository.logAdminAction({
      adminId,
      adminDeviceSessionId,
      action: 'FAILOVER',
      reason,
      targetId: this.secondary.serverId,
      previousState: 'PRIMARY:' + transition.primary.serverId,
      newState: 'PRIMARY:' + transition.secondary.serverId,
    });
    await this.authorityRepository.logSecurityEvent({
      type: 'FAILOVER_COMPLETED',
      severity: 'critical',
      details: `${transition.primary.serverId} promoted ${transition.secondary.serverId} at epoch ${this.secondary.epoch}.`,
    });
    return this.status();
  }

  /**
   * Reconnect the same student attempt after authority promotion. The method
   * resumes the existing attempt ID and reconciles queued events; it never
   * creates a second attempt for the student/session pair.
   */
  async reconnectStudent(
    sessionId: string,
    studentId: string,
    deviceSessionId: string,
    pendingEvents: SyncEvent[] = [],
  ): Promise<StudentReconnectResult> {
    this.requireInitialized();
    const repository = this.authorityRepository;
    const session = repository.snapshot.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error('The examination session was not found on the active authority.');
    const existingDevice = repository.snapshot.deviceSessions.find(
      (item) => item.id === deviceSessionId || item.deviceId === deviceSessionId,
    );
    if (!existingDevice) {
      await repository.createDeviceSession({
        id: deviceSessionId,
        deviceId: deviceSessionId,
        role: 'STUDENT',
        studentId,
        sessionId,
        capabilities: ['encrypted-local-state', 'lan-authenticated', 'recovery'],
      });
    } else if (existingDevice.studentId !== studentId || existingDevice.sessionId !== sessionId) {
      throw new Error('The reconnecting device is not bound to this student/session.');
    }
    const existingAttempt = repository.snapshot.attempts.find(
      (item) => item.sessionId === sessionId && item.studentId === studentId,
    );
    if (!existingAttempt) throw new Error('The existing student attempt was not replicated.');
    const continued = await repository.createAttempt(
      sessionId,
      studentId,
      deviceSessionId,
      existingAttempt.timerState?.authoritativeStartedAt || existingAttempt.startedAt,
      existingAttempt.id,
    );
    const sync = pendingEvents.length
      ? await repository.processIncomingSyncEvents(
          sessionId,
          pendingEvents,
          new Date().toISOString(),
          { reconcile: true },
        )
      : {
          ok: true,
          applied: 0,
          conflicts: [],
          revision: session.lastReplicationRevision,
          acknowledgedEventIds: [],
        };
    const attempt = repository.snapshot.attempts.find((item) => item.id === continued.attempt.id);
    if (!attempt) throw new Error('Attempt disappeared during student recovery.');
    await repository.logSecurityEvent({
      sessionId,
      attemptId: attempt.id,
      studentId,
      deviceSessionId,
      type: 'RECOVERY_COMPLETED',
      severity: sync.conflicts.length ? 'warning' : 'info',
      details: `Student reconnected to existing attempt at authority epoch ${session.authorityEpoch}.`,
    });
    return {
      attempt,
      continued: continued.continued,
      applied: sync.applied,
      conflicts: sync.conflicts,
      authorityEpoch: session.authorityEpoch,
      serverRevision: sync.revision,
    };
  }

  /** Admin B reconnects to the existing active session; no session is created. */
  async reconnectAdministrator(
    sessionId: string,
    adminId: string,
    deviceId: string,
  ): Promise<{ session: ExamSession; deviceSessionId: string; serverRevision: number }> {
    this.requireInitialized();
    const repository = this.authorityRepository;
    const session = repository.snapshot.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error('The existing examination session was not replicated.');
    const existing = repository.snapshot.deviceSessions.find(
      (item) => item.deviceId === deviceId && item.role === 'ADMIN',
    );
    const device =
      existing ||
      (await repository.createDeviceSession({
        deviceId,
        role: 'ADMIN',
        sessionId,
        capabilities: ['authority-control', 'live-dashboard', 'failover-review'],
      }));
    await repository.logSecurityEvent({
      sessionId,
      deviceSessionId: device.id,
      type: 'IDENTITY_AUTHENTICATED',
      severity: 'info',
      details: `${adminId} reconnected to the existing examination session.`,
    });
    return {
      session,
      deviceSessionId: device.id,
      serverRevision: session.lastReplicationRevision,
    };
  }

  /**
   * A returning primary must receive a current encrypted snapshot before it is
   * marked standby. It cannot self-promote or accept writes during this path.
   */
  async reconnectFormerPrimary(
    serverId: string,
    now = new Date().toISOString(),
  ): Promise<AuthorityStatusView> {
    this.requireInitialized();
    const returning = this.find(serverId);
    if (returning.serverId === this.activeServerId()) return this.status();
    const active = activeIdentity(this.primary, this.secondary);
    const state = this.authorityRepository.snapshot;
    const sessionId = state.sessions[0]?.id;
    if (!sessionId)
      throw new Error('No examination session is available for standby reconciliation.');
    const payload = this.replicationPayload(state);
    const snapshot = await this.buildSnapshot(payload, sessionId, active, now);
    await this.authorityRepository.saveReplicationSnapshot(snapshot);
    await this.standbyRepository.installReplicatedState(payload, snapshot);
    returning.status = 'STANDBY';
    returning.role = 'SECONDARY';
    returning.lastHeartbeatAt = now;
    returning.lastKnownGoodAt = now;
    returning.epoch = active.epoch;
    returning.revision = active.revision;
    this.replicationState = 'CURRENT';
    await this.persistAuthorityRecords();
    await this.authorityRepository.logSecurityEvent({
      type: 'RECONNECTED',
      severity: 'info',
      details: `Former authority ${serverId} synchronized at epoch ${active.epoch} and returned as standby.`,
    });
    return this.status();
  }

  /** Reject writes from an old primary even if its process returns. */
  assertCurrentAuthority(serverId: string, authorityEpoch: number): void {
    this.requireInitialized();
    if (
      serverId !== this.activeServerId() ||
      authorityEpoch !== activeIdentity(this.primary, this.secondary).epoch
    )
      throw new Error('Authority write rejected: server is not the current epoch owner.');
  }

  private async buildSnapshot(
    payload: ExamReplicationPayload,
    sessionId: string,
    active: ExamServerIdentity,
    at: string,
  ): Promise<ExamReplicationSnapshot> {
    return {
      id: randomId('replication_snapshot'),
      authorityId: active.authorityId,
      serverId: active.serverId,
      authorityEpoch: active.epoch,
      revision: active.revision,
      createdAt: at,
      sessionIds: payload.sessions
        .filter((session) => session.id === sessionId)
        .map((session) => session.id),
      attemptIds: payload.attempts
        .filter((attempt) => attempt.sessionId === sessionId)
        .map((attempt) => attempt.id),
      pendingEventIds: payload.syncEvents
        .filter((event) => event.sessionId === sessionId && event.status === 'PENDING')
        .map((event) => event.id),
      payload,
      checksum: await digestJson(payload),
    };
  }

  private replicationPayload(state: ExaminationState): ExamReplicationPayload {
    return JSON.parse(
      JSON.stringify({
        schemaVersion: state.schemaVersion,
        exams: state.exams,
        versions: state.versions,
        sessions: state.sessions,
        students: state.students,
        attempts: state.attempts,
        answers: state.answers,
        securityEvents: state.securityEvents,
        adminActions: state.adminActions,
        deviceSessions: state.deviceSessions,
        syncEvents: state.syncEvents,
        recoveryStates: state.recoveryStates,
        results: state.results,
        authorities: state.authorities,
        authorityLeases: state.authorityLeases,
        importedPackageKeys: state.importedPackageKeys,
      }),
    ) as ExamReplicationPayload;
  }

  private async persistAuthorityRecords(): Promise<void> {
    await this.authorityRepository.saveAuthorityRecord(record(this.primary));
    await this.authorityRepository.saveAuthorityRecord(record(this.secondary));
    if (this.standbyRepository !== this.authorityRepository) {
      await this.standbyRepository.saveAuthorityRecord(record(this.primary));
      await this.standbyRepository.saveAuthorityRecord(record(this.secondary));
    }
  }

  private async acquireLease(server: ExamServerIdentity, at: string): Promise<void> {
    const lease: ExamAuthorityLeaseRecord = {
      authorityId: server.authorityId,
      serverId: server.serverId,
      epoch: server.epoch,
      leaseId: randomId('authority_lease'),
      acquiredAt: at,
      expiresAt: new Date(new Date(at).getTime() + 15_000).toISOString(),
    };
    this.lease = lease;
    await this.authorityRepository.saveAuthorityLease(lease);
    if (this.standbyRepository !== this.authorityRepository)
      await this.standbyRepository.saveAuthorityLease(lease);
  }

  private findAdminDevice(deviceSessionId: string) {
    return [this.authorityRepository, this.standbyRepository]
      .flatMap((repository) => repository.snapshot.deviceSessions)
      .find(
        (device) =>
          (device.id === deviceSessionId || device.deviceId === deviceSessionId) &&
          device.role === 'ADMIN' &&
          device.status === 'CONNECTED',
      );
  }

  private find(serverId: string): ExamServerIdentity {
    if (this.primary.serverId === serverId) return this.primary;
    if (this.secondary.serverId === serverId) return this.secondary;
    throw new Error('Unknown examination authority server.');
  }

  private activeServerId(): string {
    return this.primary.status === 'PRIMARY' ? this.primary.serverId : this.secondary.serverId;
  }

  private standbyIdentity(): ExamServerIdentity {
    return this.primary.status === 'PRIMARY' ? this.secondary : this.primary;
  }

  private latestSnapshot(): ExamReplicationSnapshot | undefined {
    const snapshots = this.authorityRepository.snapshot.replicationSnapshots;
    return [...snapshots]
      .reverse()
      .find(
        (snapshot) =>
          Boolean((snapshot as Partial<ExamReplicationSnapshot>).payload) &&
          typeof snapshot.checksum === 'string',
      );
  }

  private requireInitialized(): void {
    if (!this.primary || !this.secondary)
      throw new Error('High-availability coordinator has not been initialized.');
  }

  status(): AuthorityStatusView {
    this.requireInitialized();
    return {
      authorityId: this.primary.authorityId,
      primary: record(this.primary),
      secondary: record(this.secondary),
      activeServerId: this.activeServerId(),
      lease: this.lease,
      lastSnapshot: this.latestSnapshot(),
      replicationState: this.replicationState,
      automaticFailover: false,
    };
  }
}
