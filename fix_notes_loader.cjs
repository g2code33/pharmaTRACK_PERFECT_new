const fs = require('fs');

let code = fs.readFileSync('src/pages/Notes.tsx', 'utf8');

// Ensure Loader2 is explicitly imported
const regex = /import \{[\s\S]*?\} from 'lucide-react';/;
const oldImports = code.match(regex)[0];
if (!oldImports.includes('Loader2')) {
    const newImports = oldImports.replace('Paperclip,', 'Paperclip, Loader2,');
    code = code.replace(oldImports, newImports);
}

fs.writeFileSync('src/pages/Notes.tsx', code);

// Bump version to 1.1.15
let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.15';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.15';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
layout = layout.replace(/v1\.\d+\.\d+/g, 'v1.1.15');
fs.writeFileSync('src/components/Layout.tsx', layout);
