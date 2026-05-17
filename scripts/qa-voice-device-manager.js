#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const preload = fs.readFileSync(path.join(repo, 'electron', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(repo, 'electron', 'main.js'), 'utf8');
const outDir = '/Users/master/.tarx/runs/voice-device-readiness';
fs.mkdirSync(outDir, { recursive: true });

function record(checks, name, pass, detail = null) {
  checks.push({ name, pass: Boolean(pass), detail });
}

const checks = [];
record(checks, 'uses_mediadevices_enumerate_devices', preload.includes('navigator.mediaDevices.enumerateDevices'), null);
record(checks, 'permission_refresh_uses_getusermedia', preload.includes('requestMediaDevicePermissionForLabels') && preload.includes('navigator.mediaDevices.getUserMedia'), null);
record(checks, 'devicechange_listener_refreshes_inventory', preload.includes("addEventListener('devicechange'") && preload.includes("state: 'device_changed'"), null);
record(checks, 'default_device_supported', preload.includes("deviceId = 'default'") && preload.includes("requested === 'default'"), null);
record(checks, 'explicit_device_uses_deviceid', preload.includes('deviceId: { exact: deviceId }'), null);
record(checks, 'conservative_audio_constraints', ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'channelCount'].every((token) => preload.includes(token)), null);
record(checks, 'tracks_released_after_turn', preload.includes('stopTracks(captureStream)') && preload.includes('track.stop()'), null);
record(checks, 'preload_exposes_device_manager_methods', ['listInputDevices', 'refreshInputDevices', 'captureManualTurn', 'askManualInternal'].every((token) => preload.includes(token)), null);
record(checks, 'main_records_device_metadata', ['deviceId', 'label', 'groupId', 'trackSettings', 'constraints'].every((token) => main.includes(token)), null);
record(checks, 'device_readiness_evidence_declared', main.includes('/Users/master/.tarx/runs/voice-device-readiness/latest.json') && main.includes('writeVoiceDeviceReadinessEvidence'), null);
record(checks, 'browser_fallback_not_product_device_manager', !/captureManualTurn[\s\S]*\/api\/voice\/transcribe/.test(preload), null);

const failed = checks.filter((check) => !check.pass);
const result = {
  schema: 'tarx-voice-device-readiness.v1',
  ts: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'voice_device_manager_green' : 'voice_device_manager_red',
  firstBlocker: failed[0]?.name || null,
  checks,
  productCapturePath: 'electron_mediadevices',
  nativeCaptureRole: 'qa_fallback_diagnostic_only',
  guardrails: {
    browserFallbackUsed: false,
    supercomputerUsed: false,
    productionVoiceReady: false,
    wakeWordModeEnabled: false,
    computerUseExecutionEnabled: false,
  },
  evidencePath: path.join(outDir, 'latest.json'),
};

fs.writeFileSync(result.evidencePath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
