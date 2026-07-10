#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use tauri::{
    webview::WebviewBuilder, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[tauri::command]
async fn embed_website(
    app: tauri::AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let main_webview_window = app.get_webview_window("main").unwrap();

    // Re-use an existing webview if the user switches back to this tab
    if let Some(existing_webview) = app.get_webview(&label) {
        let _ = existing_webview.set_position(LogicalPosition::new(x, y));
        let _ = existing_webview.set_size(LogicalSize::new(width, height));
        let _ = existing_webview.show();
        return Ok(());
    }

    let app_clone = app.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url.parse().unwrap()))
        .auto_resize()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
        .on_new_window(move |url, _features| {
            // Emits an event to React to CREATE A NEW TAB dynamically inside PharmaTRACK!
            let _ = app_clone.emit("new-browser-tab", url.to_string());
            tauri::webview::NewWindowResponse::Deny
        });

    let _webview = main_webview_window
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
        let _ = webview.hide();
    }
    Ok(())
}

#[tauri::command]
async fn update_website(app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let script = format!("window.location.href = '{}';", url);
        let _ = webview.eval(&script);
    }
    Ok(())
}

#[tauri::command]
async fn destroy_website(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.close();
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            open_devtools,
            embed_website,
            hide_website,
            update_website,
            destroy_website
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
