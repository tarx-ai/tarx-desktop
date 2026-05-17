# Release Notes

## 2026-05-17 - Electron Black Screen Recovery Hardening

- Records the Skynet `Refresh TARX` black-screen incident as recovered manually with root cause unknown.
- Hardens `Refresh TARX` with previous-route recording, renderer ready heartbeat, load timeout recovery, and safe-shell fallback.
- Adds `TARX_SAFE_MODE=1` / `--tarx-safe-mode` boot path that skips runtime-dependent boot work and opens a minimal recovery shell.
- Adds safe-shell actions for Reload, Restart app, Open safe mode, Copy diagnostics, Open logs, and Quit.
- Adds `qa:electron-black-screen-recovery` and `qa:electron-release-stability`.
- Public Electron release now depends on signed build and standard release gates after recovery QA is green.

## 2026-05-17 - Runtime Spine And Manual Voice Intelligence

- Adds Runtime Spine audit commands for Prime Electron, exposing Bridge/runtime parity, local operator capability state, and degraded runtime endpoints without enabling production voice or autonomous actions.
- Adds Manual Voice intelligence QA so internal voice answers are grounded in current TARX gates, route truth, secret-handling rules, and proposal-only Computer Use boundaries.

## 2026-05-17 - Voice Default Input Hardening

- Adds macOS default input mode and explicit microphone override handling for internal Voice testing.

## 2026-05-16 - Voice Panel Hardening

- Adds internal Voice panel state machine and evidence view for Prime voice testing. Shows mic/STT/Bridge/TTS blockers without enabling release voice, browser fallback, or Supercomputer.

## 2026-05-16 - Local Operator Control Plane

- Adds hidden Local Operator readiness control plane behind internal flags. No models bundled. No runtime enabled by default.
- Signed build validation is green for the control-plane-only patch: notarized app accepted by spctl, DMG and ZIP produced.
- Local Operator beta remains blocked until native Electron voice produces a meaningful Whisper transcript.
