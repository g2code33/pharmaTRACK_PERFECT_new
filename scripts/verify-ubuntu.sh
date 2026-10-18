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

def fingerprint(path):
    """First bytes + size, so the screenshot tells us WHAT the corruption is."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(16)
        return len(head), " ".join(f"{b:02x}" for b in head)
    except OSError as exc:
        return -1, f"unreadable: {exc}"

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

print(f"    {ok} of {len(manifest)} files match the release")
for label, items in (("CORRUPTED (bytes differ)", bad), ("MISSING", missing)):
    for rel in items[:12]:
        full = os.path.join(dist_dir, rel)
        size, head = fingerprint(full) if label.startswith("CORRUPTED") else (-1, "-")
        note = ""
        if head.startswith("25 50 44 46"):
            note = "  <-- starts with %PDF (a PDF is sitting where this file should be!)"
        print(f"    {label}: {rel}  ({size} bytes, head: {head}){note}")
    if len(items) > 12:
        print(f"    … and {len(items) - 12} more {label.split()[0].lower()} files")
if bad or missing:
    print("!! The files on disk are NOT what the package shipped.")
    print("   This is decided on DISK — no webview, no cache, no protocol involved.")
    print("   Repair attempt: run scripts/update-ubuntu.sh (reinstalls the same version).")
    print("   If the same files fail again after that, the disk or RAM is writing bad")
    print("   bytes — run a memory test and check disk health before anything else.")
    sys.exit(1)
print("==> Disk is clean: every file is exactly what the package shipped.")
EOF
