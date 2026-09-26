#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod lan_server;

use std::{fs, path::Path, sync::Mutex};

use ring::rand::{SecureRandom, SystemRandom};
use tauri_plugin_shell::ShellExt;
use tauri::{
    webview::WebviewBuilder, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, State,
    WebviewUrl, WindowEvent,
};
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
use tauri::RunEvent;

const NATIVE_SECURE_EVENT: &str = "pharmatrack://secure-exam-native-event";

#[derive(Clone, serde::Serialize)]
struct NavUpdate {
    label: String,
    url: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSecureExamEvent {
    kind: String,
    detail: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCapability {
    id: String,
    label: String,
    support_level: String,
    supported: bool,
    enforceable: bool,
    detected: bool,
    required: bool,
    notes: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSecureExamSession {
    session_token: String,
    capabilities: Vec<NativeCapability>,
}

struct ActiveSecureExam {
    attempt_id: String,
    session_token: String,
}

#[derive(Default)]
struct SecureExamHostState {
    active: Mutex<Option<ActiveSecureExam>>,
}

#[derive(Default)]
struct PendingPharmaExamFiles(Mutex<Vec<String>>);

impl SecureExamHostState {
    fn is_active(&self) -> bool {
        self.active.lock().map(|value| value.is_some()).unwrap_or(true)
    }

}

fn emit_native_event(app: &tauri::AppHandle, kind: &str, detail: &str) {
    let _ = app.emit(
        NATIVE_SECURE_EVENT,
        NativeSecureExamEvent {
            kind: kind.to_string(),
            detail: detail.to_string(),
        },
    );
}

fn is_pharmaexam_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("pharmaexam"))
        .unwrap_or(false)
}

fn filter_pharmaexam_paths<I>(paths: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    paths.into_iter().filter(|path| is_pharmaexam_path(path)).collect()
}

fn queue_pharmaexam_paths(app: &tauri::AppHandle, paths: Vec<String>) {
    let paths = filter_pharmaexam_paths(paths);
    if paths.is_empty() {
        return;
    }
    if let Some(pending) = app.try_state::<PendingPharmaExamFiles>() {
        if let Ok(mut queue) = pending.0.lock() {
            queue.extend(paths.iter().cloned());
        }
    }
    let _ = app.emit("pharmaexam-file-opened", paths);
}

fn ensure_application_controls_available(state: &SecureExamHostState) -> Result<(), String> {
    if state.is_active() {
        Err("This application capability is unavailable during a secure examination.".to_string())
    } else {
        Ok(())
    }
}

fn create_session_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "Unable to create a secure examination session handle.".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn native_capabilities() -> Vec<NativeCapability> {
    vec![
        NativeCapability {
            id: "browser-navigation-block".into(),
            label: "PharmaTRACK navigation block".into(),
            support_level: "SUPPORTED".into(),
            supported: true,
            enforceable: true,
            detected: true,
            required: false,
            notes: "The native webview navigation path is denied while secure mode is active; operating-system task switching remains outside the app boundary.".into(),
        },
        NativeCapability {
            id: "copy-paste-block".into(),
            label: "Copy and paste restriction".into(),
            support_level: "PARTIAL".into(),
            supported: true,
            enforceable: true,
            detected: true,
            required: false,
            notes: "Exam-page clipboard events and shortcuts are prevented; OS-level clipboard access is not universally controllable.".into(),
        },
        NativeCapability {
            id: "printing-block".into(),
            label: "Print restriction".into(),
            support_level: "PARTIAL".into(),
            supported: true,
            enforceable: true,
            detected: true,
            required: false,
            notes: "Exam-page print events and shortcuts are prevented; an operating system cannot be claimed to have no print path.".into(),
        },
        NativeCapability {
            id: "external-link-block".into(),
            label: "External link restriction".into(),
            support_level: "SUPPORTED".into(),
            supported: true,
            enforceable: true,
            detected: true,
            required: false,
            notes: "Embedded webview navigation and new-window requests are denied during secure mode.".into(),
        },
        NativeCapability {
            id: "developer-tools-detection".into(),
            label: "Developer tools restriction".into(),
            support_level: "SUPPORTED".into(),
            supported: true,
            enforceable: true,
            detected: true,
            required: false,
            notes: "The exposed native devtools command is denied during secure mode; OS-level debugging tools are not controlled by this app.".into(),
        },
        NativeCapability {
            id: "window-control-restriction".into(),
            label: "Window manipulation restriction".into(),
            support_level: "PARTIAL".into(),
            supported: true,
            enforceable: true,
            detected: true,
            required: false,
            notes: "Tauri disables resize, minimize, maximize, decorations, and close while active; OS termination and task switching are not guaranteed.".into(),
        },
        NativeCapability {
            id: "screen-capture-restriction".into(),
            label: "Screen capture restriction".into(),
            support_level: "NOT_GUARANTEED".into(),
            supported: false,
            enforceable: false,
            detected: true,
            required: false,
            notes: "There is no portable Tauri guarantee against screenshots or OS capture.".into(),
        },
        NativeCapability {
            id: "focus-monitoring".into(),
            label: "Focus-loss monitoring".into(),
            support_level: "NOT_GUARANTEED".into(),
            supported: true,
            enforceable: false,
            detected: true,
            required: false,
            notes: "Native focus changes are emitted and audited; focus loss is observable and is not automatically cheating.".into(),
        },
        NativeCapability {
            id: "immersive-window".into(),
            label: "Immersive examination window".into(),
            support_level: "PARTIAL".into(),
            supported: true,
            enforceable: true,
            detected: true,
            required: false,
            notes: "Native fullscreen is requested and restored; desktop-level escape routes are not guaranteed away.".into(),
        },
        NativeCapability {
            id: "android-lock-task".into(),
            label: "PC native lockdown / Android lock task".into(),
            support_level: "NOT_GUARANTEED".into(),
            supported: false,
            enforceable: false,
            detected: true,
            required: false,
            notes: "PC desktop task lockdown is not claimed. Managed operating-system policy is required for that guarantee.".into(),
        },
    ]
}

fn apply_secure_window_controls(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.set_fullscreen(true).map_err(|error| error.to_string())?;
    window.set_resizable(false).map_err(|error| error.to_string())?;
    window.set_minimizable(false).map_err(|error| error.to_string())?;
    window.set_maximizable(false).map_err(|error| error.to_string())?;
    window.set_closable(false).map_err(|error| error.to_string())?;
    window.set_decorations(false).map_err(|error| error.to_string())?;
    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    let _ = window.close_devtools();
    Ok(())
}

fn restore_window_controls(window: &tauri::WebviewWindow) -> Result<(), String> {
    // These values match the normal window policy in tauri.conf.json. Keeping
    // restoration explicit means a crashed/returned exam does not leave the
    // ordinary PharmaTRACK desktop window permanently altered.
    window.set_fullscreen(false).map_err(|error| error.to_string())?;
    window.set_always_on_top(false).map_err(|error| error.to_string())?;
    window.set_decorations(true).map_err(|error| error.to_string())?;
    window.set_resizable(true).map_err(|error| error.to_string())?;
    window.set_minimizable(true).map_err(|error| error.to_string())?;
    window.set_maximizable(true).map_err(|error| error.to_string())?;
    window.set_closable(true).map_err(|error| error.to_string())?;
    Ok(())
}

// Captured once in .setup() and held for the app's lifetime, so embed_website
// never needs to re-query get_webview_window("main") — which was observed
// returning an empty window registry on the second/later call for reasons
// that didn't match any documented Tauri behavior. Holding a direct handle
// sidesteps that lookup entirely.
struct MainWindowHandle(tauri::WebviewWindow);

#[tauri::command]
fn open_devtools(
    window: tauri::WebviewWindow,
    state: State<'_, SecureExamHostState>,
) -> Result<(), String> {
    if state.is_active() {
        return Err("Developer tools are prohibited during a secure examination.".to_string());
    }
    if !cfg!(debug_assertions) {
        return Err("Developer tools are permanently disabled in production builds.".to_string());
    }
    ensure_application_controls_available(state.inner())?;
    window.open_devtools();
    Ok(())
}

#[tauri::command]
fn restart_application(
    app: tauri::AppHandle,
    state: State<'_, SecureExamHostState>,
) -> Result<(), String> {
    ensure_application_controls_available(state.inner())?;
    app.restart();
}

#[tauri::command]
fn open_external_url(
    app: tauri::AppHandle,
    state: State<'_, SecureExamHostState>,
    url: String,
) -> Result<(), String> {
    ensure_application_controls_available(state.inner())?;
    let parsed: url::Url = url
        .parse()
        .map_err(|error: url::ParseError| format!("invalid external URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto" | "tel") {
        return Err("Only browser-safe external URL schemes are allowed.".to_string());
    }
    app.shell()
        .open(parsed.as_str(), None)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn enter_secure_exam_mode(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, SecureExamHostState>,
    attempt_id: String,
) -> Result<NativeSecureExamSession, String> {
    if attempt_id.trim().is_empty() {
        return Err("A secure examination attempt id is required.".to_string());
    }
    if let Ok(active) = state.active.lock() {
        if let Some(current) = active.as_ref() {
            if current.attempt_id == attempt_id {
                return Ok(NativeSecureExamSession {
                    session_token: current.session_token.clone(),
                    capabilities: native_capabilities(),
                });
            }
            return Err("Another secure examination is already active in this window.".to_string());
        }
    } else {
        return Err("Secure examination state is unavailable.".to_string());
    }

    apply_secure_window_controls(&window)?;
    let session_token = create_session_token()?;
    let mut active = state
        .active
        .lock()
        .map_err(|_| "Secure examination state is unavailable.".to_string())?;
    if active.is_some() {
        return Err("Another secure examination is already active in this window.".to_string());
    }
    *active = Some(ActiveSecureExam {
        attempt_id,
        session_token: session_token.clone(),
    });
    emit_native_event(
        &app,
        "focus_restored",
        "Native secure examination window entered fullscreen and received focus.",
    );
    Ok(NativeSecureExamSession {
        session_token,
        capabilities: native_capabilities(),
    })
}

#[tauri::command]
fn exit_secure_exam_mode(
    window: tauri::WebviewWindow,
    state: State<'_, SecureExamHostState>,
    session_token: String,
) -> Result<(), String> {
    let mut active = state
        .active
        .lock()
        .map_err(|_| "Secure examination state is unavailable.".to_string())?;
    let current = active
        .as_ref()
        .ok_or_else(|| "No secure examination is active.".to_string())?;
    if current.session_token != session_token {
        return Err("Secure examination restoration authorization was rejected.".to_string());
    }
    restore_window_controls(&window)?;
    *active = None;
    Ok(())
}

#[tauri::command]
async fn embed_website(
    app: tauri::AppHandle,
    host_state: tauri::State<'_, SecureExamHostState>,
    main_window: tauri::State<'_, MainWindowHandle>,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    ensure_application_controls_available(host_state.inner())?;
    // Guard: a zero-size webview is created "successfully" but is invisible,
    // which looks identical to an infinite spinner from the frontend's
    // point of view. Reject early instead of silently creating a ghost webview.
    if width <= 0.0 || height <= 0.0 {
        return Err(format!(
            "embed_website called with invalid size: {}x{}",
            width, height
        ));
    }

    // Re-use an existing webview if the user switches back to this tab.
    // Use Logical (CSS) coordinates — getBoundingClientRect() returns logical
    // pixels; Physical coords on HiDPI displays make the webview overshoot its frame.
    if let Some(existing_webview) = app.get_webview(&label) {
        existing_webview
            .set_position(Position::Logical(LogicalPosition::new(x, y)))
            .map_err(|e| e.to_string())?;
        existing_webview
            .set_size(Size::Logical(LogicalSize::new(width, height)))
            .map_err(|e| e.to_string())?;
        existing_webview.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let parsed_url: url::Url = url
        .parse()
        .map_err(|e: url::ParseError| format!("invalid url '{}': {}", url, e))?;

    let app_clone = app.clone();
    let label_clone = label.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed_url))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
        .on_navigation(move |nav_url| {
            let secure_state = app_clone.state::<SecureExamHostState>();
            if secure_state.is_active() {
                emit_native_event(
                    &app_clone,
                    "navigation_blocked",
                    "Embedded webview navigation was blocked during secure examination.",
                );
                return false;
            }
            let _ = app_clone.emit(
                "webview-navigation-update",
                NavUpdate { label: label_clone.clone(), url: nav_url.to_string() },
            );
            true
        })
        .on_new_window({
            let app_clone2 = app.clone();
            move |url, _features| {
                let secure_state = app_clone2.state::<SecureExamHostState>();
                if secure_state.is_active() {
                    emit_native_event(
                        &app_clone2,
                        "external_link_blocked",
                        &format!("External browser launch was blocked during secure examination: {url}"),
                    );
                } else {
                    let _ = app_clone2.emit("new-browser-tab", url.to_string());
                }
                tauri::webview::NewWindowResponse::Deny
            }
        });

    main_window
        .0
        .as_ref()
        .window()
        .add_child(
            builder,
            Position::Logical(LogicalPosition::new(x, y)),
            Size::Logical(LogicalSize::new(width, height)),
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn hide_website(
    app: tauri::AppHandle,
    state: tauri::State<'_, SecureExamHostState>,
    label: String,
) -> Result<(), String> {
    ensure_application_controls_available(state.inner())?;
    if let Some(webview) = app.get_webview(&label) {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Kept for backwards compatibility; delegates to `navigate_website`.
#[tauri::command]
async fn update_website(
    app: tauri::AppHandle,
    state: tauri::State<'_, SecureExamHostState>,
    label: String,
    url: String,
) -> Result<(), String> {
    ensure_application_controls_available(state.inner())?;
    navigate_website_impl(app, label, url).await
}

async fn navigate_website_impl(
    app: tauri::AppHandle,
    label: String,
    url: String,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let parsed_url: url::Url = url
            .parse()
            .map_err(|e: url::ParseError| format!("invalid url '{}': {}", url, e))?;
        webview.navigate(parsed_url).map_err(|e| e.to_string())?;
        let _ = app.emit("webview-navigation-update", NavUpdate { label, url });
    }
    Ok(())
}

#[tauri::command]
async fn navigate_website(
    app: tauri::AppHandle,
    state: tauri::State<'_, SecureExamHostState>,
    label: String,
    url: String,
) -> Result<(), String> {
    ensure_application_controls_available(state.inner())?;
    navigate_website_impl(app, label, url).await
}

#[tauri::command]
async fn webview_back(
    app: tauri::AppHandle,
    state: tauri::State<'_, SecureExamHostState>,
    label: String,
) -> Result<(), String> {
    ensure_application_controls_available(state.inner())?;
    if let Some(webview) = app.get_webview(&label) {
        webview.eval("window.history.back();").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn webview_forward(
    app: tauri::AppHandle,
    state: tauri::State<'_, SecureExamHostState>,
    label: String,
) -> Result<(), String> {
    ensure_application_controls_available(state.inner())?;
    if let Some(webview) = app.get_webview(&label) {
        webview.eval("window.history.forward();").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn webview_reload(
    app: tauri::AppHandle,
    state: tauri::State<'_, SecureExamHostState>,
    label: String,
) -> Result<(), String> {
    ensure_application_controls_available(state.inner())?;
    if let Some(webview) = app.get_webview(&label) {
        webview.eval("window.location.reload();").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn destroy_website(
    app: tauri::AppHandle,
    state: tauri::State<'_, SecureExamHostState>,
    label: String,
) -> Result<(), String> {
    ensure_application_controls_available(state.inner())?;
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn start_lan_exam_server(
    app: tauri::AppHandle,
    state: State<'_, lan_server::LanServerHandle>,
    secure_state: State<'_, SecureExamHostState>,
    config: lan_server::LanServerConfig,
) -> Result<lan_server::LanServerStatus, String> {
    ensure_application_controls_available(secure_state.inner())?;
    lan_server::start(&app, state.inner(), config)
}

#[tauri::command]
fn stop_lan_exam_server(
    state: State<'_, lan_server::LanServerHandle>,
    secure_state: State<'_, SecureExamHostState>,
) -> Result<(), String> {
    ensure_application_controls_available(secure_state.inner())?;
    lan_server::stop(state.inner())
}

#[tauri::command]
fn lan_exam_server_status(
    state: State<'_, lan_server::LanServerHandle>,
) -> Result<lan_server::LanServerStatus, String> {
    lan_server::status(state.inner())
}

/// Returns file-association launches that happened before the webview listener
/// was ready. Only .pharmaexam is accepted; ordinary documents remain outside
/// this route.
#[tauri::command]
fn get_pending_pharmaexam_files(
    state: State<'_, PendingPharmaExamFiles>,
    secure_state: State<'_, SecureExamHostState>,
) -> Result<Vec<String>, String> {
    ensure_application_controls_available(secure_state.inner())?;
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "Pending examination launch state is unavailable.".to_string())?;
    Ok(std::mem::take(&mut *pending))
}

#[tauri::command]
fn read_pharmaexam_file(
    path: String,
    secure_state: State<'_, SecureExamHostState>,
) -> Result<Vec<u8>, String> {
    ensure_application_controls_available(secure_state.inner())?;
    let candidate = Path::new(&path);
    if candidate.extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase()) != Some("pharmaexam".to_string()) {
        return Err("Only .pharmaexam files can be opened by the examination launcher.".to_string());
    }
    let metadata = fs::metadata(candidate).map_err(|error| format!("Unable to inspect examination package: {error}"))?;
    if !metadata.is_file() || metadata.len() > 50 * 1024 * 1024 {
        return Err("The examination package is missing, not a file, or exceeds the 50 MB limit.".to_string());
    }
    fs::read(candidate).map_err(|error| format!("Unable to read examination package: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_state_denies_application_capabilities_while_active() {
        let state = SecureExamHostState::default();
        assert!(ensure_application_controls_available(&state).is_ok());
        *state.active.lock().expect("test state lock") = Some(ActiveSecureExam {
            attempt_id: "attempt-1".into(),
            session_token: "session-1".into(),
        });
        assert!(ensure_application_controls_available(&state).is_err());
    }

    #[test]
    fn native_capability_report_is_explicit_about_non_guarantees() {
        let capabilities = native_capabilities();
        let capture = capabilities
            .iter()
            .find(|capability| capability.id == "screen-capture-restriction")
            .expect("capture capability");
        assert_eq!(capture.support_level, "NOT_GUARANTEED");
        assert!(!capture.enforceable);
    }
}

fn main() {
    tauri::Builder::default()
        .manage(SecureExamHostState::default())
        .manage(PendingPharmaExamFiles::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let secure_state = window.app_handle().state::<SecureExamHostState>();
            if !secure_state.is_active() {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    emit_native_event(
                        &window.app_handle(),
                        "close_blocked",
                        "Window close was blocked while a secure examination was active.",
                    );
                }
                WindowEvent::Focused(false) => {
                    let _ = window.set_always_on_top(true);
                    let _ = window.set_fullscreen(true);
                    let _ = window.set_focus();
                    emit_native_event(
                        &window.app_handle(),
                        "focus_lost",
                        "Native secure examination window lost focus; focus re-assertion was dispatched.",
                    );
                }
                WindowEvent::Focused(true) => emit_native_event(
                    &window.app_handle(),
                    "focus_restored",
                    "Native secure examination window focus was restored.",
                ),
                _ => {}
            }
        })
        .setup(|app| {
            app.manage(lan_server::LanServerHandle::default());
            let main_window = app
                .get_webview_window("main")
                .expect("main window must exist at startup");
            app.manage(MainWindowHandle(main_window));
            // Windows and Linux deliver file-association launches as command
            // line arguments. Mobile/macOS use RunEvent::Opened below.
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            queue_pharmaexam_paths(app.handle(), std::env::args().skip(1).collect());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_devtools,
            restart_application,
            open_external_url,
            enter_secure_exam_mode,
            exit_secure_exam_mode,
            embed_website,
            hide_website,
            update_website,
            navigate_website,
            webview_back,
            webview_forward,
            webview_reload,
            destroy_website,
            get_pending_pharmaexam_files,
            read_pharmaexam_file,
            start_lan_exam_server,
            stop_lan_exam_server,
            lan_exam_server_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let RunEvent::Opened { urls } = event {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect();
                queue_pharmaexam_paths(app, paths);
            }
        });
}
