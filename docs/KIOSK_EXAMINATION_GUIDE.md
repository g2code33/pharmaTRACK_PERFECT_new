# Kiosk examination — the complete run-book

This is the step-by-step guide for running a secure PharmaTRACK examination from
setup to archive. It answers two questions in one place: **what the LAN
authority is actually for**, and **how to start and manage a kiosk exam
completely**. The protocol internals live in
[LAN_EXAMINATION_SERVER.md](./LAN_EXAMINATION_SERVER.md); the HA/failover design
lives in [EXAMINATION_HIGH_AVAILABILITY.md](./EXAMINATION_HIGH_AVAILABILITY.md).

## What the LAN authority is for

During a real examination the invigilator's machine runs a small TCP server
(`src-tauri/src/lan_server.rs`, default port 8787). It is the **single source of
truth** for that exam:

| Responsibility | Why it matters |
| -------------- | -------------- |
| **Authoritative timers** | Every student's clock is anchored to the authority's start time, not their own device — a phone with the wrong time cannot gain minutes. |
| **One attempt per student** | The authority owns attempt IDs and device ownership, so a student cannot start a second attempt from a second device. |
| **Append-only journal** | Every answer and security event is fsynced to disk before it is acknowledged. Pull the power on the invigilator machine and the exam resumes with nothing lost. |
| **Recovery and reconciliation** | A student whose battery dies mid-exam gets a replacement device, reconnects with their identity, and continues from the authority's last accepted revision. |
| **Admin controls** | Pause, resume, ±5 minutes, force-submit, terminate and unlock are authority transactions — audit-logged, not local edits a student device could fake. |
| **Result release gate** | Scores exist in the authority; students only see them when the invigilator releases them (per policy: immediate, on-release, or never). |

Without it (single-device mode) the same encrypted kiosk runs against a local
authority on that one device — fine for practice, not acceptable when the exam
must be supervised, timed centrally, or recovered across devices.

## What you need

- **Invigilator/admin machine**: the installed PharmaTRACK app (Windows/Linux
  desktop build or Android build — *not* a browser tab; browsers cannot bind a
  TCP listener) on the examination Wi-Fi/LAN.
- **Student devices**: any device with PharmaTRACK (installed app, PWA, or
  browser on the same network).
- **A published exam**: a signed, immutable `.pharmaexam` package from the
  Examination Builder.

### The admin console is password-locked

Students run the same app as the invigilator, so the Admin Examination
Control Center asks for the **administrator password** before it shows
anything — sessions, results, and submitted work stay completely hidden
behind the lock screen. Unlocking applies to that tab only; a new tab always
starts locked, and **Lock console now** re-arms it instantly when you step
away.

- The console ships with the initial password and the **phantom PIN**
  (the second secret) seeded from `src/examination/adminGate.ts`. **Change
  both on first setup**: *Administrator access → Change console password*
  requires the current password *and* the phantom PIN.
- Only salted SHA-256 hashes are ever stored on the device — neither secret
  is kept in plaintext, and a change re-salts the record immediately.
- This gate protects the local console UI. The LAN authority itself has
  always exposed no admin routes, so students cannot control an exam from
  their devices regardless.

### Keep the host's address stable (recommended)

Routers may hand the invigilator machine a different IP after every restart.
Two defences, in order of strength:

1. **DHCP reservation** in the router (bind the machine's MAC address to one
   IP) or a **static IP** on the machine itself — one-time router setup.
2. **Discovery makes it not matter**: student apps broadcast on the Wi-Fi and
   find the authority wherever it currently lives (see Step 3), and the admin
   page auto-detects this machine's current address when starting. Students
   never type an IP on a properly run exam.

## Step 1 — Build and publish the exam (lecturer)

1. Open **Examinations → Builder**.
2. Build the paper from the Question Bank, set duration, marks, security
   (kiosk mode, required capabilities, `requireLanAuthority`), and the result
   visibility policy.
3. Click **Publish and download .pharmaexam**. Publishing freezes the exact
   text, options, marks and security into a signed, immutable version. Distribute
   that one file — e-mail, shared folder or USB — to students (or load it on
   each machine yourself).

> Only published versions can have sessions. Drafts cannot be examined.

## Step 2 — Create the session (invigilator)

The LAN authority serves **one session**, and a session is created the moment a
`.pharmaexam` is opened on a device:

1. On the invigilator machine open **Examinations → Kiosk Entry**.
2. Load the `.pharmaexam` package (click or drag-and-drop). It validates the
   signature and shows the version and question count.
3. You do **not** need to enter as a student: opening the package and having the
   admin page pick the session up is enough. (Registering a student identity and
   entering is what *students* do in Step 4.)

The **Admin Examination Control Center** (Examinations → Admin) now shows the
session under *Examination*.

## Step 3 — Start the LAN authority (invigilator)

On the same machine, in **Admin Examination Control Center → Production LAN
examination server**:

1. **Advertised LAN host/IP** is auto-filled with this machine's Wi-Fi address
   (a `detect_lan_host` command asks the OS for the route address). Verify it is
   the address on the *examination* network; edit it if the machine has several
   adapters.
2. Check the status line above the buttons:
   - `✓ Native host ready` — you are in the installed app.
   - `✓ Session session_…` — the session from Step 2 exists.
   If either shows ⚠, the button will tell you exactly what to do when clicked —
   it is never silently disabled.
3. Optionally tick **Open enrollment**. With it on, student apps on the
   examination Wi-Fi receive the session token via the discovery broadcast and
   join with **zero typing** — their student identity and the exam password
   still gate entry, and the token only ever authorizes student session routes
   (the authority exposes no admin routes), so broadcasting it cannot hand out
   control. Be aware the LAN protocol is plain HTTP with signed requests, so
   the token is no more secret on the board than on the wire; leave enrollment
   closed if your policy requires the token to be typed.
4. Click **Start LAN authority**. The panel shows the endpoint
   (`http://<host>:8787`), the discovery endpoint, and the **session token**.
   Write the exam password on the board — that is now the only thing a student
   may ever need to type (and with discovery, not even the endpoint).

## Step 4 — Students enter the kiosk

On each student device:

1. Open **Examinations → Kiosk Entry** (or launch the app via the
   `.pharmaexam` file — file association opens the kiosk directly).
2. Load the same `.pharmaexam` package.
3. **Identity**: first-time users click *First-time registration* (first name +
   level → a one-time RX30 kiosk password is generated). Returning students
   type their name and password.
4. The app **finds the authority automatically** by broadcast (installed app
   or Android build): one authority → endpoint and, with open enrollment, the
   session token are filled in with zero typing; several → pick from a list;
   none found (or in a plain browser) → type the endpoint/token from the board.
   Enter the **exam password** if the paper has one.
5. Click **Run readiness checks** — package validity, encrypted storage,
   capability policy, LAN reachability. The *Enter secure examination* button
   unlocks only when the required checks pass (a hint states this while it is
   locked; it never unlocks silently).
6. **Enter secure examination** → the device locks into the secure kiosk for
   the attempt.

## Step 5 — Manage the exam live (invigilator)

In the Admin Control Center (it refreshes every 5 seconds):

- **Authenticate admin device** once — every control you touch afterwards is
  audit-logged with your admin identity and reason.
- The **students and attempts** list shows each student's progress, device,
  sync state and remaining time.
- Per student: **Pause / Resume / +5 min / −5 min / Unlock / Force submit /
  Terminate**.
- **Server authority / Primary and secondary authority** cards show epoch,
  lease and replication state. Failover to the secondary is a *confirmed*
  action (never automatic — that is what prevents split-brain).
- The **append-only audit trail** records every security event and admin
  action; it cannot be edited from the UI.

If the Wi-Fi drops mid-exam: nothing stops. Students keep working against their
encrypted local state; when the network (or a replacement authority) returns,
events reconcile against the journal. See
[EXAMINATION_HIGH_AVAILABILITY.md](./EXAMINATION_HIGH_AVAILABILITY.md).

## Step 6 — Release results and archive

1. Under **Examination-wide results**: select students (or use select-all) and
   **Release** / **Keep Hidden** per the paper's policy. Releasing changes
   visibility only — never scores.
2. **Archive examination** when everyone is done: results and the audit history
   are retained; the session is closed.

## Where the admin sees results and submitted work — at any time

Students answer on their own devices; the authority (the invigilator's
machine) is the record of what happened. The **Admin Examination Control
Center** pulls that record onto the invigilator's device:

- **Automatically, while the authority runs.** Every refresh (the page polls
  every 5 seconds) imports the authority's full view of the session — every
  submitted attempt, each student's answers question by question, and the
  audit trail — into this device's encrypted examination store. **Import work
  from the LAN authority** does the same on demand and reports any error
  verbatim.
- **Scores** appear in the *Examination-wide results* table as soon as an
  attempt is submitted: score, maximum, percentage, answered/unanswered, and
  the submission time.
- **The work itself.** **Review work** on any row shows every question with
  the text, the option or text the student actually submitted, the correct
  answer, the marks awarded, and the security summary for that attempt. This
  is the evidence base for a regrade appeal or an academic-integrity review.
- **Any time, including after the exam is long over.** The *Viewing
  examination* picker at the top lists every session ever administered on
  this device — live ones first, closed/archived ones forever after. Pick any
  past session to see its results and work again. Imported results live in
  this device's encrypted local store, so they survive app restarts.

Two honest limits: the import happens while the authority is running (or can
be triggered from it) — an attempt submitted to an authority that is already
stopped and never imported stays in that authority's journal file on disk
until the authority is started again — and the review shows questions in the
version's canonical order, because each student's on-device shuffle seed
lives on the student's device, not on the authority.

## Client lockdown (what a student device cannot do)

During a secure examination the device is locked down in layers:

- **Devtools shortcuts are cancelled**: F12, Ctrl+Shift+I/J/C, Ctrl+U — the
  keydown is prevented *and* the attempt is written to the audit trail. In the
  packaged app devtools are additionally compiled out of production builds and
  the native command is refused while an exam is active.
- **Copy resistance**: right-click, copy/paste/cut, printing, and dragging
  content out of the exam are blocked; text selection is disabled everywhere
  except the answer inputs the student must type into.
- **The webview cannot be escaped**: navigation is gated to the exam route
  (attempts are audited), the native kiosk holds fullscreen/always-on-top on
  desktop, and the Android build applies its native kiosk adapter.

The honest boundary, as always: browser-level blocking raises the bar but is
not unbreakable on its own — which is exactly why every answer event is signed
and revision-checked by the authority, so tampered traffic is rejected and
logged rather than trusted.

## No single point of failure

- **Local-first answers**: every answer is written to the student device's
  encrypted local storage *before* anything is sent to the network. Pull the
  Wi-Fi mid-exam and students keep working; nothing is lost.
- **Queued sync with automatic flush**: answer events queue locally and flush
  to the authority on every answer, every timer tick, on reconnect (`online`),
  on page visibility, and on the native resume event (a device that slept
  through a network drop flushes the moment it wakes).
- **Authority journal**: the invigilator machine keeps an append-only fsynced
  journal — crash or power-cut, restart and it replays every accepted event.
- **Confirmed failover**: a secondary authority can be promoted by explicit
  admin confirmation (never automatically — that is the split-brain guard);
  300-student failover and reconciliation are covered by the HA test suite.

## Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| "Start LAN authority" does nothing | It never silently fails. Click it — the message names the blocker: browser preview (use the installed app), no session (open the `.pharmaexam` on Kiosk Entry first), or an empty host (fill the machine's Wi-Fi IP). |
| Students cannot connect | The advertised host must be the invigilator machine's address **on the examination network**, and student devices must be on that same network. Check the endpoint on the board against the status panel. |
| Port already in use | Another authority is still running (previous exam). **Stop** it first, or reboot the machine — the journal replays on restart. |
| Student's "Enter" button locked | A required readiness check failed — the amber hint says which one (bad package, no encrypted storage, unreachable authority…). |
| App window blank after switching away | The resume-repaint recovery forces a fresh frame on focus; if it ever stays blank for more than ~1 second the app reloads itself automatically. |

## Rollback / disaster notes

- The authority journal is append-only and fsynced; restarting the invigilator
  machine replays it — no exam is lost to a power cut.
- Student devices keep encrypted local recovery state, so a dead battery or a
  replacement device continues from the last acknowledged revision.
- Every admin action (pause, release, archive…) is in the audit trail with
  identity, device, reason and epoch.
