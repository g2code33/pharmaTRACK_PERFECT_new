# Manual steps for `.github/workflows/release.yml`

GitHub blocks the Arena app from editing `.github/workflows/**` without extra
`workflows` permission, so these two changes have to be pasted in by hand.
Both are copy-paste. You can delete this file afterwards.

---

## 1. Gate releases on tests and version consistency

Without this a release can be built and published even when the tests fail or
the version is inconsistent. The version one matters most: if
`src-tauri/tauri.conf.json` lags behind, the updater silently never offers the
update and you would not find out until users complained.

Find this in the **build-windows** job (around line 33):

```yaml
      - run: npm install --legacy-peer-deps
      - run: npm run build
```

Replace with:

```yaml
      - run: npm install --legacy-peer-deps

      # Fail early rather than shipping a broken or unreachable update.
      - name: Check version consistency
        run: npm run version:check
      - name: Lint
        run: npm run lint
      - name: Run tests
        run: npm test

      - run: npm run build
```

Only **build-windows** needs it — it runs first and the Linux job depends on
it, so a failure stops the whole release.

---

## 2. Add macOS builds

Pharmacy students use MacBooks, and the workflow currently ships Windows and
Linux only.

### a. Add the job

Paste this **between** `build-windows` and `build-linux-and-release`:

```yaml
  build-macos:
    needs: build-windows
    permissions:
      contents: write
    runs-on: macos-latest
    outputs:
      mac_sig: ${{ steps.mac_sig.outputs.sig }}
    env:
      VITE_SUPABASE_URL: "${{ secrets.VITE_SUPABASE_URL }}"
      VITE_SUPABASE_ANON_KEY: "${{ secrets.VITE_SUPABASE_ANON_KEY }}"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: aarch64-apple-darwin,x86_64-apple-darwin }

      - run: npm install --legacy-peer-deps
      - run: npm run build

      # universal-apple-darwin covers both Intel and Apple Silicon in one
      # bundle, so only a single updater entry is needed.
      - name: Build macOS App
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}"
          TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_B64 }}"
        with:
          args: --target universal-apple-darwin
          tagName: v__VERSION__
          releaseName: "PharmaTRACK v__VERSION__"
          releaseDraft: true
          prerelease: false

      - name: Read macOS Signature
        id: mac_sig
        shell: bash
        run: |
          SIG_FILE=$(find src-tauri/target -name "*.app.tar.gz.sig" 2>/dev/null | head -n 1)
          SIG=$(cat "$SIG_FILE" 2>/dev/null || echo "")
          if [ -z "$SIG" ]; then
            echo "ERROR: No macOS .sig file found." >&2
            exit 1
          fi
          echo "sig=$SIG" >> $GITHUB_OUTPUT
```

### b. Let the release job wait for it

In `build-linux-and-release`, change:

```yaml
    needs: build-windows
```

to:

```yaml
    needs: [build-windows, build-macos]
```

### c. Put macOS in the updater manifest

Otherwise Mac users are never offered updates. In the **Generate Manual
Manifest File** step, add to `env:`:

```yaml
          MAC_SIG: ${{ needs.build-macos.outputs.mac_sig }}
```

and add this platform entry after `linux-x86_64` (mind the comma on the line
before it):

```json
              "darwin-universal": {
                "signature": "$MAC_SIG",
                "url": "https://github.com/$REPO/releases/download/v$APP_VER/PharmaTRACK_universal.app.tar.gz"
              }
```

> Check the exact asset name on your first macOS draft release and correct the
> URL if it differs — the filename depends on `productName` and the target.

### Unsigned builds

Without an Apple Developer certificate (~$99/year) macOS shows
"PharmaTRACK is damaged and can't be opened". It isn't damaged — it's
unsigned. Users can right-click the app and choose **Open** once to bypass it.
Worth mentioning in your release notes.

---

## Verify

Push to `main` and open the **Actions** tab. You should see **Check version
consistency**, **Lint** and **Run tests** run green before the build, plus a
**build-macos** job producing a `.dmg` and a `.app.tar.gz`.
