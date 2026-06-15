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

if [[ -n "${TARX_RELEASE_NODE_BIN:-}" ]]; then
  export PATH="$(dirname "$TARX_RELEASE_NODE_BIN"):$PATH"
elif [[ -x "/opt/homebrew/opt/node@22/bin/node" ]]; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -gt 22 ]]; then
  echo "✗ TARX Electron release builds require Node <= 22; found $(node -v). Set TARX_RELEASE_NODE_BIN or install node@22." >&2
  exit 1
fi

resolve_default_web_root() {
  local candidate=""
  for candidate in \
    "$ROOT/../tarx-web" \
    "$ROOT/../../tarx-web" \
    "$ROOT/../tarx-web-coord-operator" \
    "$ROOT/../../Worktrees/tarx-web-coord-operator"
  do
    if [[ -d "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

PUBLISH=false
SKIP_BUILD=false
for arg in "$@"; do
  case $arg in
    --publish)    PUBLISH=true ;;
    --skip-build) SKIP_BUILD=true ;;
  esac
done

find_tool() {
  local pattern="$1"
  local tool
  while IFS= read -r tool; do
    if [[ -x "$tool" ]]; then
      printf '%s' "$tool"
      return 0
    fi
  done < <(find node_modules -path "$pattern" -type f 2>/dev/null | sort)
  if [[ -z "${tool:-}" ]]; then
    echo "✗ Missing required release helper matching $pattern. Run npm install." >&2
  else
    echo "✗ Release helper is not executable: $tool" >&2
  fi
  exit 1
}

rebuild_updater_zip_if_needed() {
  local version="$1"
  local app_dir="dist/mac-arm64/TARX.app"
  local zip="dist/TARX-${version}-arm64-mac.zip"
  local blockmap="${zip}.blockmap"

  if [[ ! -d "$app_dir" ]]; then
    echo "✗ Cannot rebuild updater ZIP; missing $app_dir." >&2
    exit 1
  fi

  local seven_zip
  local app_builder
  if [[ "$(uname -m)" == "arm64" ]]; then
    seven_zip="node_modules/7zip-bin/mac/arm64/7za"
    app_builder="node_modules/app-builder-bin/mac/app-builder_arm64"
  else
    seven_zip="node_modules/7zip-bin/mac/x64/7za"
    app_builder="node_modules/app-builder-bin/mac/app-builder_amd64"
  fi
  [[ -x "$seven_zip" ]] || seven_zip="$(find_tool '*/7zip-bin/mac/*/7za')"
  [[ -x "$app_builder" ]] || app_builder="$(find_tool '*/app-builder-bin/mac/app-builder*')"

  echo "▶ Rebuilding updater ZIP with TARX.app at archive root…"
  rm -f "$zip" "$blockmap"
  (
    cd dist/mac-arm64
    if ! "../../$seven_zip" a -bd -mx=7 -mtc=off -mm=Deflate -mcu "../TARX-${version}-arm64-mac.zip" TARX.app; then
      echo "⚠ 7za updater ZIP failed; falling back to ditto." >&2
      rm -f "../TARX-${version}-arm64-mac.zip"
      ditto -c -k --sequesterRsrc --keepParent TARX.app "../TARX-${version}-arm64-mac.zip"
    fi
  )
  "$app_builder" blockmap --input "$zip" --output "$blockmap"

  local first_zip_entry
  first_zip_entry="$(zipinfo -1 "$zip" | sed -n '1p' || true)"
  if [[ "$first_zip_entry" != TARX.app/* ]]; then
    echo "✗ Updater ZIP root must be TARX.app/." >&2
    exit 1
  fi
}

ensure_notarization_credentials() {
  if [[ "${APPLE_SKIP_NOTARIZE:-}" == "1" ]]; then
    if [[ "$PUBLISH" == true ]]; then
      echo "✗ APPLE_SKIP_NOTARIZE=1 is not allowed in the publish lane. Provide notarization credentials or stop." >&2
      exit 1
    fi
    return 0
  fi

  local credential_modes=0
  [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_KEY_ID:-}" ]] && credential_modes=$((credential_modes + 1))
  [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]] && credential_modes=$((credential_modes + 1))
  [[ -n "${APPLE_ID:-}" || -n "${APPLE_APP_PASSWORD:-}" || -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]] && credential_modes=$((credential_modes + 1))

  if [[ "$credential_modes" -eq 0 ]]; then
    echo "✗ Missing notarization credentials. Set APPLE_API_KEY/APPLE_API_KEY_ID, APPLE_KEYCHAIN_PROFILE, or APPLE_ID/APPLE_APP_PASSWORD." >&2
    exit 1
  fi

  if [[ "$credential_modes" -ne 1 ]]; then
    echo "✗ Choose exactly one notarization credential mode: APPLE_API_KEY/APPLE_API_KEY_ID, APPLE_KEYCHAIN_PROFILE, or APPLE_ID/APPLE_APP_PASSWORD." >&2
    exit 1
  fi

  if [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
    if ! security find-generic-password -s "$APPLE_KEYCHAIN_PROFILE" -w >/dev/null 2>&1; then
      echo "✗ No Keychain password item found for profile: $APPLE_KEYCHAIN_PROFILE. Configure notarytool credentials before release." >&2
      exit 1
    fi
  fi
}

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

ensure_notarization_credentials

VERSION=$(node -p "require('./package.json').version")
echo "▶ TARX Electron v${VERSION}"

# ── 2. Install deps ───────────────────────────────────────────────────────────
if [[ ! -d node_modules ]]; then
  echo "▶ Installing dependencies…"
  npm install
fi

# ── 3. Build ──────────────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == false ]]; then
  echo "▶ Building mac app + DMG with electron-builder…"
  node scripts/build-assets.js
  node node_modules/electron-builder/cli.js --mac dmg --publish never
  rebuild_updater_zip_if_needed "$VERSION"

  echo "▶ Signing check…"
  ARM64_DMG=$(ls "dist/TARX-${VERSION}"-*-arm64.dmg 2>/dev/null | head -1 || true)
  X64_DMG=$(ls "dist/TARX-${VERSION}"-*-x64.dmg 2>/dev/null | head -1 || true)

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
else
  rebuild_updater_zip_if_needed "$VERSION"
fi

echo "▶ Verifying native dependency packaging across shipped app bundles…"
node scripts/qa-electron-native-packaging.js

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
  DEFAULT_WEB_ROOT="$(resolve_default_web_root || true)"
  WEB_ROOT="${TARX_WEB_ROOT:-$DEFAULT_WEB_ROOT}"
  if [[ -z "$WEB_ROOT" || ! -d "$WEB_ROOT" ]]; then
    echo "✗ TARX web repo not found. Set TARX_WEB_ROOT or place tarx-web next to tarx-electron." >&2
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
  echo "  Next: patch tarx-web release manifest from dist/tarx-electron-release-${VERSION}-publish-plan.json and deploy tarx.com."
fi

echo ""
echo "✓ Done. DMGs in dist/"
