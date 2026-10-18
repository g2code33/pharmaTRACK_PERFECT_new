#!/usr/bin/env bash
#
# PharmaTRACK Ubuntu disk verifier — ground truth about the installation.
#
# v2: the app's web files are EMBEDDED inside the PharmaTRACK binary by the
# packaging (there is no dist/ directory on disk), so an earlier version of
# this script that looked for dist/integrity.json via dpkg -L could never
# find anything. What CAN be verified on disk is what dpkg actually wrote:
# every installed file's MD5 is recorded in /var/lib/dpkg/info/<pkg>.md5sums
# at install time, and re-checking those hashes now catches any file that
# was corrupted on disk AFTER a verified download — a flaky disk or RAM
# writes bad bytes exactly here. No webview, no cache, no protocol involved.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/g2code33/pharmaTRACK_PERFECT_new/arena/01a0e837-pharmatrack-perfect-new/scripts/verify-ubuntu.sh)
set -u

PKG_NAME="pharma-track"

if ! command -v dpkg-query >/dev/null 2>&1; then
  echo "!! dpkg-query not available — this script is for Debian/Ubuntu." >&2
  exit 1
fi

VERSION="$(dpkg-query -W -f='${Version}' "$PKG_NAME" 2>/dev/null || true)"
if [ -z "$VERSION" ]; then
  echo "!! $PKG_NAME is not installed — nothing to verify. Install first:"
  echo "   bash <(curl -fsSL https://raw.githubusercontent.com/g2code33/pharmaTRACK_PERFECT_new/arena/01a0e837-pharmatrack-perfect-new/scripts/update-ubuntu.sh)"
  exit 1
fi
echo "==> Installed version: $VERSION"

MD5SUMS="/var/lib/dpkg/info/${PKG_NAME}.md5sums"
if [ ! -f "$MD5SUMS" ]; then
  echo "!! No dpkg md5sums ledger found at $MD5SUMS — cannot verify on-disk state."
  exit 1
fi

FILES_TOTAL="$(wc -l < "$MD5SUMS")"
echo "==> Verifying every installed file of the package against dpkg's install-time hashes …"
echo "    (the app's web files are embedded in the binary, so the package is"
echo "     few files — the binary, icons, desktop entry — each one counted)"

# Run from / because the ledger paths are relative (./usr/...).
RESULT="$(cd / && md5sum -c "$MD5SUMS" 2>/dev/null || true)"
OK_COUNT="$(printf '%s' "$RESULT" | grep -c ': OK$' || true)"
FAILED="$(printf '%s' "$RESULT" | grep -v ': OK$' | grep -v '^$' || true)"

echo "    $OK_COUNT of $FILES_TOTAL files match the hashes recorded at install time."
if [ -n "$FAILED" ]; then
  echo "!! The files BELOW ON DISK are not the bytes dpkg wrote at install:"
  printf '%s\n' "$FAILED" | sed 's/^/      /'
  echo "   A verified download cannot produce this — the disk or RAM is"
  echo "   writing bad bytes. Run a memory test (sudo apt install memtester86+,"
  echo "   or the boot-time memtest) and check disk health"
  echo "   (gnome-disks -> SMART data) before anything else."
  exit 1
fi

echo "==> Disk is clean: every installed file is exactly what the package wrote."
echo "    If the app still shows wrong-content errors with a clean disk, the"
echo "    bad bytes are coming from the webview's own cache — run the cleaner:"
echo "    bash <(curl -fsSL https://raw.githubusercontent.com/g2code33/pharmaTRACK_PERFECT_new/arena/01a0e837-pharmatrack-perfect-new/scripts/clean-webview-ubuntu.sh)"
