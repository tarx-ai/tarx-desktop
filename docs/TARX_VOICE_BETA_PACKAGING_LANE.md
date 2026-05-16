# TARX Voice Beta Packaging Lane

Purpose: prove real TARX Voice on macOS through a stable, signed Electron app instead of localhost Chrome or a hacked `node_modules/electron/dist/Electron.app` bundle.

## Contract

- Production Electron remains `com.tarxan.tarx` and defaults to `https://tarx.com`.
- Voice beta Electron uses `com.tarxan.tarx.voicebeta` and product name `TARX Voice Beta`.
- The beta desktop URL is baked into packaged app metadata with `TARX_VOICE_BETA_DESKTOP_URL` at build time.
- The beta package does not publish updater artifacts automatically.
- The app must include microphone usage copy and microphone/audio-input entitlements.
- Real wake/listen/speak proof only counts against the signed beta app, not browser localhost and not ad-hoc dev Electron.

## Build

```bash
cd /Users/master/Desktop/tarx-electron
export TARX_VOICE_BETA_DESKTOP_URL="http://localhost:3000"
npm run qa:voice-beta-package-contract
npm run build:voice-beta
```

For CI/GitHub Actions, provide signing/notarization material already supported by `scripts/notarize.js`:

- `APPLE_API_KEY` and `APPLE_API_KEY_ID`, optionally `APPLE_API_ISSUER`; or
- `APPLE_KEYCHAIN_PROFILE`; or
- `APPLE_ID`, `APPLE_APP_PASSWORD`, and `APPLE_TEAM_ID`.


## GitHub Artifact Flow

Use the `TARX Voice Beta Electron` workflow when local SSH signing hits keychain/TCC boundaries:

1. Dispatch `.github/workflows/voice-beta-electron.yml` with the beta URL.
2. GitHub imports `APPLE_DEVELOPER_ID_CERT_P12` through `CSC_LINK` and signs with a stable app identity.
3. Optional notarization uses `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
4. Download the `tarx-voice-beta-macos` artifact, install it, grant microphone once, then rerun Voice proof.

Known local blocker: non-interactive SSH builds can fail at `codesign ... errSecInternalComponent` when the Developer ID keychain item is not accessible. That is a signing environment red, not a Voice product red.

## Proof Order

1. Install `dist-voice-beta/TARX Voice Beta*.dmg` or app artifact.
2. Open `TARX Voice Beta.app` once.
3. Grant Microphone in macOS Privacy & Security.
4. Run beta fork proof:
   - `npm run qa:electron-vva-smoke`
   - one real spoken TARX turn
5. Success requires selected mic stream, non-empty local transcript, exactly one TARX response, speech stop/mute proof, route truth, Vision observe, and action proposal-only safety.

## Why

macOS TCC microphone permission is tied to stable app identity/signing. Mutating the Electron dev app plist is not durable enough for launch-grade Voice proof.
