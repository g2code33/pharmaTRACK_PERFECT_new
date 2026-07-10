const fs = require('fs');
const path = require('path');

console.log('🛠️ Patching Tauri V2 Unstable Features...');

// 1. Force enable 'unstable' feature in Cargo.toml
const cargoTomlPath = path.join('src-tauri', 'Cargo.toml');
let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');

if (!cargoToml.includes('"unstable"')) {
    cargoToml = cargoToml.replace(/features\s*=\s*\["devtools"\]/, 'features = ["devtools", "unstable"]');
    fs.writeFileSync(cargoTomlPath, cargoToml);
    console.log('✅ Added "unstable" feature to Cargo.toml');
} else {
    console.log('✅ "unstable" feature already exists in Cargo.toml');
}

// 2. Overwrite main.rs completely with the fully-compiled fix
const mainRsPath = path.join('src-tauri', 'src', 'main.rs');
const newMainRs = `#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

// Notice the new tauri::webview::WebviewBuilder path and Logical coordinates!
use tauri::{webview::{WebviewBuilder, WebviewUrl}, LogicalPosition, LogicalSize, Manager};

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[tauri::command]
fn embed_website(app: tauri::AppHandle, label: String, url: String, x: f64, y: f64, width: f64, height: f64) {
    // 1. Get the WebviewWindow Wrapper
    let main_webview_window = app.get_webview_window("main").unwrap();

    // 2. We must look up existing webviews natively now
    if let Some(existing_webview) = app.get_webview(&label) {
        let _ = existing_webview.close();
    }

    // 3. Construct the builder
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url.parse().unwrap()))
        .auto_resize()
        // Spoof identity to bypass AI bot blockers!
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");

    // 4. Extract the raw OS Window and add the child Webview natively
    let _webview = main_webview_window.as_ref().window()
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width, height))
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
`;

fs.writeFileSync(mainRsPath, newMainRs);
console.log('✅ Overwrote main.rs with fixed add_child coordinates and Webview methods!');
