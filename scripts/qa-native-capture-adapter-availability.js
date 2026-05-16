#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const checks = [];
const record = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail });
const requireAdapter = process.env.TARX_REQUIRE_NATIVE_CAPTURE_ADAPTER === '1';
const candidates = [
  process.env.TARX_VOICE_NATIVE_CAPTURE_BIN,
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  'ffmpeg',
].filter(Boolean);

let binary = null;
for (const candidate of candidates) {
  if (candidate === 'ffmpeg' || fs.existsSync(candidate)) {
    binary = candidate;
    break;
  }
}

record('native_capture.ffmpeg_binary_available', Boolean(binary), binary || candidates.join(','));

let output = '';
if (binary) {
  const result = spawnSync(binary, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
    encoding: 'utf8',
    timeout: 5000,
  });
  output = `${result.stdout || ''}${result.stderr || ''}`;
  const adapterAvailable = /AVFoundation/i.test(output);
  const audioVisible = /audio devices:[\s\S]*\[\d+\]/i.test(output);
  record('native_capture.avfoundation_adapter_available', !requireAdapter || adapterAvailable, output.slice(0, 1200) || 'not_required_in_this_environment');
  record('native_capture.audio_device_visible', !requireAdapter || audioVisible, output.slice(0, 1200) || 'not_required_in_this_environment');
}

const result = {
  ts: new Date().toISOString(),
  ok: checks.every((entry) => entry.pass),
  passed: checks.filter((entry) => entry.pass).length,
  failed: checks.filter((entry) => !entry.pass).length,
  checks,
  firstBlocker: checks.find((entry) => !entry.pass)?.name || null,
  fingerprint: checks.every((entry) => entry.pass)
    ? (requireAdapter ? 'native_capture_adapter_available' : 'native_capture_adapter_check_nonblocking')
    : 'native_capture_adapter_unavailable',
  required: requireAdapter,
};

const outDir = path.join(root, 'dist-voice-beta-proof');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'latest-native-capture-adapter.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
