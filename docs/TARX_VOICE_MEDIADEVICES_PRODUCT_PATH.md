# TARX Voice MediaDevices Product Path

Updated: 2026-05-17

## Decision

TARX voice product UX should move to Electron renderer `MediaDevices` for microphone truth:

Electron renderer `navigator.mediaDevices.enumerateDevices()` / `getUserMedia()`
-> local capture
-> local STT
-> Operating Brief / Current Gates answer
-> local TTS
-> Electron playback
-> local evidence.

The current ffmpeg / AVFoundation path remains valuable, but it is no longer the desired primary user experience. It should remain as QA fallback, diagnostics, and evidence harness.

## Why MediaDevices Is The Primary UX Path

The product needs to behave like a desktop app, not a terminal harness. Users expect the app to:

- ask for microphone permission in-app;
- show the default microphone selected by the OS;
- list microphones after permission is granted;
- let them pick a microphone without environment variables;
- respond clearly when the microphone is unavailable.

`MediaDevices.enumerateDevices()` is the browser/Electron-native model for listing microphones and other media devices. MDN documents that default capture devices are listed first, and non-default devices are permission-gated. That matches the TARX product problem better than parsing AVFoundation output.

Reference: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices

## Mic Permissions And Device Selection

The Electron renderer can request access with `getUserMedia({ audio: true })`. Before permission, labels may be empty or device visibility may be limited. After permission, `enumerateDevices()` can show the device list with labels, including default devices and permission-granted non-default devices.

TARX should treat this as the product source of truth:

- default mode: use the OS default input;
- explicit mode: user selects a renderer-visible `deviceId`;
- warning mode: selected device differs from last green proof device;
- blocked mode: permission denied, no input devices, or empty capture.

## Not System Audio Capture

MediaDevices microphone capture is not the same as system audio capture.

TARX manual voice should capture microphone input only. Capturing speaker/app output is a separate capability with different privacy expectations, different macOS permissions, and different user consent language. This pivot does not enable system audio capture.

## Route Truth

For the MediaDevices product path:

- Route: Computer
- Supercomputer: Off
- Browser fallback: Off
- Raw audio telemetry: Off
- Raw audio persistence by default: Off
- Evidence: metadata and file references only unless a specific QA harness intentionally writes an audio artifact

The renderer MediaDevices path is not the old browser fallback route. It is the intended Electron product input path. The old fallback label should be reserved for web/browser capture that is not the native desktop path.

## What Stays Local

Local-first remains the rule:

- microphone capture happens in Electron;
- STT routes to the local Whisper service;
- answers are generated from local TARX Operating Brief / Current Gates state where available;
- TTS routes to local TTS;
- playback happens in Electron or local OS playback;
- evidence is written under `/Users/master/.tarx/runs`.

## What Remains Blocked

- Wake-word voice remains blocked until explicit wake-word proof passes.
- Always-on listening remains blocked.
- Production voice remains blocked.
- Supercomputer remains off.
- Browser fallback remains off.
- Daniel voice remains internal/unapproved until the brand gate is approved.

## Current Status

Manual Voice Internal Test is green through the existing path. MediaDevices Product Path is SPIKE / DRAFT. The first spike only proves renderer device enumeration, permission, short in-memory capture, level stats, and metadata evidence. It does not replace the manual voice loop yet.

## Evidence

MediaDevices spike evidence:

`/Users/master/.tarx/runs/voice-mediadevices-spike/latest.json`

Existing manual voice evidence:

`/Users/master/.tarx/runs/voice-manual-loop/latest.json`
