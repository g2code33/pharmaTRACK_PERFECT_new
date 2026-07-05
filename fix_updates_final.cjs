const fs = require('fs');

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');

// Replace Tauri's strict updater with our custom Github API updater
const newUpdateFunc = `  const checkForUpdates = async () => {
    try {
      setUpdateStatus('checking');
      const currentVersion = await getVersion();
      
      const response = await fetch('https://api.github.com/repos/g2code33/pharmaTRACK_PERFECT_new/releases/latest');
      if (!response.ok) throw new Error('Failed to fetch from GitHub');
      
      const data = await response.json();
      const latestVersion = data.tag_name.replace('v', '');
      
      if (latestVersion !== currentVersion) {
        setUpdateStatus('available');
        if (window.confirm(\`Good news! Version \${latestVersion} is available! (You have \${currentVersion})\\n\\nClick OK to download the new installer.\`)) {
          const { open } = await import('@tauri-apps/plugin-shell');
          await open(data.html_url); 
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

// Replace the old check function
layout = layout.replace(/const checkForUpdates = async \(\) => \{[\s\S]*?setUpdateStatus\('idle'\);\n    \}\n  \};/, newUpdateFunc);

// Bump versions to v1.1.16
layout = layout.replace(/v1\.1\.\d+/g, 'v1.1.16');
fs.writeFileSync('src/components/Layout.tsx', layout);

let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.16';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.16';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
