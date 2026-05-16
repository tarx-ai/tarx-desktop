# TARX Local Operator Internal Beta Decision Packet

Generated: 2026-05-15

## Decision

Recommendation: **DO NOT RUN**

TARX should not start the combined local Voice/Vision/Action internal beta yet. Vision freshness is now measurable enough for internal validation, and Computer Use action proposals are safety-gated, but Voice is still blocked before the full local loop.

The blocker is not the Whisper route or WAV format. The native WAV reaches Whisper successfully, but the latest native capture proof transcribes as `[BLANK_AUDIO]`, so `native_voice_stt_green` is not achieved and the full loop artifact is missing.

No public production claims are allowed.

## Readiness Scores

| Surface | Score | Status | Reason |
| --- | ---: | --- | --- |
| Voice | 45/100 | blocked | Native byte capture and Whisper route are green, but semantic STT is red, full loop proof is missing, and Daniel brand review has not run. |
| Vision | 70/100 | yellow | Packet freshness, occlusion status, local-only policy, and screenshot privacy are measurable; external macOS occlusion remains imperfect. |
| Computer Use / Action | 85/100 | proposal green | Fresh grounding and risk policy are enforced; execution remains disabled and confirmation-gated. |
| Memory / RAG | 35/100 | incomplete | Local briefing/RAG direction exists, but full voice loop and durable Bridge-backed memory/RAG proof are missing in this decision set. |
| Supercomputer Permission | 75/100 | guarded | Contracts and route truth keep Supercomputer permission-only/off; real escalation UX and hosted handoff proof remain unproven. |

## Current Status Summary

Voice is not ready for the internal Local Operator beta. The strongest current proof is source/adapter progress: Electron native byte capture exists, Whisper route discovery is corrected, and the native WAV is accepted by local Whisper. The latest semantic result is still `[BLANK_AUDIO]`.

Vision can move into internal validation as a yellow lane. It now emits measurable freshness fields and conservative occlusion policy without sending screenshots to Supercomputer or logging raw screenshots by default.

Computer Use can move into internal proposal-only validation. It can propose actions with fresh Vision grounding, risk metadata, and confirmation copy. It cannot execute autonomous mutations.

## Internal Beta Scope

Selected scope: **DO NOT RUN**

Allowed engineering dry-runs:
- Vision freshness validation in a running Electron app.
- Action proposal safety validation with execution disabled.
- Voice STT harness work to capture a real spoken native phrase.

Not allowed:
- Combined Voice/Vision/Action internal beta.
- Production voice claim.
- Autonomous Computer Use.
- Supercomputer usage without explicit approval.

## What Is Allowed

- Browser capture as fallback/diagnostic only.
- Electron native capture development behind `TARX_VOICE_NATIVE_CAPTURE=1`.
- Local Whisper STT route validation against `127.0.0.1:11447/inference`.
- Vision observations with honest `freshness_ms`, `occlusion_status`, `target_confidence`, `sensitive_flags`, and `local_only: true`.
- Action proposals that include fresh Vision grounding and confirmation copy.
- Read-only action proposals without confirmation.
- Medium/high-risk action proposals only as blocked or confirmation-required proposals.

## What Is Blocked

- Full local voice loop until native WAV -> non-blank STT is green.
- Daniel approval until human brand scoring artifacts exist.
- Computer Use execution.
- Terminal commands, email sending, purchase/delete/modify-setting actions without explicit confirmation and future action-result proof.
- Any action with stale Vision grounding.
- Any action with blocked occlusion.
- Silent Supercomputer calls.
- Raw audio, raw screenshots, or full transcripts in default telemetry.
- Public production claims.

## Required Operator Instructions

1. Keep Supercomputer off unless explicitly approved by the user.
2. Treat browser capture as fallback only.
3. Do not proceed to full voice loop unless `native_voice_stt_green` is achieved.
4. Use the exact phrase for the next voice proof: “TARX, what are we working on today?”
5. Keep Vision route truth visible: report freshness and occlusion honestly.
6. Keep Computer Use in proposal-only mode.
7. Use confirmation copy for mutations: “I can do this. Please confirm.”
8. Never say “I handled it” until `tarx-action-result.v1` is green.

## Known Failure Modes

- Native mic proof can produce a valid WAV with no speech content.
- Whisper endpoint assumptions can drift; `11445` is not the active Whisper route in the latest proof.
- Installed Bridge runtime can lag source-contract changes.
- External macOS window occlusion cannot yet be fully proven from Electron-only checks.
- Vision can be measurable but still not reliable enough for execution.
- Daniel voice may be technically functional while still failing brand quality.
- Local JSON/RAG briefing is not equivalent to durable production memory.

## Evidence Paths

| Evidence | Latest Result |
| --- | --- |
| `/Users/master/.tarx/runs/voice-runtime-production-contract/latest-sprint-002.json` | `native_capture_to_stt_route_green_semantic_speech_pending` |
| `/Users/master/.tarx/runs/voice-native-stt/latest.json` | `native_voice_stt_route_green_semantic_speech_red` |
| `/Users/master/.tarx/runs/voice-internal-beta-loop/latest.json` | missing |
| `/Users/master/.tarx/runs/daniel-voice-brand-gate/latest.json` | missing |
| `/Users/master/.tarx/runs/vision-freshness/latest.json` | `vision_freshness_yellow`, 29/29 |
| `/Users/master/.tarx/runs/action-safety-gate/latest.json` | `action_safety_gate_green`, 33/33 |

## Next Sprint

Primary goal: move Voice from route-green to semantic-green, then rerun the full loop.

Prompt:

```text
Codex, continue TARX Local Operator Sprint 003.

Do not touch Vision or Computer Use unless needed for shared runtime IDs.
Do not run Daniel brand gate until full local voice loop is green.
Do not call Supercomputer.

Goal:
Achieve native_voice_stt_green using a real spoken Electron-native capture.

Required phrase:
“TARX, what are we working on today?”

Tasks:
1. Capture a fresh Electron-native WAV with TARX_VOICE_NATIVE_CAPTURE=1.
2. Confirm the WAV contains speech, not silence.
3. Submit it to local Whisper at the discovered route: http://127.0.0.1:11447/inference.
4. Validate non-blank tarx-stt-result.v1.
5. Correlate capture_id and transcript_id.
6. Confirm Supercomputer remains off.
7. Confirm raw audio is not logged by default.
8. Rerun npm run qa:voice-native-stt.
9. If native_voice_stt_green is achieved, run npm run qa:voice-internal-beta-loop.
10. If local_voice_internal_beta_green is achieved, generate Daniel brand gate review artifacts only; do not approve Daniel automatically.

Evidence:
- /Users/master/.tarx/runs/voice-native-stt/latest.json
- /Users/master/.tarx/runs/voice-internal-beta-loop/latest.json
- /Users/master/.tarx/runs/daniel-voice-brand-gate/latest.json

Stop immediately if native WAV -> STT returns [BLANK_AUDIO].
```

## Final Recommendation

**DO NOT RUN** the combined internal local Voice/Vision/Action beta yet.

Proceed with targeted engineering validation:
- Voice: fix the spoken native STT proof.
- Vision: validate freshness from running Electron scenarios.
- Action: continue proposal-only safety testing.

Once Voice reaches `local_voice_internal_beta_green`, the recommended scope can be upgraded to **VOICE + VISION + ACTION PROPOSALS INTERNAL BETA** if Daniel remains labeled experimental and action execution stays disabled.
