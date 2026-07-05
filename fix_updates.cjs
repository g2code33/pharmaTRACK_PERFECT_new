const fs = require('fs');

let conf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
if (!conf.plugins.updater.pubkey) {
    conf.plugins.updater.pubkey = "untrusted comment: minisign public key: 266819AA42D89928\nRWQomdhCqhloJngNlFUkTH0eZnb23xkL+RD1u2LNsYx/uXic/LVagQGwC";
}
conf.version = "1.1.3";
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(conf, null, 2));

let pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = "1.1.3";
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
layout = layout.replace(/v1\.1\.\d+/g, 'v1.1.3');
fs.writeFileSync('src/components/Layout.tsx', layout);
