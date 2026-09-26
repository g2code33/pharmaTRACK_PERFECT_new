# PHARMATRACK — CENTRAL PLATFORM SECURITY CAPABILITY MATRIX

## 1. Executive Summary & Purpose

The PharmaTRACK Examination Network enforces a strict, honest security capability model. Different operating systems and deployment runtime targets provide fundamentally different security boundaries:
* **PC Native (Tauri)**: Provides window control locks, fullscreen enforcement, and local API command restrictions, but cannot claim kernel-level OS lockdown without dedicated OS kiosk shells.
* **Android Native (Host Bridge)**: Provides hardware key pinning via `startLockTask()`, screenshot/screen-recording blocking via `FLAG_SECURE`, and intent filtering, but relies on device owner provisioning for silent task pinning.
* **Web (Desktop/Laptop Browsers)**: Operates within the browser sandbox; enforces route locks, DOM clipboard and printing restrictions, and focus monitoring, but cannot block OS shortcuts or window close.
* **iPhone PWA (Mobile Safari / Standalone WebKit)**: Runs in standalone home-screen mode with safe-area layouts, but cannot block OS screenshots, home indicator swipes, or app switching.

Under no circumstances does PharmaTRACK make false security claims or label browser or desktop sessions as "unbreakable". Every security control is rated strictly:
* **`SUPPORTED`**: Guaranteed and fully enforceable by the platform host.
* **`LIMITED`**: Partially enforceable, heuristic, or requiring external MDM/OS policy.
* **`UNAVAILABLE`**: Cannot be guaranteed by userspace software without making false claims.

---

## 2. Central Capability Report Table

| # | Security Control | PC Native (Tauri) | Android Native (Host Bridge) | Web (Desktop/Laptop) | iPhone PWA | Platform Boundary & Technical Rationale |
|---|---|:---:|:---:|:---:|:---:|---|
| **1** | **Application Route & Navigation Block** | **SUPPORTED** | **SUPPORTED** | **SUPPORTED** | **SUPPORTED** | Internal router gates block navigation away from `/examination/secure`. Native webviews veto URL changes. |
| **2** | **Copy, Cut & Paste Restriction** | **SUPPORTED** | **SUPPORTED** | **SUPPORTED** | **SUPPORTED** | DOM clipboard events (`copy`, `cut`, `paste`) and key combinations (Ctrl/Cmd+C/V/X) are intercepted and audited. |
| **3** | **Print Restriction** | **SUPPORTED** | **SUPPORTED** | **SUPPORTED** | **SUPPORTED** | `beforeprint` events, print stylesheets, and shortcuts (Ctrl/Cmd+P) are blocked across all platforms. |
| **4** | **External Link & URL Restriction** | **SUPPORTED** | **SUPPORTED** | **SUPPORTED** | **SUPPORTED** | `window.open` is suppressed; native Tauri `open_external_url` and Android `WebViewClient` block non-exam schemes and external hosts. |
| **5** | **Developer Tools Restriction** | **SUPPORTED** | **SUPPORTED** | **LIMITED** | **UNAVAILABLE** | PC native blocks `open_devtools` and F12/Ctrl+Shift+I; Android disables WebView debugging in release; Web only audits shortcuts; iOS Safari has no on-device devtools. |
| **6** | **Window Control Restriction (Close/Minimize)** | **SUPPORTED** | **SUPPORTED** | **LIMITED** | **LIMITED** | PC native disables close/minimize/maximize buttons and window decorations; Android locks task; Web/PWA can only prompt `beforeunload`. |
| **7** | **Screen Capture / Screenshot Blocking** | **UNAVAILABLE** | **SUPPORTED** | **UNAVAILABLE** | **UNAVAILABLE** | Android uses `WindowManager.LayoutParams.FLAG_SECURE` to block screenshots; desktop OS and iOS cannot block screenshots in userspace. |
| **8** | **Screen Recording Blocking** | **UNAVAILABLE** | **SUPPORTED** | **UNAVAILABLE** | **UNAVAILABLE** | Android `FLAG_SECURE` blacks out the screen in recordings; PC, Web, and iOS cannot detect or block OS screen recording. |
| **9** | **OS Application Switch Restriction** | **LIMITED** | **SUPPORTED** | **UNAVAILABLE** | **UNAVAILABLE** | Android Lock-Task mode disables Home and Recents; PC re-asserts always-on-top and focus but cannot disable Alt+Tab; Web/iOS cannot intercept OS gestures. |
| **10** | **Mobile Home Gesture Restriction** | **UNAVAILABLE** | **SUPPORTED** | **UNAVAILABLE** | **UNAVAILABLE** | Android Lock-Task mode suppresses the navigation bar; iOS strictly reserves the home indicator bar for the operating system. |
| **11** | **OS Global Keyboard Shortcuts** | **LIMITED** | **SUPPORTED** | **UNAVAILABLE** | **UNAVAILABLE** | Android blocks hardware buttons (Volume, Power); PC blocks in-window shortcuts but cannot intercept Ctrl+Alt+Del without an OS kiosk shell; Web cannot block OS shortcuts. |
| **12** | **Process Termination Restriction** | **UNAVAILABLE** | **LIMITED** | **UNAVAILABLE** | **UNAVAILABLE** | Task Manager / SIGKILL / Force Stop cannot be completely prevented by userspace software without MDM/kernel drivers. |
| **13** | **Secondary Physical Device Restriction** | **UNAVAILABLE** | **UNAVAILABLE** | **UNAVAILABLE** | **UNAVAILABLE** | Physical separation and in-room proctoring are required across all client types; software cannot prevent a student looking at a second phone. |
| **14** | **Focus Loss Monitoring & Auditing** | **SUPPORTED** | **SUPPORTED** | **SUPPORTED** | **SUPPORTED** | Window blur/focus, visibility changes, and pagehide/pageshow events are logged to the tamper-evident audit trail without automatic punitive assumptions. |
| **15** | **Immersive / Fullscreen Window** | **SUPPORTED** | **SUPPORTED** | **LIMITED** | **SUPPORTED** | PC native uses `set_fullscreen(true)`; Android uses sticky immersive system bars; iPhone PWA uses standalone display mode; Web requests browser fullscreen. |
| **16** | **Device Lock-Task / Kiosk Mode** | **LIMITED** | **SUPPORTED** | **UNAVAILABLE** | **UNAVAILABLE** | Android `startLockTask()` pins the app; PC window locks controls but requires Windows Assigned Access for true OS lock; Web and iOS do not support app pinning. |
| **17** | **.pharmaexam OS File Association** | **SUPPORTED** | **SUPPORTED** | **UNAVAILABLE** | **UNAVAILABLE** | PC registers file associations via Tauri bundle; Android registers intent filters; Web and iOS use standard HTML file pickers. |

---

## 3. Shared Examination Engine Invariants

Across PC Native, Android Native, Web, and iPhone PWA, all clients execute the **exact same examination business logic**:
* **Exam & ExamVersion**: Immutable version snapshots and cryptographic signatures verified identically.
* **StudentAttempt**: Same state machine (`ACTIVE`, `PAUSED`, `SUBMITTED`, `LOCKED`, `SUBMITTING`, `KIOSK_RELEASED`).
* **Authoritative Timer**: Synchronized against LAN authority (`serverNowAt`), unaffected by client clock manipulation.
* **Save-Before-Next Invariant**: Local encrypted persistence (AES-GCM IndexedDB) must succeed before question navigation advances.
* **Synchronization Protocol**: Monotonic revisions, duplicate event idempotency, conflict detection, and retry queues.
* **Passwordless Submission**: Students can always submit without passwords; timer expiry submits automatically.
* **Recovery**: Restores all 12 local-first state invariants upon crash, reload, or device restart.
