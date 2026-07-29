# TARX Desktop 1.1.13 — Computer-canonical Mac beta

**Date:** 2026-07-29  
**Company:** TARXAN Inc  
**Product:** TARX · **App:** TARX Desktop  
**Channel:** Mac Beta (Apple Silicon)

## Why this release

Public proof that TARX is **Computer by default**, not a thin-shell marketing chat wrapper.

## What's in

- **Computer-canonical entry:** default product origin `https://app.tarx.com`, entry `/computer`
- Local Computer ports **3050 / 3051** allowed for packaged local surfaces
- **Electron 39.8** security dependency line + patched builder/updater lockfile
- **Local resource bounds:** generated dataset retention + process/memory/disk pressure guard
- Agentic smoke + navigation QA no longer require legacy `tarx.com/chat` 200

## Explicitly not claimed

- Production voice / wake-word
- Supercomputer enabled by default
- Computer Use execution enabled
- Windows / Linux public Desktop

## Verify

```bash
shasum -a 256 TARX-1.1.13-arm64.dmg
codesign --verify --deep --strict --verbose=2 /Applications/TARX.app
spctl --assess --type execute -v /Applications/TARX.app
xcrun stapler validate /Applications/TARX.app
```

Expect: notarized Developer ID accepted; stapler validate OK when stapled.
