# TARX Desktop

Mac desktop app for **TARX** — local-first AI that runs on your computer.

| | |
|---|---|
| **Company** | TARXAN Inc |
| **Product** | TARX |
| **App** | TARX Desktop |
| **Repo** | `tarx-desktop` |
| **Status** | **Mac Beta** (Apple Silicon) |
| **OS** | macOS 14 Sonoma or later |
| **Arch** | arm64 (Apple Silicon) only |

Windows and Linux Desktop are **not** public.

## Install

1. Download the signed DMG from [tarx.com/download](https://tarx.com/download) or [Releases](https://github.com/tarx-ai/tarx-desktop/releases).
2. Open the DMG → drag **TARX** to Applications.
3. If Gatekeeper prompts: Control-click → Open once.
4. Optional local runtime:

```bash
curl -fsSL https://tarx.com/install | sh
```

### Verify a release

```bash
shasum -a 256 TARX-*-arm64.dmg
codesign --verify --deep --strict --verbose=2 /Applications/TARX.app
spctl --assess --type execute -v /Applications/TARX.app
xcrun stapler validate /Applications/TARX.app
```

Expect: `accepted` / `source=Notarized Developer ID` and stapler validate OK when the release is stapled.

## What this app does

- Opens the canonical **Computer** shell at
  **`https://app.tarx.com/computer`**.
- Bootstraps the local **Computer** Bridge when available and exposes connection,
  approval, tool, and evidence state through that shell.
- Keeps `/chat` as a focused task surface instead of treating chat as the whole
  Desktop product.
- Opens marketing and documentation links outside the application shell.

## Develop

```bash
git clone https://github.com/tarx-ai/tarx-desktop.git
cd tarx-desktop
npm ci
npm run dev
```

```bash
node scripts/qa-electron-navigation-boundary.js
node scripts/qa-desktop-computer-entry-smoke.js
```

## Security

- Developer ID signed (TARXAN Inc / team `JH4243GARF`)
- Apple notarized + stapled on shipped app builds
- Hardened runtime + entitlements under `build/`

## License

Proprietary — **UNLICENSED**. © TARXAN Inc. Source may be visible for transparency; redistribution requires written permission.

## Not claimed here

- Production voice
- Windows/Linux Desktop public builds
- Supercomputer enabled by default
