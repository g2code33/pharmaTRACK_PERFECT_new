import { digestJson, randomId } from './crypto';
import { createServerIdentity, requestManualFailover, type ExamServerIdentity } from './network';
import type { ExaminationRepository } from './service';
import type {
  ExamAuthorityLeaseRecord,
  ExamAuthorityRecord,
  ExamReplicationSnapshot,
} from './types';

export interface AuthorityStatusView {
  authorityId: string;
  primary: ExamAuthorityRecord;
  secondary: ExamAuthorityRecord;
  activeServerId: string;
  lease?: ExamAuthorityLeaseRecord;
  lastSnapshot?: ExamReplicationSnapshot;
  automaticFailover: false;
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
  };
}

function identity(saved: ExamAuthorityRecord): ExamServerIdentity {
  return { ...saved };
}

/**
 * Controlled high-availability coordinator. Automatic promotion is explicitly
 * disabled: a human administrator must confirm promotion after the heartbeat
 * and last-known-good snapshot have been reviewed. This avoids two authorities
 * accepting answers during a network partition.
 */
export class ExaminationHighAvailability {
  private readonly repository: ExaminationRepository;
  private primary!: ExamServerIdentity;
  private secondary!: ExamServerIdentity;
  private lease?: ExamAuthorityLeaseRecord;

  constructor(repository: ExaminationRepository) {
    this.repository = repository;
  }

  async initialize(): Promise<AuthorityStatusView> {
    const saved = this.repository.snapshot.authorities;
    const primarySaved = saved.find((item) => item.role === 'PRIMARY') || saved[0];
    const secondarySaved = saved.find((item) => item.role === 'SECONDARY') || saved[1];
    const authorityId = primarySaved?.authorityId || randomId('authority');
    this.primary = primarySaved
      ? identity(primarySaved)
      : createServerIdentity({
          authorityId,
          label: 'Primary examination server',
          role: 'PRIMARY',
          status: 'PRIMARY',
        });
    this.secondary = secondarySaved
      ? identity(secondarySaved)
      : createServerIdentity({
          authorityId,
          label: 'Secondary examination server',
          role: 'SECONDARY',
          status: 'SECONDARY',
        });
    if (this.primary.authorityId !== this.secondary.authorityId)
      throw new Error('Primary and secondary servers must share one authority identity.');
    this.lease = this.repository.snapshot.authorityLeases.find(
      (item) =>
        item.serverId ===
        (this.primary.status === 'PRIMARY' ? this.primary.serverId : this.secondary.serverId),
    );
    if (!this.lease) await this.acquireLease(this.primary, new Date().toISOString());
    await this.repository.saveAuthorityRecord(record(this.primary));
    await this.repository.saveAuthorityRecord(record(this.secondary));
    return this.status();
  }

  async heartbeat(serverId: string, at = new Date().toISOString()): Promise<AuthorityStatusView> {
    this.requireInitialized();
    const target = this.find(serverId);
    target.lastHeartbeatAt = at;
    target.revision += 1;
    if (target.serverId === this.activeServerId()) target.status = 'PRIMARY';
    await this.repository.saveAuthorityRecord(record(target));
    if (target.serverId === this.activeServerId()) await this.acquireLease(target, at);
    return this.status();
  }

  async replicateToSecondary(
    sessionId: string,
    at = new Date().toISOString(),
  ): Promise<ExamReplicationSnapshot> {
    this.requireInitialized();
    if (this.activeServerId() !== this.primary.serverId)
      throw new Error('Only the current primary may send replication data.');
    const state = this.repository.snapshot;
    const snapshotPayload = {
      sessionIds: state.sessions
        .filter((session) => session.id === sessionId)
        .map((session) => session.id),
      attemptIds: state.attempts
        .filter((attempt) => attempt.sessionId === sessionId)
        .map((attempt) => attempt.id),
      pendingEventIds: state.syncEvents
        .filter((event) => event.sessionId === sessionId && event.status === 'PENDING')
        .map((event) => event.id),
    };
    const snapshot: ExamReplicationSnapshot = {
      id: randomId('replication_snapshot'),
      authorityId: this.primary.authorityId,
      serverId: this.primary.serverId,
      authorityEpoch: this.primary.epoch,
      revision: this.primary.revision,
      createdAt: at,
      ...snapshotPayload,
      checksum: await digestJson(snapshotPayload),
    };
    await this.repository.saveReplicationSnapshot(snapshot);
    this.secondary.revision = Math.max(this.secondary.revision, this.primary.revision);
    this.secondary.lastHeartbeatAt = at;
    this.secondary.lastKnownGoodAt = at;
    await this.repository.saveAuthorityRecord(record(this.secondary));
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
    const adminDevice = this.repository.snapshot.deviceSessions.find(
      (device) =>
        (device.id === adminDeviceSessionId || device.deviceId === adminDeviceSessionId) &&
        device.role === 'ADMIN' &&
        device.status === 'CONNECTED',
    );
    if (!adminDevice)
      throw new Error('Administrator device session is not authenticated or connected.');
    if (this.secondary.status === 'LOCKED')
      throw new Error('The secondary server is locked and cannot be promoted.');
    const staleFor = new Date(now).getTime() - new Date(this.primary.lastHeartbeatAt).getTime();
    if (staleFor < 5_000)
      throw new Error('Primary heartbeat is still healthy; controlled failover was not started.');
    await this.repository.logSecurityEvent({
      type: 'FAILOVER_REQUESTED',
      severity: 'warning',
      details: `${adminId} requested controlled failover: ${reason}`,
    });
    const transition = requestManualFailover(this.primary, this.secondary, reason);
    this.primary = transition.primary;
    this.secondary = transition.secondary;
    this.lease = undefined;
    await this.acquireLease(this.secondary, now);
    const state = this.repository.snapshot;
    for (const session of state.sessions.filter(
      (item) => !['CLOSED', 'CLOSING'].includes(item.status),
    ))
      await this.repository.applyAuthorityTakeover(
        session.id,
        this.secondary.serverId,
        this.secondary.epoch,
        now,
      );
    await this.repository.saveAuthorityRecord(record(this.primary));
    await this.repository.saveAuthorityRecord(record(this.secondary));
    await this.repository.logAdminAction({
      adminId,
      adminDeviceSessionId,
      action: 'FAILOVER',
      reason,
      targetId: this.secondary.serverId,
      previousState: 'PRIMARY:' + transition.primary.serverId,
      newState: 'PRIMARY:' + transition.secondary.serverId,
    });
    await this.repository.logSecurityEvent({
      type: 'FAILOVER_COMPLETED',
      severity: 'critical',
      details: `${transition.primary.serverId} promoted ${transition.secondary.serverId} at epoch ${this.secondary.epoch}.`,
    });
    return this.status();
  }

  async reconnectFormerPrimary(
    serverId: string,
    now = new Date().toISOString(),
  ): Promise<AuthorityStatusView> {
    this.requireInitialized();
    const returning = this.find(serverId);
    if (returning.serverId === this.activeServerId()) return this.status();
    returning.status = 'STANDBY';
    returning.role = 'SECONDARY';
    returning.lastHeartbeatAt = now;
    returning.lastKnownGoodAt = now;
    returning.epoch = this.secondary.epoch;
    returning.revision = this.secondary.revision;
    await this.repository.saveAuthorityRecord(record(returning));
    await this.repository.logSecurityEvent({
      type: 'RECONNECTED',
      severity: 'info',
      details: `Former authority ${serverId} returned as standby; it did not self-promote.`,
    });
    return this.status();
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
    await this.repository.saveAuthorityLease(lease);
  }

  private find(serverId: string): ExamServerIdentity {
    if (this.primary.serverId === serverId) return this.primary;
    if (this.secondary.serverId === serverId) return this.secondary;
    throw new Error('Unknown examination authority server.');
  }

  private activeServerId(): string {
    return this.primary.status === 'PRIMARY' ? this.primary.serverId : this.secondary.serverId;
  }
  private requireInitialized(): void {
    if (!this.primary || !this.secondary)
      throw new Error('High-availability coordinator has not been initialized.');
  }

  status(): AuthorityStatusView {
    this.requireInitialized();
    const snapshots = this.repository.snapshot.replicationSnapshots;
    return {
      authorityId: this.primary.authorityId,
      primary: record(this.primary),
      secondary: record(this.secondary),
      activeServerId: this.activeServerId(),
      lease: this.lease,
      lastSnapshot: snapshots[snapshots.length - 1],
      automaticFailover: false,
    };
  }
}
