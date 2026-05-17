# TARX Local Operator Control Plane Status

Updated: 2026-05-17

## Decision

Recommendation: **RELEASE STABILITY GREEN FOR BLACK-SCREEN RECOVERY GATE**

The Skynet `Refresh TARX` black-screen incident is recovered manually, but root cause remains unknown. This is not a Local Operator beta, not production voice, and not wake-word mode. The Electron control plane stays hidden by default and Manual Voice internal testing is allowed only when `TARX_LOCAL_OPERATOR_BETA=1`, `TARX_VOICE_MANUAL_INTERNAL=1`, and `TARX_VOICE_NATIVE_CAPTURE=1` are all set. Models are not bundled, Supercomputer remains off, browser fallback remains off, and Computer Use execution remains disabled.

## Current Status

| Workstream | Status | Notes |
| --- | --- | --- |
| Electron Black Screen Incident | RECOVERED / ROOT CAUSE UNKNOWN | Triggered by `Refresh TARX` on Skynet; public Electron release blocked until recovery QA is green. |
| Refresh TARX | RECOVERY QA GREEN | Refresh now has previous-route recording, renderer heartbeat, safe-shell fallback, and safe-mode recovery. |
| Public Electron Release | RELEASE STABILITY GREEN FOR BLACK-SCREEN RECOVERY GATE | Normal signed-build, notarization, and target-machine smoke gates still apply before shipment. |
| Internal development | ALLOWED | Feature merges allowed only if they do not touch refresh/boot path or if stability QA passes afterward. |
| Electron Local Operator Control Plane | GREEN | Hidden unless `TARX_LOCAL_OPERATOR_BETA=1`; feature flags default off. |
| Signed Build Validation | GREEN | `npm run build` completed; app is notarized and accepted by `spctl`. |
| Local Operator Beta | BLOCKED | Do not run combined beta yet. |
| Manual Voice Internal Test | GREEN | Product label: Manual Voice Internal Ready. Manual Voice button / push-to-talk does not require wake word; latest manual loop proof is green. |
| Manual Voice Product Path | GREEN / INTERNAL ONLY | Electron `Ask TARX` path is behind `TARX_LOCAL_OPERATOR_BETA=1`, `TARX_VOICE_MANUAL_INTERNAL=1`, and `TARX_VOICE_NATIVE_CAPTURE=1`. |
| Current ffmpeg / AVFoundation Voice Path | QA FALLBACK / DIAGNOSTIC | Keep for proof, doctor, WAV evidence, and regression checks. Do not treat as the long-term product microphone UX. |
| MediaDevices Product Path | SPIKE / DRAFT | Internal renderer spike is behind `TARX_VOICE_MEDIADEVICES_INTERNAL=1`; it lists devices, requests mic permission, captures a short metadata-only audio blob, and writes local evidence. |
| Pipecat Orchestration | SCAFFOLDED / BLOCKED | Internal scaffold is behind `TARX_VOICE_PIPECAT_INTERNAL=1`; current blocker is missing Pipecat dependency/adapters, reported honestly as `pipecat_spike_scaffolded_not_running`. |
| Runtime Spine Performance | AUDIT / DEGRADED-AWARE | `qa:runtime-spine-performance` separates shallow health from readiness and records fixed-budget Bridge/MCP/runtime probes. |
| Runtime Spine Readiness | AUDIT | `qa:runtime-spine-readiness` consumes voice, vision, action, MCP, and route-truth evidence without rerunning heavy flows. |
| Manual Voice Intelligence | AUDIT | `qa:voice-manual-intelligence` verifies current-gates answers, route truth, secret handling, and proposal-only Computer Use boundaries. |
| Wake-word Voice | BLOCKED | Wake-word / always-on mode still requires explicit TARX/TARS wake-word proof. |
| Voice STT Semantic Proof | BLOCKED | Strict native STT remains blocked until the wake word passes separately. |
| Daniel Brand Gate | PENDING | Kokoro/am_adam remains internal/unapproved; Daniel is not approved. |
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
- `/Users/master/.tarx/runs/voice-manual-button-gate/latest.json`
- `/Users/master/.tarx/runs/voice-manual-loop/latest.json`
- `/Users/master/.tarx/runs/voice-manual-intelligence/latest.json`
- `/Users/master/.tarx/runs/voice-manual-electron-path/latest.json`
- `/Users/master/.tarx/runs/voice-mediadevices-spike/latest.json`
- `/Users/master/.tarx/runs/voice-pipecat-spike/latest.json`
- `/Users/master/.tarx/runs/voice-tts-playback/latest.json`
- `/Users/master/.tarx/runs/runtime-spine-performance/latest.json`
- `/Users/master/.tarx/runs/runtime-spine-readiness/latest.json`
- `/Users/master/.tarx/runs/electron-black-screen-incident/latest.json`
- `/Users/master/.tarx/runs/electron-black-screen-recovery/latest.json`
- `/Users/master/.tarx/runs/electron-release-stability/latest.json`

## Next Blocker

Manual Voice button is unblocked for internal product testing. The next blocker is not infrastructure: wake-word / always-on voice still needs a fresh spoken Electron-native WAV that includes an accepted `TARX`/`TARS` wake-word transcript. Do not use the manual button proof as production voice or wake-word proof.

Pipecat orchestration has a local scaffold and evidence contract. It is not green until the Pipecat runtime and adapters are installed and connected.

## Voice Input Doctor

Run `npm run qa:voice-input-doctor` before retrying semantic STT if native capture returns a valid WAV with RMS/peak at zero. The doctor verifies macOS default input, AVFoundation visibility, recent silence evidence, and keeps the blocker classified as environment/input red rather than Whisper or TARX runtime red.

Current known blocker: the stale Razer Kiyo Pro input can appear as the macOS/AVFoundation default while returning all-zero samples. Select a connected live microphone in System Settings > Sound > Input, verify the input meter moves, then rerun the spoken `TARS` STT proof.
