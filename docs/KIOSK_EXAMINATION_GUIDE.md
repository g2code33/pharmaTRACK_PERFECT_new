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
3. Click **Start LAN authority**. The panel shows the endpoint
   (`http://<host>:8787`), the discovery endpoint, and the **session token**.
4. Give the students two things (write them on the board): the **endpoint** and
   the **session token**. Devices on the same Wi-Fi discover the server
   automatically via UDP; the explicit endpoint always works as a fallback.

## Step 4 — Students enter the kiosk

On each student device:

1. Open **Examinations → Kiosk Entry** (or launch the app via the
   `.pharmaexam` file — file association opens the kiosk directly).
2. Load the same `.pharmaexam` package.
3. **Identity**: first-time users click *First-time registration* (first name +
   level → a one-time RX30 kiosk password is generated). Returning students
   type their name and password.
4. Enter the **LAN authority endpoint** and **session token** from the board,
   and the **exam password** if the paper has one.
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
