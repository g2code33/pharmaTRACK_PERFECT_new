# Examination high availability and recovery

PharmaTRACK keeps the examination authority offline/LAN-first. The primary and secondary are authority processes/repository views under one authority ID; students also retain encrypted local state and a compact event queue.

## Replication contract

`ExaminationHighAvailability.replicateToSecondary()` creates a checksummed encrypted-state snapshot containing:

- sessions and immutable exam/version references
- student registry
- attempts and accepted answer revisions
- synchronization events and pending event IDs
- timer state and submission state
- device sessions
- security events and administrator actions
- recovery states and results
- authority records, leases, epoch, and revision

The complete payload is durably saved on the current authority and installed through `ExaminationRepository.installReplicatedState()` on the standby. The standby verifies the checksum and only replaces its encrypted state after its own durable save succeeds. A failed installation puts replication into `INTERRUPTED`; controlled promotion is refused until reconciliation succeeds.

## Controlled failover

Automatic promotion is intentionally disabled. The sequence is:

```text
PRIMARY ACTIVE
  -> heartbeat becomes stale
  -> last-known-good snapshot reviewed
  -> administrator confirms promotion
  -> secondary receives epoch + 1 lease
  -> active session authority is updated
  -> students/admin reconnect to the same session and attempt IDs
  -> queued events reconcile by event ID/revision
```

The old primary's server ID and epoch are rejected by `assertCurrentAuthority()`. The returning process receives a current snapshot first and is marked `STANDBY`; it cannot self-promote.

## Student and administrator recovery

`reconnectStudent()` binds the reconnecting device to the existing student/session, resumes the existing attempt, and processes queued events with recovery reconciliation. It never creates a second active attempt. Events from the previous authority epoch may be reconciled only through the explicit recovery path; future epochs are rejected.

`reconnectAdministrator()` attaches Admin Device B to the existing session and returns its current server revision. It does not call session creation.

The timer remains attempt-owned and authority-based. Promotion changes authority epoch, not the authoritative deadline. At a simulated 40-minute failure of a 60-minute exam, the promoted authority reports the same remaining time; at the deadline it reports zero rather than granting time from a device wall clock.

## Split-brain boundary

Only the current active server ID and epoch may be accepted for authoritative writes. The coordinator requires an authenticated administrator device and an explicit confirmation. A stale or returning primary remains standby after synchronization. Client event IDs and answer revisions provide idempotency and deterministic stale-event handling; a client snapshot is never blindly accepted as authoritative.
