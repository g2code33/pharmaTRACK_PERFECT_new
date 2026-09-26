# PharmaTRACK PC examination capability matrix

PharmaTRACK secure examinations use the existing examination security settings and violation policies. In a Tauri desktop build, the browser adapter and native Tauri host are both active. The native host does not turn the application into an operating-system lockdown product and this document intentionally does not call it “fully locked down”.

## Capability matrix

| Capability | Status on Tauri PC | Enforcement layer | What is enforced | Boundary / non-guarantee |
| --- | --- | --- | --- | --- |
| Normal PharmaTRACK route/navigation | **Supported** | React kiosk adapter + native webview navigation callback | Secure-page history restoration, external-page navigation and embedded webview navigation are blocked and audited while active. | An OS user can still switch desktops or terminate the process.
| Devtools command and debug shortcuts | **Supported** for the application path | Native `open_devtools` command authorization + browser shortcut audit | `open_devtools` returns an authorization error during an active attempt; browser attempts are recorded. | OS-level debuggers, browser-engine vulnerabilities, and a separately attached debugger are not controlled by this app.
| External links / browser launch | **Supported** for application paths | Browser click/new-window handlers + native embedded-webview callback + capability removal | Exam links and Tauri-created external webview windows are denied and produce security events. Shell `open` is not granted to the webview. | A user can use an operating-system facility outside the app.
| Printing | **Partial** | Browser `copy/keydown/beforeprint` handlers | Exam print shortcuts and the page print lifecycle are prevented and audited. | There is no portable Tauri API that guarantees an OS has no print or capture route.
| Clipboard copy/paste | **Partial** | Browser clipboard handlers + shortcut prevention | Exam-page copy, cut, paste, context-menu and common shortcuts are prevented and audited. | OS clipboard managers and access outside the webview are not universally controllable.
| Fullscreen / immersive window | **Partial** | Native Tauri window state | The window enters fullscreen, requests focus, and restores its normal state after exit. | OS shortcuts, other desktop sessions, and task switching can leave fullscreen.
| Resize, minimize, maximize, decorations, close | **Partial** | Native Tauri window controls + `CloseRequested` veto | Resize/minimize/maximize/decorations/close are disabled while active; close requests are vetoed and audited. | OS termination, task switching, power loss, and platform-specific window-manager behavior are not guaranteed away.
| Focus monitoring | **Not guaranteed as prevention** | Native `Focused` events + browser focus/visibility events | Focus loss and restoration are recorded as `FOCUS_LOST`/`RECOVERY` security events and are passed through the configured violation policy. | Focus loss is an observation, not proof of misconduct, and cannot be prevented reliably.
| Screen capture / screenshots | **Not guaranteed** | None portable in Tauri | The capability matrix reports that no portable native guarantee exists. | The app does not claim to prevent OS screenshots, camera capture, remote desktop capture, or external recording.
| OS task lock / kiosk lockdown | **Not guaranteed** | None in the PC Tauri adapter | No PC task-lock guarantee is claimed. | A managed operating-system policy or dedicated exam product is required for that level of control; Safe Exam Browser is not used.
| Shell/process access | **Supported** for secure-mode reduction | Tauri capability ACL + authorized native commands | The webview is not granted shell open or process restart permissions. Normal external study links use the native `open_external_url` command (or the browser fallback), and update completion uses the authorized native restart command. Both are denied while secure mode is active. | Native plugins remain compiled into the desktop host for normal application compatibility; this is not a claim that an administrator with host access is blocked.
| Updater | **Partial** | Existing updater capability + secure route separation | Update UI is outside the secure-exam route; secure mode does not expose the normal Layout update controls. | Tauri plugin ACLs are static. An OS administrator or a future native updater integration is outside this application session policy.

“Supported” means the application can enforce the stated application-boundary behavior. “Partial” means the behavior is enforced only for the supported boundary. “Not guaranteed” means the capability is reported honestly and must not be made a required precondition unless an external managed policy supplies it.

## Native authorization model

`enter_secure_exam_mode(attemptId)` creates a random native session handle, applies the strongest portable Tauri window controls, and returns a capability report. `exit_secure_exam_mode(sessionToken)` restores the ordinary PharmaTRACK window only when the active native session handle matches. This is a capability/state check, not an administrator identity system; administrative unlock and termination remain governed by the existing examination repository and `ViolationPolicy` flow.

The native host denies the following while secure mode is active:

- the exposed devtools command;
- embedded webview creation, navigation, history navigation, reload, hide and close commands;
- external embedded-webview new-window requests;
- LAN server start/stop commands;
- native close requests, where the Tauri window API supplies a close veto.

The browser adapter remains installed at the same time so clipboard, printing, route, focus, before-unload, offline and shortcut events continue to be recorded through the existing encrypted attempt/security-event service. The configured `LOG_ONLY`, `WARNING`, `LOCK_TEMPORARILY`, `REQUIRE_ADMIN_UNLOCK`, `TERMINATE_ATTEMPT`, and `FORCE_SUBMIT` values are not replaced by native-specific policy names.

## Recovery and restoration

Answer persistence and encrypted local recovery run before route changes as before. Native window restoration is attempted on normal submission and component cleanup; a failed native restoration emits a suspicious-state security event and keeps its session handle for a retry. A crash or operating-system kill cannot run cleanup, so the next launch must rely on the existing recoverable local attempt state and administrator recovery flow rather than assuming the previous window state was restored.
