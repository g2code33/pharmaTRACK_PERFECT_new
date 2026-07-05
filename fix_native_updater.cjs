const fs = require('fs');

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');

// 1. Make sure Tauri's native updater plugins are imported
if (!layout.includes("import { check } from '@tauri-apps/plugin-updater'")) {
    layout = layout.replace(
        "import { getVersion } from '@tauri-apps/api/app';", 
        "import { getVersion } from '@tauri-apps/api/app';\nimport { check } from '@tauri-apps/plugin-updater';\nimport { relaunch } from '@tauri-apps/plugin-process';"
    );
}

// 2. Replace the web-browser fallback with the True Native Background Downloader
const nativeUpdateFunc = `  const checkForUpdates = async () => {
    try {
      setUpdateStatus('checking');
      const update = await check();
      
      if (update) {
        setUpdateStatus('available');
        let downloaded = 0;
        let contentLength = 0;
        
        if (window.confirm(\`Version \${update.version} is available! Do you want to download and install it now?\`)) {
          setUpdateStatus('downloading');
          
          // Natively download and install in the background
          await update.downloadAndInstall((event) => {
            if (event.event === 'Started') contentLength = event.data.contentLength || 0;
            if (event.event === 'Progress') downloaded += event.data.chunkLength;
            console.log(\`Downloaded \${downloaded} of \${contentLength}\`);
          });
          
          setUpdateStatus('done');
          alert('Update installed successfully! The app will now restart.');
          await relaunch(); // Auto-restarts the app!
        } else {
          setUpdateStatus('idle');
        }
      } else {
        const currentVersion = await getVersion();
        alert('You are already on the latest version (' + currentVersion + ')!');
        setUpdateStatus('idle');
      }
    } catch (error: any) {
      console.error('Update failed:', error);
      alert(\`Update Check Failed: \${error.message || error}\`);
      setUpdateStatus('idle');
    }
  };`;

const oldRegex = /const checkForUpdates = async \(\) => \{[\s\S]*?setUpdateStatus\('idle'\);\n    \}\n  \};/;
layout = layout.replace(oldRegex, nativeUpdateFunc);

// 3. Bump version to v1.1.19
layout = layout.replace(/v1\.1\.\d+/g, 'v1.1.19');
fs.writeFileSync('src/components/Layout.tsx', layout);

// 4. Restore the Public Key to tauri.conf.json so the background downloader trusts the file!
let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.plugins = t.plugins || {};
t.plugins.updater = {
  endpoints: ['https://github.com/g2code33/pharmaTRACK_PERFECT_new/releases/latest/download/latest.json'],
  pubkey: "untrusted comment: minisign public key: 266819AA42D89928\nRWQomdhCqhloJngNlFUkTH0eZnb23xkL+RD1u2LNsYx/uXic/LVagQGwC"
};
t.version = '1.1.19';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.19';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

console.log("Restored Native Background Auto-Updater and bumped to 1.1.19");
