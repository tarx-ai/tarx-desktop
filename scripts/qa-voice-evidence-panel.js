#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(repo, 'electron', 'main.js'), 'utf8');
const outDir = '/Users/master/.tarx/runs/voice-evidence-panel';
fs.mkdirSync(outDir, { recursive: true });

const evidencePaths = {
  inventory: '/Users/master/.tarx/runs/voice-input-inventory/latest.json',
  doctor: '/Users/master/.tarx/runs/voice-input-doctor/latest.json',
  nativeStt: '/Users/master/.tarx/runs/voice-native-stt/latest.json',
  liveCalibration: '/Users/master/.tarx/runs/voice-live-calibration/latest.json',
  manualLoop: '/Users/master/.tarx/runs/voice-manual-loop/latest.json',
  mediaDevicesSpike: '/Users/master/.tarx/runs/voice-mediadevices-spike/latest.json',
  pipecatSpike: '/Users/master/.tarx/runs/voice-pipecat-spike/latest.json',
  ttsPlayback: '/Users/master/.tarx/runs/voice-tts-playback/latest.json',
};

function readJson(file) {
  try {
    return { file, ok: true, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { file, ok: false, error: error.message, json: null };
  }
}

function record(checks, name, pass, detail = null) {
  checks.push({ name, pass: Boolean(pass), detail });
}

const checks = [];
record(checks, 'evidence_ipc_handler_exists', main.includes("ipcMain.handle('tarx:voice-prime-evidence'"), null);
record(checks, 'evidence_paths_declared', Object.values(evidencePaths).every((file) => main.includes(file)), evidencePaths);
record(checks, 'missing_evidence_fallback_visible', main.includes('No voice evidence yet.'), null);
record(checks, 'wav_path_rendered', main.includes("row('WAV'") && main.includes('wavPath'), null);
record(checks, 'rms_peak_duration_rendered', main.includes("row('RMS / peak / duration'"), null);
record(checks, 'transcript_rendered', main.includes("row('Transcript'"), null);
record(checks, 'first_blocker_rendered', main.includes("row('First blocker'"), null);
record(checks, 'selected_device_rendered', main.includes("row('Selected'"), null);
record(checks, 'live_calibration_rendered', main.includes("row('Live calibration'") && main.includes('liveCalibration'), null);
record(checks, 'mediadevices_spike_rendered', main.includes("row('MediaDevices spike'") && main.includes('mediaDevicesSpike'), null);
record(checks, 'pipecat_spike_rendered', main.includes("row('Pipecat spike'") && main.includes('pipecatSpike'), null);
record(checks, 'test_microphone_writes_evidence', main.includes('writeVoicePanelTestEvidence') && main.includes('electron_panel_manual_single_attempt'), null);
record(checks, 'json_path_rendered', main.includes("row('Evidence JSON'"), null);
record(checks, 'bridge_and_tts_readiness_in_snapshot', main.includes('bridgeCaptureContract') && main.includes('ttsHealth') && main.includes('danielApproved: false'), null);

const latest = Object.fromEntries(Object.entries(evidencePaths).map(([key, file]) => [key, readJson(file)]));
const failed = checks.filter((check) => !check.pass);
const result = {
  schema: 'tarx-voice-evidence-panel-qa.v1',
  ts: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'voice_evidence_panel_green' : 'voice_evidence_panel_red',
  firstBlocker: failed[0]?.name || null,
  checks,
  latestEvidence: Object.fromEntries(Object.entries(latest).map(([key, entry]) => [key, {
    file: entry.file,
    ok: entry.ok,
    status: entry.json?.status || null,
    firstBlocker: entry.json?.firstBlocker || null,
  }])),
};

fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
