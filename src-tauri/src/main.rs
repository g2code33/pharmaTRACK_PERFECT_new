#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use tauri::{
    webview::WebviewBuilder, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

#[derive(Clone, serde::Serialize)]
struct NavUpdate {
    label: String,
    url: String,
}

// Captured once in .setup() and held for the app's lifetime, so embed_website
// never needs to re-query get_webview_window("main") — which was observed
// returning an empty window registry on the second/later call for reasons
// that didn't match any documented Tauri behavior. Holding a direct handle
// sidesteps that lookup entirely.
struct MainWindowHandle(tauri::WebviewWindow);

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[tauri::command]
async fn embed_website(
    app: tauri::AppHandle,
    main_window: tauri::State<'_, MainWindowHandle>,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // Guard: a zero-size webview is created "successfully" but is invisible,
    // which looks identical to an infinite spinner from the frontend's
    // point of view. Reject early instead of silently creating a ghost webview.
    if width <= 0.0 || height <= 0.0 {
        return Err(format!(
            "embed_website called with invalid size: {}x{}",
            width, height
        ));
    }

    // Re-use an existing webview if the user switches back to this tab
    if let Some(existing_webview) = app.get_webview(&label) {
        existing_webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        existing_webview
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        existing_webview.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Never .unwrap() a parse that comes from user/JS input — propagate the
    // error instead so the frontend actually sees why it failed.
    let parsed_url: url::Url = url
        .parse()
        .map_err(|e: url::ParseError| format!("invalid url '{}': {}", url, e))?;

    let app_clone = app.clone();
    let label_clone = label.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed_url))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
        .on_navigation(move |nav_url| {
            let _ = app_clone.emit(
                "webview-navigation-update",
                NavUpdate { label: label_clone.clone(), url: nav_url.to_string() },
            );
            true // allow the navigation
        })
        .on_new_window({
            let app_clone2 = app.clone();
            move |url, _features| {
                let _ = app_clone2.emit("new-browser-tab", url.to_string());
                tauri::webview::NewWindowResponse::Deny
            }
        });

    main_window
        .0
        .as_ref()
        .window()
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn hide_website(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn update_website(app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let script = format!("window.location.href = '{}';", url.replace('\'', "\\'"));
        webview.eval(&script).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn navigate_website(app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
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
async fn webview_back(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.eval("window.history.back();").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn webview_forward(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.eval("window.history.forward();").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn webview_reload(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.eval("window.location.reload();").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn destroy_website(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let main_window = app
                .get_webview_window("main")
                .expect("main window must exist at startup");
            app.manage(MainWindowHandle(main_window));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_devtools,
            embed_website,
            hide_website,
            update_website,
            navigate_website,
            webview_back,
            webview_forward,
            webview_reload,
            destroy_website
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}