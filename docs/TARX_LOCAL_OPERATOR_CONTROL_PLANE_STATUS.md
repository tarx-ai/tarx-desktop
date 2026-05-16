# TARX Local Operator Control Plane Status

Updated: 2026-05-16

## Decision

Recommendation: **MERGE CONTROL PLANE ONLY**

This is not a Local Operator beta and not production voice. The patch adds a hidden, inert readiness control plane for Electron only. Models are not bundled, runtime behavior remains disabled by default, Supercomputer remains off, and Computer Use execution remains disabled.

## Current Status

| Workstream | Status | Notes |
| --- | --- | --- |
| Electron Local Operator Control Plane | GREEN | Hidden unless `TARX_LOCAL_OPERATOR_BETA=1`; feature flags default off. |
| Signed Build Validation | GREEN | `npm run build` completed; app is notarized and accepted by `spctl`. |
| Local Operator Beta | BLOCKED | Do not run combined beta yet. |
| Voice STT Semantic Proof | BLOCKED | Needs fresh spoken Electron-native WAV -> meaningful Whisper transcript. |
| Supercomputer | OFF | Escalation remains disabled unless explicitly enabled later. |
| Computer Use Execution | DISABLED | Action proposals remain confirmation-gated; execution is not enabled. |

## Signed Artifact Measurements

| Artifact | Path | Size |
| --- | --- | ---: |
| TARX.app | `dist/mac-arm64/TARX.app` | 249.44 MB |
| DMG | `dist/TARX-1.1.8-arm64.dmg` | 104.5 MB |
| ZIP | `dist/TARX-1.1.8-arm64-mac.zip` | 99.54 MB |

Forbidden payload scan: **0 hits**. No Whisper, Gemma, Vision, TTS model payloads, diagnostic WAVs, run evidence JSONL, or local `.tarx` payloads are bundled in the packaged app.

## Evidence

- `/Users/master/.tarx/runs/local-operator-control-plane/latest.json`
- `/Users/master/.tarx/runs/local-operator-footprint/latest.json`
- `/Users/master/.tarx/runs/local-operator-package-build/latest.json`

## Next Blocker

Capture a fresh spoken Electron-native WAV of “TARX, what are we working on today?” (spoken as “TARS, what are we working on today?”), submit it to local Whisper, and require a meaningful transcript before continuing the full local voice loop.

## Voice Input Doctor

Run `npm run qa:voice-input-doctor` before retrying semantic STT if native capture returns a valid WAV with RMS/peak at zero. The doctor verifies macOS default input, AVFoundation visibility, recent silence evidence, and keeps the blocker classified as environment/input red rather than Whisper or TARX runtime red.

Current known blocker: the stale Razer Kiyo Pro input can appear as the macOS/AVFoundation default while returning all-zero samples. Select a connected live microphone in System Settings > Sound > Input, verify the input meter moves, then rerun the spoken `TARS` STT proof.
