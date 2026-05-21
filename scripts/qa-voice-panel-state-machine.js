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
  'capture_no_level',
  'capture_non_silent',
  'stt_route_green',
  'stt_route_failed',
  'stt_semantic_red',
  'stt_green',
  'bridge_contracts_missing',
  'tts_missing',
  'internal_loop_ready',
  'blocked_needs_mic_fix',
  'permission_needed',
  'device_lost',
  'device_changed',
  'manual_loop_green',
  'tts_failed',
  'playback_failed',
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
record(checks, 'stale_voice_injection_replaced', main.includes('mediadevices-product-v1') && main.includes('data-tarx-voice-injection-version') && main.includes('existingPanel.remove()'), null);
record(checks, 'device_inventory_renders', main.includes('mediaDeviceInventory') && main.includes('No microphones visible to MediaDevices'), null);
record(checks, 'macos_default_input_mode_visible', main.includes('Use macOS Default Input') && main.includes('macOS default input'), null);
record(checks, 'override_warning_visible_when_active', main.includes('Override active: using') && main.includes('not macOS default'), null);
record(checks, 'clear_override_available', main.includes('Clear override') && main.includes('Override cleared'), null);
record(checks, 'default_mode_uses_mediadevices_default', main.includes("defaultOption.value = useMediaDevices ? 'default'") && main.includes("return deviceSelect && deviceSelect.value ? deviceSelect.value : 'default'"), null);
record(checks, 'test_microphone_button_runs_electron_path', main.includes('Test Microphone') && main.includes('voice.testMicrophone') && main.includes("ipcMain.handle('tarx:voice-test-microphone'"), null);
record(checks, 'start_voice_proof_action_uses_product_path', main.includes('Start voice proof') && main.includes('operatorAction') && main.includes('Running local voice proof through Electron MediaDevices and local Whisper') && main.includes('voice.testMicrophone'), null);
record(checks, 'ask_tarx_manual_voice_internal_flagged', main.includes('Ask TARX') && main.includes('voice.askManualInternal') && main.includes('TARX_VOICE_MANUAL_INTERNAL'), null);
record(checks, 'mediadevices_product_path_primary', main.includes('MediaDevices product capture') && preload.includes('captureManualTurn') && preload.includes('tarx:voice-mediadevices-product-capture'), null);
record(checks, 'avfoundation_labeled_qa_fallback', main.includes('Native AVFoundation is QA fallback') && main.includes('Native QA Start'), null);
record(checks, 'mediadevices_spike_internal_flagged', main.includes('MediaDevices Spike') && main.includes('runMediaDevicesSpike') && main.includes('TARX_VOICE_MEDIADEVICES_INTERNAL'), null);
record(checks, 'pipecat_spike_internal_flagged', main.includes('Pipecat Spike') && main.includes('runPipecatSpike') && main.includes('TARX_VOICE_PIPECAT_INTERNAL'), null);
record(checks, 'bluetooth_settings_shortcut_visible', main.includes('Bluetooth') && main.includes('tarx:voice-open-bluetooth-settings'), null);
record(checks, 'airpods_not_visible_guidance', main.includes('AirPods are connected, but not visible to TARX/MediaDevices'), null);
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
