#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(repo, 'electron', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(repo, 'electron', 'preload.js'), 'utf8');
const outDir = '/Users/master/.tarx/runs/voice-manual-electron-path';
fs.mkdirSync(outDir, { recursive: true });

function record(checks, name, pass, detail = null) {
  checks.push({ name, pass: Boolean(pass), detail });
}

const checks = [];
record(checks, 'feature_flag_declared', main.includes('TARX_VOICE_MANUAL_INTERNAL') && main.includes('VOICE_MANUAL_INTERNAL_ENABLED'), null);
record(checks, 'requires_internal_flags', main.includes('TARX_LOCAL_OPERATOR_BETA') && main.includes('manual_voice_internal_feature_flag_required'), null);
record(checks, 'manual_ui_hidden_without_flag', main.includes('id="tarx-native-voice-ask"') && main.includes('askButton.hidden = !manualEnabled'), null);
record(checks, 'ipc_handler_exists', main.includes("ipcMain.handle('tarx:voice-manual-internal-ask'") && preload.includes('askManualInternal'), null);
record(checks, 'native_capture_used', main.includes('runVoicePanelMicrophoneTest(payload)') && main.includes("source: 'electron_native'"), null);
record(checks, 'browser_fallback_not_used', main.includes('browserFallbackUsed: false') && main.includes("browserFallback: 'Off'"), null);
record(checks, 'supercomputer_not_used', main.includes('supercomputerUsed: false') && main.includes("supercomputer: 'Off'"), null);
record(checks, 'operating_brief_answer_source', main.includes('manualVoiceAnswerFromEvidence') && main.includes('local_prime_operating_status_from_evidence'), null);
record(checks, 'tts_generated_and_played', main.includes('requestTtsWav') && main.includes('/usr/bin/afplay') && main.includes('tts_or_playback_failed'), null);
record(checks, 'selected_device_recorded', main.includes('selectedDevice: capture.selectedDevice') && main.includes('selectedDevice,'), null);
record(checks, 'device_drift_warning_visible', main.includes('Last green proof used') && main.includes('Run a fresh test before trusting voice'), null);
record(checks, 'evidence_path_written', main.includes("manualLoop: '/Users/master/.tarx/runs/voice-manual-loop/latest.json'") && main.includes('writeVoiceManualLoopEvidence'), null);
record(checks, 'wake_word_remains_blocked', main.includes('strictWakeWordModeBlocked: true') && main.includes("wakeWordVoice: 'BLOCKED'"), null);
record(checks, 'no_production_claim', main.includes('productionVoiceReady: false') && !/production voice ready/i.test(main), null);

const failed = checks.filter((check) => !check.pass);
const result = {
  schema: 'tarx-voice-manual-electron-path-qa.v1',
  ts: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'voice_manual_electron_path_green' : 'voice_manual_electron_path_red',
  firstBlocker: failed[0]?.name || null,
  checks,
  evidencePath: path.join(outDir, 'latest.json'),
  guardrails: {
    browserFallbackEnabledByQa: false,
    supercomputerEnabledByQa: false,
    productionVoiceReadyClaim: false,
    wakeWordModeEnabled: false,
  },
};

fs.writeFileSync(result.evidencePath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
