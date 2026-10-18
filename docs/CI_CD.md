# CI/CD and Release Automation

How PharmaTRACK is validated on every change and how a release reaches
GitHub — web, Android and desktop from one pipeline.

## What runs when

| Workflow | Trigger | What it proves |
| --- | --- | --- |
| `pull-request-validation.yml` | every pull request and every push to `main` | the full gate below, in parallel |
| `unit-tests.yml` | called by the two above | web suite (vitest ~780 tests), lint, `tsc` + production build, worker typecheck, desktop shell `cargo check` + `cargo test` |
| `dependency-validation.yml` | called by the two above | `npm ci` lockfile sync, `cargo fetch --locked`, the full Android dependency graph, `npm run version:check` (one product version everywhere) |
| `kotlin-compile.yml` | called by the two above | Kotlin sources compile in **both** debug and release variants |
| `android-build.yml` | called; `pr` mode on PRs, `release` mode for releases | PR: debug APK + JVM unit tests (no secrets, fork-safe). Release: signed APK (apksigner) + signed AAB (jarsigner) with the pinned release certificate |
| `desktop-windows.yml` | called | MSI + NSIS installers built on a **Windows** runner, updater signatures when the key is available |
| `desktop-linux.yml` | called | `.deb` built on **Ubuntu 22.04** (older glibc → wider install base), updater signature |
| `release.yml` | tag push `v*` (or manual dispatch) | the full release process below |
| `cloudflare.yml` | push to `main` (unchanged) | web deployment to Cloudflare Pages |

Platform runners are chosen deliberately: Ubuntu builds the Linux package and
all Android artifacts, Windows builds its own installers. No macOS target
exists, so none is built or claimed.

## Release process

A release is started by pushing a tag that matches the product version
**exactly**:

```bash
npm run version:set 1.2.3   # bumps package.json, tauri.conf.json, Cargo, in-app fallback
git commit -am "chore: release 1.2.3"
git tag v1.2.3
git push origin main --tags
```

The workflow then, in order:

1. **Validate version** — the tag equals `package.json`'s version, and
   `version:check` confirms every platform manifest agrees. Android's
   `versionCode` is derived from the version in `android/app/build.gradle.kts`
   (monotonic, platform-specific build number).
2. **Run tests** — the same unit-test and dependency-validation workflows PRs
   must pass. A red test run cannot ship.
3. **Build all supported targets in parallel** — Android APK + AAB (signed),
   Windows MSI + NSIS, Linux `.deb`. A failed platform build fails the whole
   release; nothing is silently skipped.
4. **Generate checksums** — `SHA256SUMS.txt` over every downloadable binary.
5. **Generate release notes** — grouped commit log since the previous tag,
   plus install instructions.
6. **Upload artifacts** — everything is verified present and non-trivial
   (> 1 MB binaries, non-empty signatures) before anything is attached.
7. **Publish** — only after all of the above: the GitHub release is created
   from the protected `release` environment and flagged `latest`, because the
   desktop updater reads `releases/latest/download/latest.json`.

A manual `workflow_dispatch` run performs steps 1–6 only and never publishes.

### Release artifacts

```
PharmaTRACK-1.2.3-android.apk        signed Android app (sideload)
PharmaTRACK-1.2.3-android.aab        signed Android App Bundle (Play upload)
PharmaTRACK-1.2.3-windows-x64.msi    Windows installer (updater target)
PharmaTRACK-1.2.3-windows-x64.exe    Windows NSIS installer
pharmatrack_1.2.3_amd64.deb          Linux package (updater target)
*.sig                                updater signatures (MSI, exe, deb)
SHA256SUMS.txt                       checksums for every binary
latest.json                          desktop updater manifest
```

## Security rules

- **Actions are pinned to immutable commit SHAs** with the version in a
  comment. Dependabot updates them monthly (`.github/dependabot.yml`).
- **No signing material in logs.** The Android keystore is decoded straight to
  a file from the `ANDROID_KEYSTORE_BASE64` secret and never echoed; the Tauri
  updater key is written to the job environment without printing; only the
  public certificate SHA-256 (already published in
  `public/.well-known/assetlinks.json`) is compared and logged.
- **Fail-closed signing.** Release-mode Android and desktop builds hard-fail
  with a `::error` annotation when a required secret is missing — they never
  silently produce unsigned or debug-signed artifacts. The release certificate
  fingerprint is pinned, so a rotated or wrong keystore is rejected before
  anything ships.
- **Releases are restricted.** `release.yml` only publishes on a `v*` tag
  push; the publishing job runs in the `release` **environment** — add
  required reviewers there (Settings → Environments → release) to require a
  human approval before anything goes public. It carries `contents: write`
  for exactly one job; every other job in every workflow is read-only.
- **Untrusted pull requests publish nothing.** PR validation never creates
  releases or uploads release assets. Fork PRs receive no repo secrets at
  all: Android runs the unsigned debug + tests path, and desktop builds
  disable the updater payload via a merged `createUpdaterArtifacts: false`
  config (Tauri refuses to build a signed updater artifact without the key).
  `pull_request_target` is deliberately never used.
- **Missing validations are visible.** Each platform is its own job; a failed
  or missing artifact is named in a `::error` annotation at packaging time,
  and the packaging job writes a summary table of exactly what was verified.

## Secrets

| Secret | Used by | Notes |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY_B64` | desktop builds | updater signing key, exactly as produced by `cat updater_keys` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | desktop builds | only if the key is password-protected |
| `ANDROID_KEYSTORE_BASE64` | android release | `base64 -w 0 pharmatrack-release.p12` |
| `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | android release | keystore credentials |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | builds | optional; public fallbacks are compiled in |

See `docs/ANDROID_APK_RELEASE.md` for the Android signing background and
`docs/CLOUDFLARE_INFRASTRUCTURE.md` for the web deployment.

## Tips

- Full PR validation is intentionally thorough (it builds real installers on
  all three platforms). For docs-only changes you can close and reopen the PR
  or push an empty commit to re-run; to trim costs later, add path filters to
  `pull-request-validation.yml`.
- If the release workflow fails at packaging with a "missing artifact"
  annotation, the named file's platform job is the place to look — the error
  names the exact file that was not produced.
