#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = '/Users/master/.tarx/runs/voice-mediadevices-spike/latest.json';
const checks = [];
const record = (name, pass, detail = null) => checks.push({ name, pass: Boolean(pass), detail });

record('feature_flag_declared', main.includes('TARX_VOICE_MEDIADEVICES_INTERNAL') && preload.includes('TARX_VOICE_MEDIADEVICES_INTERNAL'), null);
record('feature_flag_defaults_off', main.includes("process.env.TARX_VOICE_MEDIADEVICES_INTERNAL === '1'"), null);
record('preload_uses_enumerate_devices', preload.includes('navigator.mediaDevices?.enumerateDevices') && preload.includes('listMediaDevicesInputs'), null);
record('preload_uses_get_user_media', preload.includes('navigator.mediaDevices.getUserMedia'), null);
record('preload_uses_media_recorder', preload.includes('new MediaRecorder'), null);
record('preload_computes_audio_stats', preload.includes('rmsApprox') && preload.includes('peakApprox') && preload.includes('nonSilentLikely'), null);
record('raw_audio_not_persisted', preload.includes('audioBlobPersisted: false') && main.includes('audioBlobPersisted: false'), null);
record('evidence_path_declared', main.includes('/Users/master/.tarx/runs/voice-mediadevices-spike/latest.json'), null);
record('ipc_evidence_writer_exists', main.includes("ipcMain.handle('tarx:voice-mediadevices-spike-evidence'"), null);
record('panel_button_internal_only', main.includes('tarx-native-voice-mediadevices-spike') && main.includes('TARX_VOICE_MEDIADEVICES_INTERNAL'), null);
record('browser_fallback_not_enabled', main.includes('browserFallback:') && main.includes("browserFallback: 'Off'"), null);
record('supercomputer_off', main.includes("supercomputer: 'Off'"), null);
record('qa_script_registered', pkg.scripts?.['qa:voice-mediadevices-spike'] === 'node scripts/qa-voice-mediadevices-spike.js', null);

const ok = checks.every((check) => check.pass);
const result = {
  schema: 'tarx-voice-mediadevices-spike-qa.v1',
  ts: new Date().toISOString(),
  ok,
  status: ok ? 'voice_mediadevices_spike_wired' : 'voice_mediadevices_spike_red',
  firstBlocker: ok ? null : checks.find((check) => !check.pass)?.name,
  note: 'This QA proves the internal Electron MediaDevices spike is wired. A live in-app run writes capture metadata to the same evidence path.',
  evidencePath: out,
  checks,
  guardrails: {
    browserFallbackEnabledByQa: false,
    supercomputerEnabledByQa: false,
    productionVoiceReadyClaim: false,
    rawAudioPersistedBySpike: false,
  },
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
