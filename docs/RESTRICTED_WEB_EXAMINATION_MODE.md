# PHARMATRACK — RESTRICTED WEB EXAMINATION MODE

## 1. Overview & Architectural Philosophy

PharmaTRACK Restricted Web Examination Mode implements the strongest technically available browser-level examination restrictions for modern web browsers and Progressive Web Apps (PWAs). 

A core principle of PharmaTRACK's security architecture is **strict honesty regarding platform boundaries**:
* **Browser Restrictions**: Enforced via standard Web APIs, DOM event isolation, and central application routing.
* **Native OS Lockdown**: Enforced via native host platforms (Tauri PC window manipulation and Android Device Owner / Lock Task mode).
* **Clear Distinction**: The web client **never fakes** native OS capabilities or misrepresents browser capabilities to proctors, administrators, or examination engines.

---

## 2. Browser Restrictions vs. OS Lockdown Boundary

A standard web browser or Progressive Web App executes within an operating system user-space sandbox. The table below delineates what can be enforced within the browser sandbox versus limitations inherent to the web platform:

| Security Domain | Browser / PWA Capability | Native OS Lockdown Capability | Status in Web Mode |
| :--- | :--- | :--- | :--- |
| **PharmaTRACK Navigation** | Blocked via `SecureExamRouteGate` & `Layout` redirects | Blocked at native UI / window level | **Fully Enforced** (`SUPPORTED`) |
| **PharmaTRACK AI Engine** | Completions blocked in `AIManager`, UI disabled in `AIChatPanel` | N/A | **Fully Enforced** (`SUPPORTED`) |
| **Academic Notes & Materials** | Routes (`/notes`, `/materials`, `/library`, `/archive`, `/read`) blocked | N/A | **Fully Enforced** (`SUPPORTED`) |
| **External Hyperlinks** | Cross-origin links intercepted and default-prevented | Outbound network firewall / URL filter | **Fully Enforced** (`SUPPORTED`) |
| **New Windows / Tabs** | `window.open` overridden and blocked | Process / popup creation blocked | **Fully Enforced** (`SUPPORTED`) |
| **In-Page Clipboard** | `copy`, `cut`, `paste`, Ctrl+C/V/X/S/U, context menu blocked | OS clipboard isolation | **Fully Enforced** (`SUPPORTED`) |
| **In-Page Printing** | Ctrl+P and `beforeprint` event blocked | OS spooler / printer driver disabled | **Fully Enforced** (`SUPPORTED`) |
| **Accidental Navigation** | Intercepted via `beforeunload`, `hashchange`, `popstate` | Browser window close button disabled | **Fully Enforced** (`SUPPORTED`) |
| **Window Focus Loss** | Audited via `blur` & `focus` events | OS task switcher disabled | **Observable / Audited** (`NOT_GUARANTEED`) |
| **Tab / Page Visibility** | Audited via `visibilitychange` (`hidden`/`visible`) | OS process virtualization | **Observable / Audited** (`NOT_GUARANTEED`) |
| **Page Transitions** | Audited via `pagehide` & `pageshow` | Process suspension controls | **Observable / Audited** (`NOT_GUARANTEED`) |
| **Fullscreen Mode** | Requested via HTML5 Fullscreen API; exit audited | Immersive kiosk window without exit controls | **Observable / Audited** (`NOT_GUARANTEED`) |
| **OS Screenshot Prevention** | **Unavailable** in standard web browser / PWA sandbox | OS display flags (`FLAG_SECURE`, desktop API) | **UNAVAILABLE** (Honest) |
| **OS Screen Recording Prevention** | **Unavailable** in standard web browser / PWA sandbox | OS capture detection / DRM surface | **UNAVAILABLE** (Honest) |
| **OS App Switching (Alt+Tab)** | **Unavailable** in standard web browser / PWA sandbox | OS task switcher suppressed | **UNAVAILABLE** (Honest) |
| **Mobile Home Gestures** | **Unavailable** in standard web browser / PWA sandbox | Android Lock Task / Pinning | **UNAVAILABLE** (Honest) |
| **OS Keyboard Shortcuts** | **Unavailable** (Win key, Ctrl+Alt+Del, Cmd+Tab) | Low-level OS keyboard hook | **UNAVAILABLE** (Honest) |
| **Browser Process Termination** | **Unavailable** (User can kill browser via Task Manager) | System service watchdog | **UNAVAILABLE** (Honest) |
| **Secondary Physical Devices** | **Unavailable** (Cannot prevent phones, tablets, or notes) | Physical in-person proctoring | **UNAVAILABLE** (Honest) |

---

## 3. Active Examination Restrictions

When an examination attempt is active (`kioskState.active === true`):

### Central Navigation & Route Blocking
1. **Central Route Gate (`SecureExamRouteGate`)**:
   * Evaluates every route change in the single-page application.
   * If any path other than `/examination/secure/:attemptId` is navigated to, the attempt is immediately redirected back to the active secure examination.
   * Records a `NAVIGATION_BLOCKED` security violation in the repository audit log.
2. **Navigation UI Suppression (`Layout`)**:
   * The sidebar, top bar, and mobile navigation menus are never rendered.
   * Attempting to render the app layout immediately executes a `<Navigate to="/examination/secure/:attemptId" replace />`.
3. **Accidental Navigation Guard**:
   * Registers a `beforeunload` listener that prompts the student and emits an `ATTEMPTED_EXIT` security violation.
   * Registers `hashchange` and `popstate` listeners that restore the exam hash URL and emit `ATTEMPTED_NAVIGATION`.

### Total Resource Isolation
* **AI Engine Blocking**: `AIManager.execute()` inspects the central kiosk state before preparing any chain. If an exam is active, it immediately aborts with an `AIEngineError` (`PROVIDER_ERROR`: `"AI completion is disabled during an active examination."`).
* **AI Chat UI Blocking**: `AIChatPanel` detects the active exam, renders a prominent warning banner (`"PharmaTRACK AI is disabled during an active examination."`), and disables the message textarea and send button.
* **Academic Notes Blocking**: Route `/notes` is in the `blockedRoutes` manifest and intercepted by `SecureExamRouteGate`.
* **Study Materials & Readers Blocking**: Routes `/materials`, `/library`, `/archive`, and `/read/*` are intercepted and blocked.
* **External Navigation Blocking**:
  * Event listener on document intercepts all click events on `<a>` tags. Cross-origin hyperlinks have `preventDefault()` invoked and emit `EXTERNAL_LINK_ATTEMPT`.
  * `window.open` is overridden during the exam session to prevent spawning new tabs or popups.

### In-Page Clipboard & Developer Key Guard
* Event listeners on `copy`, `cut`, `paste`, and `contextmenu` call `preventDefault()` and emit `ATTEMPTED_COPY_PASTE`.
* Keyboard listener intercepts shortcuts:
  * Ctrl/Cmd + C, V, X, S, U, A (copy, cut, paste, save, view-source, select-all).
  * Ctrl/Cmd + P (printing).
  * F12 and Ctrl+Shift+I/J/C (developer tools).

---

## 4. Lifecycle & Focus Monitoring

Web browsers cannot lock the user out of the OS window manager, but they provide rich lifecycle events that PharmaTRACK audits:

* **`blur` / `focus`**: Monitors when the examination window loses or regains OS window focus.
* **`visibilitychange`**: Detects when the user switches tabs or minimizes the browser (`document.visibilityState === 'hidden'`). Emits `VISIBILITY_CHANGE` or `RECOVERY`.
* **`pagehide` / `pageshow`**: Detects back-forward cache suspension or backgrounding on mobile browsers. Emits `PAGE_HIDDEN` or `RECOVERY`.
* **`fullscreenchange`**: Detects when fullscreen mode is exited. Emits `FULLSCREEN_EXIT`.

### Non-Puntative Proportional Policy Architecture
PharmaTRACK recognizes that harmless background notifications, OS alerts, or accidental trackpad gestures can cause momentary focus loss. **The system never automatically force-submits an examination on a single harmless focus event.**

Administrators configure fine-grained violation policies in the examination package:
* **`LOG` / `LOG_ONLY`**: Logs an `info` security event in the durable audit log; leaves the attempt active with zero student penalty.
* **`WARN` / `WARNING`** *(Default)*: Logs a `warning` security event; increments `attempt.focusLosses`; updates `attempt.securityState = 'WARNING'`; student continues uninterrupted.
* **`LOCK` / `LOCK_TEMPORARILY`**: Transitions `attempt.status = 'LOCKED'`; student cannot continue until unlocked.
* **`ADMIN_INTERVENTION` / `REQUIRE_ADMIN_UNLOCK`**: Transitions `attempt.status = 'LOCKED'` with `securityState = 'ADMIN_REVIEW'`, requiring proctor intervention.
* **`FORCE_SUBMIT`**: Only triggered if the administrator **explicitly configured** this aggressive policy for the violation type. Immediately saves answers, flushes sync, and marks the attempt `SUBMITTED` (`trigger: 'ADMIN_FORCE'`).

---

## 5. Fullscreen Mode Handling

1. **Start Request**: When entering the examination, `adapter.requestFullscreen()` requests fullscreen mode via the HTML5 Fullscreen API where supported.
2. **Exit Detection**: When the user exits fullscreen (e.g. via Escape or gesture), `FULLSCREEN_EXIT` is audited.
3. **Re-entry Action**: The examination header displays an actionable notification banner:
   > **Fullscreen exited:** Fullscreen mode is recommended for this secure examination. [Return to Fullscreen]
   Clicking the button immediately re-engages fullscreen via a direct user gesture.

---

## 6. Student Submission Contract

### 1. Password-Free Student Submission
The examination submission contract specifies that **a student who has finished answering their exam must NEVER be blocked by an exit password**.
* When the student clicks **"Submit Exam"**, confirmation is requested.
* Upon confirming, `finalizeSubmission(false, 'MANUAL')`:
  1. Saves the currently edited question.
  2. Flushes the sync queue to the LAN or local authority.
  3. Transitions attempt to `SUBMITTED`.
  4. Releases all browser restrictions via `releaseSecureKiosk()`.
  5. Logs `SUBMITTED` security event: `"Student submitted after save and synchronization reconciliation; no password was requested."`
* Early exit passwords (such as `verifyAdminExitPassword`) apply **only** to unauthorized early session termination or student aborts, **never** to standard exam completion.

### 2. Authoritative Automatic Submission on Expiry
* Duration is authoritative and tracked independent of device clock tampering via `attempt.timerState`.
* When remaining time reaches zero (`remaining <= 0`):
  * The timer automatically invokes `finalizeSubmission(true, 'EXPIRY')`.
  * The attempt is submitted with `submissionTrigger: 'EXPIRY'`.
  * No password or manual action is required from the student.

---

## 7. Crash Recovery & Offline Resilience

* **Browser Reload Recovery**: If a student refreshes or reloads the browser tab, `sessionStorage` restores the active kiosk mode (`SECURE_EXAM_ACTIVE`). The attempt, question order, existing answers, and authoritative deadline are restored from local encrypted IndexedDB.
* **Offline Resilience**: During LAN network drops or offline operation:
  * Answers continue saving to encrypted local IndexedDB (`pharmatrack_examination_state_v1`).
  * `saveState` displays `SAVED` immediately after local commit.
  * Synchronization engine buffers events and reconciles them automatically when connectivity resumes.
