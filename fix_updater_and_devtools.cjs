const fs = require('fs');

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');

// Swap out the broken Tauri updater plugin for the Shell plugin
layout = layout.replace(
  "import { check } from '@tauri-apps/plugin-updater';",
  "import { open } from '@tauri-apps/plugin-shell';"
);
layout = layout.replace("import { relaunch } from '@tauri-apps/plugin-process';", "");

// The Foolproof Custom Updater Logic
const oldUpdateFuncRegex = /const checkForUpdates = async \(\) => \{[\s\S]*?setUpdateStatus\('idle'\);\n    \}\n  \};/;
const newUpdateFunc = `  const checkForUpdates = async () => {
    try {
      setUpdateStatus('checking');
      const currentVersion = await getVersion();
      
      // 1. Fetch directly from GitHub's public API (No signatures required!)
      const response = await fetch('https://api.github.com/repos/g2code33/pharmaTRACK_PERFECT_new/releases/latest');
      if (!response.ok) throw new Error('Could not connect to GitHub');
      
      const data = await response.json();
      const latestVersion = data.tag_name.replace('v', '');
      
      // 2. Compare versions
      if (latestVersion !== currentVersion) {
        setUpdateStatus('available');
        if (window.confirm(\`Good news! Version \${latestVersion} is available! (You have \${currentVersion})\\n\\nClick OK to open the download page.\`)) {
          await open(data.html_url); // Opens GitHub Releases natively in their web browser
          setUpdateStatus('idle');
        } else {
          setUpdateStatus('idle');
        }
      } else {
        alert('You are already on the latest version (' + currentVersion + ')!');
        setUpdateStatus('idle');
      }
    } catch (error: any) {
      console.error('Update failed:', error);
      alert(\`Update Check Failed: \${error.message || error}\`);
      setUpdateStatus('idle');
    }
  };`;

layout = layout.replace(oldUpdateFuncRegex, newUpdateFunc);
fs.writeFileSync('src/components/Layout.tsx', layout);

// 2. ENABLE DEVELOPER MODE (INSPECT ELEMENT)
let mainRs = fs.readFileSync('src-tauri/src/main.rs', 'utf8');
if (!mainRs.includes('open_devtools')) {
    const devToolsHook = `use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.open_devtools(); // Forces Inspect Element open on launch!
            Ok(())
        })`;
    mainRs = mainRs.replace('fn main() {', devToolsHook.replace('fn main() {', ''));
    fs.writeFileSync('src-tauri/src/main.rs', mainRs);
}

// 3. Bump version to 1.1.4 to trigger the build
let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.4';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.4';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

console.log("Foolproof Updater and Developer Mode successfully installed!");
