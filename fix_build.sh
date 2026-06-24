cd /workspaces/pharmaTRACK_PERFECT_new

# Inject the Tauri Private Key back into the Github Actions
sed -i '/env:/a \      TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}' .github/workflows/tauri-build.yml
sed -i '/env:/a \      TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}' .github/workflows/tauri-build-ubuntu.yml

# Bump version to 1.0.7
node -e "
const fs = require('fs');
let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.0.7';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.0.7';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
"
