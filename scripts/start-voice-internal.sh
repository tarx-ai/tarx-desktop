#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -x "./node_modules/.bin/electron" ]; then
  echo "Missing ./node_modules/.bin/electron. Run npm install in tarx-electron first." >&2
  exit 1
fi

if pgrep -x TARX >/dev/null 2>&1; then
  echo "A packaged TARX.app process is running. Closing it so the internal Voice dev app is the active surface."
  osascript -e 'tell application "TARX" to quit' >/dev/null 2>&1 || true
  sleep 1
fi

unset TARX_VOICE_NATIVE_CAPTURE_DEVICE
export TARX_LOCAL_OPERATOR_BETA=1
export TARX_VOICE_MANUAL_INTERNAL=1
export TARX_VOICE_MEDIADEVICES_INTERNAL=1
export TARX_VOICE_CAPTURE_DRIVER=mediadevices
export TARX_VOICE_NATIVE_CAPTURE=1
export TARX_VOICE_BROWSER_FALLBACK=0
export TARX_SUPERCOMPUTER_ESCALATION=0
export TARX_ALLOW_PARALLEL_ELECTRON_SMOKE=1

echo "Starting TARX internal Manual Voice from repo:"
echo "  $(pwd)"
echo "Guardrails: Browser fallback OFF, Supercomputer OFF, wake-word/production voice BLOCKED."
echo "Mic mode: Electron MediaDevices macOS default input unless an in-app override is selected. Native AVFoundation remains QA fallback only."

exec ./node_modules/.bin/electron .
