const fs = require('fs');

// 1. Fix the Rust Backend so the Updater Button works
let mainRs = fs.readFileSync('src-tauri/src/main.rs', 'utf8');
if (!mainRs.includes('tauri_plugin_updater')) {
    mainRs = mainRs.replace(
        '.plugin(tauri_plugin_shell::init())',
        '.plugin(tauri_plugin_shell::init())\n        .plugin(tauri_plugin_process::init())\n        .plugin(tauri_plugin_updater::Builder::new().build())'
    );
    fs.writeFileSync('src-tauri/src/main.rs', mainRs);
}

// 2. Fix the Cargo dependencies
let cargoToml = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
if (!cargoToml.includes('tauri-plugin-updater')) {
    cargoToml = cargoToml.replace(
        'tauri-plugin-shell = "2"',
        'tauri-plugin-shell = "2"\ntauri-plugin-updater = "2"\ntauri-plugin-process = "2"'
    );
    fs.writeFileSync('src-tauri/Cargo.toml', cargoToml);
}

// 3. Revert ChatGPT to Google Search to bypass OpenAI's aggressive security block
let slideReader = fs.readFileSync('src/pages/SlideReader.tsx', 'utf8');
slideReader = slideReader.replace(/https:\/\/chatgpt\.com/g, 'https://www.google.com/search?igu=1');
fs.writeFileSync('src/pages/SlideReader.tsx', slideReader);
