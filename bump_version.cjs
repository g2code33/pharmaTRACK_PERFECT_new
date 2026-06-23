const fs = require('fs');

// Update tauri.conf.json to v1.0.1
const tauriPath = 'src-tauri/tauri.conf.json';
let conf = JSON.parse(fs.readFileSync(tauriPath, 'utf8'));
conf.version = '1.0.1';
fs.writeFileSync(tauriPath, JSON.stringify(conf, null, 2));

// Update package.json to v1.0.1
const pkgPath = 'package.json';
let pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = '1.0.1';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

console.log("Version bumped to 1.0.1 successfully!");
