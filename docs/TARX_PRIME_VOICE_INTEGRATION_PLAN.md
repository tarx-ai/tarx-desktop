# TARX Prime Voice Integration Plan

Updated: 2026-05-16

## Decision

Prime is now the development and production-integration machine for TARX voice.
Skynet remains the independent QA, first-user, and watchdog environment.

Product voice development must land in Prime repos: `tarx-electron` for Electron capture/playback/signing and `tarx-ops` for Bridge/runtime contracts when needed. Skynet proofs may inform QA, but they are not production proof.

## Current Truth

- Skynet reached `native_voice_stt_green` and a local voice loop green in the Skynet harness.
- Prime Electron control plane is merged and signed.
- Prime owns signing, product integration, release packaging, and Prime evidence.
- Prime voice STT semantic proof is still blocked.
- No production voice claim is allowed.

Inventory note: `/Users/skynet/.tarx/apps/tarx-voice-skynet` is not mounted on this Prime filesystem. This plan inventories the named Skynet proof assets from the handoff and maps them to the Prime-equivalent files and evidence that are locally present.

## Port Inventory

| Skynet proof asset | Prime destination | Port status | Rule |
| --- | --- | --- | --- |
| `qa-voice-native-stt.js` | `scripts/qa-voice-native-stt.js` | Present in Prime | Must use Prime native capture or an explicit Prime WAV. |
| Voice input doctor | `scripts/qa-voice-input-doctor.js` | Present in Prime | Diagnoses macOS default input, AVFoundation visibility, and silent captures. |
| Launch readiness proof | Prime control-plane, footprint, and package evidence | Prime-owned | Launch readiness must come from signed Electron artifacts and local runtime evidence. |
| Real mic loop proof | `qa:voice-native-stt`, then `qa:voice-internal-beta-loop` | Guarded scaffold | Skynet mic green cannot substitute for Prime Electron mic green. |
| Pronunciation rule | `docs/TARX_VOICE_PRONUNCIATION_RULES.md`, `resources/voice-pronunciation-rules.json`, `qa:voice-pronunciation-rule` | Present in Prime | Display/write `TARX`; speak/pronounce `TARS`. |
| STT route handling | `scripts/qa-voice-native-stt.js`, Electron native route, tarx-ops runtime endpoints | Present in Prime | Supports Skynet-style `11445/transcribe` JSON/base64 when advertised and Prime `11447/inference` multipart fallback; route truth must record local Whisper and Supercomputer off. |
| TTS/playback proof | Future Prime playback proof under `/Users/master/.tarx/runs/voice-tts-playback/latest.json` or equivalent | Not green yet | Required before full loop green. |
| Evidence schemas | Prime run JSON plus tarx-ops runtime contracts | Present/continued | Evidence must identify machine, route, privacy posture, and blockers. |

## What Remains Skynet-Only

Do not port unrelated Skynet harness internals:

- Skynet browser proof UI and harness-only launchers.
- Skynet scheduled watchdog automation.
- Skynet local proof wrappers and machine-specific run folders.
- Skynet first-user journey scripts that are not product integration code.
- Skynet source forks or app shims that are not part of Prime Electron.

Skynet can keep these as QA tools, not source-of-truth product code.

## Prime Proves Native Voice

Prime proof must run from `tarx-electron` and emit Prime evidence under `/Users/master/.tarx/runs`.

```bash
cd "/Users/master/Desktop/TARX/Repos - active/tarx-electron"
npm run qa:voice-input-doctor
unset TARX_VOICE_NATIVE_CAPTURE_DEVICE
npm run qa:voice-live-calibration
TARX_VOICE_NATIVE_CAPTURE=1 npm run qa:voice-native-stt
npm run qa:voice-audio-diagnostics
npm run qa:voice-internal-beta-loop
```

Voice capture defaults to the macOS default input device from System Settings > Sound > Input. Explicit device selection is an override, not the normal path:

```bash
TARX_VOICE_NATIVE_CAPTURE_DEVICE=":1" npm run qa:voice-live-calibration
TARX_VOICE_NATIVE_CAPTURE=1 TARX_VOICE_NATIVE_CAPTURE_DEVICE=":1" npm run qa:voice-native-stt
```

Do not confuse macOS default input with system audio capture. TARX live voice is microphone input. Speaker/app output capture remains out of scope for live voice unless a separate synthetic acoustic proof explicitly says it is testing that path.

Bridge/runtime contract checks remain in `tarx-ops`:

```bash
cd "/Users/master/Desktop/TARX/Repos - active/tarx-ops"
npm run qa:runtime-contracts
npm run qa:bridge-runtime-endpoints
```

Prime native voice green requires:

- A fresh Prime Electron-native capture or explicit Prime WAV.
- The selected capture device must be the macOS default input unless an explicit override is visible in the app or command environment.
- Non-silent audio stats.
- Meaningful local Whisper transcript for `TARX, what are we working on today?`, spoken as `TARS, what are we working on today?`.
- `tarx-stt-result.v1` validation and capture/transcript correlation.
- Installed Bridge runtime acceptance.
- Supercomputer off.
- Browser fallback not counted as native proof.
- Raw audio not logged by default.
- TTS/playback Prime evidence before full loop green.

## Skynet Verifies As First User

After Prime produces a candidate proof or build, Skynet verifies as an independent first user:

- Install or launch the Prime-built Electron artifact.
- Run first-user voice harness checks against that artifact.
- Verify mic permission, native STT, route truth, pronunciation, and later playback.
- Emit Skynet QA evidence.
- Report regressions without becoming the product fork.

Skynet success can raise confidence in Prime artifacts. It cannot replace Prime evidence.

## Evidence Paths

Prime evidence:

- `/Users/master/.tarx/runs/voice-input-doctor/latest.json`
- `/Users/master/.tarx/runs/voice-native-stt/latest.json`
- `/Users/master/.tarx/runs/voice-audio-diagnostics/latest.json`
- `/Users/master/.tarx/runs/voice-internal-beta-loop/latest.json`
- `/Users/master/.tarx/runs/voice-pronunciation-rule/latest.json`
- `/Users/master/.tarx/runs/local-operator-control-plane/latest.json`
- `/Users/master/.tarx/runs/local-operator-footprint/latest.json`
- `/Users/master/Desktop/TARX/Repos - active/tarx-ops/runs/runtime-contracts/latest.json`
- `/Users/master/Desktop/TARX/Repos - active/tarx-ops/runs/runtime-contracts/latest-bridge-endpoints.json`

Skynet evidence:

- `/Users/skynet/.tarx/runs/capability-plane/latest.json`
- `/Users/skynet/.tarx/runs/voice-native-stt/latest.json`
- `/Users/skynet/.tarx/runs/voice-internal-beta-loop/latest.json`
- `/Users/skynet/.tarx/runs/first-user-voice/latest.json`
- `/Users/skynet/.tarx/apps/tarx-voice-skynet/runs/voice-launch-readiness/latest.json`

If Prime cannot read a Skynet evidence path, record that as a visibility gap instead of promoting Prime status.

## No-Production-Claim Rules

- Do not mark production voice ready.
- Do not enable Supercomputer.
- Do not enable autonomous Computer Use.
- Do not bundle models.
- Do not claim Daniel approval.
- Do not use Skynet mic proof as a substitute for Prime Electron proof.
- Do not treat browser fallback as native voice proof.

## Current Recommendation

**PRIME VOICE DEV READY; PRIME VOICE PROOF BLOCKED ON MANUAL PRIME MIC FIX**

Prime is now the correct voice development lane, but Prime voice is not production ready. The immediate blocker remains Prime native STT semantic green from a live, non-silent Electron-native microphone capture.
