#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const checks = [];
const record = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail });
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const pkg = JSON.parse(read('package.json'));
const main = read('electron/main.js');
const preload = read('electron/preload.js');

record('native_capture.flag_declared', main.includes('TARX_VOICE_NATIVE_CAPTURE'), 'main flag');
record('browser_fallback.flag_declared', main.includes('TARX_VOICE_BROWSER_FALLBACK'), 'main flag');
record('native_capture.disabled_by_default', main.includes("process.env.TARX_VOICE_NATIVE_CAPTURE === '1'"), 'native requires opt-in');
record('browser_fallback.explicit_opt_in', main.includes("process.env.TARX_VOICE_BROWSER_FALLBACK === '1'"), 'fallback explicit/off by default');
record('native_capture.source_label_electron_native', main.includes("source: 'electron_native'") && preload.includes("source: 'electron_native'"), 'electron_native source');
record('browser_fallback.source_label_browser_fallback', main.includes("source = payload.source === 'electron_native' ? 'electron_native' : 'browser_fallback'") && preload.includes("source: 'browser_fallback'"), 'browser_fallback source');
record('native_capture.bridge_event_endpoint', main.includes("'/v1/runtime/voice/capture-events'"), 'Bridge voice capture endpoint');
record('native_capture.no_silent_supercomputer', main.includes('supercomputerAllowed: false') && main.includes('supercomputerUsed: false') && main.includes('supercomputer_used: false'), 'supercomputer defaults off');
record('native_capture.real_byte_adapter_declared', main.includes("adapter: 'ffmpeg-avfoundation'") && main.includes("'-f', 'avfoundation'"), 'ffmpeg AVFoundation adapter');
record('native_capture.uses_macos_default_input_discovery', main.includes('macDefaultInputDevice') && main.includes('resolveNativeCaptureDevice') && main.includes('macos_default_input'), 'system default input discovery');
record('native_capture.exposes_available_input_devices', main.includes('availableInputDevices') && main.includes('selectedDevice'), 'available/default device metadata');
record('native_capture.detects_silent_or_disconnected_input', main.includes('readWavAudioStats') && main.includes('silent_or_disconnected') && main.includes('inputStatus'), 'silent input detection');
record('native_capture.opens_system_settings', main.includes('tarx:voice-open-input-settings') && preload.includes('openInputSettings'), 'Sound input settings affordance');
record('native_capture.opens_microphone_privacy_settings', main.includes('tarx:voice-open-microphone-privacy-settings') && preload.includes('openMicrophonePrivacySettings'), 'Microphone privacy settings affordance');
record('native_capture.audio_file_reference_only', main.includes('audio_ref') && main.includes('raw_audio_logged: false') && !/\brawAudio\b/.test(main), 'audio ref without raw telemetry');
record('native_capture.stop_kills_process_and_stats_bytes', main.includes('stopNativeCaptureProcess') && main.includes('fs.statSync(capturePath).size'), 'stop and byte proof');
record('native_capture.preload_stop_routes_native', preload.includes("activeSource === 'electron_native'") && preload.includes('tarx:voice-native-capture-stop'), 'native stop path');
record('native_capture.whisper_endpoint_uses_11447', main.includes("http://127.0.0.1:11447") && main.includes('/inference'), 'whisper.cpp /inference route');
record('native_capture.stt_result_emits_bridge_contract', main.includes('/v1/runtime/stt-results') && main.includes("schema: 'tarx-stt-result.v1'"), 'Bridge STT result contract');
record('native_capture.stt_uses_file_reference_not_raw_audio_telemetry', main.includes('transcribeNativeCaptureFile') && main.includes('raw_audio_logged: false'), 'STT file ref');
record('voice_states.off', main.includes("'Voice off'") && preload.includes("'Voice off'"), 'Voice off');
record('voice_states.permission_needed', main.includes('Allow microphone access to talk to TARX.') && preload.includes('Allow microphone access to talk to TARX.'), 'permission copy');
record('voice_states.listening', main.includes('TARX is listening') && preload.includes('TARX is listening'), 'listening copy');
record('voice_states.working_locally', main.includes('TARX is working locally') && preload.includes('TARX is working locally'), 'working locally copy');
record('voice_states.responding', main.includes('TARX is responding') && preload.includes('TARX is responding'), 'responding copy');
record('voice_states.unavailable_fallback', main.includes('Voice unavailable, try fallback') && preload.includes('Voice unavailable, try fallback'), 'fallback copy');
record('preload.exposes_runtime_capabilities', preload.includes('getRuntimeCapabilities'), 'window.tarxVoiceNative.getRuntimeCapabilities');
record('preload.exposes_native_start_stop', preload.includes('startNativeCapture') && preload.includes('stopNativeCapture'), 'native start/stop');
record('preload.browser_capture_does_not_send_raw_audio_to_bridge', preload.includes("tarx:voice-capture-event") && !/\brawAudio\b/.test(preload), 'metadata-only bridge event');
record('package.qa_script_registered', Boolean(pkg.scripts['qa:native-voice-capture-contract']), pkg.scripts['qa:native-voice-capture-contract'] || '');

const result = {
  ts: new Date().toISOString(),
  ok: checks.every((entry) => entry.pass),
  passed: checks.filter((entry) => entry.pass).length,
  failed: checks.filter((entry) => !entry.pass).length,
  checks,
  firstBlocker: checks.find((entry) => !entry.pass)?.name || null,
  fingerprint: checks.every((entry) => entry.pass)
    ? 'electron_native_capture_byte_adapter_source_green'
    : 'electron_native_capture_contract_stub_red',
};

const outDir = path.join(root, 'dist-voice-beta-proof');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'latest-native-capture-contract.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
