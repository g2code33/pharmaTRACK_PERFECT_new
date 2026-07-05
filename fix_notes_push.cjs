const fs = require('fs');

// 1. Force the TypeScript 'Note' type to accept attached files
let typeCode = fs.readFileSync('src/types/index.ts', 'utf8');
typeCode = typeCode.replace(
  /export interface Note \{[\s\S]*?avatar_url\?: string;\n\}/g,
  "export interface Note {\n  id: string;\n  topicId: string;\n  noteText: string;\n  isAiGenerated: boolean;\n  createdAt: string;\n  avatar_url?: string;\n  attachedFiles?: { id: string; name: string; type: string; data: string }[];\n}"
);
fs.writeFileSync('src/types/index.ts', typeCode);

// 2. Bump versions to 1.1.14
let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.14';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.14';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
layout = layout.replace(/v1\.\d+\.\d+/g, 'v1.1.14');
fs.writeFileSync('src/components/Layout.tsx', layout);
