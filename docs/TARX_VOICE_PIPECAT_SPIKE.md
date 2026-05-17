# TARX Voice Pipecat Spike

Updated: 2026-05-17

## Decision

Proceed with a local-first Pipecat spike, but keep it internal and non-product by default.

The goal is to prove the orchestration shape:

MediaDevices/manual voice input
-> local STT
-> local Operating Brief / Current Gates answer
-> local TTS
-> playback and evidence.

This does not replace Manual Voice, does not enable wake-word mode, and does not make a public release claim.

## Why Pipecat

Pipecat maps well to TARX because it is pipeline-oriented. TARX needs a clean way to pass audio/text/answer/audio-output frames through explicit processors, with route truth and evidence at each boundary.

The current custom path has proven the components, but it is too easy for routing, device truth, Bridge contracts, and evidence to drift. Pipecat gives TARX a better orchestration vocabulary without jumping straight to a full realtime room/server model.

## Route Truth

The Pipecat spike must keep this route truth:

- Route: Computer
- Supercomputer: Off
- Supercomputer used: false
- Browser fallback: Off
- Browser fallback used: false
- Raw audio logged: false
- Models bundled into Electron: false

Supercomputer can only be introduced later through a separate explicit approval path. This spike does not add that path.

## Evidence

Evidence is written to:

`/Users/master/.tarx/runs/voice-pipecat-spike/latest.json`

Evidence must include:

- session id;
- selected input;
- capture source;
- STT provider;
- transcript;
- answer source;
- answer text;
- TTS provider;
- playback status;
- route truth;
- first blocker when not green.

Expected statuses:

- `voice_pipecat_spike_green`
- `voice_pipecat_spike_partial`
- `voice_pipecat_spike_blocked`

Current scaffold status:

`pipecat_spike_scaffolded_not_running`

That status is intentional when the Pipecat dependency or adapters are not installed. Do not fake a green result.

## Ownership Boundaries

Electron:

- owns the user-facing Voice panel;
- owns MediaDevices microphone UX;
- can trigger the internal spike behind `TARX_VOICE_PIPECAT_INTERNAL=1`;
- reads and displays evidence.

Bridge:

- remains the local runtime contract acceptor;
- keeps capture/STT/TTS evidence contracts local;
- must not be bypassed for product readiness claims.

Pipecat spike service:

- should live outside Electron main;
- owns pipeline orchestration experiments;
- receives audio references or stream references;
- runs STT, answer, and TTS adapters once connected;
- writes evidence.

## Difference From ffmpeg / AVFoundation

ffmpeg / AVFoundation remains QA fallback and diagnostics. It is useful for:

- device inventory under macOS;
- WAV proof;
- silence and RMS diagnostics;
- regression checks.

It is not the preferred product microphone UX. The product path should be Electron MediaDevices, then a real orchestration layer.

## Current Scaffold

The initial scaffold is:

`scripts/voice-pipecat-spike-service.js`

It supports:

- `node scripts/voice-pipecat-spike-service.js once`
- `node scripts/voice-pipecat-spike-service.js serve`
- `GET /health`
- `POST /v1/voice/pipecat/session`

Because Pipecat is not installed locally yet, the expected honest result is:

`voice_pipecat_spike_blocked`

with first blocker:

`pipecat_dependency_missing`

## Next Step

Install or vendor the Pipecat runtime in a local service environment, then connect adapters in this order:

1. MediaDevices audio reference / stream bridge.
2. Local Whisper STT adapter.
3. Local Operating Brief / Current Gates answer adapter.
4. Local TTS adapter.
5. Electron playback adapter.
6. Evidence hooks for each frame boundary.
