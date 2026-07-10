#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use tauri::{Manager, WebviewBuilder, WebviewUrl};

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[tauri::command]
fn embed_website(app: tauri::AppHandle, label: String, url: String, x: f64, y: f64, width: f64, height: f64) {
    let main_window = app.get_webview_window("main").unwrap();

    if let Some(existing_webview) = app.get_webview(&label) {
        let _ = existing_webview.close();
    }

    let _webview = main_window
        .add_child(
            WebviewBuilder::new(&label, WebviewUrl::External(url.parse().unwrap()))
                .auto_resize()
                .position(x, y)
                .size(width, height)
                // Spoof identity to bypass AI bot blockers!
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
        )
        .unwrap();
}

#[tauri::command]
fn destroy_website(app: tauri::AppHandle, label: String) {
    if let Some(existing_webview) = app.get_webview(&label) {
        let _ = existing_webview.close();
    }
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