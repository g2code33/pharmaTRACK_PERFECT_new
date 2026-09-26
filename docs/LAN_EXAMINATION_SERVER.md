# Production LAN examination server

PharmaTRACK formal examinations remain offline/LAN-first. The authorized admin/examination Tauri host is the authority; student PC and Android clients use the existing `LanExamClient` transport over the same LAN or Wi-Fi.

## Runtime architecture

- `src-tauri/src/lan_server.rs` binds a real TCP listener (default port `8787`) on `0.0.0.0`. It is not a browser mock and does not require a cloud service.
- `src/examination/lanServer.ts` starts and stops that listener through Tauri commands and stages the immutable exam package and session metadata.
- `src/examination/network.ts` is the shared client contract for PC WebView, Android WebView/native adapter, and the admin dashboard.
- The native authority stores an append-only, fsynced journal under the Tauri application data directory. On restart it replays accepted transactions before serving requests.
- A UDP discovery responder listens on the port immediately above the HTTP port for `PHARMATRACK_EXAM_DISCOVER`. Clients may also use the displayed LAN endpoint directly.

The normal browser preview intentionally cannot claim to be a LAN server: only the authorized Tauri runtime can bind the local network listener.

## Connection flow

1. Admin opens an immutable published version and starts **Production LAN examination server**.
2. The host binds the LAN listener, generates a high-entropy session token, and displays the endpoint, discovery endpoint, and token for controlled distribution to examination devices.
3. A student stages and validates the signed `.pharmaexam` package, authenticates the existing local kiosk identity, and enters the session endpoint/token.
4. `POST /pharmaexam/v1/sessions/{sessionId}/connect` authenticates the session token and creates or resumes a device session bound to the student identity.
5. The client creates/resumes one attempt. The server owns the attempt ID, device ownership, status, authoritative revision, and submission state.
6. Package delivery is a pre-exam `GET .../package`; answer traffic uses compact events rather than retransmitting the package.

Requests use the session token plus a SHA-256 request signature over method, path, and body. Event IDs, device sessions, authority epoch, and attempt ownership provide replay and split-brain checks. The token is kept in encrypted examination state when a client must reconnect; it is not placed in normal Quiz history or cloud accounts.

## Event lifecycle and ACK guarantee

For every sync event the authority performs:

```text
receive
  -> authenticate token/signature
  -> validate session and protocol
  -> validate authority epoch
  -> validate attempt ownership and connected device session
  -> validate event ID, revision, question and payload
  -> apply the answer/security mutation in the authority transaction
  -> append audit/security data
  -> fsync the journal
  -> update server revision and in-memory authority state
  -> return ACK
```

The native server never acknowledges an event before `sync_all()` succeeds. The browser/local authority uses the same contract through `ExaminationRepository.processIncomingSyncEvents`. If persistence fails, no event ID is returned in `acknowledgedEventIds`; the student queue remains retryable.

Duplicate event IDs return the prior accepted revision without applying the answer or incrementing the revision. Stale answer revisions and wrong device/attempt ownership return deterministic conflicts and are not acknowledged. Newer answers are never silently overwritten.

## Offline and reconnect behavior

- Student answer navigation still requires encrypted local persistence first.
- LAN sync is asynchronous after that local save; a LAN outage does not block navigation.
- Pending compact events stay in the encrypted local examination state.
- Heartbeats are separate from answer synchronization and update connection/last-seen state only.
- Reconnect resends pending events. The authority applies only unseen valid IDs, then the client marks them applied after the authority response.
- A disconnected client keeps its encrypted recovery copy. The authority does not infer submission from transport loss.
- The attempt timer remains authority-based; local display uses the last received authority clock and never grants time because of a disconnect.

## Security boundaries and limitations

- Student kiosk credentials remain PBKDF2 verifiers; plaintext passwords are not persisted.
- LAN session tokens are bearer secrets and must be distributed only by the examination administrator. Request signatures provide integrity and event replay protection; the current native transport is intended for the controlled examination LAN, not an untrusted public network.
- The server is the authority while reachable. Device-local encrypted state is the recovery authority only during permitted offline operation.
- Browser PC and Android WebView APIs cannot guarantee OS-level developer-tool, screen-capture, or process lockdown. The existing capability matrix reports enforceability honestly; native Android/Tauri adapters are used where platform APIs exist.
- Automatic failover remains disabled. The existing HA coordinator requires explicit promotion and reconciliation to prevent split-brain.
- Apple/macOS and Safe Exam Browser are not part of this runtime.
