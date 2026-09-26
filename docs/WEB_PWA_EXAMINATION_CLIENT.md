# PHARMATRACK — Web/PWA Examination Client

## Overview

The PharmaTRACK Web/PWA Examination Client extends the existing Secure Examination Engine to execute full, supervised course examinations directly in modern web browsers and Progressive Web Apps (PWAs). It avoids duplicate engines by reusing the exact core data models, cryptographic primitives, and execution flow:

* **Exam** & **ExamVersion**: Immutable version snapshots with cryptographic SHA-256 hashes and ECDSA P-256 signatures.
* **ExamSession**: Authoritative LAN or local examination sessions with heartbeat monitoring and lease tracking.
* **Student** & **StudentAttempt**: Sequential RX30 credential identities and attempt-owned timers surviving device transitions.
* **ExamQuestion** & **ExamAnswer**: Question snapshots, options, randomized orders, and revisioned answer records.
* **Timer**: Authoritative duration tracking independent of device clock manipulation.
* **Sync & Recovery**: Local-first answer queuing, idempotent server synchronization, and crash recovery.
* **Results**: Deterministic grading, marks allocation, and Quiz history export.
* **SecurityEvent**: Full audit logging of exits, navigation blocks, focus changes, and sync status.
* **`.pharmaexam`**: Signed and sealed ZIP archive packages with SHA-256 file digests.
* **Question Renderer**: Reused from Quiz mode with question cards, option bubbles (A, B, C, D), progress bars, and navigation.

---

## 1. Platform Identification & Capability Boundaries

### Platform Identification
The web examination client explicitly identifies itself to the system as:
```text
platform = 'web'
```
while preserving existing platform adapters:
```text
native-pc   (Tauri PC native kiosk)
android     (Android native kiosk with PharmaTRACKAndroidKiosk host bridge)
```

### Honest Security Capability Reporting
Web browsers operate inside sandboxes and cannot manipulate host operating system windows or intercept global hotkeys without native application bridges. The client explicitly identifies its capabilities and never falsely claims OS lockdown:

| Capability ID | Description | Web Support | Enforceable | Level | Notes |
| :--- | :--- | :---: | :---: | :--- | :--- |
| `navigation` | PharmaTRACK navigation block | Yes | Yes | `SUPPORTED` | Normal application navigation omitted; route gates active. |
| `copy-paste` | Copy & paste restriction | Yes | Yes | `SUPPORTED` | Clipboard shortcuts (Ctrl+C, Ctrl+V, context menu) prevented in-page. |
| `printing` | Print restriction | Yes | Yes | `SUPPORTED` | Print shortcut (Ctrl+P) and `beforeprint` event blocked in-page. |
| `external-links` | External link restriction | Yes | Yes | `SUPPORTED` | Cross-origin link clicks intercepted and prevented. |
| `focus` | Window focus loss detection | Yes | No | `NOT_GUARANTEED` | `blur` and `visibilitychange` audited; browser can be obscured. |
| `immersive` | Fullscreen request | Yes | No | `NOT_GUARANTEED` | HTML5 Fullscreen API requested; escape key controlled by browser. |
| `window-controls` | Window manipulation restriction | **No** | **No** | `UNAVAILABLE` | Browser cannot prevent minimize, close, or OS task switching. |
| `screen-capture` | Screen capture restriction | **No** | **No** | `UNAVAILABLE` | Browser cannot prevent OS-level screenshots or screen capture. |
| `lock-task` | OS lockdown / Lock-task | **No** | **No** | `UNAVAILABLE` | OS lockdown requires native Tauri or Android Device Owner host bridge. |
| `file-association` | OS-level file associations | **No** | **No** | `UNAVAILABLE` | Browsers use standard file selection flow without OS associations. |

---

## 2. Web Examination Flow

The client implements the complete required workflow:

```text
PharmaTRACK Web/PWA
        ↓
Quiz (/quiz)
        ↓
Kiosk (/examinations/kiosk)
        ↓
Choose .pharmaexam (Browser file selection / drag-and-drop)
        ↓
Validate package (Integrity check, digest verification, signature verification)
        ↓
Connect to examination session where required (LAN endpoint + token OR local authority)
        ↓
Student identity (First Name, Level 100–600, RX30 Kiosk password)
        ↓
Exam readiness check (Package, version, encrypted storage, crypto, storage quota, capabilities)
        ↓
Enter Examination (/examination/secure/:attemptId)
```

### Browser File Selection Flow
Browsers cannot reliably register `.pharmaexam` file extensions with desktop operating systems. The web client provides:
* File input accepting `.pharmaexam`, `.zip`, and `application/zip`.
* Drag-and-drop zone with visual feedback for desktop, laptop, and tablet users.
* Direct byte reading via `Blob.arrayBuffer()` and `Uint8Array`.
* Immediate cryptographic verification and local encrypted staging via `stagePharmaExamPackage`.

---

## 3. Offline Architecture & LAN Operation

1. **Pre-Exam Package Caching**:
   * As soon as a `.pharmaexam` package is chosen and validated, it is cached in local encrypted storage (`idb-keyval` AES-GCM-256) under key `pharmatrack_staged_pharmaexam_v1`.
   * Staged package survives page reloads, tab closure, and network disconnects.
2. **Zero Reliance on Internet**:
   * During an active LAN examination, the client communicates strictly with the local LAN server authority (e.g. `http://192.168.1.100:8787`) or operates as a standalone local exam authority (`LocalExamAuthority`).
   * No calls to public cloud servers, Supabase, or external CDNs occur during the exam.
3. **Local Encrypted Answer Persistence**:
   * Every answer choice is recorded into encrypted IndexedDB storage before any UI navigation or sync queueing.
   * If the local LAN drops or experiences packet loss, the client shifts to `DEGRADED` sync state and buffers answers locally.
   * When LAN connectivity returns, queued sync events flush automatically without student interruption.

---

## 4. UI Design & Quiz Mode Reuse

The examination UI reuses the battle-tested Quiz examination design from `src/pages/Quiz.tsx`:

* **Question Cards**:
  * White container with subtle borders and elevation (`rounded-2xl bg-white border border-slate-100 shadow-md p-5 sm:p-8`).
  * Badge row: Question type tag (`Multiple Choice`, `Short Answer`, `Structured`) and marks allocation (`X marks`).
  * Question text in high-legibility typography.
* **MCQ Option Selection**:
  * Option cards with circular letter badges (`A`, `B`, `C`, `D` ...).
  * Selected state: Emerald border, tinted background, and solid badge (`border-emerald-600 bg-emerald-50 text-slate-900` + `bg-emerald-600 text-white`).
  * Unselected state: Slate border and subtle hover feedback (`border-slate-200 hover:bg-slate-50 text-slate-700`).
* **Progress & Numbering**:
  * "Question X of Y" label with visual percentage progress bar.
* **Authoritative Timer**:
  * Authoritative countdown timer bound to session epoch.
  * Transitions to warning styling with pulsing red badge under 5 minutes remaining (`< 300` seconds).
* **Save & Sync Status**:
  * Real-time badges for `SAVED`, `SAVING…`, `Save problem — retrying`.
  * Real-time connection badge for `Synchronized` vs `LAN Reconnecting`.
* **Save-Before-Navigation**:
  * Moving to Previous, Next, or jumping to any question via the question navigator executes `saveCurrentBeforeNavigation()` to commit edits before changing index.
* **Submission Flow**:
  * Prominent "SUBMIT EXAM" action with confirmation prompt.
  * Final submission reconciles local answers, flushes sync, and logs audit events.
  * Submission confirmation view with "Return to Quiz" button.

### Multi-Device Responsiveness
* **iPhone & Android Mobile (< 640px)**:
  * Compact header with timer and save badge.
  * Full-width question card with touch-optimized targets (`min-h-[52px]`).
  * Clean question navigator row below card for thumb navigation.
* **Tablets & iPads (640px – 1024px)**:
  * Comfortable reading layout with adaptive margins and touch-friendly controls.
* **Desktop (> 1024px)**:
  * Two-column grid (`lg:grid-cols-[1fr_280px]`): Main question workspace on the left, sticky question grid and submit panel on the right.

---

## 5. Verification & Test Suite

The test suite in `src/test/examination-web-client.test.tsx` tests the complete feature set:

1. **Platform Identity**: Confirms `platform = 'web'`, verifies honest matrix capability flags, and ensures native PC and Android adapters remain uncorrupted.
2. **`.pharmaexam` Loading**: Verifies browser file selection flow with `.pharmaexam` files and rejection of tampered archives.
3. **Offline Caching**: Confirms pre-exam package caching in encrypted IndexedDB and recovery after restart.
4. **Student Authentication**: Confirms sequential RX30 passwords, authentication, and duplicate name constraints.
5. **Lifecycle & Persistence**: Starts attempt, records answers, verifies timer, executes save-before-navigation, and completes submission.
6. **Network Resilience**: Proves zero reliance on internet during LAN interruption and sync event recovery.
7. **Readiness Check**: Confirms capability failure policies (`ALLOW_WITH_WARNING` vs `PREVENT_START`).
8. **UI Component Rendering**: Tests question card, MCQ option letters (A, B, C, D), progress bar, timer, save status, and responsive layout.

**Suite Results**:
* 63 of 63 test files passing.
* 622 of 622 tests passing.
* Full TypeScript compilation and production bundle build passing cleanly.
