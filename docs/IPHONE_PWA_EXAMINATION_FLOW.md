# PHARMATRACK — IPHONE PWA EXAMINATION FLOW

## 1. Executive Summary & Single-Codebase Architecture

The iPhone-compatible PharmaTRACK PWA examination experience delivers a high-security, local-first examination client directly in Mobile Safari and installed iOS Progressive Web Apps (PWAs).

### Core Constraint: Zero Separate Codebases
PharmaTRACK maintains a **single, unified web application**. There is no separate iPhone codebase, native wrapper, or bifurcated protocol. The exact same application code runs across:
1. **iPhone Safari** (standard browser tab)
2. **Installed PharmaTRACK PWA on iOS** (standalone display mode via Add to Home Screen)
3. **Android browser & PWA**
4. **Desktop browsers** (macOS, Windows, Linux, ChromeOS)
5. **Native Desktop Kiosk** (Tauri PC bridge when present)

---

## 2. The Complete iPhone Flow

```text
iPhone
  ↓
Safari (https://...)
  ↓
PharmaTRACK Web (Public Shell Cached via Service Worker)
  ↓
Optional Add to Home Screen (Share Sheet → Add to Home Screen)
  ↓
Quiz Mode (/quiz)
  ↓
Kiosk Examination Entry (/examinations/kiosk)
  ↓
Choose .pharmaexam (Standard iOS Files / Browser File Picker)
  ↓
Validate (HMAC-SHA256 Signature, Package Hash, Version Integrity)
  ↓
Student Identity (First Name + Level + Sequential RX30 Kiosk Password)
  ↓
Readiness Check (AES-GCM IndexedDB, Crypto Subtle, Storage Quota, Authority)
  ↓
Restricted Web Examination Mode (/examination/secure/:attemptId)
```

---

## 3. PWA Configuration, Viewport & Safe-Area Support

### Viewport Cover & Notches
On modern iPhone models (iPhone X through iPhone 16 Pro Max, Dynamic Island, and home indicator bar):
* `index.html` sets:
  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  ```
  `viewport-fit=cover` ensures the WebKit rendering surface extends behind the notch/island and home indicator, activating CSS `env(safe-area-inset-*)`.
* Safe-area utility classes in `src/index.css`:
  ```css
  .pt-safe { padding-top: max(env(safe-area-inset-top, 0px), 0.75rem); }
  .pb-safe { padding-bottom: max(env(safe-area-inset-bottom, 0px), 0.75rem); }
  .pl-safe { padding-left: max(env(safe-area-inset-left, 0px), 0.75rem); }
  .pr-safe { padding-right: max(env(safe-area-inset-right, 0px), 0.75rem); }
  .safe-area-x {
    padding-left: max(env(safe-area-inset-left, 0px), 0.75rem);
    padding-right: max(env(safe-area-inset-right, 0px), 0.75rem);
  }
  ```

### Standalone Display & Web App Manifest
* `public/manifest.webmanifest`:
  * `"display": "standalone"`
  * `"orientation": "any"`
  * `"background_color": "#0f172a"`
  * `"theme_color": "#0f172a"`
  * High-resolution icons (`1024x1024` png and `favicon.ico`)
* `index.html` iOS integration:
  * `<meta name="apple-mobile-web-app-capable" content="yes" />`
  * `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`
  * `<meta name="apple-mobile-web-app-title" content="PharmaTRACK" />`
  * `<link rel="apple-touch-icon" sizes="180x180" href="./icon.png" />`
  * `<link rel="apple-touch-icon" sizes="1024x1024" href="./icon.png" />`

### Touch Targets & Anti-Delay
* Apple Human Interface Guidelines require minimum touch targets of **44x44 points**.
* All mobile buttons in `SecureExamination.tsx` and `KioskEntry.tsx` enforce `min-w-[44px] min-h-[44px]`, with MCQ options providing `min-h-[52px]` and submit buttons providing `min-h-[48px]`.
* `.touch-manipulation` is applied to prevent the 300ms double-tap delay on Mobile Safari.
* `body { overflow-x: hidden; }` prevents horizontal scroll jitter during touch navigation.

---

## 4. Safari Lifecycle Resilience: No Cheating Assumptions

Mobile Safari and WebKit PWAs have distinct lifecycle behaviors that must be handled transparently without penalizing the student:

### Lifecycle Scenarios & Platform Reactions

| Safari Event / State | Trigger Scenario | PharmaTRACK Reaction | Integrity & Cheating Assessment |
|---|---|---|---|
| **Backgrounding** | Incoming phone call, alarm, Control Center, or switching tabs | Fires `blur`, `visibilitychange` (hidden), `pagehide` | Logs `FOCUS_LOST` to append-only security log for administrative review. **Crucially: The attempt status remains ACTIVE. The student is NEVER locked out and NEVER flagged as cheating.** |
| **Returning to PWA** | Student finishes call or switches back | Fires `focus`, `visibilitychange` (visible), `pageshow` | Logs `RECOVERY_COMPLETED`. Immediately re-synchronizes authoritative clock against LAN authority, checks deadline, and flushes pending sync events. |
| **Temporary Suspension** | iOS sleeps or freezes background tabs; JS `setInterval` halts | App wakes up on `pageshow` / `visibilitychange` | Evaluates authoritative deadline against wall clock (`serverNowAt` + elapsed drift). If deadline expired while away, immediately finalizes `EXPIRY` submission. If time remains, timer continues without losing authoritative duration. |
| **Screen Rotation** | User rotates iPhone between portrait and landscape | Fires `resize`, `orientationchange` | Layout smoothly adapts. **0 security violations logged.** Navigation and answers remain intact. |
| **Network Changes** | Switching between Wi-Fi and Cellular or dead spots | Fires `offline`, `online` | Local-first: **SAVE-BEFORE-NEXT continues saving to AES-GCM IndexedDB.** Answers queue in `pendingSyncEvents`. When online returns, events automatically flush. |
| **Page Reload / Refresh** | User accidentally pulls to refresh or Safari jetsams WebProcess | Route `/examination/secure/:attemptId` mounts | Encrypted repository re-reads state from IndexedDB. All 12 state invariants (attempt, questions, answers, revisions, timer) are restored without loss. |

---

## 5. Exam Package Processing on iOS

* **File Selection**: Mobile Safari does not allow web applications to register OS-level file associations (`.pharmaexam`).
* **Workflow**: PharmaTRACK uses the standard HTML file input with:
  ```ts
  export const BROWSER_PHARMAEXAM_ACCEPT = '.pharmaexam,.zip,application/zip,application/octet-stream';
  ```
  Including `application/octet-stream` prevents the iOS Files app from greying out `.pharmaexam` files in iCloud Drive or local Downloads.
* **Honest Reporting**: In the platform capability matrix, `pharmaexam-file-association` is honestly reported as `UNAVAILABLE` (`supported: false`, `enforceable: false`). The system never pretends browser sandboxes have native OS file association capabilities.

---

## 6. Honest Lockdown: Restricted Web Examination Mode

* **UI Labeling**: The examination header displays:
  ```text
  Restricted Web Examination Mode · iPhone Safari (or iPhone PWA)
  ```
* **Strict Negative Invariant**: The application **never** labels this security mode `"Full Device Lockdown"`. Full device lockdown is reserved solely for approved native OS bridges (e.g. Android Lock-Task mode or Tauri PC native window managers).
* **Fullscreen API on iPhone**:
  * iPhone Safari does not support the HTML `Element.requestFullscreen()` API on arbitrary container elements (it is undefined).
  * In installed PWA mode (`standalone`), the app is already borderless.
  * In standard Safari, the UI detects the absence of the Element Fullscreen API and does not display broken or impossible "Return to Fullscreen" prompt dialogs.

---

## 7. Submission Contract

* **Unrestricted Student Submission**:
  A student can always tap **SUBMIT EXAM** at any time:
  * No administrator password is requested.
  * No student password is requested.
  * Attempt transitions to `SUBMITTED` with `submissionTrigger = 'MANUAL'`.
  * Results are durably computed and saved.
* **Automatic Expiry**:
  When the authoritative timer reaches 0, the attempt automatically finalizes with `submissionTrigger = 'EXPIRY'` without requiring student confirmation or password entry.

---

## 8. Verification & Test Suite

The test suite in `src/test/examination-iphone-pwa.test.tsx` executes 18 comprehensive tests covering:

1. **iPhone Safari Detection**: Verifies user agent matching, `detectDeviceFamily() === 'ios'`, `isIPhone() === true`, `isIOSSafari() === true`.
2. **iPhone PWA Standalone Detection**: Verifies `(navigator as any).standalone = true` and `(display-mode: standalone)` matchMedia queries.
3. **Platform Adapter Routing**: Routes `createPlatformKioskAdapter` to `'IOS_SAFARI'` and `'IOS_PWA'`.
4. **Capability Matrix**: Honest reporting of `IOS_SAFARI` limitations (no Element fullscreen, no OS file routes, focus monitoring noted as observable without cheating accusations) and `IOS_PWA` standalone support.
5. **Configuration Verification**: Validates `viewport-fit=cover`, Apple meta tags, and touch icons in `index.html`; validates `manifest.webmanifest` standalone settings; validates `.pt-safe`, `.pb-safe`, and `.touch-manipulation` rules in `src/index.css`.
6. **File Picking**: Verifies `.pharmaexam` and `application/octet-stream` support; verifies KioskEntry guidance banner.
7. **Safari Backgrounding & Returning**: Audits `FOCUS_LOST` and `RECOVERY_COMPLETED`; verifies attempt remains strictly `ACTIVE`.
8. **Safari Suspension & Expiry**: Verifies wall-clock comparison and automated `EXPIRY` submission upon waking after deadline.
9. **Screen Rotation**: Verifies `resize` and `orientationchange` trigger 0 security violations.
10. **Network Drops & Offline Saving**: Verifies answer revisions commit locally and flush upon reconnection.
11. **Submission Without Password**: Verifies manual submit requires no passwords and generates result.
12. **UI Touch Targets & Security Mode**: Verifies "Restricted Web Examination Mode" label, absence of "Full Device Lockdown", and >= 44x44px touch target compliance.

### Overall Test Suite Results
* **66 Test Files Passed**: 667/667 tests passing across the entire PharmaTRACK test suite.
* **Production Build**: `npm run build` completed with 0 errors.
