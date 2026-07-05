const fs = require('fs');

// 1. Rewrite Rust backend to expose the devtools command and REMOVE the auto-open hook
const mainRs = `#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![open_devtools])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}`;
fs.writeFileSync('src-tauri/src/main.rs', mainRs);

// 2. Enable devtools in Cargo.toml so it works in the final .exe/.deb builds
let cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
cargo = cargo.replace(/tauri = \{ version = "2"[^\}]*\}/, 'tauri = { version = "2", features = ["devtools"] }');
fs.writeFileSync('src-tauri/Cargo.toml', cargo);

// 3. Inject the DevTools button into Settings.tsx
let settings = fs.readFileSync('src/pages/Settings.tsx', 'utf8');

if (!settings.includes("@tauri-apps/api/core")) {
    settings = settings.replace("import React", "import { invoke } from '@tauri-apps/api/core';\nimport React");
}

const devToolsUI = `
      {/* Developer Options */}
      <div className="bg-slate-900 rounded-2xl p-6 shadow-sm border border-slate-800 text-white">
        <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
          Developer Options
        </h3>
        <p className="text-sm text-slate-400 mb-4">Advanced debugging tools. Use this to inspect elements and view the console.</p>
        <button 
          onClick={() => invoke('open_devtools')} 
          className="px-6 py-3 bg-[#FFB703] text-[#2D6A4F] rounded-xl font-black shadow-md hover:bg-yellow-400 transition-all"
        >
          Open Inspect Element
        </button>
      </div>
`;

if (!settings.includes("invoke('open_devtools')")) {
    // Inject the button right at the top of the Settings page
    settings = settings.replace('<div className="max-w-4xl mx-auto space-y-6">', '<div className="max-w-4xl mx-auto space-y-6">\n' + devToolsUI);
    fs.writeFileSync('src/pages/Settings.tsx', settings);
}

console.log("DevTools button added to Settings page!");
