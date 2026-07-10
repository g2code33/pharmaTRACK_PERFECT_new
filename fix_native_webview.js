const fs = require('fs');
const path = require('path');

console.log("🛠️  Patching Tauri V2 Unstable Features...");

// 1. Enable Unstable Features in Cargo.toml
const cargoTomlPath = path.join('src-tauri', 'Cargo.toml');
let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');

if (cargoToml.includes('features = ["devtools"]') && !cargoToml.includes('"unstable"')) {
    cargoToml = cargoToml.replace('features = ["devtools"]', 'features = ["devtools", "unstable"]');
    fs.writeFileSync(cargoTomlPath, cargoToml);
    console.log('✅ Added "unstable" feature to Cargo.toml');
} else {
    console.log('✅ "unstable" feature already exists in Cargo.toml.');
}

// 2. Refactor native window coordinates in main.rs
const mainRsPath = path.join('src-tauri', 'src', 'main.rs');
let mainRs = fs.readFileSync(mainRsPath, 'utf8');

if (!mainRs.includes('LogicalPosition')) {
    mainRs = mainRs.replace(
        'use tauri::{Manager, WebviewBuilder, WebviewUrl};',
        'use tauri::{LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};'
    );
}

// Robust regex targeting the older broken add_child builder chain
const oldPatternRegexStr = /let _webview = main_window\s*\.add_child\(\s*WebviewBuilder::new\(&label, WebviewUrl::External\(url\.parse\(\)\.unwrap\(\)\)\)[\s\S]*?\.user_agent\("[^"]+"\),\s*\)\s*\.unwrap\(\);/g;

const newWebviewLogic = `let builder = WebviewBuilder::new(&label, WebviewUrl::External(url.parse().unwrap()))
        .auto_resize()
        // Spoof identity to bypass AI bot blockers!
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");

    let _webview = main_window.as_ref().window()
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width, height))
        .unwrap();`;

if (oldPatternRegexStr.test(mainRs)) {
    mainRs = mainRs.replace(oldPatternRegexStr, newWebviewLogic);
    fs.writeFileSync(mainRsPath, mainRs);
    console.log('✅ Successfully refactored main.rs syntax and Webview window coordinates!');
} else {
    console.log('✅ main.rs already patched or matching failed. No changes needed.');
}
