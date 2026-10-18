#!/usr/bin/env bash
#
# PharmaTRACK Ubuntu updater — the path that cannot be blocked by the
# in-app updater's environment.
#
# The desktop app updates itself by downloading the .deb from the GitHub
# release and installing it with elevated privileges (pkexec, or a
# zenity/kdialog password prompt, or terminal sudo — whatever the session
# offers first). On a kiosk or minimal Ubuntu session none of those may be
# available, and every in-app update then fails at the install step no
# matter how healthy the release is.
#
# This script does the same update with none of those dependencies: it
# reads the release manifest, downloads the .deb, checks it against the
# release's SHA256SUMS.txt, and installs it with apt. Run it on the kiosk:
#
#   curl -fsSL -o /tmp/pharmatrack-update.sh \
#     https://raw.githubusercontent.com/g2code33/pharmaTRACK_PERFECT_new/arena/01a0e837-pharmatrack-perfect-new/scripts/update-ubuntu.sh
#   sudo bash /tmp/pharmatrack-update.sh
#
# It is also safe when the app is not installed yet (it simply installs
# it) and when the newest version is already installed (apt reinstalls
# the same version, which changes nothing).
set -euo pipefail

REPO="g2code33/pharmaTRACK_PERFECT_new"
MANIFEST_URL="https://github.com/${REPO}/releases/latest/download/latest.json"

# Re-exec through sudo so the operator does not have to remember it.
if [ "$(id -u)" -ne 0 ]; then
  echo "==> Root is needed to install the package; re-running with sudo…"
  exec sudo bash "$0" "$@"
fi

for tool in curl sha256sum apt-get; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "!! This script needs '$tool', which is not installed. Install it with: sudo apt-get install -y $tool" >&2
    exit 1
  fi
done

WORKDIR="$(mktemp -d /tmp/pharmatrack-update.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

CURRENT="$(dpkg-query -W -f='${Version}' pharmatrack 2>/dev/null || true)"
echo "==> Installed PharmaTRACK version: ${CURRENT:-none}"

echo "==> Reading the release manifest (${MANIFEST_URL})…"
curl --fail --location --retry 3 --silent --show-error "$MANIFEST_URL" -o "$WORKDIR/latest.json"

VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$WORKDIR/latest.json" | head -n 1)"
DEB_URL="$(sed -n 's/.*"url": *"\([^"]*amd64\.deb\)".*/\1/p' "$WORKDIR/latest.json" | head -n 1)"
if [ -z "$VERSION" ] || [ -z "$DEB_URL" ]; then
  echo "!! Could not read the version or the Linux package URL from the manifest:" >&2
  cat "$WORKDIR/latest.json" >&2
  exit 1
fi
echo "==> Latest release: ${VERSION}"

DEB="$WORKDIR/pharmatrack_${VERSION}_amd64.deb"
echo "==> Downloading ${DEB_URL##*/} …"
curl --fail --location --retry 3 --progress-bar "$DEB_URL" -o "$DEB"

# The release publishes SHA256SUMS.txt next to the packages; verify the
# download against it so a truncated or tampered file never installs.
echo "==> Verifying the download against the release checksums…"
curl --fail --location --retry 3 --silent --show-error \
  "https://github.com/${REPO}/releases/download/v${VERSION}/SHA256SUMS.txt" -o "$WORKDIR/SHA256SUMS.txt"
EXPECTED="$(sed -n "s/^\([0-9a-f]\{64\}\)[[:space:]]*[*= ]*pharmatrack_${VERSION}_amd64\.deb$/\1/p" "$WORKDIR/SHA256SUMS.txt" | head -n 1)"
if [ -z "$EXPECTED" ]; then
  echo "!! No checksum line for pharmatrack_${VERSION}_amd64.deb in the release's SHA256SUMS.txt:" >&2
  cat "$WORKDIR/SHA256SUMS.txt" >&2
  exit 1
fi
ACTUAL="$(sha256sum "$DEB" | cut -d' ' -f 1)"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "!! Checksum mismatch — the downloaded package is not what the release published." >&2
  echo "   expected $EXPECTED" >&2
  echo "   actual   $ACTUAL" >&2
  exit 1
fi
echo "    checksum ok ($ACTUAL)"

echo "==> Installing…"
apt-get install -y --reinstall -- "$DEB"

INSTALLED="$(dpkg-query -W -f='${Version}' pharmatrack 2>/dev/null || true)"
echo "==> Done. Installed version: ${INSTALLED:-unknown}"
if [ "$INSTALLED" != "$VERSION" ]; then
  echo "!! dpkg reports ${INSTALLED:-nothing} after installing $VERSION — check the apt output above." >&2
  exit 1
fi
if [ "$CURRENT" = "$VERSION" ]; then
  echo "    (this was already the installed version; the app is unchanged)"
fi
echo "==> Launch (or restart) PharmaTRACK — it should report ${VERSION}."
