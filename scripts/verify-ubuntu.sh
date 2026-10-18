#!/usr/bin/env bash
#
# PharmaTRACK Ubuntu disk verifier — ground truth about the installation.
#
# The app's own startup check verifies files through the webview, which is
# the right thing 99% of the time. When something is still off, this script
# verifies the exact same manifest straight from DISK, with no webview,
# service worker, or asset protocol in between. It answers one question:
# are the files on disk the files the package shipped?
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/g2code33/pharmaTRACK_PERFECT_new/arena/01a0e837-pharmatrack-perfect-new/scripts/verify-ubuntu.sh)
set -euo pipefail

PKG_NAME="pharma-track"

if ! command -v dpkg-query >/dev/null 2>&1; then
  echo "!! dpkg-query not available — this script is for Debian/Ubuntu." >&2
  exit 1
fi

echo "==> Installed version: $(dpkg-query -W -f='${Version}' "$PKG_NAME" 2>/dev/null || echo none)"

MANIFEST="$(dpkg-query -L "$PKG_NAME" 2>/dev/null | grep 'dist/integrity.json$' | head -n 1 || true)"
if [ -z "$MANIFEST" ]; then
  echo "!! No integrity manifest found in the $PKG_NAME package." >&2
  echo "   (If the app works, your version predates the manifest — nothing to verify.)" >&2
  exit 0
fi
DIST_DIR="$(dirname "$MANIFEST")"
echo "==> Verifying every shipped file under $DIST_DIR against $MANIFEST …"

python3 - "$MANIFEST" "$DIST_DIR" <<'EOF'
import hashlib, json, os, sys

manifest_path, dist_dir = sys.argv[1], sys.argv[2]
with open(manifest_path) as fh:
    manifest = json.load(fh)["files"]

bad, missing, ok = [], [], 0
for rel, expected in sorted(manifest.items()):
    full = os.path.join(dist_dir, rel)
    if not os.path.isfile(full):
        missing.append(rel)
        continue
    with open(full, "rb") as fh:
        actual = hashlib.sha256(fh.read()).hexdigest()
    if actual != expected:
        bad.append(rel)
    else:
        ok += 1

print(f"    {ok} files match the release")
for rel in bad:
    print(f"    CORRUPTED (bytes differ): {rel}")
for rel in missing:
    print(f"    MISSING: {rel}")
if bad or missing:
    print("!! The files on disk are NOT what the package shipped.")
    print("   Repair: run scripts/update-ubuntu.sh (it reinstalls over the same version).")
    sys.exit(1)
print("==> Disk is clean: every file is exactly what the package shipped.")
EOF
