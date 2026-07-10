#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use tauri::{webview::WebviewBuilder, WebviewUrl, LogicalPosition, LogicalSize, Manager};

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

// 1. Added ASYNC keyword to offload from the main UI thread and prevent Deadlocks!
#[tauri::command]
async fn embed_website(app: tauri::AppHandle, label: String, url: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let main_webview_window = app.get_webview_window("main").unwrap();

    if let Some(existing_webview) = app.get_webview(&label) {
        let _ = existing_webview.close();
    }

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url.parse().unwrap()))
        .auto_resize()
        // Spoof identity to bypass AI bot blockers!
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");

    let _webview = main_webview_window.as_ref().window()
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;

    Ok(())
}

// 2. Added ASYNC keyword here as well to prevent deadlocks when closing the AI pane
#[tauri::command]
async fn destroy_website(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(existing_webview) = app.get_webview(&label) {
        let _ = existing_webview.close();
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![open_devtools, embed_website, destroy_website])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
