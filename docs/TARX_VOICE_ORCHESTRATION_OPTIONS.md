# TARX Voice Orchestration Options

Updated: 2026-05-17

## Decision

Recommendation: **PROCEED PIPECAT SPIKE**

Use Electron MediaDevices immediately for product microphone UX. Keep the current custom stack for one short stabilization window. Run a Pipecat spike next because TARX needs local-first, modular pipeline control before committing to a heavier realtime room/server architecture.

LiveKit Agents remains the likely production-grade candidate if TARX voice grows into realtime multi-device, video, telephony, interruption-heavy, or agent-server deployment workflows.

## Criteria

| Option | Local-first | Electron fit | STT/LLM/TTS pipeline | Turn detection | Barge-in / interruption | Offline/local model fit | Evidence hooks | Route truth compatibility | Deployment complexity | Speed to internal beta | Production readiness |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Current custom stack | High | Medium | Partial | Low | Low | High | High | High | Low | High short-term | Low/Medium |
| Pipecat | High/Medium | Medium | High | Medium/High | Medium/High | High/Medium | High | High | Medium | Medium | Medium/High |
| LiveKit Agents | Medium/High | High via WebRTC | High | High | High | Medium | Medium/High | High if configured | Medium/High | Medium | High |
| Vocode | Medium | Medium | High | Medium | Medium | Medium | Medium | Medium/High | Medium | Medium | Medium/High, strongest for telephony |

## Current Custom Stack

The custom stack has been useful for proving the pieces:

- Electron panel and feature flags;
- ffmpeg / AVFoundation diagnostic capture;
- local Whisper route;
- Bridge voice contracts;
- local TTS playback;
- evidence files.

It is now showing the cost of custom orchestration: device drift, route confusion, Bridge endpoint edge cases, and duplicated state handling. Keep it as the QA harness and short-term internal proof path, but do not deepen it as the long-term voice product architecture.

## Pipecat

Pipecat is a voice AI pipeline framework built around frames, processors, transports, and parallel audio/text processing. Its model maps naturally to TARX's desired loop:

audio frames -> STT processor -> local answer processor -> TTS processor -> playback transport.

Strengths:

- good fit for local-first modular control;
- provider-swappable STT/TTS/LLM layers;
- pipeline model is close to TARX evidence and route-truth needs;
- useful for a desktop/local agent without committing to rooms or telephony;
- good next step from the current custom stack.

Risks:

- Python runtime integration adds a service boundary;
- Electron playback/capture still needs a clean transport bridge;
- production deployment story is lighter than LiveKit's.

Reference: https://docs.pipecat.ai/pipecat/learn/overview

## LiveKit Agents

LiveKit Agents is the strongest production-grade voice agent framework. The docs describe it as a realtime framework for voice, video, and physical AI agents, with WebRTC media, STT/LLM/TTS pipelines, turn detection, interruptions, plugins, agent server orchestration, and deployment patterns.

Strengths:

- mature realtime media foundation;
- WebRTC transport fits Electron, browser, mobile, and future devices;
- strong turn detection and interruption model;
- clear path to voice/video/multimodal rooms;
- strong production deployment story.

Risks:

- heavier architecture than TARX needs for tonight's manual button path;
- adds room/server concepts before the core local loop is fully settled;
- local-only/offline operation needs careful configuration.

Reference: https://docs.livekit.io/agents/

## Vocode

Vocode provides voice-agent abstractions, endpointing, STT/TTS integrations, and cross-platform support including telephony, web, and Zoom.

Strengths:

- good abstractions for voice agents and conversation flows;
- useful if TARX prioritizes phone/call-center/meeting scenarios;
- provider integrations are a strong fit for hosted deployments.

Risks:

- less directly aligned with TARX's local-first desktop proof path;
- may be too telephony/service oriented for the immediate Electron manual voice loop.

Reference: https://docs.vocode.dev/welcome

## Recommendation

Proceed in this order:

1. **MediaDevices now** for Electron microphone selection and permission truth.
2. **Pipecat spike first** for local-first pipeline orchestration.
3. **LiveKit spike second** if TARX voice becomes a realtime multi-device/product network capability.
4. Keep the custom ffmpeg / AVFoundation path as QA fallback and diagnostics.

## Next Spike Shape

Pipecat spike should prove:

- Electron MediaDevices capture can feed a local pipeline;
- local Whisper receives audio or text frames;
- local answer source uses Operating Brief / Current Gates;
- local TTS returns audio;
- Electron plays the result;
- evidence records route truth, selected device, transcript, answer, TTS path, and guardrails.

Expected recommendation after spike:

`PROCEED PIPECAT SPIKE`
