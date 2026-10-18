#!/usr/bin/env bash
#
# PharmaTRACK complete reinstall (Ubuntu).
#
# For the machine where nothing else worked. Three layers of state exist and
# a plain reinstall only touches the first:
#
#   1. The package files        — replaced by any reinstall.
#   2. The webview's caches and SERVICE WORKER REGISTRATIONS, which live in
#      ~/.config/com.pharmatrack.app/ and survive every reinstall forever.
#      A worker registered there once intercepts every /assets/ request the
#      app makes; its own fetches bypass the shell's protocol handler, so
#      pages crash with wrong-MIME errors on a perfectly clean disk.
#   3. The user's own data (IndexedDB, Local Storage, databases) — in the
#      SAME profile directory, so this script deletes only the cache and
#      service-worker entries BY NAME and leaves all data alone.
#
# Run WITHOUT sudo (it elevates itself). Close PharmaTRACK first.
set -euo pipefail

REPO="g2code33/pharmaTRACK_PERFECT_new"
BRANCH_REF="https://raw.githubusercontent.com/${REPO}/arena/01a0e837-pharmatrack-perfect-new"
IDENTIFIER="com.pharmatrack.app"
PROFILE="${HOME}/.config/${IDENTIFIER}"

if [ "$(id -u)" -eq 0 ]; then
  echo "!! Run this WITHOUT sudo — it must clean YOUR user profile and elevates itself where needed." >&2
  exit 1
fi

echo "==> Step 0/4: checking that PharmaTRACK is closed…"
if pgrep -ix 'PharmaTRACK' >/dev/null 2>&1 || pgrep -ix 'pharma-track' >/dev/null 2>&1; then
  echo "!! PharmaTRACK is still running. Close it completely (the X, not minimise), then re-run." >&2
  exit 1
fi
echo "    closed."

echo "==> Step 1/4: purging every installed PharmaTRACK package…"
PKGS="$(dpkg -l 2>/dev/null | awk '/^ii/ && $2 ~ /pharma/ {print $2}' || true)"
if [ -n "${PKGS}" ]; then
  echo "    removing: ${PKGS}"
  # shellcheck disable=SC2086
  sudo apt-get purge -y ${PKGS}
else
  echo "    (no installed package found — nothing to purge)"
fi
sudo apt-get autoremove -y >/dev/null 2>&1 || true

echo "==> Step 2/4: clearing the webview's cached and service-worker state…"
if [ -d "${PROFILE}" ]; then
  echo "    profile contents before cleaning:"
  ls -la "${PROFILE}" 2>/dev/null | sed 's/^/      /' || true
  # ONLY the webview's cache and service-worker entries go. The user's data
  # (IndexedDB, Local Storage, databases, settings) is preserved by name.
  for entry in "EBICache" "Service Worker" "Code Cache" "GPUCache" "Cache" "CachedLayers"; do
    rm -rf "${PROFILE:?}/${entry}"
  done
  rm -rf "${PROFILE:?}"/serviceworker* 2>/dev/null || true
  echo "    cleared cache + service-worker registrations (your data is preserved)."
else
  echo "    (no profile directory found — clean.)"
fi

echo "==> Step 3/4: fresh install of the latest release…"
curl --fail --location --retry 3 --silent --show-error -o /tmp/pharmatrack-update.sh \
  "${BRANCH_REF}/scripts/update-ubuntu.sh"
sudo bash /tmp/pharmatrack-update.sh

echo "==> Step 4/4: verifying what landed on disk…"
PKG_NAME="pharma-track"
TOTAL="$(dpkg -L "${PKG_NAME}" 2>/dev/null | wc -l || echo 0)"
ASSETS="$(dpkg -L "${PKG_NAME}" 2>/dev/null | grep -c 'dist/assets/' || echo 0)"
echo "    package files installed: ${TOTAL}"
echo "    dist/assets files installed: ${ASSETS} (expected: 105)"
bash <(curl --fail --location --retry 3 --silent --show-error "${BRANCH_REF}/scripts/verify-ubuntu.sh")

echo ""
echo "==> Done. Launch PharmaTRACK from your applications menu."
echo "    If anything still fails, screenshot THIS terminal output — it contains"
echo "    the proof of what is on disk, and the app's error card names the rest."
