# Release Notes

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
