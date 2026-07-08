const fs = require('fs');

// 1. Fix the missing useRef import in Layout.tsx
let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
layout = layout.replace(
  "import React, { useState, useEffect } from 'react';", 
  "import React, { useState, useEffect, useRef } from 'react';"
);

// 2. Bump Layout Version
layout = layout.replace(/useState\('1\.1\.\d+'\)/, "useState('1.1.65')");
fs.writeFileSync('src/components/Layout.tsx', layout);

// 3. Bump tauri.conf.json
let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.65';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

// 4. Bump package.json
let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.65';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

// 5. Bump package-lock.json
if (fs.existsSync('package-lock.json')) {
    let pl = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
    pl.version = '1.1.65';
    if (pl.packages && pl.packages[""]) {
        pl.packages[""].version = '1.1.65';
    }
    fs.writeFileSync('package-lock.json', JSON.stringify(pl, null, 2));
}

// 6. Bump Cargo.toml
let cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
cargo = cargo.replace(/version = "1\.1\.\d+"/g, 'version = "1.1.65"');
fs.writeFileSync('src-tauri/Cargo.toml', cargo);

console.log("All files fixed and perfectly bumped to 1.1.65!");
