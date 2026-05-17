# Release Notes

## 2026-05-17 - Voice Device Hardening

- Moves internal Manual Voice product capture to Electron MediaDevices with AVFoundation retained as QA fallback.
- Adds MediaDevices device readiness, product-capture, and device-drift QA so the product path no longer depends on AVFoundation index/name selection or forced `:0`.
- Keeps production voice, browser fallback, wake-word mode, Supercomputer, Computer Use execution, and model bundling disabled.

## 2026-05-17 - Electron Black Screen Recovery Hardening

- Records the Skynet `Refresh TARX` black-screen incident as recovered manually with root cause unknown.
- Hardens `Refresh TARX` with previous-route recording, renderer ready heartbeat, load timeout recovery, and safe-shell fallback.
- Adds `TARX_SAFE_MODE=1` / `--tarx-safe-mode` boot path that skips runtime-dependent boot work and opens a minimal recovery shell.
- Adds safe-shell actions for Reload, Restart app, Open safe mode, Copy diagnostics, Open logs, and Quit.
- Adds `qa:electron-black-screen-recovery` and `qa:electron-release-stability`.
- Public Electron release remains blocked until release stability is green.

## 2026-05-17 - Runtime Spine Audit

- Adds a canonical runtime spine audit for Voice, Vision, Computer Use, MCP, and route-truth contracts.
- Adds `qa:runtime-spine-performance` with fixed-budget local probes for Bridge, runtime contracts, MCP registry, and service health. Timeouts are classified as degraded evidence.
- Adds `qa:runtime-spine-readiness` to consume existing evidence and report whether TARX is internal-manual ready, degraded, or blocked without enabling browser fallback, Supercomputer, wake-word mode, or Computer Use execution.
- Adds `qa:voice-manual-intelligence` to verify Manual Voice answers are grounded in current TARX gates, route truth, secret-handling rules, and proposal-only Computer Use boundaries.

## 2026-05-17 - Voice Architecture Pivot

- Documents the move toward Electron MediaDevices as the primary microphone product path while preserving ffmpeg / AVFoundation as QA fallback and diagnostics.
- Adds an internal `TARX_VOICE_MEDIADEVICES_INTERNAL=1` spike that lists renderer-visible microphones, requests mic permission, captures a short metadata-only audio blob, and writes evidence without enabling browser fallback, Supercomputer, wake-word mode, or release voice.
- Adds orchestration guidance recommending a Pipecat spike first, with LiveKit Agents as the stronger later production-grade realtime option.
- Adds an internal `TARX_VOICE_PIPECAT_INTERNAL=1` Pipecat scaffold and `qa:voice-pipecat-spike` evidence gate. Current expected status is `voice_pipecat_spike_blocked` until the Pipecat runtime and local adapters are installed.

## 2026-05-17 - Manual Voice Internal Loop

- Adds `qa:voice-manual-loop` for internal manual-button voice testing. Manual voice uses local capture/STT evidence, local Bridge contracts, and TTS playback without enabling wake-word mode, browser fallback, Supercomputer, or production voice.
- Adds an internal Electron `Ask TARX` path behind `TARX_LOCAL_OPERATOR_BETA=1`, `TARX_VOICE_MANUAL_INTERNAL=1`, and `TARX_VOICE_NATIVE_CAPTURE=1` so manual button voice can run from the app without terminal commands.

## 2026-05-17 - Voice Default Input Hardening

- Adds macOS default input mode and explicit microphone override handling for internal Voice testing.

## 2026-05-16 - Voice Panel Hardening

- Adds internal Voice panel state machine and evidence view for Prime voice testing. Shows mic/STT/Bridge/TTS blockers without enabling release voice, browser fallback, or Supercomputer.

## 2026-05-16 - Local Operator Control Plane

- Adds hidden Local Operator readiness control plane behind internal flags. No models bundled. No runtime enabled by default.
- Signed build validation is green for the control-plane-only patch: notarized app accepted by spctl, DMG and ZIP produced.
- Local Operator beta remains blocked until native Electron voice produces a meaningful Whisper transcript.
