#!/usr/bin/env bash
# PharmaTRACK — webview cache cleaner (Ubuntu / Linux).
#
# WHY THIS EXISTS
#   The app files installed by the .deb are checksum-verified, yet the app
#   still reports unreadable files and MIME errors. That is because WebKitGTK
#   keeps its own HTTP cache for the app's origin (https://tauri.localhost)
#   inside  ~/.local/share/com.pharmatrack.app/  — a folder that survives
#   every uninstall/reinstall. The broken v1.4.0 build wrote WRONG content
#   into that cache under the SAME URLs the app still uses, so WebKit keeps
#   answering with the poisoned bytes instead of reading the good files.
#
#   This script deletes ONLY the cache and service-worker storage, BY NAME.
#   Your data (IndexedDB, Local Storage, databases, cookies) is preserved.
#
# Layout written by WebKitGTK (base data dir = base cache dir, same folder):
#   KEPT  (your data):   localstorage/        Local Storage
#                        databases/           WebSQL + databases/indexeddb/
#                        cookies*             persistent cookie store
#   WIPED (just caches): "Version "*/         HTTP disk cache (THE culprit)
#                        CacheStorage/        service-worker Cache API data
#                        serviceworkers/      service-worker registrations
#                        applications/        old appcache
#                        itp/                 resource-load statistics
#
# Usage:  close PharmaTRACK completely, then:  bash clean-webview-ubuntu.sh
# No root required — everything lives in your home directory.

set -u

say()  { printf '%s\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  say "Please run this as your normal user (no sudo) — it only touches your home folder."
  exit 1
fi

say "==> PharmaTRACK webview cache cleaner"
say ""

# The app must be closed: WebKit re-writes its cache when it exits and would
# undo this cleanup.
if pgrep -ix PharmaTRACK >/dev/null 2>&1 || pgrep -ix pharma-track >/dev/null 2>&1; then
  say "PharmaTRACK is running. Close it completely (including the tray), then run this again."
  exit 1
fi

# ---------------------------------------------------------------- locate ----
CANDIDATES=""
add() { [ -n "${1:-}" ] && [ -d "$1" ] && CANDIDATES="${CANDIDATES}$1"$'\n'; }

add "${XDG_DATA_HOME:-$HOME/.local/share}/com.pharmatrack.app"
add "${XDG_CACHE_HOME:-$HOME/.cache}/com.pharmatrack.app"
# Safety net in case the folder is named after the package/product:
while IFS= read -r d; do add "$d"; done < <(
  find "${HOME}/.local/share" "${HOME}/.config" "${HOME}/.cache" -maxdepth 2 -type d \
    \( -iname '*pharmatrack*' -o -iname '*pharma-track*' \) 2>/dev/null
)

if [ -z "${CANDIDATES//[$' \n']/}" ]; then
  say "No PharmaTRACK webview storage found. Nothing to clean."
  say "If problems persist, send the output of:"
  say "  ls -la \$HOME/.local/share | grep -i pharma"
  exit 0
fi

WIPED=0
while IFS= read -r dir; do
  [ -d "$dir" ] || continue
  say "==> Webview storage: $dir"
  say "    contents before cleaning:"
  du -sh "$dir"/* 2>/dev/null | sed 's/^/      /' || ls -la "$dir" | sed 's/^/      /'
  say ""

  kept=""
  for entry in "$dir"/* "$dir"/.*; do
    base="$(basename "$entry")"
    case "$base" in
      .|..|.*) continue ;;
      # ---- your data: untouched ----
      localstorage|databases|cookies*) kept="${kept} ${base}"; continue ;;
      # ---- caches: delete ----
      Version\ *|CacheStorage|serviceworkers|applications|itp)
        rm -rf -- "${dir:?}/${base}"
        say "    wiped: ${base}"
        WIPED=$((WIPED + 1))
        ;;
      # ---- anything we do not recognise: keep, but report it ----
      *) kept="${kept} ${base}" ;;
    esac
  done
  # lowercase service worker leftovers, just in case
  rm -rf -- "${dir:?}"/serviceworker* 2>/dev/null || true

  say ""
  say "    kept (your data):${kept:- (nothing)}"
  say "    contents after cleaning:"
  ls -la "$dir" 2>/dev/null | sed 's/^/      /'
  say ""
done <<EOF
${CANDIDATES}
EOF

say "==> Done. ${WIPED} cache entr$( [ "$WIPED" -eq 1 ] && echo y || echo ies ) removed; your data was preserved."
say "==> Now open PharmaTRACK again."
say "    The 'damaged copy' banner should be gone and pages should load."
say "    First launch will be slightly slower — the cache is being rebuilt"
say "    from the verified files on disk."
