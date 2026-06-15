# TARX Electron Update Funnel

Last updated: 2026-06-08 CT / 2026-06-09 UTC

## Purpose

This is the canonical TARX Desktop update funnel. It separates four states that
must not be collapsed:

1. local source candidate
2. signed/notarized local artifacts
3. uploaded staged artifacts
4. public updater/direct-download release truth

Building `dist/` artifacts is not pushing an update. Uploading Blob artifacts is
not pushing an update. A user-visible update exists only when the web release
manifest and public updater feed move to a version greater than the currently
served release and `release:electron-feed` passes.

## Current Update Rule

Before preparing any update, check live truth:

```bash
curl -fsS https://tarx.com/api/version
curl -fsS https://tarx.com/api/download/electron/latest-mac.yml
```

If the live Electron version is `1.1.11`, a chrome fix must be prepared as
`1.1.12` or later. Rebuilding `1.1.11` is artifact proof only; installed clients
will correctly report "up to date" because the updater feed has not advanced.

## Human Gates

These are separate approval gates:

- source patch approval
- commit approval
- publish/upload approval
- web release-manifest patch approval
- web deploy approval
- merge approval
- rollback or emergency-feed mutation approval

No ordinary chat answer, worker envelope, task packet, or local build implies any
of these approvals.

## Funnel

### 1. Source Candidate

Requirements:

- version is greater than the public Electron release
- scoped source patch is reviewed
- release-stability QA is green
- no private files, local credentials, raw logs, or secrets are copied into docs
  or release notes

Minimum commands:

```bash
cd "/Users/master/Desktop/TARX/Repos - active/tarx-electron"
npm run qa:electron-black-screen-recovery
npm run qa:electron-release-stability
npm run qa:electron-navigation-boundary
npm run qa:voice-beta-package-contract
git diff --check
```

### 2. Local Signed Artifact Candidate

This builds and proves local artifacts. It does not update users.

```bash
cd "/Users/master/Desktop/TARX/Repos - active/tarx-electron"
APPLE_KEYCHAIN_PROFILE=tarx ./scripts/ship.sh
```

`ship.sh` must:

- use Node 22 or another supported Node version, not an unsupported bleeding-edge
  Node runtime
- build `TARX.app`, DMG, ZIP, and blockmaps
- keep the updater ZIP root as `TARX.app/`
- scan every shipped `TARX.app` bundle in `dist/` for native packaging
  completeness before notarize/upload, including arm64, x64, and universal
  outputs when present
- sign and notarize the app
- sign, notarize, and staple the DMG
- regenerate `dist/latest-mac.yml` from the actual ZIP and DMG bytes
- abort the lane if notarization credentials are missing or if the configured
  keychain profile cannot be resolved

Local artifact proof:

```bash
zipinfo -1 dist/TARX-<version>-arm64-mac.zip | head
xcrun stapler validate dist/mac-arm64/TARX.app
xcrun stapler validate dist/TARX-<version>-arm64.dmg
xcrun syspolicy_check distribution dist/mac-arm64/TARX.app
xcrun syspolicy_check distribution dist/TARX-<version>-arm64.dmg
hdiutil verify dist/TARX-<version>-arm64.dmg
```

Legacy `spctl` output can be recorded, but modern macOS release policy uses
`syspolicy_check distribution` as the hard local distribution signal.

### 3. Staged Artifact Upload

This uploads artifacts only. It still does not update users until release truth
is patched and deployed.

Requires explicit publish/upload approval.

Requires publisher auth in the web worktree environment:

```text
BLOB_READ_WRITE_TOKEN
```

Do not paste, store, print, or copy the token into docs, chat, backlog, or
release reports. If the token is not available, the blocker is
`electron_blob_publisher_auth_not_provisioned`.

```bash
cd "/Users/master/Desktop/TARX/Worktrees/tarx-web-coord-operator"
TARX_EXPECTED_ELECTRON_VERSION=<version> \
TARX_ELECTRON_DIST="/Users/master/Desktop/TARX/Repos - active/tarx-electron/dist" \
TARX_ELECTRON_APP="/Users/master/Desktop/TARX/Repos - active/tarx-electron/dist/mac-arm64/TARX.app" \
npm run release:electron-publish
```

The publisher writes:

```text
dist/tarx-electron-release-<version>-publish-plan.json
```

That report is a proposal packet for `lib/release-manifest.ts`; it is not a
release.

### 4. Release Manifest Patch

Patch TARX web release truth from the publish-plan values:

- `lib/release-manifest.ts`
- release notes/copy only when needed
- no hardcoded artifact URLs outside release manifest

Run:

```bash
cd "/Users/master/Desktop/TARX/Worktrees/tarx-web-coord-operator"
TARX_EXPECTED_ELECTRON_VERSION=<version> npm run release:electron-feed
npm run download:funnel-proof
npm run release:readiness
```

This still does not update users until the web patch is committed, deployed, and
the public feed verifies.

### 5. Public Feed Verification

After web deploy approval and deployment:

```bash
cd "/Users/master/Desktop/TARX/Worktrees/tarx-web-coord-operator"
TARX_EXPECTED_ELECTRON_VERSION=<version> npm run release:electron-feed
```

Pass criteria:

- `/api/version` reports the new Electron version
- `/api/download/electron/latest-mac.yml` reports the new version
- public ZIP, DMG, and blockmaps are reachable
- local artifact hashes match local `latest-mac.yml`
- distribution policy, notarization, and staple checks pass
- previous public version detects the new update, downloads it, and relaunches

## Rollback

Rollback is a separate human gate. The default rollback is to patch web release
truth back to the previous known-good artifact set and redeploy. Blob deletion is
not required for ordinary rollback and should not be the first move.

## Do Not Claim

- Do not claim "update pushed" from a local build.
- Do not claim "release shipped" from a Blob upload.
- Do not reuse the current public version for a new user-visible update.
- Do not publish updater artifacts from the voice-beta lane.
- Do not mutate `lib/release-manifest.ts`, deploy web, publish, merge, or
  rollback without the matching human gate.
