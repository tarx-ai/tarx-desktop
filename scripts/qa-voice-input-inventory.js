#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const outDir = '/Users/master/.tarx/runs/voice-input-inventory';
fs.mkdirSync(outDir, { recursive: true });

function safeExecFile(command, args, timeout = 6000) {
  try {
    return { ok: true, stdout: execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }) };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout || ''), stderr: String(error.stderr || ''), error: error.message };
  }
}

function parseAvFoundationAudioDevices(output) {
  const devices = [];
  let inAudio = false;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (/AVFoundation audio devices:/i.test(line)) { inAudio = true; continue; }
    if (inAudio && /AVFoundation video devices:/i.test(line)) break;
    const match = inAudio && line.match(/\[(\d+)\]\s+(.+)$/);
    if (match) devices.push({ index: Number(match[1]), name: match[2].trim(), selector: ':' + match[1] });
  }
  return devices;
}

function parseSystemAudio(output) {
  const devices = [];
  let current = null;
  for (const line of String(output || '').split(/\r?\n/)) {
    const deviceMatch = line.match(/^\s{8}([^:]+):\s*$/);
    if (deviceMatch) {
      if (current) devices.push(current);
      current = { name: deviceMatch[1].trim(), defaultInput: false, inputChannels: null, sampleRate: null, transport: null };
      continue;
    }
    if (!current) continue;
    let match;
    if (/Default Input Device:\s*Yes/i.test(line)) current.defaultInput = true;
    if ((match = line.match(/Input Channels:\s*(\d+)/i))) current.inputChannels = Number(match[1]);
    if ((match = line.match(/Current SampleRate:\s*([0-9.]+)/i))) current.sampleRate = Number(match[1]);
    if ((match = line.match(/Transport:\s*(.+)$/i))) current.transport = match[1].trim();
  }
  if (current) devices.push(current);
  return devices.filter((device) => device.inputChannels || device.defaultInput);
}

function resolveRequestedDevice(devices, requested) {
  const value = String(requested || '').trim();
  if (!value) return null;
  return devices.find((device) => device.name === value)
    || devices.find((device) => device.selector === value)
    || devices.find((device) => String(device.index) === value.replace(/^:/, ''))
    || null;
}

const ffmpeg = process.env.TARX_VOICE_NATIVE_CAPTURE_BIN || '/opt/homebrew/bin/ffmpeg';
const av = safeExecFile(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
const system = safeExecFile('/usr/sbin/system_profiler', ['SPAudioDataType']);
const avRaw = (av.stdout || '') + (av.stderr || '');
const systemInputs = parseSystemAudio(system.stdout || system.stderr || '');
const defaultInput = systemInputs.find((device) => device.defaultInput) || null;
const avFoundationInputs = parseAvFoundationAudioDevices(avRaw).map((device) => {
  const systemMatch = systemInputs.find((input) => input.name.toLowerCase() === device.name.toLowerCase()) || null;
  return {
    ...device,
    default: Boolean(systemMatch?.defaultInput),
    system: systemMatch,
  };
});
const requested = process.env.TARX_VOICE_NATIVE_CAPTURE_DEVICE || '';
const requestedDevice = resolveRequestedDevice(avFoundationInputs, requested);
const selectedDefaultDevice = defaultInput
  ? avFoundationInputs.find((device) => device.name.toLowerCase() === defaultInput.name.toLowerCase()) || null
  : null;
const selectedCaptureDevice = requested ? requestedDevice : selectedDefaultDevice || avFoundationInputs[0] || null;
const staleRazerDrift = !requested
  && selectedDefaultDevice
  && /razer kiyo pro/i.test(String(selectedCaptureDevice?.name || ''))
  && !/razer kiyo pro/i.test(String(defaultInput?.name || ''));
const result = {
  ts: new Date().toISOString(),
  ok: avFoundationInputs.length > 0 && (!requested || Boolean(requestedDevice)) && !staleRazerDrift,
  status: avFoundationInputs.length > 0
    ? (requested && !requestedDevice
      ? 'voice_input_inventory_requested_device_not_found'
      : staleRazerDrift
        ? 'voice_input_inventory_default_selection_drift_red'
        : 'voice_input_inventory_green')
    : 'voice_input_inventory_no_avfoundation_audio_inputs',
  firstBlocker: avFoundationInputs.length === 0
    ? 'no_avfoundation_audio_inputs'
    : requested && !requestedDevice
      ? 'requested_avfoundation_input_not_found'
      : staleRazerDrift
        ? 'selected_capture_drifted_from_macos_default_input'
      : null,
  ffmpeg,
  requestedDevice: requested || null,
  selectedRequestedDevice: requestedDevice,
  selectedDefaultDevice,
  selectedCaptureDevice,
  selectionMode: requested ? 'explicit_override' : 'macos_default_input',
  staleRazerDrift,
  avFoundationInputs,
  systemInputs,
  defaultInput,
  avFoundationRaw: avRaw.slice(0, 3000),
  usage: {
    defaultInput: 'unset TARX_VOICE_NATIVE_CAPTURE_DEVICE && npm run qa:voice-live-calibration',
    byName: 'TARX_VOICE_NATIVE_CAPTURE_DEVICE="Exact Device Name" npm run qa:voice-native-stt',
    byIndex: 'TARX_VOICE_NATIVE_CAPTURE_DEVICE=0 npm run qa:voice-native-stt',
    bySelector: 'TARX_VOICE_NATIVE_CAPTURE_DEVICE=:0 npm run qa:voice-native-stt',
  },
};

fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
