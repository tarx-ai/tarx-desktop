'use strict';

const { app, BrowserWindow, Menu, shell, ipcMain, nativeImage, dialog, clipboard, systemPreferences, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

const isDev = process.env.NODE_ENV === 'development';

// Enable accessibility tree for TARX Vision (AX-based UI automation)
app.commandLine.appendSwitch('force-renderer-accessibility');

function packagedTarxDesktopUrl() {
  try {
    const pkg = require(path.join(app.getAppPath(), 'package.json'));
    return typeof pkg.tarxDesktopUrl === 'string' && pkg.tarxDesktopUrl ? pkg.tarxDesktopUrl : '';
  } catch {
    return '';
  }
}

// URLs — default to tarx.com, but allow signed beta/dev apps without shipping Voice to prod.
const PRIMARY_URL = process.env.TARX_DESKTOP_URL || process.env.TARX_VOICE_BETA_DESKTOP_URL || packagedTarxDesktopUrl() || 'https://tarx.com';
const FALLBACK_PORTS = [11440, 11441];
const FALLBACK_URL = 'http://localhost:11440'; // Updated dynamically
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const RUNTIME_HEALTH_URL = 'http://127.0.0.1:11440/health';
const RUNTIME_START_TIMEOUT_MS = 12_000;
const UPDATE_CHECK_INTERVAL_MS = 60_000;
const UPDATE_DOWNLOAD_STALL_MS = 20_000;
const RESPONSIVE_CHROME_BREAKPOINT = 1100;
const VOICE_NATIVE_CAPTURE_ENABLED = process.env.TARX_VOICE_NATIVE_CAPTURE === '1';
const VOICE_BROWSER_FALLBACK_ENABLED = process.env.TARX_VOICE_BROWSER_FALLBACK === '1';
const LOCAL_OPERATOR_FLAGS = {
  TARX_VOICE_NATIVE_CAPTURE: VOICE_NATIVE_CAPTURE_ENABLED,
  TARX_VOICE_BROWSER_FALLBACK: VOICE_BROWSER_FALLBACK_ENABLED,
  TARX_VOICE_LOCAL_PACK: process.env.TARX_VOICE_LOCAL_PACK === '1',
  TARX_VISION_LOCAL_PACK: process.env.TARX_VISION_LOCAL_PACK === '1',
  TARX_ACTION_PROPOSALS: process.env.TARX_ACTION_PROPOSALS === '1',
  TARX_LOCAL_OPERATOR_BETA: process.env.TARX_LOCAL_OPERATOR_BETA === '1',
  TARX_SUPERCOMPUTER_ESCALATION: process.env.TARX_SUPERCOMPUTER_ESCALATION === '1',
};
const VOICE_NATIVE_CAPTURE_DEVICE = process.env.TARX_VOICE_NATIVE_CAPTURE_DEVICE || '';
const MAC_SOUND_INPUT_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Sound-Settings.extension?input';
const MAC_MICROPHONE_PRIVACY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
const VOICE_NATIVE_CAPTURE_SAMPLE_RATE = Number(process.env.TARX_VOICE_NATIVE_CAPTURE_SAMPLE_RATE || 16000);
const VOICE_NATIVE_CAPTURE_MAX_MS = Number(process.env.TARX_VOICE_NATIVE_CAPTURE_MAX_MS || 15000);
const VOICE_WHISPER_URL = process.env.TARX_WHISPER_URL || 'http://127.0.0.1:11447';
const VOICE_UX_STATES = {
  off: 'Voice off',
  permissionNeeded: 'Allow microphone access to talk to TARX.',
  listening: 'TARX is listening',
  workingLocally: 'TARX is working locally',
  responding: 'TARX is responding',
  unavailable: 'Voice unavailable, try fallback',
};
const VISION_SAVE_SCREENSHOT = process.env.TARX_VISION_SAVE_SCREENSHOT === '1';
const VISION_FRESHNESS_POLICY_MS = {
  passiveDescribe: 5000,
  uiSuggestion: 2000,
  actionProposal: 1000,
  actionExecution: 500,
};
const LOCAL_OPERATOR_PACK_MANIFEST = path.join(__dirname, '..', 'resources', 'local-operator-packs.json');

let mainWindow = null;
let trayManager = null;
let currentUrl = PRIMARY_URL;
let isOnline = true;
let pendingDeepLink = null; // Stores deep link if received before window is ready
let updateState = { status: 'idle', updatedAt: null, version: null, error: null };
let runtimeState = { status: 'unknown', updatedAt: null, health: null, error: null, pid: null };
let voiceNativeCaptureState = { active: false, process: null, captureEvent: null, capturePath: null, startedAt: null, updatedAt: null };
let composerIpcRegistered = false;
let updateDownloadWatchdog = null;
let updateDownloadInFlight = null;

function syncWindowButtonVisibility() {
  if (process.platform !== 'darwin' || !mainWindow || typeof mainWindow.setWindowButtonVisibility !== 'function') return;
  const { width } = mainWindow.getBounds();
  mainWindow.setWindowButtonVisibility(width >= RESPONSIVE_CHROME_BREAKPOINT);
}

function diagnosticsDir() {
  const dir = path.join(app.getPath('userData'), 'diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeDiagnostic(name, payload) {
  try {
    fs.writeFileSync(path.join(diagnosticsDir(), name), JSON.stringify(payload, null, 2));
  } catch (error) {
    console.log(`[tarx] Failed to write ${name}:`, error.message);
  }
}

function readLocalOperatorPackManifest() {
  try {
    const manifest = JSON.parse(fs.readFileSync(LOCAL_OPERATOR_PACK_MANIFEST, 'utf8'));
    return Array.isArray(manifest.packs) ? manifest.packs : [];
  } catch {
    return [];
  }
}

function resolvePackPath(pack) {
  if (!pack?.installed_path) return '';
  return String(pack.installed_path).replace(/^~(?=$|\/)/, userHome());
}

function localOperatorPackStatus(pack) {
  const installedPath = resolvePackPath(pack);
  const installed = Boolean(installedPath && fs.existsSync(installedPath));
  return {
    id: pack.id,
    version: pack.version,
    model_service_name: pack.model_service_name,
    expected_size: pack.expected_size,
    installed_path: installedPath,
    checksum: pack.checksum,
    required_ports: Array.isArray(pack.required_ports) ? pack.required_ports : [],
    health_check_url: pack.health_check_url,
    install_status: installed ? 'installed' : 'missing',
    installed,
  };
}

function requestLocalOperatorJson(url, timeoutMs = 700) {
  return new Promise((resolve) => {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch (error) {
      resolve({ ok: false, status: 'invalid_url', error: error.message });
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(parsed, { method: 'GET', timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 'timeout' });
    });
    req.on('error', (error) => resolve({ ok: false, status: 'error', error: error.message }));
    req.end();
  });
}

async function probeLocalOperatorService(url, timeoutMs = 700) {
  if (!url) return { ok: false, status: 'missing_url' };
  try {
    const result = await requestLocalOperatorJson(url, timeoutMs);
    return { ok: Boolean(result?.ok), status: result?.status || null, url };
  } catch (error) {
    return { ok: false, status: 'probe_failed', url, error: error?.message || String(error) };
  }
}

async function localOperatorControlPlaneState() {
  const packs = readLocalOperatorPackManifest().map(localOperatorPackStatus);
  const byId = Object.fromEntries(packs.map((pack) => [pack.id, pack]));
  const bridge = await probeLocalOperatorService('http://127.0.0.1:11440/health');
  const whisper = await probeLocalOperatorService('http://127.0.0.1:11447/health');
  const tts = await probeLocalOperatorService('http://127.0.0.1:11446/health');
  const context = await probeLocalOperatorService('http://127.0.0.1:11435/health');
  return {
    ok: true,
    surface: {
      name: 'Local Operator',
      visibility: LOCAL_OPERATOR_FLAGS.TARX_LOCAL_OPERATOR_BETA ? 'internal' : 'hidden',
      public: false,
    },
    flags: { ...LOCAL_OPERATOR_FLAGS },
    runtimeStatus: {
      bridge: bridge.ok ? 'reachable' : 'unavailable',
      native_capture: nativeCaptureStatus().available ? 'available' : 'unavailable',
      browser_fallback: VOICE_BROWSER_FALLBACK_ENABLED ? 'available_fallback_only' : 'disabled',
      supercomputer: LOCAL_OPERATOR_FLAGS.TARX_SUPERCOMPUTER_ESCALATION ? 'requires_explicit_approval' : 'off',
    },
    services: {
      bridge,
      whisper,
      tts,
      context,
    },
    packs: {
      all: packs,
      voice_stt: byId['voice-stt-whisper-base-en-int8']?.install_status || 'missing',
      voice_tts: byId['voice-tts-kokoro-daniel']?.install_status || 'missing',
      context: byId['context-gemma-worker']?.install_status || 'missing',
      vision: byId['vision-observer']?.install_status || 'missing',
    },
    controls: {
      enableVoiceBeta: { visible: LOCAL_OPERATOR_FLAGS.TARX_LOCAL_OPERATOR_BETA, enabled: false, reason: 'blocked_until_native_voice_stt_green' },
      enableVisionBeta: { visible: LOCAL_OPERATOR_FLAGS.TARX_LOCAL_OPERATOR_BETA, enabled: false, reason: 'vision_freshness_yellow_not_green' },
      enableActionProposals: { visible: LOCAL_OPERATOR_FLAGS.TARX_LOCAL_OPERATOR_BETA, enabled: LOCAL_OPERATOR_FLAGS.TARX_ACTION_PROPOSALS, execution_enabled: false },
      installLocalVoicePack: { visible: LOCAL_OPERATOR_FLAGS.TARX_LOCAL_OPERATOR_BETA, enabled: false, reason: 'pack_download_not_enabled' },
      runLocalOperatorCheck: { visible: LOCAL_OPERATOR_FLAGS.TARX_LOCAL_OPERATOR_BETA, enabled: true },
    },
    routeTruth: {
      computer_default: true,
      browser_capture_is_fallback: true,
      supercomputer_default_off: true,
      autonomous_actions_enabled: false,
      raw_audio_logged_by_default: false,
      raw_screenshots_logged_by_default: false,
      full_transcripts_logged_by_default: false,
      production_voice_claim: false,
      daniel_approved: false,
      vision_green_claim: false,
    },
  };
}

function setUpdateState(next) {
  updateState = {
    ...updateState,
    ...next,
    updatedAt: new Date().toISOString(),
  };
  mainWindow?.webContents.send('tarx:update-status', updateState);
  writeDiagnostic('updater-status.json', updateState);
}

function clearUpdateDownloadWatchdog() {
  if (updateDownloadWatchdog) clearTimeout(updateDownloadWatchdog);
  updateDownloadWatchdog = null;
}

function armUpdateDownloadWatchdog() {
  clearUpdateDownloadWatchdog();
  updateDownloadWatchdog = setTimeout(() => {
    if (updateState.status !== 'downloading' && updateState.status !== 'download-progress') return;
    const transferred = Number(updateState.transferred || 0);
    if (transferred > 0) return;
    setUpdateState({
      status: 'error',
      error: 'Update download did not start. Check the updater feed and try again.',
    });
    console.log('[tarx] Update download stalled before first progress event');
  }, UPDATE_DOWNLOAD_STALL_MS);
}

function setRuntimeState(next) {
  runtimeState = {
    ...runtimeState,
    ...next,
    updatedAt: new Date().toISOString(),
  };
  mainWindow?.webContents.send('tarx:runtime-status', runtimeState);
  writeDiagnostic('runtime-status.json', runtimeState);
}

function userHome() {
  return app.getPath('home');
}

function runtimeBridgePath() {
  return path.join(userHome(), '.tarx', 'servers', 'tarx-ops', 'dist', 'bridge.js');
}

function runtimeLogPath() {
  return path.join(userHome(), '.tarx', 'logs', 'bridge.log');
}

function nodePath() {
  const bundled = path.join(userHome(), '.local', 'node', 'bin', 'node');
  if (fs.existsSync(bundled)) return bundled;
  return process.execPath;
}

async function getRuntimeHealth(timeoutMs = 2500) {
  const ok = await probe(RUNTIME_HEALTH_URL, false, timeoutMs);
  if (!ok) return null;
  return new Promise((resolve) => {
    const req = http.get(RUNTIME_HEALTH_URL, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ status: res.statusCode < 500 ? 'ok' : 'error' });
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function requestBridgeJson(pathname, { method = 'GET', body = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: 11440,
      path: pathname,
      method,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try {
          const data = text ? JSON.parse(text) : {};
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
        } catch {
          resolve({ ok: false, status: res.statusCode, data: { error: 'invalid_json', raw: text } });
        }
      });
    });
    req.on('error', (error) => resolve({ ok: false, status: 0, data: { error: error.message } }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, data: { error: 'timeout' } });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function voiceRuntimeCapabilities() {
  return {
    ok: true,
    featureFlags: {
      TARX_VOICE_NATIVE_CAPTURE: VOICE_NATIVE_CAPTURE_ENABLED,
      TARX_VOICE_BROWSER_FALLBACK: VOICE_BROWSER_FALLBACK_ENABLED,
    },
    sources: {
      production: VOICE_NATIVE_CAPTURE_ENABLED ? 'electron_native' : null,
      fallback: VOICE_BROWSER_FALLBACK_ENABLED ? 'browser_fallback' : null,
    },
    routeTruth: {
      localOnly: true,
      supercomputerAllowed: false,
      supercomputerUsed: false,
      browserCaptureIsFallback: true,
    },
    states: VOICE_UX_STATES,
    nativeCapture: nativeCaptureStatus(),
    stt: {
      endpoint: VOICE_WHISPER_URL,
      contract: 'whisper.cpp /inference multipart',
      localOnly: true,
    },
  };
}

function createVoiceCaptureEvent({ source, sessionId, captureId, durationMs = 0, sampleRate = 16000 } = {}) {
  return {
    schema: 'tarx-voice-capture-event.v1',
    session_id: String(sessionId || 'rt_electron_local'),
    capture_id: String(captureId || `vc_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`),
    source,
    sample_rate: sampleRate,
    duration_ms: durationMs,
    vad: {
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      confidence: 0,
    },
    privacy: {
      local_only: true,
      supercomputer_used: false,
    },
  };
}

function voiceCaptureDir() {
  const dir = path.join(diagnosticsDir(), 'voice-captures');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function findNativeCaptureBinary() {
  const candidates = [
    process.env.TARX_VOICE_NATIVE_CAPTURE_BIN,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') return candidate;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

function safeExecFile(command, args, timeout = 4000) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
  } catch (error) {
    return `${error.stdout || ''}${error.stderr || ''}`;
  }
}

function parseAvFoundationAudioDevices(output) {
  const devices = [];
  let inAudio = false;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (/AVFoundation audio devices:/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (inAudio && /AVFoundation video devices:/i.test(line)) break;
    const match = inAudio && line.match(/\[(\d+)\]\s+(.+)$/);
    if (match) devices.push({ index: Number(match[1]), name: match[2].trim(), selector: `:${match[1]}` });
  }
  return devices;
}

function listNativeCaptureDevices() {
  const binary = findNativeCaptureBinary();
  if (!binary) return { ok: false, devices: [], raw: '', firstBlocker: 'native_capture_binary_missing' };
  const raw = safeExecFile(binary, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
  return { ok: true, devices: parseAvFoundationAudioDevices(raw), raw: raw.slice(0, 3000), firstBlocker: null };
}

function macDefaultInputDevice() {
  if (process.platform !== 'darwin') return null;
  const raw = safeExecFile('/usr/sbin/system_profiler', ['SPAudioDataType'], 6000);
  const lines = String(raw || '').split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const deviceMatch = line.match(/^\s{8}([^:]+):\s*$/);
    if (deviceMatch) current = deviceMatch[1].trim();
    if (/Default Input Device:\s*Yes/i.test(line) && current) return { name: current, raw: raw.slice(0, 3000) };
  }
  return { name: null, raw: raw.slice(0, 3000) };
}

function nativeInputSettingsHints() {
  return {
    soundInput: MAC_SOUND_INPUT_SETTINGS_URL,
    microphonePrivacy: MAC_MICROPHONE_PRIVACY_SETTINGS_URL,
    guidance: 'Use macOS System Settings to select a connected microphone and allow TARX microphone access.',
  };
}

function resolveNativeCaptureDevice() {
  const listing = listNativeCaptureDevices();
  const defaultInput = macDefaultInputDevice();
  const requested = VOICE_NATIVE_CAPTURE_DEVICE.trim();
  if (requested) {
    const match = listing.devices.find((device) => device.selector === requested || String(device.index) === requested.replace(/^:/, '') || device.name === requested || `:${device.name}` === requested);
    return {
      selector: match?.selector || requested,
      source: 'env_override',
      requested,
      device: match || { selector: requested, name: requested, index: null },
      defaultInput,
      availableDevices: listing.devices,
      settings: nativeInputSettingsHints(),
    };
  }
  const byDefault = defaultInput?.name
    ? listing.devices.find((device) => device.name.toLowerCase() === defaultInput.name.toLowerCase())
    : null;
  const selected = byDefault || listing.devices[0] || null;
  return {
    selector: selected?.selector || ':0',
    source: byDefault ? 'macos_default_input' : (selected ? 'first_avfoundation_audio_device' : 'fallback_selector'),
    requested: null,
    device: selected,
    defaultInput,
    availableDevices: listing.devices,
    settings: nativeInputSettingsHints(),
  };
}

function nativeCaptureStatus() {
  const binary = findNativeCaptureBinary();
  const resolved = resolveNativeCaptureDevice();
  return {
    adapter: 'ffmpeg-avfoundation',
    available: Boolean(binary && resolved.device),
    binary,
    device: resolved.selector,
    selectedDevice: resolved,
    deviceSelection: resolved.source,
    systemDefaultInput: resolved.defaultInput,
    availableInputDevices: resolved.availableDevices,
    settings: nativeInputSettingsHints(),
    sampleRate: VOICE_NATIVE_CAPTURE_SAMPLE_RATE,
    maxMs: VOICE_NATIVE_CAPTURE_MAX_MS,
  };
}

function nativeCaptureArgs(capturePath, selectedDevice = resolveNativeCaptureDevice()) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'avfoundation',
    '-i', selectedDevice.selector,
    '-ac', '1',
    '-ar', String(VOICE_NATIVE_CAPTURE_SAMPLE_RATE),
    '-f', 'wav',
    capturePath,
  ];
}

function readWavAudioStats(capturePath) {
  try {
    if (!capturePath || !fs.existsSync(capturePath)) return { validWav: false, fileSize: 0, nonSilent: false };
    const buffer = fs.readFileSync(capturePath);
    if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return { validWav: false, fileSize: buffer.length, nonSilent: false };
    const sampleRate = buffer.readUInt32LE(24);
    const channelCount = buffer.readUInt16LE(22);
    const bitsPerSample = buffer.readUInt16LE(34);
    let dataOffset = -1;
    let dataSize = 0;
    for (let i = 12; i + 8 < buffer.length;) {
      const id = buffer.toString('ascii', i, i + 4);
      const size = buffer.readUInt32LE(i + 4);
      if (id === 'data') { dataOffset = i + 8; dataSize = size; break; }
      i += 8 + size + (size % 2);
    }
    let sumSq = 0;
    let peak = 0;
    let count = 0;
    if (dataOffset > 0 && bitsPerSample === 16) {
      const end = Math.min(buffer.length, dataOffset + dataSize);
      for (let i = dataOffset; i + 1 < end; i += 2) {
        const sample = buffer.readInt16LE(i) / 32768;
        const abs = Math.abs(sample);
        if (abs > peak) peak = abs;
        sumSq += sample * sample;
        count += 1;
      }
    }
    const rms = count ? Math.sqrt(sumSq / count) : 0;
    return {
      validWav: true,
      fileSize: buffer.length,
      sampleRate,
      channelCount,
      bitsPerSample,
      durationMs: sampleRate && channelCount ? Math.round((count / sampleRate / channelCount) * 1000) : 0,
      rms: Number(rms.toFixed(6)),
      peakAmplitude: Number(peak.toFixed(6)),
      nonSilent: rms > 0.003 || peak > 0.03,
      inputStatus: rms > 0.003 || peak > 0.03 ? 'live' : 'silent_or_disconnected',
    };
  } catch (error) {
    return { validWav: false, fileSize: 0, nonSilent: false, error: error.message };
  }
}

function startNativeCaptureProcess(captureEvent) {
  const binary = findNativeCaptureBinary();
  if (!binary) throw new Error('native_capture_binary_missing');
  const selectedDevice = resolveNativeCaptureDevice();
  if (!selectedDevice.device && !selectedDevice.requested) throw new Error('native_capture_input_device_missing');
  const capturePath = path.join(voiceCaptureDir(), `${captureEvent.capture_id}.wav`);
  const args = nativeCaptureArgs(capturePath, selectedDevice);
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  child.on('error', (error) => {
    voiceNativeCaptureState.error = error.message;
  });
  const timeout = setTimeout(() => {
    if (!child.killed) child.kill('SIGINT');
  }, VOICE_NATIVE_CAPTURE_MAX_MS);
  return { process: child, capturePath, startedAt: Date.now(), stderr: () => stderr, timeout, selectedDevice };
}

function stopNativeCaptureProcess() {
  const active = voiceNativeCaptureState;
  const child = active.process;
  if (!child) return Promise.resolve({ exitCode: null, signal: null });
  return new Promise((resolve) => {
    let settled = false;
    const done = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (active.timeout) clearTimeout(active.timeout);
      resolve({ exitCode, signal });
    };
    child.once('close', done);
    if (!child.killed) child.kill('SIGINT');
    setTimeout(() => {
      if (!settled && !child.killed) child.kill('SIGKILL');
      done(null, 'SIGKILL_TIMEOUT');
    }, 2500);
  });
}

async function emitVoiceCaptureEventToBridge(event) {
  return requestBridgeJson('/v1/runtime/voice/capture-events', {
    method: 'POST',
    body: event,
    timeoutMs: 2500,
  });
}

async function emitSttResultToBridge(result) {
  return requestBridgeJson('/v1/runtime/stt-results', {
    method: 'POST',
    body: result,
    timeoutMs: 2500,
  });
}

function extractWhisperTranscript(payload, fallbackText = '') {
  return String(
    payload?.text ||
    payload?.transcript ||
    payload?.result?.text ||
    payload?.segments?.map?.((segment) => segment.text).join(' ') ||
    fallbackText ||
    ''
  ).trim();
}

async function transcribeNativeCaptureFile(captureEvent, capturePath) {
  if (!capturePath || !fs.existsSync(capturePath)) {
    return { ok: false, error: 'capture_file_missing', transcript: '', audioBytes: 0 };
  }
  const started = Date.now();
  const audio = fs.readFileSync(capturePath);
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), path.basename(capturePath));
  form.append('temperature', '0.0');
  form.append('response_format', 'json');
  const endpoint = `${VOICE_WHISPER_URL.replace(/\/$/, '')}/inference`;
  const response = await fetch(endpoint, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(Number(process.env.TARX_WHISPER_TIMEOUT || 30000)),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const transcript = extractWhisperTranscript(json, text);
  const sttResult = {
    schema: 'tarx-stt-result.v1',
    session_id: captureEvent.session_id,
    capture_id: captureEvent.capture_id,
    transcript_id: `stt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    model: 'whisper-base.en-int8',
    text: transcript,
    confidence: transcript && !/^\[BLANK_AUDIO\]$/i.test(transcript) ? 0.8 : 0,
    latency_ms: Date.now() - started,
    local_only: true,
    evidence: {
      audio_ref: capturePath,
      audio_bytes: audio.length,
      raw_audio_logged: false,
      endpoint,
    },
  };
  const bridge = transcript ? await emitSttResultToBridge(sttResult) : null;
  return {
    ok: response.ok && Boolean(transcript),
    status: response.status,
    transcript,
    blankAudio: /^\[BLANK_AUDIO\]$/i.test(transcript),
    raw: json || text.slice(0, 500),
    sttResult,
    bridge,
  };
}

async function waitForRuntime(timeoutMs = RUNTIME_START_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const health = await getRuntimeHealth(2000);
    if (health) return health;
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  return null;
}

async function ensureLocalRuntime() {
  const existing = await getRuntimeHealth();
  if (existing) {
    setRuntimeState({ status: 'ready', health: existing, error: null, pid: null });
    return true;
  }

  const bridge = runtimeBridgePath();
  if (!fs.existsSync(bridge)) {
    setRuntimeState({
      status: 'missing',
      health: null,
      error: `Bridge runtime not found at ${bridge}`,
      pid: null,
    });
    return false;
  }

  try {
    fs.mkdirSync(path.dirname(runtimeLogPath()), { recursive: true });
    const out = fs.openSync(runtimeLogPath(), 'a');
    const child = spawn(nodePath(), [bridge], {
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        TARX_PHONE_HOME: process.env.TARX_PHONE_HOME || 'true',
      },
    });
    child.unref();
    setRuntimeState({ status: 'starting', health: null, error: null, pid: child.pid });
  } catch (error) {
    setRuntimeState({ status: 'error', health: null, error: error.message, pid: null });
    return false;
  }

  const health = await waitForRuntime();
  if (health) {
    setRuntimeState({ status: 'ready', health, error: null });
    return true;
  }
  setRuntimeState({ status: 'error', health: null, error: 'Bridge did not become healthy before timeout' });
  return false;
}

// ── Deep link protocol (tarx://) ─────────────────────────────────────────────
if (process.defaultApp) {
  // Dev mode: register with path to electron binary
  app.setAsDefaultProtocolClient('tarx', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('tarx');
}

// ── App single-instance lock ─────────────────────────────────────────────────
const gotLock = process.env.TARX_ALLOW_PARALLEL_ELECTRON_SMOKE === '1' ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  // Windows/Linux: deep link URL is in argv
  const deepLink = argv.find(arg => arg.startsWith('tarx://'));
  if (deepLink) handleDeepLink(deepLink);
});

// ── Window creation ──────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 24, y: 24 },
    roundedCorners: true,
    backgroundColor: '#0A0A0D',
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Web content fills the ENTIRE window. Traffic lights overlay on the sidebar.
  // The web app's CSS handles the traffic light clearance (padding-top on sidebar).
  syncWindowButtonVisibility();
  mainWindow.on('resize', syncWindowButtonVisibility);

  // Inject desktop integration CSS + JS after each page load
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      /* Drag region for title bar */
      body::before {
        content: '';
        position: fixed;
        top: 0; left: 0; right: 0;
        height: 60px;
        -webkit-app-region: drag;
        z-index: 99998;
        pointer-events: none;
      }
      button, a, input, textarea, select, [role="button"], [contenteditable],
      [data-radix-popper-content-wrapper] {
        -webkit-app-region: no-drag;
      }
      /* Web shell owns chrome geometry. Native only supplies the drag region. */
      .light-mode aside, [data-theme="light"] aside {
        background: #F5F5F7 !important;
      }
      aside > div:first-child { margin-top: 0 !important; }
      body { padding-top: 0 !important; }
      /* Window background matches content — native macOS handles corner radius */
      html, body {
        background: var(--tarx-bg, #0A0A0D) !important;
      }
    `);

    // ── JS: expose version only — sidebar logic handled in React (AppShell) ──
    mainWindow.webContents.executeJavaScript(`
      (function() {
        if (window.__tarxDesktopInjected) return;
        window.__tarxDesktopInjected = true;
        var d = window.__TARX_DESKTOP__;
        if (d && d.getVersion) {
          d.getVersion().then(function(v) { window.__TARX_VERSION = v; });
        }
      })();
    `).catch(function() {});
  });

  // ── Voice: auto-grant microphone to TARX origins ──────────────────
  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const url = webContents.getURL();
      const isTarx = url.includes('tarx.com') || url.includes('localhost') || url.startsWith('file://');
      if ((permission === 'media' || permission === 'microphone') && isTarx) {
        callback(true);
      } else {
        callback(permission === 'clipboard-read' || permission === 'notifications');
      }
    }
  );
  mainWindow.webContents.session.setPermissionCheckHandler(
    (webContents, permission) => {
      if (permission === 'media' || permission === 'microphone') return true;
      return false;
    }
  );

  loadBestUrl();

  mainWindow.once('ready-to-show', () => {
    syncWindowButtonVisibility();
    mainWindow.show();
    if (!isDev) {
      checkForUpdates({ download: false });
      setInterval(() => checkForUpdates({ download: false, silent: true }), UPDATE_CHECK_INTERVAL_MS);
    }
  });

  // Handle external links — open in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://tarx.com') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedUrl) => {
    if (errorCode === -3) return;
    console.error(`[tarx] Load failed: ${errorCode} ${errorDesc} at ${validatedUrl}`);
    handleLoadFailure();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerComposerIpc() {
  if (composerIpcRegistered) return;
  composerIpcRegistered = true;

  ipcMain.on('open-composer', () => openComposerWindow());
  ipcMain.handle('open-composer', () => openComposerWindow());
}

// ── URL routing with fallback ────────────────────────────────────────────────
async function loadBestUrl() {
  const primary = await probe(PRIMARY_URL + '/api/version', true);
  if (primary) {
    currentUrl = PRIMARY_URL;
    isOnline = true;
    trayManager?.setStatus('online');
    mainWindow?.loadURL(PRIMARY_URL);
    return;
  }

  const fallback = await probe(FALLBACK_URL + '/health', false);
  if (fallback) {
    currentUrl = FALLBACK_URL;
    isOnline = false;
    trayManager?.setStatus('local');
    mainWindow?.loadURL(FALLBACK_URL);
    return;
  }

  // Both unreachable — show offline page
  isOnline = false;
  trayManager?.setStatus('offline');
  mainWindow?.loadFile(path.join(__dirname, 'offline.html'));
}

function handleLoadFailure() {
  if (currentUrl === PRIMARY_URL) {
    probe(FALLBACK_URL + '/health', false).then((ok) => {
      if (ok) {
        currentUrl = FALLBACK_URL;
        trayManager?.setStatus('local');
        mainWindow?.loadURL(FALLBACK_URL);
      } else {
        trayManager?.setStatus('offline');
        mainWindow?.loadFile(path.join(__dirname, 'offline.html'));
      }
    });
  }
}

function probe(url, secure, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let mod = secure ? https : http;
    try {
      const parsed = new URL(url);
      mod = parsed.protocol === 'http:' ? http : https;
    } catch {}
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      resolve(res.statusCode < 500);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── Floating Composer Window ─────────────────────────────────────────────────
let composerWindow = null;

function openComposerWindow() {
  if (composerWindow && !composerWindow.isDestroyed()) {
    composerWindow.focus();
    return;
  }

  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = display.workAreaSize;

  const composerW = 660;
  const composerH = 480;

  composerWindow = new BrowserWindow({
    width: composerW,
    height: composerH,
    x: Math.round((screenW - composerW) / 2),
    y: screenH - composerH - 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    roundedCorners: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load tarx.com/chat in the composer — just the chat interface
  const composerURL = currentUrl === FALLBACK_URL
    ? `${FALLBACK_URL}/chat`
    : `${PRIMARY_URL}/chat`;
  composerWindow.loadURL(composerURL);

  // Inject glassmorphic styling once loaded
  composerWindow.webContents.on('did-finish-load', () => {
    composerWindow.webContents.insertCSS(`
      /* Glassmorphic floating composer */
      html, body {
        background: transparent !important;
        border-radius: 24px !important;
        overflow: hidden !important;
      }
      /* Hide everything except the composer + COT */
      [class*="sidebar"], [class*="Sidebar"], aside,
      [class*="activity"], [class*="Activity"],
      header, nav, footer {
        display: none !important;
      }
      /* Make the main content area full-width */
      main, [class*="main"], [class*="content"], [class*="canvas"] {
        margin: 0 !important;
        padding: 16px !important;
        max-width: 100% !important;
        width: 100% !important;
      }
    `);
  });

  // Close on Escape
  composerWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      composerWindow.close();
    }
  });

  composerWindow.on('closed', () => {
    composerWindow = null;
  });

  composerWindow.on('blur', () => {
    // Don't auto-close on blur — user might be copying text
  });
}


function targetWindowForVisionAction() {
  if (composerWindow && !composerWindow.isDestroyed() && composerWindow.isFocused()) return composerWindow;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  if (composerWindow && !composerWindow.isDestroyed()) return composerWindow;
  return null;
}

function visionEvidenceDir() {
  const dir = path.join(diagnosticsDir(), 'vision-observations');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function boundsToPlain(bounds = {}) {
  return {
    x: Math.round(Number(bounds.x || 0)),
    y: Math.round(Number(bounds.y || 0)),
    width: Math.round(Number(bounds.width || 0)),
    height: Math.round(Number(bounds.height || 0)),
  };
}

function rectArea(rect) {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function rectIntersectionArea(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function inferSensitiveFlags(text = '') {
  const value = String(text || '');
  const flags = new Set();
  if (/\b(api[_-]?key|password|passwd|secret|token|private[_ -]?key|bearer\s+[a-z0-9._-]+|sk-[a-z0-9]{12,}|xox[baprs]-[a-z0-9-]+|ghp_[a-z0-9]{20,}|akia[0-9a-z]{16})\b/i.test(value)) {
    flags.add('credential_like');
  }
  if (/\b(card number|cvv|routing number|account number|invoice|payment|billing)\b/i.test(value)) flags.add('payment');
  if (/\b(ssn|social security|passport|dob|date of birth|home address)\b/i.test(value)) flags.add('personal');
  return flags.size ? Array.from(flags) : ['none'];
}

function classifyWindowOcclusion(windowRef) {
  if (!windowRef || windowRef.isDestroyed()) return { status: 'blocked', confidence: 0, reasons: ['no_window_available'] };
  if (!windowRef.isVisible() || windowRef.isMinimized()) return { status: 'blocked', confidence: 0.05, reasons: ['window_not_visible'] };

  const bounds = boundsToPlain(windowRef.getBounds());
  const targetArea = rectArea(bounds);
  if (targetArea <= 0) return { status: 'blocked', confidence: 0.05, reasons: ['invalid_window_bounds'] };

  const display = screen.getDisplayMatching(bounds);
  const workArea = boundsToPlain(display?.workArea || display?.bounds || {});
  const visibleArea = rectIntersectionArea(bounds, workArea);
  const visibleRatio = targetArea ? visibleArea / targetArea : 0;
  const reasons = [];
  if (visibleRatio <= 0.05) return { status: 'blocked', confidence: 0.1, reasons: ['window_outside_display'] };
  if (visibleRatio < 0.95) reasons.push('window_partially_offscreen');

  let internalOverlapRatio = 0;
  for (const other of BrowserWindow.getAllWindows()) {
    if (other === windowRef || other.isDestroyed() || !other.isVisible() || other.isMinimized()) continue;
    const otherBounds = boundsToPlain(other.getBounds());
    const overlap = rectIntersectionArea(bounds, otherBounds) / targetArea;
    if (overlap > internalOverlapRatio) internalOverlapRatio = overlap;
  }
  if (internalOverlapRatio > 0.05) reasons.push('overlapped_by_electron_window');

  if (internalOverlapRatio >= 0.8) return { status: 'blocked', confidence: 0.2, reasons, internalOverlapRatio };
  if (internalOverlapRatio > 0.05 || visibleRatio < 0.95) {
    return { status: 'partial', confidence: 0.65, reasons, internalOverlapRatio, visibleRatio };
  }

  // Electron cannot prove occlusion from unrelated macOS apps without a deeper AX/WindowServer pass.
  return { status: 'clear', confidence: 0.78, reasons: ['electron_window_clear_external_occlusion_unverified'], visibleRatio };
}

function evaluateVisionFreshnessPolicy(observation) {
  const freshness = Number(observation?.freshness_ms);
  const blocked = observation?.occlusion_status === 'blocked';
  return {
    passive_describe_allowed: Number.isFinite(freshness) && freshness <= VISION_FRESHNESS_POLICY_MS.passiveDescribe,
    ui_suggestion_allowed: Number.isFinite(freshness) && freshness <= VISION_FRESHNESS_POLICY_MS.uiSuggestion && !blocked,
    action_proposal_allowed: Number.isFinite(freshness) && freshness <= VISION_FRESHNESS_POLICY_MS.actionProposal && !blocked,
    action_execution_allowed: false,
    action_execution_blocked_reason: blocked
      ? 'occlusion_blocked'
      : (Number.isFinite(freshness) && freshness <= VISION_FRESHNESS_POLICY_MS.actionExecution ? 'execution_disabled_internal_beta' : 'freshness_over_500ms'),
    thresholds_ms: VISION_FRESHNESS_POLICY_MS,
  };
}

async function getRendererSurface(windowRef) {
  if (!windowRef || windowRef.isDestroyed()) return { url: '', title: '', visibleText: '', actions: [] };
  try {
    return await windowRef.webContents.executeJavaScript(`(() => {
      const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 8000);
      const actions = Array.isArray(window.__tarxActionManifest?.actions) ? window.__tarxActionManifest.actions : [];
      return { url: location.href, title: document.title, visibleText: text, actions: actions.slice(0, 24) };
    })()`, true);
  } catch (error) {
    return { url: windowRef.webContents.getURL(), title: '', visibleText: '', actions: [], error: error.message };
  }
}

async function observeVisionSurface(reason = 'manual') {
  const windowRef = targetWindowForVisionAction();
  const id = `vision-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const capturedAtMs = Date.now();
  const capturedAt = new Date(capturedAtMs).toISOString();
  if (!windowRef) {
    return {
      ok: false,
      schema: 'tarx-vision-observation.v1',
      version: 'tarx-vision-observation.v1',
      session_id: 'rt_electron_local',
      observation_id: id,
      id,
      source: 'active_window',
      captured_at: capturedAt,
      freshness_ms: 0,
      occlusion_status: 'blocked',
      target_confidence: 0,
      sensitive_flags: ['unknown'],
      local_only: true,
      error: 'no_window_available',
      createdAt: capturedAt,
    };
  }
  const surface = await getRendererSurface(windowRef);
  let screenshotPath = null;
  let screenshotError = null;
  try {
    if (VISION_SAVE_SCREENSHOT) {
      const image = await windowRef.webContents.capturePage();
      screenshotPath = path.join(visionEvidenceDir(), `${id}.png`);
      fs.writeFileSync(screenshotPath, image.toPNG());
    }
  } catch (error) {
    screenshotError = error.message;
    surface.screenshotError = error.message;
  }
  const bounds = boundsToPlain(windowRef.getBounds());
  const occlusion = classifyWindowOcclusion(windowRef);
  const freshnessMs = Date.now() - capturedAtMs;
  const visibleText = String(surface.visibleText || '').slice(0, 8000);
  const observation = {
    ok: true,
    schema: 'tarx-vision-observation.v1',
    version: 'tarx-vision-observation.v1',
    session_id: 'rt_electron_local',
    observation_id: id,
    id,
    source: 'active_window',
    captured_at: capturedAt,
    freshness_ms: freshnessMs,
    window: {
      app: 'TARX Electron',
      title: surface.title || windowRef.getTitle() || '',
      bounds,
      focused: windowRef.isFocused(),
      visible: windowRef.isVisible(),
      minimized: windowRef.isMinimized(),
    },
    occlusion_status: occlusion.status,
    target_confidence: occlusion.confidence,
    sensitive_flags: inferSensitiveFlags(visibleText),
    local_only: true,
    capture_policy: {
      raw_screenshot_logged_by_default: false,
      screenshot_saved: Boolean(screenshotPath),
      save_screenshot_requires_env: 'TARX_VISION_SAVE_SCREENSHOT=1',
    },
    freshness_policy: null,
    producer: { name: 'tarx-electron', capture: 'live', reason },
    surface: {
      kind: surface.url?.includes('/chat') ? 'chat' : 'unknown',
      url: surface.url || windowRef.webContents.getURL(),
      title: surface.title || '',
      visibleText,
      actionCount: Array.isArray(surface.actions) ? surface.actions.length : 0,
    },
    evidence: { screenshotPath, screenshotOk: Boolean(screenshotPath), screenshotSaved: Boolean(screenshotPath), screenshotError },
    occlusion,
    actionManifest: Array.isArray(surface.actions) ? surface.actions : [],
    createdAt: capturedAt,
  };
  observation.freshness_policy = evaluateVisionFreshnessPolicy(observation);
  writeDiagnostic('latest-vision-observation.json', observation);
  return observation;
}

function inferActionIntentMode(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (/\b(click|open|create|send|submit|type|press|run|execute|delete|move|rename|archive|complete|schedule)\b/.test(text)) return 'action_requested';
  if (/\b(what am i looking at|what do you see|describe|summarize the screen|read this screen)\b/.test(text)) return 'describe_only';
  return 'describe_with_followup_option';
}

function inferActionRisk(payload = {}, intentMode = 'describe_only') {
  const text = String(payload.prompt || payload.intent || payload.action || payload.target || '').toLowerCase();
  const type = String(payload.type || payload.actionType || '').toLowerCase();
  const mutation = intentMode === 'action_requested';
  const externalSideEffect = /\b(send|email|sms|post|purchase|buy|delete|terminal|command|run|deploy|transfer|payment)\b/.test(text);
  const highRisk = externalSideEffect || ['send_message', 'run_command', 'delete', 'purchase', 'modify_setting', 'external_tool'].includes(type);
  const blocked = /\b(password|api key|private key|credential|wire transfer|bank transfer)\b/.test(text);
  const level = blocked ? 'blocked' : (highRisk ? 'high' : (mutation ? 'medium' : 'read_only'));
  return {
    level,
    mutation,
    external_side_effect: externalSideEffect,
    requires_confirmation: level === 'medium' || level === 'high' || level === 'blocked',
    high_risk_confirmation_required: level === 'high',
    reason: blocked
      ? 'Blocked risk cannot execute.'
      : (mutation ? 'Mutation requires confirmation and fresh target proof.' : 'Read-only action proposal.'),
  };
}

async function proposeUiAction(payload = {}) {
  const observation = await observeVisionSurface('action-proposal');
  const intentMode = inferActionIntentMode(payload.prompt || payload.intent || payload.action);
  const policy = observation.freshness_policy || evaluateVisionFreshnessPolicy(observation);
  const risk = inferActionRisk(payload, intentMode);
  const bounds = observation.window?.bounds || {};
  const targetFreshnessMs = Number(observation.freshness_ms ?? 9999);
  const targetConfidence = Number(observation.target_confidence ?? 0);
  const canPropose = intentMode === 'action_requested' && policy.action_proposal_allowed && risk.level !== 'blocked';
  const grounding = {
    ok: canPropose,
    schema: 'tarx-action-grounding.v1',
    version: 'tarx-action-grounding.v1',
    groundingId: `grounding-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    session_id: observation.session_id || 'rt_electron_local',
    action_id: String(payload.actionId || payload.action || 'ui_action_proposal'),
    intent_id: String(payload.intentId || `intent-${Date.now()}`),
    actionId: String(payload.actionId || payload.action || 'ui_action_proposal'),
    intentMode,
    proposed_action: {
      type: String(payload.type || payload.actionType || 'click'),
      target: String(payload.target || payload.prompt || ''),
      parameters: payload.parameters && typeof payload.parameters === 'object' ? payload.parameters : {},
      expected_result: String(payload.expectedResult || payload.expected_result || ''),
    },
    grounding: {
      vision_observation_id: observation.observation_id || observation.id,
      target_freshness_ms: targetFreshnessMs,
      target_confidence: targetConfidence,
      target_bounds: bounds,
      occlusion_status: observation.occlusion_status || 'unknown',
    },
    risk,
    status: 'proposed',
    ux_copy: {
      confirmation: risk.requires_confirmation ? 'I can do this. Please confirm.' : '',
      completion_guard: 'Do not say "I handled it" until tarx-action-result.v1 is green.',
    },
    executionPlane: 'computer_local',
    executor: 'electron-native',
    requiresConfirmation: risk.requires_confirmation,
    executionBlocked: true,
    blockedReason: intentMode === 'action_requested'
      ? (risk.level === 'blocked' ? 'blocked_risk' : (policy.action_proposal_allowed ? 'confirmation_required_execution_disabled' : policy.action_execution_blocked_reason))
      : 'describe_only_forbids_side_effects',
    freshnessPolicy: policy,
    target: payload.target || null,
    observationId: observation.id,
    beforeEvidence: observation.evidence?.screenshotPath || null,
    availableActions: observation.actionManifest || [],
    createdAt: new Date().toISOString(),
  };
  writeDiagnostic('latest-action-grounding.json', grounding);
  return grounding;
}

// ── Periodic health check ────────────────────────────────────────────────────
function startHealthLoop() {
  setInterval(async () => {
    const primary = await probe(PRIMARY_URL + '/api/version', true);

    if (primary && currentUrl !== PRIMARY_URL) {
      // Came back online — reload primary
      currentUrl = PRIMARY_URL;
      isOnline = true;
      trayManager?.setStatus('online');
      mainWindow?.loadURL(PRIMARY_URL);
      return;
    }

    if (!primary) {
      isOnline = false;
      const fallback = await probe(FALLBACK_URL + '/health', false);
      trayManager?.setStatus(fallback ? 'local' : 'offline');
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

// ── Menu bar ─────────────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: 'TARX',
      submenu: [
        {
          label: 'About TARX',
          click: showAbout,
        },
        { type: 'separator' },
        {
          label: 'Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click: openPreferences,
        },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => checkForUpdates(),
        },
        { type: 'separator' },
        {
          label: 'Quit TARX',
          accelerator: 'CmdOrCtrl+Q',
          role: 'quit',
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About TARX',
    message: 'TARX',
    detail: `Version ${app.getVersion()}\n\nThe AI that lives on your machine.\n\ntarx.com`,
    buttons: ['OK'],
  });
}

function openPreferences() {
  if (mainWindow && currentUrl === PRIMARY_URL) {
    mainWindow.loadURL(PRIMARY_URL + '/settings');
  } else if (mainWindow) {
    mainWindow.focus();
  }
}

// ── Auto-updater (consumer-friendly: no dialogs, footer-based) ──────────────
function checkForUpdates({ download = false, silent = false } = {}) {
  autoUpdater.autoDownload = download;
  autoUpdater.autoInstallOnAppQuit = true;
  if (!silent) setUpdateState({ status: 'checking', error: null });
  return autoUpdater.checkForUpdates().catch((err) => {
    setUpdateState({ status: 'error', error: err.message });
    console.log('[tarx] Update check failed:', err.message);
    throw err;
  });
}

function downloadUpdate() {
  if (updateDownloadInFlight) return updateDownloadInFlight;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  setUpdateState({ status: 'downloading', percent: 1, error: null });
  armUpdateDownloadWatchdog();
  updateDownloadInFlight = (async () => {
    try {
      if (typeof autoUpdater.downloadUpdate === 'function' && updateState.version) {
        return await autoUpdater.downloadUpdate();
      }
      return await autoUpdater.checkForUpdates();
    } catch (err) {
      const message = err?.message || String(err);
      if (/check.*updates?|no update info|update info/i.test(message)) {
        console.log('[tarx] Update download requested before native update info was warm; rechecking with autoDownload.');
        return autoUpdater.checkForUpdates();
      }
      setUpdateState({ status: 'error', error: message });
      console.log('[tarx] Update download failed:', message);
      throw err;
    } finally {
      updateDownloadInFlight = null;
    }
  })();
  return updateDownloadInFlight;
}

autoUpdater.on('update-available', (info) => {
  console.log(`[tarx] Update available: ${info.version}`);
  setUpdateState({ status: 'available', version: info.version, error: null });
  mainWindow?.webContents.send('tarx:update-available', { version: info.version });
});

autoUpdater.on('update-not-available', (info) => {
  console.log(`[tarx] No update available: ${info.version || app.getVersion()}`);
  setUpdateState({ status: 'not-available', version: info.version || app.getVersion(), error: null });
});

autoUpdater.on('download-progress', (progress) => {
  const percent = Number.isFinite(progress.percent) ? progress.percent : 0;
  if (percent > 0) clearUpdateDownloadWatchdog();
  setUpdateState({
    status: 'download-progress',
    percent: Math.max(1, percent),
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond,
    error: null,
  });
});

autoUpdater.on('update-downloaded', (info) => {
  clearUpdateDownloadWatchdog();
  console.log(`[tarx] Update downloaded: ${info.version}`);
  setUpdateState({ status: 'downloaded', version: info.version, percent: 100, error: null });
  mainWindow?.webContents.send('tarx:update-ready', { version: info.version });
});

autoUpdater.on('error', (err) => {
  clearUpdateDownloadWatchdog();
  setUpdateState({ status: 'error', error: err.message });
  console.log('[tarx] Update error:', err.message);
});

// User clicks "Relaunch to update" in the footer
ipcMain.handle('tarx:relaunch-to-update', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('tarx:check-for-updates', () => {
  checkForUpdates({ download: false });
  return updateState;
});

ipcMain.handle('tarx:download-update', async () => {
  await downloadUpdate();
  return updateState;
});

ipcMain.handle('tarx:copy-text', (_event, value) => {
  clipboard.writeText(String(value || ''));
  return true;
});

ipcMain.handle('tarx:vision-observe', async (_event, payload) => {
  return observeVisionSurface(payload?.reason || 'manual');
});

ipcMain.handle('tarx:action-propose', async (_event, payload) => {
  return proposeUiAction(payload || {});
});


ipcMain.handle('tarx:voice-permission-status', () => getVoicePermissionStatus());

ipcMain.handle('tarx:voice-request-permission', async () => requestVoicePermission());

ipcMain.handle('tarx:voice-runtime-capabilities', () => voiceRuntimeCapabilities());

ipcMain.handle('tarx:voice-open-input-settings', async () => {
  await shell.openExternal(MAC_SOUND_INPUT_SETTINGS_URL);
  return { ok: true, url: MAC_SOUND_INPUT_SETTINGS_URL };
});

ipcMain.handle('tarx:voice-open-microphone-privacy-settings', async () => {
  await shell.openExternal(MAC_MICROPHONE_PRIVACY_SETTINGS_URL);
  return { ok: true, url: MAC_MICROPHONE_PRIVACY_SETTINGS_URL };
});

ipcMain.handle('tarx:local-operator-control-plane', async () => localOperatorControlPlaneState());

ipcMain.handle('tarx:voice-native-capture-start', async (_event, payload = {}) => {
  if (!VOICE_NATIVE_CAPTURE_ENABLED) {
    return {
      ok: false,
      state: 'unavailable',
      label: VOICE_UX_STATES.unavailable,
      source: 'electron_native',
      fallbackAvailable: VOICE_BROWSER_FALLBACK_ENABLED,
      routeTruth: voiceRuntimeCapabilities().routeTruth,
      reason: 'TARX_VOICE_NATIVE_CAPTURE_disabled',
    };
  }
  if (voiceNativeCaptureState.active) {
    return {
      ok: true,
      state: 'listening',
      label: VOICE_UX_STATES.listening,
      source: 'electron_native',
      captureEvent: voiceNativeCaptureState.captureEvent,
      capture: { localPath: voiceNativeCaptureState.capturePath, active: true },
      routeTruth: voiceRuntimeCapabilities().routeTruth,
    };
  }
  const nativeStatus = nativeCaptureStatus();
  if (!nativeStatus.available) {
    return {
      ok: false,
      state: 'unavailable',
      label: VOICE_UX_STATES.unavailable,
      source: 'electron_native',
      nativeCapture: nativeStatus,
      fallbackAvailable: VOICE_BROWSER_FALLBACK_ENABLED,
      routeTruth: voiceRuntimeCapabilities().routeTruth,
      reason: 'ffmpeg_avfoundation_unavailable',
    };
  }
  const permission = await requestVoicePermission();
  if (permission?.status && permission.status !== 'granted' && permission.granted !== true) {
    return {
      ok: false,
      state: 'permission_needed',
      label: VOICE_UX_STATES.permissionNeeded,
      source: 'electron_native',
      permission,
      routeTruth: voiceRuntimeCapabilities().routeTruth,
    };
  }
  const captureEvent = createVoiceCaptureEvent({
    source: 'electron_native',
    sessionId: payload.session_id,
    sampleRate: payload.sample_rate || VOICE_NATIVE_CAPTURE_SAMPLE_RATE,
  });
  let started;
  try {
    started = startNativeCaptureProcess(captureEvent);
  } catch (error) {
    return {
      ok: false,
      state: 'unavailable',
      label: VOICE_UX_STATES.unavailable,
      source: 'electron_native',
      nativeCapture: nativeStatus,
      routeTruth: voiceRuntimeCapabilities().routeTruth,
      error: error.message,
    };
  }
  const captureStartedEvent = {
    ...captureEvent,
    duration_ms: 0,
    evidence: {
      audio_ref: started.capturePath,
      raw_audio_logged: false,
      adapter: nativeStatus.adapter,
      selected_device: started.selectedDevice,
      system_default_input: nativeStatus.systemDefaultInput,
    },
  };
  const bridge = await emitVoiceCaptureEventToBridge(captureStartedEvent);
  voiceNativeCaptureState = {
    active: true,
    process: started.process,
    captureEvent,
    capturePath: started.capturePath,
    selectedDevice: started.selectedDevice,
    startedAt: started.startedAt,
    updatedAt: new Date().toISOString(),
    stderr: started.stderr,
    timeout: started.timeout,
  };
  writeDiagnostic('latest-native-voice-capture.json', {
    state: 'listening',
    source: 'electron_native',
    captureEvent: captureStartedEvent,
    capture: { localPath: started.capturePath, active: true },
    nativeCapture: nativeStatus,
    selectedDevice: started.selectedDevice,
    bridge,
    routeTruth: voiceRuntimeCapabilities().routeTruth,
  });
  return {
    ok: bridge.ok,
    state: 'listening',
    label: VOICE_UX_STATES.listening,
    source: 'electron_native',
    captureEvent: captureStartedEvent,
    capture: { localPath: started.capturePath, active: true },
    bridge,
    nativeCapture: nativeStatus,
    routeTruth: voiceRuntimeCapabilities().routeTruth,
  };
});

ipcMain.handle('tarx:voice-native-capture-stop', async () => {
  const stopped = await stopNativeCaptureProcess();
  const capturePath = voiceNativeCaptureState.capturePath;
  const bytes = capturePath && fs.existsSync(capturePath) ? fs.statSync(capturePath).size : 0;
  const audioStats = readWavAudioStats(capturePath);
  const durationMs = voiceNativeCaptureState.startedAt ? Math.max(1, Date.now() - voiceNativeCaptureState.startedAt) : 0;
  const captureEvent = voiceNativeCaptureState.captureEvent
    ? {
        ...voiceNativeCaptureState.captureEvent,
        duration_ms: durationMs,
        vad: {
          ...voiceNativeCaptureState.captureEvent.vad,
          ended_at: new Date().toISOString(),
          confidence: bytes > 1000 ? 0.8 : 0,
        },
        evidence: {
          audio_ref: capturePath,
          audio_bytes: bytes,
          raw_audio_logged: false,
          adapter: 'ffmpeg-avfoundation',
          audio_stats: audioStats,
          selected_device: voiceNativeCaptureState.selectedDevice,
          input_status: audioStats.inputStatus,
        },
      }
    : null;
  const bridge = captureEvent ? await emitVoiceCaptureEventToBridge(captureEvent) : null;
  const stt = captureEvent && bytes > 1000 && process.env.TARX_VOICE_NATIVE_CAPTURE_TRANSCRIBE !== '0'
    ? await transcribeNativeCaptureFile(captureEvent, capturePath).catch((error) => ({ ok: false, error: error.message }))
    : null;
  const diagnostic = {
    state: 'off',
    source: 'electron_native',
    captureEvent,
    capture: { localPath: capturePath, audioBytes: bytes, audioStats, active: false, stopped },
    inputStatus: audioStats.inputStatus,
    settings: nativeInputSettingsHints(),
    bridge,
    stt,
    routeTruth: voiceRuntimeCapabilities().routeTruth,
  };
  writeDiagnostic('latest-native-voice-capture.json', diagnostic);
  voiceNativeCaptureState = { active: false, process: null, captureEvent: null, capturePath: null, startedAt: null, updatedAt: new Date().toISOString() };
  return {
    ok: Boolean(captureEvent && bytes > 0 && (!bridge || bridge.ok)),
    state: 'off',
    label: VOICE_UX_STATES.off,
    source: 'electron_native',
    captureEvent,
    capture: { localPath: capturePath, audioBytes: bytes, audioStats, active: false, stopped },
    inputStatus: audioStats.inputStatus,
    settings: nativeInputSettingsHints(),
    bridge,
    stt,
    routeTruth: voiceRuntimeCapabilities().routeTruth,
  };
});

ipcMain.handle('tarx:voice-capture-event', async (_event, payload = {}) => {
  const source = payload.source === 'electron_native' ? 'electron_native' : 'browser_fallback';
  const captureEvent = {
    ...createVoiceCaptureEvent({
      source,
      sessionId: payload.session_id,
      captureId: payload.capture_id,
      durationMs: payload.duration_ms,
      sampleRate: payload.sample_rate,
    }),
    vad: payload.vad || createVoiceCaptureEvent({ source }).vad,
  };
  const bridge = await emitVoiceCaptureEventToBridge(captureEvent);
  return {
    ok: bridge.ok,
    source,
    captureEvent,
    bridge,
    routeTruth: voiceRuntimeCapabilities().routeTruth,
  };
});



function getVoicePermissionStatus() {
  if (process.platform !== 'darwin' || !systemPreferences?.getMediaAccessStatus) {
    return { platform: process.platform, status: 'unknown', canAsk: false };
  }
  return {
    platform: process.platform,
    status: systemPreferences.getMediaAccessStatus('microphone'),
    canAsk: typeof systemPreferences.askForMediaAccess === 'function',
  };
}

async function requestVoicePermission() {
  const before = getVoicePermissionStatus();
  if (process.platform !== 'darwin' || !systemPreferences?.askForMediaAccess) return before;
  if (before.status === 'granted') return before;
  try {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    return { ...getVoicePermissionStatus(), granted };
  } catch (error) {
    return { ...getVoicePermissionStatus(), granted: false, error: error.message };
  }
}

// ── Deep link handler (tarx://auth/callback?token=...) ───────────────────────
// macOS: open-url fires when user clicks a tarx:// link (e.g., magic link email)
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function handleDeepLink(url) {
  if (!url || !url.startsWith('tarx://')) return;

  // If window isn't ready yet, queue the link for after creation
  if (!mainWindow) {
    pendingDeepLink = url;
    return;
  }

  // Convert tarx://auth/callback?token=X&email=Y
  // to     https://tarx.com/api/auth/callback/resend?token=X&email=Y
  try {
    const parsed = new URL(url);
    // tarx://auth/callback → host="auth", pathname="/callback"
    const fullPath = `/${parsed.host}${parsed.pathname}`; // e.g., /auth/callback
    const params = parsed.search; // e.g., ?token=X&email=Y

    if (fullPath.startsWith('/auth/callback')) {
      // Redirect to Auth.js callback with the token, redirecting to / after auth
      const webUrl = `${PRIMARY_URL}/api/auth/callback/resend${params}&callbackUrl=%2F`;

      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.loadURL(webUrl);

        // After auth callback processes, always navigate to home.
        // Auth.js sometimes lands on /settings or /login?error= — override both.
        mainWindow.webContents.once('did-finish-load', () => {
          const finalUrl = mainWindow.webContents.getURL();
          if (finalUrl.includes('/login?error=') || finalUrl.includes('/settings') || finalUrl.includes('/api/auth')) {
            mainWindow.loadURL(PRIMARY_URL);
          }
        });
      }

      console.log(`[tarx] Deep link auth: tarx://auth/callback → redirected (token redacted)`);
    }
  } catch (err) {
    console.error('[tarx] Deep link parse error:', err.message);
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Import tray after app is ready (requires display)
  const { TrayManager } = require('./tray');
  trayManager = new TrayManager({
    onOpen: () => mainWindow?.show(),
    onAskTarx: () => openComposerWindow(),
  });

  buildMenu();
  await ensureLocalRuntime();
  registerComposerIpc();
  createWindow();
  startHealthLoop();

  // Process any deep link received before window was ready
  if (pendingDeepLink) {
    handleDeepLink(pendingDeepLink);
    pendingDeepLink = null;
  }

  // macOS: check if launched via deep link (argv contains the URL)
  const launchUrl = process.argv.find(arg => arg.startsWith('tarx://'));
  if (launchUrl) handleDeepLink(launchUrl);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow?.show();
  }
});

// macOS: keep process alive when window is closed (tray app)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC — renderer can request status
ipcMain.handle('tarx:version', () => app.getVersion());

ipcMain.handle('tarx:runtime-status', async () => {
  const health = await getRuntimeHealth().catch(() => null);
  if (health) setRuntimeState({ status: 'ready', health, error: null });
  return runtimeState;
});

ipcMain.handle('tarx:local-data-status', async () => {
  await ensureLocalRuntime();
  return requestBridgeJson('/api/local-data/status');
});

ipcMain.handle('tarx:restart-runtime', async () => {
  const result = await requestBridgeJson('/api/local-data/restart-runtime', { method: 'POST', body: {} });
  setRuntimeState({ status: 'restarting', health: null, error: null });
  setTimeout(() => ensureLocalRuntime(), 1500);
  return result;
});

ipcMain.handle('tarx:fresh-app-test', async () => {
  await ensureLocalRuntime();
  return requestBridgeJson('/api/local-data/fresh-app-test', { method: 'POST', body: {} });
});

ipcMain.handle('tarx:full-wipe-prepare', async () => {
  await ensureLocalRuntime();
  return requestBridgeJson('/api/local-data/full-wipe/prepare', { method: 'POST', body: {} });
});

ipcMain.handle('tarx:full-wipe-confirm', async (_event, payload) => {
  await ensureLocalRuntime();
  return requestBridgeJson('/api/local-data/full-wipe/confirm', { method: 'POST', body: payload || {} });
});

ipcMain.handle('tarx:vault-reset', async (_event, payload) => {
  await ensureLocalRuntime();
  return requestBridgeJson('/api/local-data/vault-reset', { method: 'POST', body: payload || {} });
});

ipcMain.handle('tarx:status', () => ({
  version: app.getVersion(),
  online: isOnline,
  currentUrl,
  platform: process.platform,
  arch: process.arch,
  update: updateState,
  runtime: runtimeState,
}));
