# TARX Skynet First-User QA Role

Updated: 2026-05-16

## Decision

Skynet is now the QA, first-user, and watchdog environment. Prime is the development and production-integration machine.

Skynet may prove that a user environment can exercise a Prime build, but it must not become the product source of truth.

## Responsibilities

Skynet owns:

- Scheduled capability-plane checks.
- First-user voice harness verification against Prime-built artifacts.
- Regression checks for native capture, STT route truth, pronunciation acceptance, TTS/playback, and full voice loop behavior.
- QA evidence collection under `/Users/skynet/.tarx/runs`.
- Independent watchdog reporting when Prime claims drift from evidence.

Skynet does not own:

- Production signing.
- Electron product integration.
- Release packaging.
- Source-of-truth product branches.
- Production voice readiness decisions.
- Daniel approval.

## First-User Voice QA

Skynet should verify the user-facing path after Prime produces a candidate build or proof packet:

1. Install or launch the Prime-built TARX Electron artifact.
2. Confirm microphone permission and first-run behavior.
3. Run the Skynet voice harness as a first user.
4. Verify that the transcript route remains local and non-Supercomputer.
5. Verify that the written brand remains `TARX` and spoken pronunciation accepts `TARS`.
6. Verify that raw audio is not logged by default.
7. Write QA evidence to Skynet run paths.

Skynet success upgrades confidence in a Prime artifact. It does not replace Prime evidence.

## Regression Checks

Minimum recurring checks:

- Capability-plane health.
- Voice input availability.
- Native STT route and semantic transcript.
- Full voice loop once Prime exposes a green loop proof.
- TTS/playback once Prime exposes playback evidence.
- Privacy route truth: Supercomputer off, browser fallback labeled, raw audio not logged by default.
- No autonomous Computer Use execution.
- No bundled local models in Electron artifacts.

## Evidence Paths

Skynet evidence:

- `/Users/skynet/.tarx/runs/capability-plane/latest.json`
- `/Users/skynet/.tarx/runs/voice-native-stt/latest.json`
- `/Users/skynet/.tarx/runs/voice-internal-beta-loop/latest.json`
- `/Users/skynet/.tarx/runs/first-user-voice/latest.json`
- `/Users/skynet/.tarx/apps/tarx-voice-skynet/runs/voice-launch-readiness/latest.json`

Prime evidence Skynet should compare against:

- `/Users/master/.tarx/runs/voice-input-doctor/latest.json`
- `/Users/master/.tarx/runs/voice-native-stt/latest.json`
- `/Users/master/.tarx/runs/voice-internal-beta-loop/latest.json`
- `/Users/master/.tarx/runs/voice-pronunciation-rule/latest.json`

## Guardrails

- No production signing on Skynet.
- No source-of-truth product fork on Skynet.
- No production voice claim from Skynet-only proof.
- No Daniel approval claim from automated Skynet harness results.
- No Supercomputer enablement.
- No autonomous Computer Use enablement.
- No model bundling.

## Status

Skynet voice remains useful as a proof harness according to the handoff, but its operating role is now independent first-user QA. Prime must still produce its own Electron-native voice green before any production or internal beta upgrade.
