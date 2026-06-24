const fs = require('fs');

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
const newUpdateFunc = `  const checkForUpdates = async () => {\n    try {\n      setUpdateStatus('checking');\n      const update = await check();\n      if (update) {\n        setUpdateStatus('available');\n        if (window.confirm(\`Version \${update.version} is available! Do you want to install it now?\`)) {\n          setUpdateStatus('downloading');\n          await update.downloadAndInstall();\n          setUpdateStatus('done');\n          alert('Update complete! The app will now restart.');\n          await relaunch();\n        } else {\n          setUpdateStatus('idle');\n        }\n      } else {\n        alert('You are already on the latest version!');\n        setUpdateStatus('idle');\n      }\n    } catch (error: any) {\n      console.error('Update failed:', error);\n      alert(\`Update Check Failed: \${error.message || error}\`);\n      setUpdateStatus('idle');\n    }\n  };`;
layout = layout.replace(/const checkForUpdates = async \(\) => \{[\s\S]*?setUpdateStatus\('idle'\);\n    \}\n  \};/, newUpdateFunc);
fs.writeFileSync('src/components/Layout.tsx', layout);

let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
if (t.plugins && t.plugins.updater) {
  delete t.plugins.updater.pubkey; // DELETES PUBKEY REQUIREMENT
}
t.version = '1.0.10';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.0.10';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
