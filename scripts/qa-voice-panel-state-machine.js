#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(repo, 'electron', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(repo, 'electron', 'preload.js'), 'utf8');
const outDir = '/Users/master/.tarx/runs/voice-panel-state-machine';
fs.mkdirSync(outDir, { recursive: true });

const requiredStates = [
  'idle',
  'inventory_loading',
  'no_input_devices',
  'input_selected',
  'capture_running',
  'capture_complete',
  'capture_silent',
  'capture_non_silent',
  'stt_route_green',
  'stt_semantic_red',
  'stt_green',
  'bridge_contracts_missing',
  'tts_missing',
  'internal_loop_ready',
  'blocked_needs_mic_fix',
];

function record(checks, name, pass, detail = null) {
  checks.push({ name, pass: Boolean(pass), detail });
}

const checks = [];
for (const state of requiredStates) {
  record(checks, `state.${state}.declared`, main.includes(`'${state}'`) || main.includes(`"${state}"`), state);
}
record(checks, 'voice_cta_visible_in_composer', main.includes('tarx-native-voice-cta') && main.includes('tarx-voice-composer') && main.includes('findComposerMount'), null);
record(checks, 'panel_opens_from_voice_cta', main.includes('panel.hidden = !panel.hidden') && main.includes('refreshVoiceSettings'), null);
record(checks, 'device_inventory_renders', main.includes('availableInputDevices') && main.includes('No AVFoundation inputs'), null);
record(checks, 'red_state_clear_for_razer_semantic_failure', main.includes('Razer Kiyo Pro') && main.includes('Whisper is not detecting clear speech'), null);
record(checks, 'supercomputer_off_visible', main.includes("row('Supercomputer'") && main.includes("Supercomputer stay off"), null);
record(checks, 'browser_fallback_off_visible', main.includes("row('Browser fallback'") && main.includes('Browser fallback and Supercomputer stay off'), null);
record(checks, 'safe_command_execution_disabled', main.includes('Command execution is disabled from this app panel'), null);
record(checks, 'preload_exposes_prime_evidence', preload.includes('getPrimeEvidence') && preload.includes('tarx:voice-prime-evidence'), null);
record(checks, 'no_production_voice_claim', !/production voice ready/i.test(main), null);

const failed = checks.filter((check) => !check.pass);
const result = {
  schema: 'tarx-voice-panel-state-machine-qa.v1',
  ts: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'voice_panel_state_machine_green' : 'voice_panel_state_machine_red',
  firstBlocker: failed[0]?.name || null,
  requiredStates,
  checks,
  guardrails: {
    supercomputerEnabled: false,
    browserFallbackEnabledByQa: false,
    productionVoiceReadyClaim: false,
  },
};

fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
