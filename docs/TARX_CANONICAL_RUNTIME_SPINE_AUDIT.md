# TARX Canonical Runtime Spine Audit

Updated: 2026-05-17

## Decision

Prime Electron is the product integration lane. `tarx-ops` is the canonical runtime contract source. `tarx-mcp` owns the public/private MCP memory boundary. This audit keeps the system reliability-first while Voice, Vision, and Computer Use land behind local/internal gates.

This document does not enable public release voice, wake-word mode, always-on listening, browser fallback, Supercomputer, bundled models, or autonomous Computer Use.

## Canonical Surface Map

| Surface | Canonical contract | Prime evidence | Current role |
| --- | --- | --- | --- |
| Voice capture | `tarx-voice-capture-event.v1` | `/Users/master/.tarx/runs/voice-native-stt/latest.json`, `/Users/master/.tarx/runs/voice-manual-loop/latest.json` | Manual Voice internal proof; ffmpeg/AVFoundation remains QA fallback. |
| STT result | `tarx-stt-result.v1` | `/Users/master/.tarx/runs/voice-native-stt/latest.json` | Strict wake-word proof remains blocked unless semantic STT is green. |
| Manual voice loop | voice capture + STT + TTS evidence | `/Users/master/.tarx/runs/voice-manual-loop/latest.json` | Internal manual button path can be green without wake word. |
| MediaDevices | metadata-only internal spike | `/Users/master/.tarx/runs/voice-mediadevices-spike/latest.json` | Product mic UX path, draft behind `TARX_VOICE_MEDIADEVICES_INTERNAL=1`. |
| Pipecat | local orchestration scaffold | `/Users/master/.tarx/runs/voice-pipecat-spike/latest.json` | Scaffolded and blocked until dependency/adapters exist. |
| TTS playback | local playback proof | `/Users/master/.tarx/runs/voice-tts-playback/latest.json` | Internal playback proof; Daniel remains pending/unapproved. |
| Vision | `tarx-vision-observation.v1` | `/Users/master/.tarx/runs/vision-freshness/latest.json` | Yellow: measurable and policy-gated, not full occlusion green. |
| Computer Use proposal | `tarx-action-grounding.v1` | `/Users/master/.tarx/runs/action-safety-gate/latest.json` | Proposal-only; execution disabled. |
| Computer Use result | `tarx-action-result.v1` | future before/after evidence | Required before any execution claim. |
| MCP memory | `tarx-memory-candidate.v1` | `tarx-mcp` gates and canary evidence | Private memory requires auth; credential-like content routes to Vault-required handling. |
| Runtime route truth | runtime session + telemetry policy | `/Users/master/.tarx/runs/runtime-spine-*` | Computer default, Supercomputer explicit only, browser fallback off by default. |

## Reliability Findings

- TARX MCP shallow health can be green while deeper chat/Bridge readiness times out. Health must not imply readiness.
- Bridge `/v1/system/metrics` and `/v1/mcp-registry` need fixed budgets and degraded classification so slow surfaces do not stall voice or control paths.
- Runtime contract endpoints in `tarx-ops` are the canonical contract surface; source-vs-installed drift checks should remain part of the spine.
- Evidence should normalize around `ok`, `status`, `firstBlocker`, `routeTruth`, `guardrails`, and `latencyMs`.

## Optimization Backlog

1. Reliability:
   - split liveness from readiness;
   - add timeout budgets and degraded classifications;
   - make Bridge metrics and MCP registry non-blocking;
   - preserve source-vs-installed Bridge drift checks.
2. Evidence:
   - normalize evidence fields across voice, vision, action, MCP, and runtime;
   - add a cross-surface evidence index using `runtime-spine-readiness`.
3. Voice:
   - keep MediaDevices as the product mic path;
   - keep ffmpeg/AVFoundation as QA fallback;
   - keep Pipecat blocked until dependency/adapters exist.
4. Vision:
   - improve external occlusion proof before green;
   - keep raw screenshot logging off by default.
5. Computer Use:
   - keep proposal-only until action result contracts and before/after vision evidence are green.
6. MCP:
   - add scheduled canary/alerting for local and hosted MCP;
   - include latency, timeout, auth-denial, and Vault-guard probes, not only availability.

## New Audit Commands

Run from Prime Electron:

```bash
npm run qa:runtime-spine-performance
npm run qa:runtime-spine-readiness
```

Evidence:

- `/Users/master/.tarx/runs/runtime-spine-performance/latest.json`
- `/Users/master/.tarx/runs/runtime-spine-readiness/latest.json`

Expected readiness statuses:

- `runtime_spine_ready_internal_manual`
- `runtime_spine_degraded`
- `runtime_spine_blocked`

## Guardrails

- Browser fallback remains off unless explicitly enabled as fallback.
- Supercomputer remains off and requires explicit permission before hosted execution.
- Computer Use execution remains disabled.
- Wake-word and always-on voice remain blocked until separate proofs are green.
- Manual Voice internal green is not public release voice.
