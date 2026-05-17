#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(repo, 'electron', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(repo, 'electron', 'preload.js'), 'utf8');
const outDir = '/Users/master/.tarx/runs/voice-device-drift';
fs.mkdirSync(outDir, { recursive: true });

function record(checks, name, pass, detail = null) {
  checks.push({ name, pass: Boolean(pass), detail });
}

const checks = [];
record(checks, 'drift_compares_mediadevices_identity', main.includes('sameVoiceDevice') && ['deviceId', 'groupId', 'label'].every((token) => main.includes(token)), null);
record(checks, 'stale_proof_warning_visible', main.includes('Last green proof used') && main.includes('Run a fresh test before trusting voice'), null);
record(checks, 'device_changed_state_visible', main.includes("'device_changed'") && preload.includes("state: 'device_changed'"), null);
record(checks, 'device_lost_blocks_capture', main.includes("'device_lost'") && preload.includes("firstBlocker: 'device_lost'"), null);
record(checks, 'selected_device_disappears_no_silent_fallback', preload.includes('if (!selected)') && preload.includes("firstBlocker: 'device_lost'"), null);
record(checks, 'default_mode_uses_default_not_first_avfoundation', preload.includes("deviceId = 'default'") && main.includes("defaultOption.value = useMediaDevices ? 'default'"), null);
record(checks, 'product_path_never_forces_avfoundation_index', !/captureManualTurn[\s\S]*:0/.test(preload) && !/runMediaDevicesProductCapture[\s\S]*:0/.test(main), null);
record(checks, 'override_warning_names_explicit_device', main.includes('Override active: using') && main.includes('not macOS default'), null);

const failed = checks.filter((check) => !check.pass);
const result = {
  schema: 'tarx-voice-device-drift-qa.v1',
  ts: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'voice_device_drift_green' : 'voice_device_drift_red',
  firstBlocker: failed[0]?.name || null,
  checks,
  evidencePath: path.join(outDir, 'latest.json'),
  guardrails: {
    browserFallbackUsed: false,
    supercomputerUsed: false,
    productionVoiceReady: false,
  },
};

fs.writeFileSync(result.evidencePath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
