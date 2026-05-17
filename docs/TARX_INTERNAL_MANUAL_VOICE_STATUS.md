# TARX Internal Manual Voice Status

Updated: 2026-05-17

## Current Readiness

Recommendation: **INTERNAL MANUAL VOICE READY**

This is an internal manual-button voice status only. It is not public public release voice, not wake-word voice, not always-on listening, and not autonomous Computer Use.

| Surface | Status | Notes |
| --- | --- | --- |
| Manual Voice Internal | GREEN | Manual button / push-to-talk does not require wake word. |
| Manual Voice Intelligence | GREEN | Answers are grounded in current TARX gates and local evidence. |
| Runtime Spine | READY INTERNAL MANUAL | Runtime spine readiness is green for internal manual mode. |
| Bridge Runtime Contracts | GREEN / SOURCE-BACKED | Source and repo build contain canonical runtime endpoints; installed runtime currently exposes them. |
| Strict Wake-word Voice | BLOCKED | Requires separate TARX/TARS wake-word semantic proof. |
| Public Release Voice | BLOCKED | No public release voice claim is allowed from this evidence. |
| Pipecat | BLOCKED | Current blocker is dependency/adapters missing. |
| Vision | YELLOW | Acceptable for proposal grounding only; not full occlusion green. |
| Computer Use | PROPOSAL ONLY | Execution remains disabled. |
| Supercomputer | OFF | No hosted route is used or enabled. |
| Browser Fallback | OFF | Browser fallback remains disabled. |
| Daniel Brand Gate | PENDING | Current TTS voice remains internal/unapproved. |

## Evidence

- `/Users/master/.tarx/runs/runtime-spine-performance/latest.json`
- `/Users/master/.tarx/runs/runtime-spine-readiness/latest.json`
- `/Users/master/.tarx/runs/voice-manual-intelligence/latest.json`
- `/Users/master/.tarx/runs/voice-manual-loop/latest.json`
- `/Users/master/.tarx/runs/voice-prime-readiness/latest.json`

## Release Guard

- Internal manual voice may be tested from Prime Electron.
- Public public release voice remains blocked.
- Wake-word and always-on voice remain blocked.
- Computer Use execution remains disabled.
- Supercomputer remains off.
- Browser fallback remains off.
- Public Electron release still requires black-screen recovery QA to be green before release recommendation.

## Remaining Blockers

1. Strict wake-word semantic STT proof.
2. Pipecat dependency/adapters for orchestration spike.
3. Vision occlusion proof before Vision can become green.
4. Daniel brand gate approval before any Daniel-labeled voice.
5. Durable installed Bridge packaging parity if the installed runtime is replaced by a future build.
