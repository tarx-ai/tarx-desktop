#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const outDir = '/Users/master/.tarx/runs/voice-input-doctor';
fs.mkdirSync(outDir, { recursive: true });

function safeExec(command, args, timeout = 6000) {
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

function latestSilentEvidence() {
  const candidates = [
    '/Users/master/.tarx/runs/voice-native-stt/latest.json',
    '/Users/master/.tarx/runs/voice-native-stt/native-input-selector-debug.json'
  ];
  const found = [];
  for (const file of candidates) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      found.push({ file, status: json.status, firstBlocker: json.firstBlocker, audioStats: json.audioStats || null, attempts: Array.isArray(json.attempts) ? json.attempts.map((a) => ({ name: a.name, audioStats: a.audioStats })) : null });
    } catch {}
  }
  return found;
}

const ffmpeg = process.env.TARX_VOICE_NATIVE_CAPTURE_BIN || '/opt/homebrew/bin/ffmpeg';
const av = safeExec(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
const system = safeExec('/usr/sbin/system_profiler', ['SPAudioDataType']);
const volume = safeExec('/usr/bin/osascript', ['-e', 'get volume settings']);
const avDevices = parseAvFoundationAudioDevices((av.stdout || '') + (av.stderr || ''));
const systemInputs = parseSystemAudio(system.stdout || system.stderr || '');
const defaultInput = systemInputs.find((device) => device.defaultInput) || null;
const defaultAvMatch = defaultInput ? avDevices.find((device) => device.name.toLowerCase() === defaultInput.name.toLowerCase()) : null;
const latest = latestSilentEvidence();
const latestNativeStt = latest.find((entry) => entry.file.endsWith('/voice-native-stt/latest.json')) || null;
const latestNativeNonSilent = latestNativeStt?.audioStats?.nonSilent === true
  || (latestNativeStt?.audioStats?.rms > 0 && latestNativeStt?.audioStats?.peakAmplitude > 0);
const recentSilent = latestNativeStt
  ? !latestNativeNonSilent && (
    latestNativeStt.firstBlocker === 'capture_silent'
    || latestNativeStt.audioStats?.inputStatus === 'silent_or_disconnected'
    || latestNativeStt.audioStats?.rms === 0
  )
  : latest.some((entry) => entry.attempts?.some((attempt) => attempt.audioStats?.rms === 0 && attempt.audioStats?.peakAmplitude === 0));
const latestSemanticRed = latestNativeStt?.status === 'native_voice_stt_route_green_semantic_speech_red';
const disconnectedLikely = Boolean(defaultInput && !defaultAvMatch) || recentSilent;
const checks = [
  { name: 'ffmpeg_avfoundation_available', pass: /AVFoundation audio devices:/i.test((av.stdout || '') + (av.stderr || '')) && avDevices.length > 0, detail: { ffmpeg, avExitOk: av.ok, avDevices } },
  { name: 'macos_default_input_present', pass: Boolean(defaultInput), detail: defaultInput },
  { name: 'default_input_visible_to_avfoundation', pass: Boolean(defaultAvMatch), detail: { defaultInput, avDevices } },
  { name: 'recent_capture_not_silent', pass: !recentSilent, detail: latest },
];
const failed = checks.filter((check) => !check.pass);
const result = {
  ts: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'voice_input_doctor_green' : 'voice_input_doctor_blocked',
  classification: failed.length === 0 ? 'green' : 'environment_red',
  firstBlocker: failed[0]?.name || null,
  checks,
  systemInputs,
  avFoundationInputs: avDevices,
  defaultInput,
  defaultAvMatch,
  volumeSettings: (volume.stdout || volume.stderr || '').trim(),
  latestSilentEvidence: latest,
  diagnosis: disconnectedLikely
    ? 'default_input_or_avfoundation_input_is_stale_silent_or_disconnected'
    : latestSemanticRed
      ? 'input_path_available_but_required_phrase_not_transcribed'
      : 'input_path_available_pending_live_capture',
  nextFix: disconnectedLikely
    ? 'Open macOS System Settings > Sound > Input, select a connected live microphone, verify input meter moves, then rerun spoken native STT.'
    : latestSemanticRed
      ? 'Stop background audio, speak the required TARS phrase close to the selected microphone, then rerun native STT.'
    : 'Rerun spoken native STT proof with the TARS phrase.',
  settingsUrls: {
    soundInput: 'x-apple.systempreferences:com.apple.Sound-Settings.extension?input',
    microphonePrivacy: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
  },
  routeTruth: {
    supercomputerUsed: false,
    browserFallbackUsed: false,
    rawAudioLogged: false
  },
};
fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
