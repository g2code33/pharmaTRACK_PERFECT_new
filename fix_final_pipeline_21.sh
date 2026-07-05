# 1. Provide the CORRECTED Matrix workflow
cat << 'YML_EOF' > .github/workflows/release.yml
name: "Build & Release PharmaTRACK"

on:
  push:
    branches: [ main ]
  workflow_dispatch:

jobs:
  release:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            target: x86_64-pc-windows-msvc
          - os: ubuntu-22.04
            target: ""

    runs-on: ${{ matrix.os }}
    
    env:
      TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      - name: Install Linux Dependencies
        if: matrix.os == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libsoup-3.0-dev build-essential curl wget file libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev

      - name: Install Dependencies
        run: npm install --legacy-peer-deps

      - name: Build Web Assets
        run: npm run build
        env:
          VITE_SUPABASE_URL: "${{ secrets.VITE_SUPABASE_URL }}"
          VITE_SUPABASE_ANON_KEY: "${{ secrets.VITE_SUPABASE_ANON_KEY }}"

      - name: Build and Sign Tauri App
        uses: tauri-apps/tauri-action@v0.5.17
        env:
          GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}"
          TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"
        with:
          tagName: v__VERSION__
          releaseName: "PharmaTRACK v__VERSION__"
          releaseBody: "Official binaries and update artifacts for PharmaTRACK."
          releaseDraft: false
          prerelease: false
          includeUpdaterJson: true

  updater:
    needs: release
    permissions:
      contents: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Tauri Update Manifest Sync
        uses: tauri-apps/tauri-action@v0.5.17
        env:
          GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}"
        with:
          includeRelease: false
          includeUpdaterJson: true
YML_EOF

# 2. Bump version to 1.1.21
node -e "
const fs = require('fs');

let t = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
t.version = '1.1.21';
fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(t, null, 2));

let p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '1.1.21';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));

let layout = fs.readFileSync('src/components/Layout.tsx', 'utf8');
layout = layout.replace(/v1\.\d+\.\d+/g, 'v1.1.21');
fs.writeFileSync('src/components/Layout.tsx', layout);
console.log('Version bumped to 1.1.21');
"

# 3. Push to GitHub!
git add .
git commit -m "Fixed updater manifest sync arguments (v1.1.21)"
git push
