const fs = require('fs');

function fixAction(file) {
    let content = fs.readFileSync(file, 'utf8');
    const target = 'GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}"';
    const replacement = 'GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}"\n          TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"';
    
    // Check if quotes version exists
    if (content.includes(target) && !content.includes('TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"', content.indexOf(target))) {
        content = content.replace(target, replacement);
        fs.writeFileSync(file, content);
    } 
    // Check without quotes
    else if (content.includes('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}')) {
        content = content.replace(
            'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}', 
            'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}'
        );
        fs.writeFileSync(file, content);
    }
}

fixAction('.github/workflows/tauri-build.yml');
fixAction('.github/workflows/tauri-build-ubuntu.yml');

// Bump version to 1.1.9
let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.9';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.9';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
layout = layout.replace(/v1\.\d+\.\d+/g, 'v1.1.9');

// Make absolutely sure Layout uses native plugin-updater (downloadAndInstall)
const nativeUpdater = `import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';`;
if(!layout.includes('@tauri-apps/plugin-updater')) {
    layout = layout.replace("import { getVersion } from '@tauri-apps/api/app';", "import { getVersion } from '@tauri-apps/api/app';\n" + nativeUpdater);
}

const nativeFunc = `  const checkForUpdates = async () => {
    try {
      setUpdateStatus('checking');
      const update = await check();
      if (update) {
        setUpdateStatus('available');
        if (window.confirm(\`Version \${update.version} is available! Do you want to install it now?\`)) {
          setUpdateStatus('downloading');
          await update.downloadAndInstall();
          setUpdateStatus('done');
          alert('Update complete! The app will now restart.');
          await relaunch();
        } else {
          setUpdateStatus('idle');
        }
      } else {
        alert('You are already on the latest version!');
        setUpdateStatus('idle');
      }
    } catch (error: any) {
      console.error('Update failed:', error);
      alert(\`Update Check Failed: \${error.message || error}\`);
      setUpdateStatus('idle');
    }
  };`;

const oldRegex = /const checkForUpdates = async \(\) => \{[\s\S]*?setUpdateStatus\('idle'\);\n    \}\n  \};/;
layout = layout.replace(oldRegex, nativeFunc);
fs.writeFileSync('src/components/Layout.tsx', layout);

console.log("Restored native in-app downloads and fixed Github Actions secrets.");
