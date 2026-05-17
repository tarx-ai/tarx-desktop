#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(repo, 'electron', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(repo, 'electron', 'preload.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const launcher = fs.readFileSync(path.join(repo, 'scripts', 'start-voice-internal.sh'), 'utf8');
const outDir = '/Users/master/.tarx/runs/voice-mediadevices-product-capture';
fs.mkdirSync(outDir, { recursive: true });

function record(checks, name, pass, detail = null) {
  checks.push({ name, pass: Boolean(pass), detail });
}

const productCaptureMatch = main.match(/async function runMediaDevicesProductCapture[\s\S]*?function writePipecatSpikeEvidence/);
const productCaptureBody = productCaptureMatch ? productCaptureMatch[0] : '';
const captureManualTurnMatch = preload.match(/async function captureManualTurn[\s\S]*?return \{/);
const captureManualTurnBody = captureManualTurnMatch ? captureManualTurnMatch[0] : '';

const checks = [];
record(checks, 'package_script_registered', pkg.scripts?.['qa:voice-mediadevices-product-capture'] === 'node scripts/qa-voice-mediadevices-product-capture.js', null);
record(checks, 'launcher_defaults_to_mediadevices_driver', launcher.includes('TARX_VOICE_MEDIADEVICES_INTERNAL=1') && launcher.includes('TARX_VOICE_CAPTURE_DRIVER=mediadevices'), null);
record(checks, 'main_has_product_capture_ipc', main.includes("ipcMain.handle('tarx:voice-mediadevices-product-capture'") && main.includes('runMediaDevicesProductCapture'), null);
record(checks, 'capture_source_is_electron_mediadevices', productCaptureBody.includes("source: 'electron_mediadevices'"), null);
record(checks, 'renderer_uses_mediarecorder_not_avfoundation', preload.includes('new MediaRecorder') && !/captureManualTurn[\s\S]*avfoundation/i.test(preload), null);
record(checks, 'product_path_does_not_force_colon_zero', !/captureManualTurn[\s\S]*['"]:0['"]/.test(preload) && !/runMediaDevicesProductCapture[\s\S]*['"]:0['"]/.test(main), null);
record(checks, 'ffmpeg_used_for_file_conversion_only', main.includes('ffmpeg_file_conversion_only_not_avfoundation_device_routing') && productCaptureBody.includes('transcodeMediaDevicesCaptureToWav') && !productCaptureBody.includes("'-f', 'avfoundation'"), null);
record(checks, 'local_whisper_receives_converted_wav', productCaptureBody.includes('transcribeNativeCaptureFile(captureEvent, wavPath)') && main.includes("'-ar', '16000'"), null);
record(checks, 'stt_contract_records_local_route_truth', main.includes('route: {') && main.includes('supercomputer_used: false'), null);
record(checks, 'evidence_file_declared', main.includes('/Users/master/.tarx/runs/voice-mediadevices-product-capture/latest.json') && main.includes('writeMediaDevicesProductCaptureEvidence'), null);
record(checks, 'manual_ask_routes_through_mediadevices', preload.includes('const mediaDevicesResult = await captureManualTurn(payload)') && main.includes('payload.mediaDevicesResult'), null);
record(checks, 'browser_fallback_off_guard_present', main.includes("browserFallback: 'Off'") && main.includes('browserFallbackUsed: false'), null);
record(checks, 'supercomputer_off_guard_present', main.includes("supercomputer: 'Off'") && main.includes('supercomputerUsed: false'), null);
record(checks, 'computer_use_execution_not_enabled', main.includes('computerUseExecutionEnabled: false'), null);
record(checks, 'no_twilio_runtime_dependency', !Object.keys(pkg.dependencies || {}).some((name) => /twilio/i.test(name)) && !Object.keys(pkg.devDependencies || {}).some((name) => /twilio/i.test(name)), null);
record(checks, 'capture_manual_turn_body_present', Boolean(captureManualTurnBody), null);

const failed = checks.filter((check) => !check.pass);
const result = {
  schema: 'tarx-voice-mediadevices-product-capture.v1',
  ts: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'voice_mediadevices_product_capture_static_green' : 'voice_mediadevices_product_capture_static_red',
  firstBlocker: failed[0]?.name || null,
  checks,
  productCapturePath: 'electron_mediadevices',
  nativeCaptureRole: 'qa_fallback_diagnostic_only',
  routeTruth: {
    computer: true,
    supercomputer: 'Off',
    supercomputerUsed: false,
    browserFallback: 'Off',
    browserFallbackUsed: false,
    rawAudioLogged: false,
  },
  evidencePath: path.join(outDir, 'latest.json'),
};

fs.writeFileSync(result.evidencePath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
