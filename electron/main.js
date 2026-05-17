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
const PRIME_VOICE_EVIDENCE_PATHS = {
  inventory: '/Users/master/.tarx/runs/voice-input-inventory/latest.json',
  doctor: '/Users/master/.tarx/runs/voice-input-doctor/latest.json',
  nativeStt: '/Users/master/.tarx/runs/voice-native-stt/latest.json',
  internalBetaLoop: '/Users/master/.tarx/runs/voice-internal-beta-loop/latest.json',
  ttsPlayback: '/Users/master/.tarx/runs/voice-tts-playback/latest.json',
};
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

function readPrimeVoiceEvidenceFile(file) {
  try {
    if (!fs.existsSync(file)) return { file, ok: false, missing: true, json: null };
    return { file, ok: true, missing: false, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { file, ok: false, missing: false, error: error.message, json: null };
  }
}

function derivePrimeVoicePanelState({ capabilities, evidence }) {
  if (voiceNativeCaptureState.active) return 'capture_running';
  const devices = capabilities?.nativeCapture?.availableInputDevices || [];
  const stt = evidence?.nativeStt?.json || {};
  const beta = evidence?.internalBetaLoop?.json || {};
  const tts = evidence?.ttsPlayback?.json || {};
  const audio = stt.audioStats || stt.freshCapture?.audioStats || {};
  if (!devices.length) return 'no_input_devices';
  if (beta.status === 'local_voice_internal_beta_green') return 'internal_loop_ready';
  if (tts.missing || !tts.status) {
    if (stt.bridge?.installedRuntimeAcceptedContracts === false) return 'bridge_contracts_missing';
  }
  if (stt.status === 'native_voice_stt_green' && stt.semanticSpeechGreen === true) return 'stt_green';
  if (stt.status === 'native_voice_stt_route_green_semantic_speech_red') return 'stt_semantic_red';
  if (stt.routeGreen === true) return 'stt_route_green';
  if (audio.nonSilent === true) return 'capture_non_silent';
  if (stt.firstBlocker === 'capture_silent' || audio.nonSilent === false) return 'capture_silent';
  if (stt.status) return 'capture_complete';
  if (devices.length === 1 && /razer kiyo pro/i.test(String(devices[0]?.name || ''))) return 'blocked_needs_mic_fix';
  return 'input_selected';
}

function primeVoiceNextAction(state, evidence) {
  const stt = evidence?.nativeStt?.json || {};
  if (state === 'no_input_devices') return 'Open macOS Sound Input, connect/select a microphone, then Refresh Inputs.';
  if (state === 'capture_running') return 'Speak clearly, then press Stop. Required phrase: TARS, what are we working on today?';
  if (state === 'capture_silent') return 'Select a live microphone with a moving macOS input meter, then rerun native STT.';
  if (state === 'capture_non_silent') return 'Run native STT proof with the required spoken phrase.';
  if (state === 'stt_semantic_red') return 'Prime can capture audio, but Whisper is not detecting the required phrase. Select a different microphone in macOS Sound Input, then Refresh.';
  if (state === 'stt_green') return 'Stop here for STT: Bridge voice endpoints and TTS playback proof must be green before full loop.';
  if (state === 'bridge_contracts_missing') return 'Bridge voice runtime endpoints are missing or returning 404; restart/update Bridge only when safe.';
  if (state === 'tts_missing') return 'Run Prime TTS playback proof; Daniel voice remains internal/unapproved.';
  if (state === 'internal_loop_ready') return 'Internal local voice loop evidence is green. Keep release claims disabled.';
  if (stt.firstBlocker) return `Resolve blocker: ${stt.firstBlocker}`;
  return 'Run Voice Doctor, then run native STT with: TARS, what are we working on today?';
}

async function primeVoiceEvidenceSnapshot() {
  const capabilities = voiceRuntimeCapabilities();
  const evidence = Object.fromEntries(Object.entries(PRIME_VOICE_EVIDENCE_PATHS).map(([key, file]) => [key, readPrimeVoiceEvidenceFile(file)]));
  const bridgeHealth = await probeLocalOperatorService('http://127.0.0.1:11440/health');
  const ttsHealth = await probeLocalOperatorService('http://127.0.0.1:11446/health');
  const bridgeCaptureContract = await requestBridgeJson('/v1/runtime/voice/capture-events', { method: 'GET', timeoutMs: 900 });
  const bridgeSttContract = await requestBridgeJson('/v1/runtime/stt-results', { method: 'GET', timeoutMs: 900 });
  const state = derivePrimeVoicePanelState({ capabilities, evidence });
  const selectedDevice = capabilities.nativeCapture?.selectedDevice?.device
    || evidence.nativeStt?.json?.freshCapture?.inventory?.selected
    || evidence.nativeStt?.json?.captureEvent?.evidence?.selected_device
    || null;
  return {
    ok: true,
    schema: 'tarx-prime-voice-panel-evidence.v1',
    ts: new Date().toISOString(),
    states: [
      'idle',
      'inventory_loading',
      'no_input_devices',
      'input_selected',
      'capture_running',
      'capture_complete',
      'capture_silent',
      'capture_non_silent',
      'stt_route_green',
      'stt_semantic_red',
      'stt_green',
      'bridge_contracts_missing',
      'tts_missing',
      'internal_loop_ready',
      'blocked_needs_mic_fix',
    ],
    state,
    selectedDevice,
    routeTruth: {
      computer: true,
      supercomputer: 'Off',
      browserFallback: VOICE_BROWSER_FALLBACK_ENABLED ? 'On' : 'Off',
      supercomputerUsed: false,
      browserFallbackUsed: false,
      productionVoiceReady: false,
    },
    capabilities,
    evidence,
    bridge: {
      health: bridgeHealth,
      captureEventsEndpoint: bridgeCaptureContract,
      sttResultsEndpoint: bridgeSttContract,
      contractsPresent: Boolean(bridgeCaptureContract.ok && bridgeSttContract.ok),
      restartCommand: 'launchctl kickstart -k gui/$(id -u)/com.tarx.ops',
      mutationPerformed: false,
    },
    tts: {
      service: ttsHealth,
      evidence: evidence.ttsPlayback,
      danielApproved: false,
      label: 'Daniel voice is internal/unapproved.',
    },
    commands: {
      inventory: 'cd "/Users/master/Desktop/TARX/Repos - active/tarx-electron" && npm run qa:voice-input-inventory',
      doctor: 'cd "/Users/master/Desktop/TARX/Repos - active/tarx-electron" && npm run qa:voice-input-doctor',
      nativeStt: 'cd "/Users/master/Desktop/TARX/Repos - active/tarx-electron" && TARX_VOICE_NATIVE_CAPTURE=1 npm run qa:voice-native-stt',
    },
    requiredSpokenPhrase: 'TARS, what are we working on today?',
    writtenDisplayPhrase: 'TARX, what are we working on today?',
    nextAction: primeVoiceNextAction(state, evidence),
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

function resolveNativeCaptureDevice(requestedOverride = '') {
  const listing = listNativeCaptureDevices();
  const defaultInput = macDefaultInputDevice();
  const requested = String(requestedOverride || VOICE_NATIVE_CAPTURE_DEVICE || '').trim();
  if (requested) {
    const match = listing.devices.find((device) => device.name === requested)
      || listing.devices.find((device) => device.selector === requested)
      || listing.devices.find((device) => String(device.index) === requested.replace(/^:/, ''))
      || null;
    return {
      selector: match?.selector || null,
      source: 'env_override',
      requested,
      requestedFound: Boolean(match),
      device: match,
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

function startNativeCaptureProcess(captureEvent, requestedDevice = '') {
  const binary = findNativeCaptureBinary();
  if (!binary) throw new Error('native_capture_binary_missing');
  const selectedDevice = resolveNativeCaptureDevice(requestedDevice);
  if (selectedDevice.requested && !selectedDevice.device) throw new Error('requested_avfoundation_input_not_found');
  if (!selectedDevice.device) throw new Error('native_capture_input_device_missing');
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
      #tarx-native-voice-cta {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 99999;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 38px;
        max-width: min(320px, calc(100vw - 36px));
        padding: 9px 12px;
        border: 1px solid rgba(255,255,255,0.16);
        border-radius: 8px;
        background: rgba(10, 10, 13, 0.88);
        color: #fff;
        font: 500 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        box-shadow: 0 12px 30px rgba(0,0,0,0.26);
        cursor: pointer;
        -webkit-app-region: no-drag;
        backdrop-filter: blur(14px);
      }
      #tarx-native-voice-cta.tarx-voice-composer {
        position: static;
        min-height: 32px;
        height: 32px;
        margin-left: 8px;
        padding: 6px 10px;
        box-shadow: none;
        background: rgba(255,255,255,0.07);
      }
      #tarx-native-voice-cta:hover { background: rgba(20, 22, 28, 0.94); }
      #tarx-native-voice-cta.tarx-voice-composer:hover { background: rgba(255,255,255,0.11); }
      #tarx-native-voice-cta:disabled { opacity: 0.72; cursor: default; }
      #tarx-native-voice-cta .tarx-voice-dot {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 999px;
        background: #8A93A3;
      }
      #tarx-native-voice-cta[data-state="listening"] .tarx-voice-dot { background: #22C55E; }
      #tarx-native-voice-cta[data-state="blocked"] .tarx-voice-dot,
      #tarx-native-voice-cta[data-state="error"] .tarx-voice-dot { background: #F97316; }
      #tarx-native-voice-cta .tarx-voice-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #tarx-native-voice-panel {
        position: fixed;
        right: 18px;
        bottom: 66px;
        z-index: 99999;
        width: min(360px, calc(100vw - 36px));
        padding: 12px;
        border: 1px solid rgba(255,255,255,0.16);
        border-radius: 8px;
        background: rgba(10, 10, 13, 0.94);
        color: #fff;
        box-shadow: 0 18px 46px rgba(0,0,0,0.34);
        font: 13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        -webkit-app-region: no-drag;
        backdrop-filter: blur(16px);
      }
      #tarx-native-voice-panel.tarx-voice-panel-composer {
        right: auto;
        bottom: auto;
      }
      #tarx-native-voice-panel[hidden] { display: none; }
      #tarx-native-voice-panel label {
        display: block;
        margin-bottom: 6px;
        color: #AEB6C2;
        font-size: 12px;
      }
      #tarx-native-voice-panel select,
      #tarx-native-voice-panel input {
        width: 100%;
        min-height: 34px;
        padding: 7px 8px;
        border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.16);
        background: #111318;
        color: #fff;
        font: inherit;
      }
      #tarx-native-voice-panel .tarx-voice-row {
        display: flex;
        gap: 8px;
        margin-top: 10px;
      }
      #tarx-native-voice-panel button {
        min-height: 34px;
        padding: 7px 10px;
        border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.16);
        background: #171A21;
        color: #fff;
        cursor: pointer;
        font: inherit;
      }
      #tarx-native-voice-panel button:hover { background: #222632; }
      #tarx-native-voice-panel button:disabled {
        opacity: 0.52;
        cursor: default;
      }
      #tarx-native-voice-panel .tarx-voice-primary {
        background: #92B6DE;
        border-color: #92B6DE;
        color: #0A0A0D;
        font-weight: 650;
      }
      #tarx-native-voice-panel .tarx-voice-primary:hover { background: #A8C6E7; }
      #tarx-native-voice-panel .tarx-voice-status {
        margin-top: 10px;
        color: #AEB6C2;
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      #tarx-native-voice-panel .tarx-voice-note {
        margin-top: 8px;
        color: #7D8795;
        font-size: 12px;
      }
      #tarx-native-voice-panel .tarx-voice-state {
        margin-top: 10px;
        padding: 9px;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 8px;
        background: rgba(255,255,255,0.04);
      }
      #tarx-native-voice-panel .tarx-voice-state[data-tone="red"] {
        border-color: rgba(249,115,22,0.52);
        background: rgba(249,115,22,0.1);
      }
      #tarx-native-voice-panel .tarx-voice-state[data-tone="green"] {
        border-color: rgba(34,197,94,0.44);
        background: rgba(34,197,94,0.08);
      }
      #tarx-native-voice-panel .tarx-voice-kv,
      #tarx-native-voice-panel .tarx-voice-evidence {
        margin-top: 8px;
        display: grid;
        gap: 5px;
        color: #AEB6C2;
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      #tarx-native-voice-panel .tarx-voice-kv div,
      #tarx-native-voice-panel .tarx-voice-evidence div {
        display: flex;
        justify-content: space-between;
        gap: 10px;
      }
      #tarx-native-voice-panel .tarx-voice-kv strong,
      #tarx-native-voice-panel .tarx-voice-evidence strong {
        color: #DDE5F0;
        font-weight: 600;
      }
      #tarx-native-voice-panel .tarx-voice-command {
        margin-top: 8px;
        padding: 7px;
        border-radius: 6px;
        background: #080A0F;
        color: #AEB6C2;
        font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
        overflow-wrap: anywhere;
      }
    `);

    // ── JS: expose version and native Voice CTA ─────────────────────
    mainWindow.webContents.executeJavaScript(`
      (function() {
        function installVoiceDesktop() {
        if (window.__tarxDesktopInjected) return;
        var d = window.__TARX_DESKTOP__;
        if (!d || !d.voice) {
          window.__tarxDesktopVoiceRetryCount = (window.__tarxDesktopVoiceRetryCount || 0) + 1;
          if (window.__tarxDesktopVoiceRetryCount < 40) setTimeout(installVoiceDesktop, 250);
          return;
        }
        window.__tarxDesktopInjected = true;
        if (d && d.getVersion) {
          d.getVersion().then(function(v) { window.__TARX_VERSION = v; });
        }
        if (document.getElementById('tarx-native-voice-cta')) return;
        var voice = d.voice;
        var button = document.createElement('button');
        var panel = document.createElement('div');
        var active = false;
        var capabilities = null;
        button.id = 'tarx-native-voice-cta';
        button.type = 'button';
        button.setAttribute('aria-label', 'Voice');
        button.innerHTML = '<span class="tarx-voice-dot"></span><span class="tarx-voice-label">Voice</span>';
        panel.id = 'tarx-native-voice-panel';
        panel.hidden = true;
        panel.innerHTML = '' +
          '<label for="tarx-native-voice-device">Input</label>' +
          '<select id="tarx-native-voice-device"></select>' +
          '<label for="tarx-native-voice-custom" style="margin-top:10px">Override selector/name</label>' +
          '<input id="tarx-native-voice-custom" placeholder=":0 or exact device name" />' +
          '<div class="tarx-voice-row">' +
          '  <button class="tarx-voice-primary" id="tarx-native-voice-start" type="button">Start</button>' +
          '  <button id="tarx-native-voice-stop" type="button">Stop</button>' +
          '  <button id="tarx-native-voice-refresh" type="button">Refresh</button>' +
          '</div>' +
          '<div class="tarx-voice-row">' +
          '  <button id="tarx-native-voice-sound" type="button">Sound Input</button>' +
          '  <button id="tarx-native-voice-privacy" type="button">Mic Privacy</button>' +
          '</div>' +
          '<div class="tarx-voice-row">' +
          '  <button id="tarx-native-voice-doctor" type="button">Run Voice Doctor</button>' +
          '  <button id="tarx-native-voice-copy-command" type="button">Copy QA command</button>' +
          '</div>' +
          '<div class="tarx-voice-state" id="tarx-native-voice-state" data-tone="neutral">' +
          '  <strong id="tarx-native-voice-state-label">inventory_loading</strong>' +
          '  <div id="tarx-native-voice-next">Loading voice state...</div>' +
          '</div>' +
          '<div class="tarx-voice-kv" id="tarx-native-voice-route-truth"></div>' +
          '<div class="tarx-voice-evidence" id="tarx-native-voice-evidence">No voice evidence yet.</div>' +
          '<div class="tarx-voice-command" id="tarx-native-voice-command">Command execution is disabled from this app panel.</div>' +
          '<div class="tarx-voice-status" id="tarx-native-voice-status">Loading voice settings...</div>' +
          '<div class="tarx-voice-note">Native capture only. Browser fallback and Supercomputer stay off.</div>';
        var deviceSelect = panel.querySelector('#tarx-native-voice-device');
        var customInput = panel.querySelector('#tarx-native-voice-custom');
        var statusNode = panel.querySelector('#tarx-native-voice-status');
        var startButton = panel.querySelector('#tarx-native-voice-start');
        var stopButton = panel.querySelector('#tarx-native-voice-stop');
        var refreshButton = panel.querySelector('#tarx-native-voice-refresh');
        var soundButton = panel.querySelector('#tarx-native-voice-sound');
        var privacyButton = panel.querySelector('#tarx-native-voice-privacy');
        var doctorButton = panel.querySelector('#tarx-native-voice-doctor');
        var copyCommandButton = panel.querySelector('#tarx-native-voice-copy-command');
        var stateBox = panel.querySelector('#tarx-native-voice-state');
        var stateLabel = panel.querySelector('#tarx-native-voice-state-label');
        var nextNode = panel.querySelector('#tarx-native-voice-next');
        var routeTruthNode = panel.querySelector('#tarx-native-voice-route-truth');
        var evidenceNode = panel.querySelector('#tarx-native-voice-evidence');
        var commandNode = panel.querySelector('#tarx-native-voice-command');
        function setVoiceState(state, label) {
          button.dataset.state = state || 'idle';
          var labelNode = button.querySelector('.tarx-voice-label');
          if (labelNode) labelNode.textContent = label || 'Voice';
        }
        function setStatus(text) {
          if (statusNode) statusNode.textContent = text || '';
        }
        function escapeHtml(value) {
          return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }
        function shortValue(value) {
          var text = String(value == null || value === '' ? 'missing' : value);
          return text.length > 180 ? text.slice(0, 177) + '...' : text;
        }
        function row(label, value) {
          return '<div><strong>' + escapeHtml(label) + '</strong><span>' + escapeHtml(shortValue(value)) + '</span></div>';
        }
        function toneForState(state) {
          if (state === 'stt_green' || state === 'internal_loop_ready') return 'green';
          if (state === 'stt_semantic_red' || state === 'capture_silent' || state === 'no_input_devices' || state === 'blocked_needs_mic_fix' || state === 'bridge_contracts_missing' || state === 'tts_missing') return 'red';
          return 'neutral';
        }
        function selectedEvidenceDevice(snapshot) {
          var device = snapshot && snapshot.selectedDevice;
          if (!device) return 'none';
          return (device.name || 'input') + (device.selector ? ' (' + device.selector + ')' : '');
        }
        function renderPrimeEvidence(snapshot) {
          if (!snapshot) {
            if (evidenceNode) evidenceNode.textContent = 'No voice evidence yet.';
            return;
          }
          var state = snapshot.state || 'idle';
          if (stateBox) stateBox.dataset.tone = toneForState(state);
          if (stateLabel) stateLabel.textContent = state;
          if (nextNode) nextNode.textContent = snapshot.nextAction || 'Run Voice Doctor.';
          if (routeTruthNode) {
            routeTruthNode.innerHTML = ''
              + row('Selected device', selectedEvidenceDevice(snapshot))
              + row('Route', 'Computer')
              + row('Supercomputer', snapshot.routeTruth && snapshot.routeTruth.supercomputer || 'Off')
              + row('Browser fallback', snapshot.routeTruth && snapshot.routeTruth.browserFallback || 'Off');
          }
          var nativeStt = snapshot.evidence && snapshot.evidence.nativeStt && snapshot.evidence.nativeStt.json;
          var inventory = snapshot.evidence && snapshot.evidence.inventory && snapshot.evidence.inventory.json;
          var doctor = snapshot.evidence && snapshot.evidence.doctor && snapshot.evidence.doctor.json;
          var tts = snapshot.evidence && snapshot.evidence.ttsPlayback && snapshot.evidence.ttsPlayback.json;
          var audio = nativeStt && (nativeStt.audioStats || (nativeStt.freshCapture && nativeStt.freshCapture.audioStats)) || null;
          var selected = nativeStt && nativeStt.captureEvent && nativeStt.captureEvent.evidence && nativeStt.captureEvent.evidence.selected_device;
          var wav = nativeStt && (nativeStt.wavPath || (nativeStt.captureEvent && nativeStt.captureEvent.evidence && nativeStt.captureEvent.evidence.audio_ref));
          var transcript = nativeStt && (nativeStt.rawTranscript || nativeStt.normalizedDisplayTranscript || (nativeStt.sttResult && nativeStt.sttResult.text));
          if (evidenceNode) {
            if (!nativeStt && !inventory && !doctor && !tts) {
              evidenceNode.textContent = 'No voice evidence yet.';
            } else {
              evidenceNode.innerHTML = ''
                + row('Inventory', inventory && inventory.status)
                + row('Doctor', doctor && doctor.status)
                + row('Native STT', nativeStt && nativeStt.status)
                + row('First blocker', nativeStt && nativeStt.firstBlocker)
                + row('Selected', selected ? (selected.name + ' ' + selected.selector) : selectedEvidenceDevice(snapshot))
                + row('WAV', wav)
                + row('RMS / peak / duration', audio ? ((audio.rms || 0) + ' / ' + (audio.peakAmplitude || 0) + ' / ' + (audio.duration_ms || audio.durationMs || 0) + 'ms') : 'missing')
                + row('Transcript', transcript)
                + row('TTS playback', tts && tts.status)
                + row('Evidence JSON', snapshot.evidence && snapshot.evidence.nativeStt && snapshot.evidence.nativeStt.file);
            }
          }
          var command = snapshot.commands && (state === 'stt_semantic_red' || state === 'capture_non_silent' ? snapshot.commands.nativeStt : snapshot.commands.doctor);
          if (commandNode) commandNode.textContent = 'Command execution is disabled here. Copy/run: ' + (command || 'No command available.');
          var devices = inventory && inventory.avFoundationInputs || [];
          if (devices.length === 1 && /razer kiyo pro/i.test(String(devices[0].name || '')) && state === 'stt_semantic_red') {
            setStatus('Prime can capture audio from Razer Kiyo Pro, but Whisper is not detecting clear speech. Select a different microphone in macOS Sound Input, then Refresh.');
          }
        }
        function positionPanelNearButton() {
          if (!button || !panel || panel.hidden) return;
          var rect = button.getBoundingClientRect();
          if (!button.classList.contains('tarx-voice-composer')) {
            panel.classList.remove('tarx-voice-panel-composer');
            panel.style.left = '';
            panel.style.top = '';
            return;
          }
          panel.classList.add('tarx-voice-panel-composer');
          var panelWidth = Math.min(360, Math.max(260, window.innerWidth - 36));
          var left = Math.max(18, Math.min(window.innerWidth - panelWidth - 18, rect.left));
          var top = Math.max(18, rect.top - 330);
          panel.style.width = panelWidth + 'px';
          panel.style.left = left + 'px';
          panel.style.top = top + 'px';
        }
        function selectedDeviceValue() {
          var custom = customInput && customInput.value ? customInput.value.trim() : '';
          if (custom) return custom;
          return deviceSelect && deviceSelect.value ? deviceSelect.value : '';
        }
        function findComposerMount() {
          var input = document.querySelector('textarea[placeholder*="TARX"], textarea[placeholder*="anything"], [contenteditable="true"][aria-label*="message" i], [contenteditable="true"]');
          if (!input) return null;
          var root = input;
          for (var i = 0; i < 6 && root && root.parentElement; i += 1) {
            root = root.parentElement;
            var rows = Array.prototype.filter.call(root.querySelectorAll('div'), function(node) {
              return node.querySelectorAll && node.querySelectorAll('button').length >= 2;
            });
            if (rows.length) return rows[rows.length - 1];
          }
          return null;
        }
        function mountVoiceButton() {
          var mount = findComposerMount();
          if (mount && button.parentElement !== mount) {
            button.classList.add('tarx-voice-composer');
            mount.appendChild(button);
          } else if (!button.parentElement) {
            button.classList.remove('tarx-voice-composer');
            document.documentElement.appendChild(button);
          }
          positionPanelNearButton();
        }
        function renderCapabilities(next) {
          capabilities = next || capabilities;
          var native = capabilities && capabilities.nativeCapture;
          var devices = native && native.availableInputDevices ? native.availableInputDevices : [];
          deviceSelect.innerHTML = '';
          if (!devices.length) {
            var empty = document.createElement('option');
            empty.value = '';
            empty.textContent = 'No AVFoundation inputs';
            deviceSelect.appendChild(empty);
          } else {
            devices.forEach(function(device) {
              var option = document.createElement('option');
              option.value = device.selector || String(device.index);
              option.textContent = '[' + device.index + '] ' + device.name + ' (' + device.selector + ')';
              deviceSelect.appendChild(option);
            });
          }
          var selected = native && native.selectedDevice && native.selectedDevice.selector;
          if (selected) deviceSelect.value = selected;
          var defaultName = native && native.systemDefaultInput && native.systemDefaultInput.name ? native.systemDefaultInput.name : 'unknown';
          setStatus('Default: ' + defaultName + ' · Native: ' + (native && native.available ? 'available' : 'blocked'));
        }
        function refreshVoiceSettings() {
          setVoiceState(active ? 'listening' : 'blocked', active ? 'Listening' : 'Voice setup');
          if (stateLabel) stateLabel.textContent = 'inventory_loading';
          return Promise.all([
            voice.getRuntimeCapabilities(),
            voice.getPrimeEvidence ? voice.getPrimeEvidence() : Promise.resolve(null),
          ]).then(function(results) {
            var next = results[0];
            var evidence = results[1];
            renderCapabilities(next);
            renderPrimeEvidence(evidence);
            if (next && next.featureFlags && next.featureFlags.TARX_VOICE_NATIVE_CAPTURE) {
              setVoiceState(active ? 'listening' : 'idle', active ? 'Listening' : 'Voice');
            } else {
              setVoiceState('blocked', 'Voice setup');
            }
            return next;
          }).catch(function(error) {
            setVoiceState('blocked', 'Voice setup');
            setStatus('Unable to load voice settings: ' + (error && error.message ? error.message : 'unknown'));
          });
        }
        function statusLabel(result) {
          if (!result) return 'Voice';
          if (result.label) return result.label;
          if (result.state === 'listening') return 'Listening';
          if (result.error) return 'Voice blocked';
          return 'Voice';
        }
        refreshVoiceSettings();
        if (voice.onStatus) {
          voice.onStatus(function(status) {
            if (!status) return;
            if (status.state === 'listening') {
              active = true;
              setVoiceState('listening', 'Listening');
            } else if (status.state === 'error') {
              active = false;
              setVoiceState('error', 'Voice blocked');
            } else if (status.state === 'idle') {
              active = false;
              setVoiceState('idle', 'Voice');
            }
          });
        }
        button.addEventListener('click', function() {
          panel.hidden = !panel.hidden;
          if (!panel.hidden) refreshVoiceSettings();
          positionPanelNearButton();
        });
        startButton.addEventListener('click', function() {
          if (button.disabled) return;
          button.disabled = true;
          setVoiceState('idle', 'Starting...');
          setStatus('Starting native capture...');
          voice.startNativeCapture({ device: selectedDeviceValue() }).then(function(result) {
            active = result && result.state === 'listening';
            setVoiceState(active ? 'listening' : (result && result.error ? 'error' : 'blocked'), statusLabel(result));
            setStatus(active ? 'Capturing: ' + (result.capture && result.capture.localPath ? result.capture.localPath : 'native WAV') : (result.error || result.reason || 'Native capture unavailable'));
          }).catch(function() {
            active = false;
            setVoiceState('error', 'Voice blocked');
            setStatus('Native capture failed');
          }).finally(function() {
            button.disabled = false;
          });
        });
        stopButton.addEventListener('click', function() {
          voice.stopNativeCapture().then(function(result) {
            active = false;
            setVoiceState(result && result.error ? 'error' : 'idle', result && result.error ? 'Voice blocked' : 'Voice');
            setStatus(result && result.capture && result.capture.localPath ? 'Saved: ' + result.capture.localPath : 'Stopped');
            refreshVoiceSettings();
          }).catch(function(error) {
            active = false;
            setVoiceState('error', 'Voice blocked');
            setStatus('Stop failed: ' + (error && error.message ? error.message : 'unknown'));
          });
        });
        refreshButton.addEventListener('click', refreshVoiceSettings);
        soundButton.addEventListener('click', function() { voice.openInputSettings(); });
        privacyButton.addEventListener('click', function() { voice.openMicrophonePrivacySettings(); });
        doctorButton.addEventListener('click', function() {
          var command = 'cd "/Users/master/Desktop/TARX/Repos - active/tarx-electron" && npm run qa:voice-input-doctor';
          if (d.copyText) d.copyText(command);
          if (commandNode) commandNode.textContent = 'Copied Voice Doctor command. Command execution is disabled from this app panel: ' + command;
        });
        copyCommandButton.addEventListener('click', function() {
          var command = 'cd "/Users/master/Desktop/TARX/Repos - active/tarx-electron" && TARX_VOICE_NATIVE_CAPTURE=1 npm run qa:voice-native-stt';
          if (d.copyText) d.copyText(command);
          if (commandNode) commandNode.textContent = 'Copied native STT proof command: ' + command;
        });
        document.documentElement.appendChild(panel);
        mountVoiceButton();
        window.addEventListener('resize', positionPanelNearButton);
        setInterval(mountVoiceButton, 1500);
        }
        installVoiceDesktop();
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
ipcMain.handle('tarx:voice-prime-evidence', async () => primeVoiceEvidenceSnapshot());

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
  const requestedDevice = payload.device || payload.selector || payload.inputDevice || '';
  try {
    started = startNativeCaptureProcess(captureEvent, requestedDevice);
  } catch (error) {
    return {
      ok: false,
      state: 'unavailable',
      label: VOICE_UX_STATES.unavailable,
      source: 'electron_native',
      requestedDevice: requestedDevice || null,
      nativeCapture: {
        ...nativeStatus,
        selectedDevice: resolveNativeCaptureDevice(requestedDevice),
      },
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
