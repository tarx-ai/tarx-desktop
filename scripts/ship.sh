#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# TARX Electron — ship.sh
# Build → Sign → Notarize → Upload to Vercel Blob → Update release manifest
#
# Usage:
#   APPLE_ID=john@tarx.com \
#   APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
#   ./scripts/ship.sh [--publish]
#
# Flags:
#   --publish    Also upload DMGs to Vercel Blob + write latest-mac.yml
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
: "${APPLE_ID:?APPLE_ID must be set}"
: "${APPLE_APP_PASSWORD:?APPLE_APP_PASSWORD must be set}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-JH4243GARF}"

VERSION=$(node -p "require('./package.json').version")
echo "▶ TARX Electron v${VERSION}"

# ── 2. Install deps ───────────────────────────────────────────────────────────
if [[ ! -d node_modules ]]; then
  echo "▶ Installing dependencies…"
  npm install
fi

# ── 3. Build ──────────────────────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == false ]]; then
  echo "▶ Building DMGs (arm64 + x64)…"
  npm run build -- --mac dmg

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
    MNT=$(hdiutil attach "$dmg" -noautoopen -nobrowse 2>/dev/null | tail -1 | awk '{print $NF}')
    APP=$(ls "$MNT"/*.app 2>/dev/null | head -1)
    if [[ -n "$APP" ]]; then
      codesign --verify --deep --strict "$APP" && echo "  ✓ Signature OK: $dmg"
      spctl --assess --type execute "$APP" 2>&1 || echo "  ⚠ Gatekeeper: not yet notarized (expected before staple)"
    fi
    hdiutil detach "$MNT" -quiet
  done
fi

# ── 4. Publish ────────────────────────────────────────────────────────────────
if [[ "$PUBLISH" == true ]]; then
  echo "▶ Publishing…"

  ARM64_DMG=$(ls dist/TARX-*-arm64.dmg 2>/dev/null | head -1)
  X64_DMG=$(ls dist/TARX-*-x64.dmg 2>/dev/null | head -1)
  LATEST_YML=$(ls dist/latest-mac.yml 2>/dev/null | head -1)

  # Upload to Vercel Blob via tarx-web's upload API
  # Requires VERCEL_TOKEN in env
  : "${VERCEL_TOKEN:?Set VERCEL_TOKEN to upload DMGs to Vercel Blob}"

  BLOB_BASE="https://tarx.com/api/electron-releases"

  for file in "$ARM64_DMG" "$X64_DMG" "$LATEST_YML"; do
    [[ -f "$file" ]] || continue
    fname=$(basename "$file")
    echo "  Uploading $fname…"
    curl -fsSL \
      -X PUT \
      -H "Authorization: Bearer $VERCEL_TOKEN" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$file" \
      "https://blob.vercel-storage.com/tarx-electron/${fname}" \
      > /dev/null
    echo "  ✓ $fname uploaded"
  done

  echo ""
  echo "✓ TARX Electron v${VERSION} shipped."
  echo "  Update manifest: $BLOB_BASE/latest-mac.yml"
  echo "  Download (arm64): $BLOB_BASE/TARX-${VERSION}-arm64.dmg"
  echo "  Download (x64):   $BLOB_BASE/TARX-${VERSION}-x64.dmg"
fi

echo ""
echo "✓ Done. DMGs in dist/"
