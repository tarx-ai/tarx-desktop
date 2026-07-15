#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# TARX Electron — ship.sh
# Build → Sign → Notarize → hand off to tarx-web guarded Blob publisher
#
# Usage:
#   APPLE_KEYCHAIN_PROFILE=tarx ./scripts/ship.sh [--publish]
#
# Or:
#   APPLE_ID=john@tarx.com APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx ./scripts/ship.sh [--publish]
#
# Flags:
#   --publish    Run tarx-web's guarded Electron Blob publisher after build
#   --skip-build Use existing DMGs in dist/ (renotarize/reupload only)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

PUBLISH=false
SKIP_BUILD=false
for arg in "$@"; do
  case $arg in
    --publish)    PUBLISH=true ;;
    --skip-build) SKIP_BUILD=true ;;
  esac
done

# ── 1. Env checks ─────────────────────────────────────────────────────────────
APPLE_TEAM_ID="${APPLE_TEAM_ID:-JH4243GARF}"
HAS_API_KEY=false
HAS_KEYCHAIN=false
HAS_APPLE_ID=false

if [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_KEY_ID:-}" ]]; then
  HAS_API_KEY=true
fi
if [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
  HAS_KEYCHAIN=true
fi
if [[ -n "${APPLE_ID:-}" || -n "${APPLE_APP_PASSWORD:-}" || -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
  HAS_APPLE_ID=true
fi

MODE_COUNT=0
[[ "$HAS_API_KEY" == true ]] && MODE_COUNT=$((MODE_COUNT + 1))
[[ "$HAS_KEYCHAIN" == true ]] && MODE_COUNT=$((MODE_COUNT + 1))
[[ "$HAS_APPLE_ID" == true ]] && MODE_COUNT=$((MODE_COUNT + 1))

if [[ "$MODE_COUNT" -eq 0 ]]; then
  export APPLE_KEYCHAIN_PROFILE="tarx"
  HAS_KEYCHAIN=true
  MODE_COUNT=1
fi

if [[ "$MODE_COUNT" -ne 1 ]]; then
  echo "✗ Choose exactly one notarization credential mode: APPLE_API_KEY/APPLE_API_KEY_ID, APPLE_KEYCHAIN_PROFILE, or APPLE_ID/APPLE_APP_PASSWORD." >&2
  exit 1
fi

if [[ "$HAS_API_KEY" == true && ( -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_KEY_ID:-}" ) ]]; then
  echo "✗ APPLE_API_KEY and APPLE_API_KEY_ID are both required for API key notarization." >&2
  exit 1
fi

if [[ "$HAS_APPLE_ID" == true && ( -z "${APPLE_ID:-}" || ( -z "${APPLE_APP_PASSWORD:-}" && -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ) ) ]]; then
  echo "✗ APPLE_ID and APPLE_APP_PASSWORD are both required for Apple ID notarization." >&2
  exit 1
fi

VERSION=$(node -p "require('./package.json').version")
echo "▶ TARX Electron v${VERSION}"

# ── 2. Install deps ───────────────────────────────────────────────────────────
if [[ ! -d node_modules ]]; then
  echo "▶ Installing dependencies…"
  npm install
fi

# ── 3. Build ──────────────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == false ]]; then
  echo "▶ Building mac updater artifacts (DMG + ZIP)…"
  npm run build -- --mac dmg zip

  echo "▶ Signing check…"
  ARM64_DMG=$(ls dist/TARX-*-arm64.dmg 2>/dev/null | head -1)
  X64_DMG=$(ls dist/TARX-*-x64.dmg 2>/dev/null | head -1)

  if [[ -z "$ARM64_DMG" && -z "$X64_DMG" ]]; then
    echo "✗ No DMG found in dist/. Build failed." >&2
    exit 1
  fi

  echo "  arm64: ${ARM64_DMG:-SKIPPED}"
  echo "  x64:   ${X64_DMG:-SKIPPED}"

  # Verify codesign
  for dmg in $ARM64_DMG $X64_DMG; do
    [[ -f "$dmg" ]] || continue
    # Mount and verify the .app inside
    MNT=$(mktemp -d "${TMPDIR:-/tmp}/tarx-dmg-mount.XXXXXX")
    hdiutil attach "$dmg" -noautoopen -nobrowse -mountpoint "$MNT" >/dev/null
    APP=$(ls "$MNT"/*.app 2>/dev/null | head -1)
    if [[ -n "$APP" ]]; then
      codesign --verify --deep --strict "$APP" && echo "  ✓ Signature OK: $dmg"
      spctl --assess --type execute "$APP" 2>&1 || echo "  ⚠ Gatekeeper: not yet notarized (expected before staple)"
    fi
    hdiutil detach "$MNT" -quiet
    rmdir "$MNT" 2>/dev/null || true
  done
fi

# ── 3b. DMG notarization ──────────────────────────────────────────────────────
DMGS=()
while IFS= read -r dmg; do
  [[ -n "$dmg" ]] && DMGS+=("$dmg")
done < <(find dist -maxdepth 1 -type f -name "TARX-${VERSION}-*.dmg" | sort)

if [[ "${#DMGS[@]}" -gt 0 && "${APPLE_SKIP_NOTARIZE:-}" != "1" ]]; then
  echo "▶ Signing DMG containers…"
  for dmg in "${DMGS[@]}"; do
    codesign --force --sign "Developer ID Application: John Wantz (${APPLE_TEAM_ID})" "$dmg"
  done

  echo "▶ Notarizing/stapling DMG artifacts…"
  node scripts/notarize-dmg.js "${DMGS[@]}"

  echo "▶ Refreshing latest-mac.yml after DMG signing/stapling…"
  node scripts/refresh-latest-mac-yml.js
fi

# ── 4. Publish ────────────────────────────────────────────────────────────────
if [[ "$PUBLISH" == true ]]; then
  WEB_ROOT="${TARX_WEB_ROOT:-/Users/master/Desktop/tarx-web}"
  if [[ ! -d "$WEB_ROOT" ]]; then
    echo "✗ TARX web repo not found at $WEB_ROOT. Set TARX_WEB_ROOT." >&2
    exit 1
  fi

  echo "▶ Publishing through tarx-web guarded release publisher…"
  (
    cd "$WEB_ROOT"
    TARX_EXPECTED_ELECTRON_VERSION="$VERSION" \
    TARX_ELECTRON_DIST="$ROOT/dist" \
    TARX_ELECTRON_APP="$ROOT/dist/mac-arm64/TARX.app" \
      npm run release:electron-publish
  )

  echo ""
  echo "✓ TARX Electron v${VERSION} artifacts uploaded."
  echo "  Next: patch tarx-web release manifest from dist/tarx-desktop-release-${VERSION}-publish-plan.json and deploy tarx.com."
fi

echo ""
echo "✓ Done. DMGs in dist/"
