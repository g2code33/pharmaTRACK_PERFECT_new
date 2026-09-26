# PHARMATRACK — WEB/PWA LAN EXAMINATION SYNCHRONIZATION

## 1. Overview & Objective

The PharmaTRACK Web/PWA LAN Examination Synchronization architecture connects modern Web browsers and Progressive Web Apps directly to the existing local area network (LAN) examination server.

A central requirement of the system is protocol and boundary uniformity:
* **Single Protocol**: The Web/PWA client participates in the exact same examination session as native PC (`Tauri PC`), Android (`PharmaTRACKAndroidKiosk`), and other web peers. No second or bifurcated examination protocol is created.
* **Unified Wire Format**: Uses `EXAMINATION_PROTOCOL_VERSION = 1` over standard REST JSON endpoints (`/pharmaexam/v1/*`), signed tokens, and sha256 request digest headers.
* **Authority Hierarchy**: The LAN examination server remains the single authoritative source of truth for sessions, attempt state, time, student registration, conflict resolution, submission, results, and recovery. The browser never becomes the authority.

---

## 2. Server Authority Architecture

The examination server owns all authoritative state transitions:

```text
[Examination Authority Server]
       ├── Session Lifecycle (ACTIVE, PAUSED, CONCLUDED, CLOSED)
       ├── Authoritative Time (serverNowAt via health / heartbeat)
       ├── Student Registration & Sequential RX30 Kiosk Passwords
       ├── Attempt Generation & Randomized Question/Option Ordering
       ├── Monotonic Replication Revisioning (lastReplicationRevision)
       ├── Sync Event Transactions & Idempotent Deduplication
       ├── Audit Log (SecurityEvent append-only stream)
       ├── Result Allocation & Marking
       └── Cross-Device Recovery & Reconciliation
```

The Web/PWA client operates as a supervised client node:
* **Clock Synchronization**: Periodically polls the server clock (`health().serverNowAt`) and computes client drift against high-resolution performance counters (`performance.now()`), preventing client clock manipulation.
* **Server-Assigned Identifiers**: Attempt IDs, device session IDs, and server revisions originate from or are validated by the authority.

---

## 3. Local-First Encrypted Client State

The Web/PWA maintains an authoritative local-first state stored inside device-isolated, encrypted IndexedDB (`pharmatrack_examination_state_v1`) using AES-GCM-256.

The local state preserves all mandatory invariants:
1. **Attempt Identifier**: Unique `attemptId` bound to the student and session.
2. **Exam Version**: Immutable version hash and question snapshots.
3. **Question Ordering**: Deterministic or randomized question order.
4. **Option Ordering**: Randomized per-question option index maps.
5. **Current Question**: Active question position pointer.
6. **Student Answers**: Selected options, typed answers, and timestamps.
7. **Answer Revisions**: Monotonically increasing revision numbers and unique event IDs per answer.
8. **Timer Snapshot**: Authoritative deadline timestamp and paused/running duration state.
9. **Security State**: Audit state (`NORMAL`, `WARNING`, `LOCKED`, `ADMIN_REVIEW`).
10. **Synchronization Revision**: Local revision and last confirmed server revision.
11. **Device / Session Identifier**: Authenticated `deviceSessionId` and `sessionId`.
12. **Pending Events**: Unacknowledged synchronization events queue.

---

## 4. Hard Invariant: SAVE-BEFORE-NEXT

Under no circumstances may the user interface advance to another question while an answer exists solely in transient UI memory:

```text
Student selects answer
        ↓
Enqueue local persistence transaction
        ↓
Durable write to encrypted IndexedDB succeeds
        ↓
Saved state confirmed (saveState = 'SAVED', savedQuestions.add)
        ↓
Question navigation allowed (goTo advances index)
        ↓
LAN synchronization continues asynchronously (syncEngine.flush)
```

If local persistence fails (e.g. disk storage quota exceeded), the interface displays `"Save problem — retrying"`, refuses to advance the question, and records a security audit entry.

---

## 5. Synchronization & Transaction Contract

### The Authority Transaction Pipeline
The examination authority never acknowledges an incoming synchronization event merely because the network layer received the payload. Every event must pass through the complete transaction pipeline:

```text
Receive HTTP Request
        ↓
Validate Protocol Version, Session, Epoch, Attempt Ownership, and Event Revisions
        ↓
Apply Transaction to In-Memory Attempt State
        ↓
Persist to Durable Encrypted State (await save())
        ↓
Update Replication Revision (session.lastReplicationRevision++)
        ↓
Append Audit Event (ANSWER_RECORDED / SYNC_RECONCILED)
        ↓
Return Acknowledgment (acknowledgedEventIds)
```

### Concurrency & Thread-Safety
To support large cohorts (e.g. 50+ concurrent students submitting answers simultaneously in a lecture hall or computer lab), the authority enforces an atomic transaction queue (`syncQueue`). Every batch of incoming sync events is executed sequentially without race conditions, deadlocks, or lost updates.

### Conflict Detection & Idempotency
* **Event Idempotency**: If an event with an already applied `eventId` is received again (e.g. following a dropped ACK or network retry), the authority recognizes the existing record, returns the event ID in `acknowledgedEventIds`, and does not re-apply the answer or increment revisions.
* **Revision Ordering**: If an incoming answer has a revision lower than or equal to the current authoritative answer (`current.revision >= incoming.revision`), the authority rejects it with `"A newer answer revision is already authoritative."`
* **Pure Reconciliation**: When differing answers share identical revisions, `reconcileAnswer` selects the winner deterministically (favoring later timestamps) and flags the conflict for proctor audit.

---

## 6. LAN Interruption & Resilience

If the local area network is severed or the server becomes temporarily unreachable:

1. **Uninterrupted Answering**:
   * Local answer persistence continues without interruption.
   * Answers are durably committed to encrypted IndexedDB.
   * Question navigation remains fully operational.
   * No answers are ever discarded or cleared.
2. **Event Buffering & Connection Status**:
   * `ExaminationSyncEngine` captures network failures.
   * Pending sync events remain buffered in the local queue (`pendingSyncEvents`).
   * UI status badge transitions from `SYNCHRONIZED` to `DEGRADED` (or `RECOVERY_PENDING` after 3 consecutive connection failures).
3. **Automatic Reconnection & Reconciliation**:
   * Periodic heartbeats (every 5 seconds) and sync flushes (every 4 seconds) probe the network.
   * When connectivity returns, `flush()` transmits all accumulated pending events in chronological revision order.
   * The server applies each event and returns acknowledgments, restoring the client to `SYNCHRONIZED`.

---

## 7. Submission Contract

### Final Submission Pipeline
When an examination attempt is finalized (either manually by the student or automatically upon timer expiry):

```text
Save currently active question locally
        ↓
Flush pending sync queue to authority
        ↓
Finalize authoritative attempt (authority.submitAttempt)
        ↓
Mark local attempt SUBMITTED (kioskLifecycle = 'SUBMITTED')
        ↓
Release kiosk restrictions (releaseSecureKiosk)
```

### Submission During Network Drops
If the network is unavailable when the student submits:
1. The local attempt is durably persisted as `SUBMITTED` (`synchronizationState = 'RECOVERY_PENDING'`).
2. A `SUBMISSION` sync event is pushed to the pending events queue.
3. Kiosk restrictions are released.
4. When the LAN connection recovers, the sync engine delivers both the final answers and the `SUBMISSION` event to the authority.
5. The authority transitions the attempt to `SUBMITTED`. Calling `authority.submitAttempt` is strictly idempotent and never creates duplicate submissions or duplicate result records.

---

## 8. Verification & Test Suite

The test suite in `src/test/examination-web-lan-sync.test.ts` validates all 8 mandatory LAN synchronization requirements:

1. **`web student connects`**: Student registers, authenticates via sequential RX30 Kiosk credentials, receives authoritative clock and session lease, and creates authoritative attempt on LAN server.
2. **`50 concurrent web students`**: 50 simultaneous web clients connect to a single LAN server authority, register attempts, and execute concurrent sync flushes (100 total answers) without data loss or race conditions.
3. **`LAN interruption`**: Network disconnect simulated via fetch interceptor; verifies SAVE-BEFORE-NEXT invariant, local answer persistence, question navigation, and event buffering.
4. **`reconnection`**: Network restored; buffered offline sync events flush in order, achieve server ACK, and transition client to `SYNCHRONIZED`.
5. **`duplicate events`**: Re-sending identical sync events returns ACK without duplicating answers or incrementing revision numbers.
6. **`conflicting revisions`**: Out-of-order stale revisions are rejected with conflict audit; deterministic timestamp reconciliation verified.
7. **`submission during reconnect`**: Attempt submitted offline; submission event buffered; reconnected flush updates server attempt to `SUBMITTED` idempotently.
8. **`device recovery`**: Complete recovery of all 12 local-first state invariants from encrypted storage following simulated browser crash and reconciliation with the LAN authority.
