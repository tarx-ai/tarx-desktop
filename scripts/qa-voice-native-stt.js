#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const captureDir = '/Users/master/.tarx/runs/voice-native-capture-proof';
fs.mkdirSync(captureDir, { recursive: true });
let wavPath = process.env.TARX_NATIVE_CAPTURE_WAV || '';
const bridgeUrl = (process.env.TARX_BRIDGE_URL || 'http://127.0.0.1:11440').replace(/\/$/, '');
const candidateServices = [
  { port: 11445, expectedRole: 'vision_or_gemma', paths: ['/health', '/', '/transcribe', '/inference', '/v1/audio/transcriptions'] },
  { port: 11447, expectedRole: 'whisper_cpp', paths: ['/health', '/', '/transcribe', '/inference', '/v1/audio/transcriptions'] },
];
const outDir = '/Users/master/.tarx/runs/voice-native-stt';
fs.mkdirSync(outDir, { recursive: true });
const requiredSpokenPhrase = 'TARS, what are we working on today?';
const writtenDisplayPhrase = 'TARX, what are we working on today?';
const calibrationEvidencePath = '/Users/master/.tarx/runs/voice-live-calibration/latest.json';
const micProfilePath = '/Users/master/.tarx/runs/voice-live-calibration/prime-mic-profile.json';

function safeExecFile(command, args, timeout = 5000) {
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

function readWavAudioStats(file) {
  if (!file || !fs.existsSync(file)) return { validWav: false, fileSize: 0, nonSilent: false };
  const buffer = fs.readFileSync(file);
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
  let zeroCount = 0;
  let count = 0;
  if (dataOffset >= 0 && bitsPerSample === 16) {
    const end = Math.min(buffer.length, dataOffset + dataSize);
    for (let i = dataOffset; i + 1 < end; i += 2) {
      const sample = buffer.readInt16LE(i);
      const normalized = sample / 32768;
      sumSq += normalized * normalized;
      peak = Math.max(peak, Math.abs(normalized));
      if (sample === 0) zeroCount += 1;
      count += 1;
    }
  }
  const rms = count ? Math.sqrt(sumSq / count) : 0;
  const duration = sampleRate && channelCount && count ? count / sampleRate / channelCount : 0;
  return {
    validWav: true,
    duration,
    duration_ms: Math.round(duration * 1000),
    fileSize: buffer.length,
    rms,
    peakAmplitude: peak,
    sampleRate,
    channelCount,
    bitsPerSample,
    zeroRatio: count ? zeroCount / count : 1,
    nonSilent: rms > 0.0005 && peak > 0.003,
  };
}

function nativeDeviceInventory() {
  const ffmpeg = process.env.TARX_VOICE_NATIVE_CAPTURE_BIN || '/opt/homebrew/bin/ffmpeg';
  const av = safeExecFile(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
  const avRaw = (av.stdout || '') + (av.stderr || '');
  const system = safeExecFile('/usr/sbin/system_profiler', ['SPAudioDataType'], 6000);
  const avFoundationInputs = parseAvFoundationAudioDevices(avRaw);
  const systemInputs = parseSystemAudio(system.stdout || system.stderr || '');
  const defaultInput = systemInputs.find((device) => device.defaultInput) || null;
  const requestedDevice = String(process.env.TARX_VOICE_NATIVE_CAPTURE_DEVICE || '').trim();
  const selected = requestedDevice
    ? avFoundationInputs.find((device) => device.name === requestedDevice)
      || avFoundationInputs.find((device) => device.selector === requestedDevice)
      || avFoundationInputs.find((device) => String(device.index) === requestedDevice.replace(/^:/, ''))
      || null
    : (defaultInput ? avFoundationInputs.find((device) => device.name.toLowerCase() === defaultInput.name.toLowerCase()) : null) || avFoundationInputs[0] || null;
  return {
    ffmpeg,
    avRaw: avRaw.slice(0, 3000),
    systemInputs,
    avFoundationInputs,
    defaultInput,
    requestedDevice: requestedDevice || null,
    requestedDeviceFound: requestedDevice ? Boolean(selected) : null,
    selected,
  };
}

function captureFreshNativeWav() {
  const inventory = nativeDeviceInventory();
  if (inventory.requestedDevice && !inventory.selected) return { ok: false, firstBlocker: 'requested_avfoundation_input_not_found', inventory };
  if (!inventory.selected) return { ok: false, firstBlocker: 'no_avfoundation_input_device', inventory };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(captureDir, `native-tars-fresh-${stamp}.wav`);
  const seconds = Number(process.env.TARX_NATIVE_CAPTURE_SECONDS || 7);
  const capture = spawnSync(inventory.ffmpeg, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'avfoundation',
    '-t', String(seconds),
    '-i', inventory.selected.selector,
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    file,
  ], { encoding: 'utf8', timeout: (seconds + 5) * 1000 });
  const audioStats = readWavAudioStats(file);
  return {
    ok: capture.status === 0 && audioStats.validWav,
    firstBlocker: capture.status === 0 ? null : 'native_capture_command_failed',
    wavPath: file,
    audioStats,
    inventory,
    captureExit: { status: capture.status, signal: capture.signal, error: capture.error?.message || null, stderr: String(capture.stderr || '').slice(0, 1200) },
  };
}

function transcriptOf(payload, fallbackText = '') {
  if (payload && typeof payload === 'object') {
    if (typeof payload.text === 'string') return payload.text.trim();
    if (typeof payload.transcript === 'string') return payload.transcript.trim();
    if (typeof payload.result?.text === 'string') return payload.result.text.trim();
    if (Array.isArray(payload.segments)) return payload.segments.map((segment) => segment.text).join(' ').trim();
  }
  return String(
    fallbackText ||
    ''
  ).trim();
}

async function probeJsonOrText(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: response.ok, status: response.status, text: text.slice(0, 500), json };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}

async function discoverRoutes() {
  const discovered = [];
  for (const service of candidateServices) {
    const probes = [];
    for (const route of service.paths) {
      probes.push({ route, ...(await probeJsonOrText(`http://127.0.0.1:${service.port}${route}`)) });
    }
    const root = probes.find((probe) => probe.route === '/');
    const health = probes.find((probe) => probe.route === '/health');
    const transcribe = probes.find((probe) => probe.route === '/transcribe');
    const healthText = `${JSON.stringify(health?.json || {})} ${health?.text || ''}`;
    const transcribeText = `${JSON.stringify(transcribe?.json || {})} ${transcribe?.text || ''}`;
    const tarxJsonRouteAdvertised = /tarx-local-whisper|audio_base64_required|POST \/transcribe with JSON audio base64/i.test(`${healthText} ${transcribeText}`);
    const tarxJsonRouteNeedsPayload = [400, 405, 415, 422].includes(Number(transcribe?.status))
      && /audio|base64|json|method|payload|required/i.test(transcribeText);
    const role = tarxJsonRouteAdvertised || tarxJsonRouteNeedsPayload
      ? 'tarx_local_whisper_json'
      : /Whisper\.cpp Server|multipart\/form-data|Choose an audio file/i.test(root?.text || '')
      ? 'whisper_cpp'
      : /llama|OpenAI-compatible|static build of the frontend/i.test(root?.text || '')
        ? 'vision_or_gemma'
        : service.expectedRole;
    const transcriptionRoute = role === 'tarx_local_whisper_json'
      ? '/transcribe'
      : role === 'whisper_cpp' && probes.find((probe) => probe.route === '/inference')?.status === 404
        ? '/inference'
        : null;
    discovered.push({
      port: service.port,
      role,
      health,
      transcriptionRoute,
      probes,
    });
  }
  return discovered;
}

async function transcribeWithWhisper(wavBuffer, endpoint) {
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), path.basename(wavPath));
  form.append('temperature', '0.0');
  form.append('response_format', 'json');
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(Number(process.env.TARX_WHISPER_TIMEOUT || 30000)),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const transcript = transcriptOf(json, text);
  return {
    ok: response.ok && Boolean(transcript),
    status: response.status,
    ms: Date.now() - started,
    transcript,
    transcriptPreview: transcript.slice(0, 160),
    blankAudio: /^\[BLANK_AUDIO\]$/i.test(transcript),
    raw: json || text.slice(0, 500),
  };
}

async function transcribeWithTarxLocalWhisper(wavBuffer, endpoint) {
  const started = Date.now();
  const audioBase64 = wavBuffer.toString('base64');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      audio: audioBase64,
      audio_base64: audioBase64,
      mimeType: 'audio/wav',
      mime_type: 'audio/wav',
      language: 'en',
      initial_prompt: 'TARX is pronounced TARS. The phrase is: TARS, what are we working on today?',
    }),
    signal: AbortSignal.timeout(Number(process.env.TARX_WHISPER_TIMEOUT || 30000)),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const transcript = transcriptOf(json, text);
  return {
    ok: response.ok && Boolean(transcript),
    status: response.status,
    ms: Date.now() - started,
    transcript,
    transcriptPreview: transcript.slice(0, 160),
    blankAudio: /^\[BLANK_AUDIO\]$/i.test(transcript),
    raw: json || text.slice(0, 500),
  };
}

function meaningfulTranscript(text) {
  const normalized = String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /\b(tars|tarx)\b/.test(normalized) && /what.*working.*today|working.*on.*today/.test(normalized);
}

function displayTranscript(text) {
  return String(text || '').replace(/\bTARS\b/gi, 'TARX');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function calibrationContext() {
  const calibration = readJson(calibrationEvidencePath);
  const profile = readJson(micProfilePath);
  return {
    evidencePath: calibrationEvidencePath,
    micProfilePath,
    calibrationStatus: calibration?.status || null,
    calibrationGreen: calibration?.status === 'voice_live_calibration_green' && calibration?.ok === true,
    passRate: calibration?.summary?.passRate ?? profile?.passRate ?? null,
    selectedDevice: profile?.selectedDevice || calibration?.selectedMic || null,
    lastGreenAttemptPath: profile?.lastGreenAttemptPath || null,
  };
}

function wavPlaybackEvidence(file, selectedDevice = null, transcript = '', semanticSpeechGreen = false) {
  return {
    wavPath: file || null,
    command: file ? `/usr/bin/afplay ${JSON.stringify(file)}` : null,
    selectedMic: selectedDevice,
    transcript,
    semanticSpeechGreen,
  };
}

function humanListenClassification(file, selectedDevice = null, transcript = '', semanticSpeechGreen = false, audioStats = null) {
  const humanListenRequired = !semanticSpeechGreen;
  return {
    human_listen_required: humanListenRequired,
    wavPath: file || null,
    afplayCommand: file ? `/usr/bin/afplay ${JSON.stringify(file)}` : null,
    selectedMic: selectedDevice,
    transcript,
    human_heard_phrase: null,
    human_heard_background_audio: null,
    human_heard_required_phrase: null,
    decisionOptions: {
      whisper_semantic_failure: 'Use when the WAV clearly contains the required TARS phrase but Whisper does not return it.',
      input_source_wrong_or_environment_audio: 'Use when the WAV contains TV, speakers, room voices, or unrelated speech instead of the required phrase.',
      mic_quality_issue: 'Use when the WAV is silent, distorted, noisy, clipped, or too low quality to judge.',
    },
    next_decision: semanticSpeechGreen
      ? 'native_voice_stt_green'
      : audioStats?.nonSilent === false
        ? 'mic_quality_issue'
        : 'human_listen_required',
  };
}

async function postBridge(pathname, body) {
  try {
    const response = await fetch(`${bridgeUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: response.ok, status: response.status, json, text: text.slice(0, 500) };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}

function validateSttResult(sttResult, captureEvent) {
  const errors = [];
  if (sttResult.schema !== 'tarx-stt-result.v1') errors.push('schema_mismatch');
  if (sttResult.capture_id !== captureEvent.capture_id) errors.push('capture_id_not_correlated');
  if (sttResult.session_id !== captureEvent.session_id) errors.push('session_id_not_correlated');
  if (sttResult.local_only !== true) errors.push('stt_not_local_only');
  if (!sttResult.text) errors.push('text_required');
  if (sttResult.evidence?.raw_audio_logged !== false) errors.push('raw_audio_logging_must_be_false');
  if (sttResult.route?.supercomputer_used !== false) errors.push('supercomputer_must_remain_false');
  return { ok: errors.length === 0, errors };
}

async function main() {
  const started = Date.now();
  const routes = await discoverRoutes();
  const whisper = routes.find((service) => service.role === 'tarx_local_whisper_json' && service.port === 11445)
    || routes.find((service) => service.role === 'whisper_cpp' && service.port === 11447)
    || routes.find((service) => service.role === 'tarx_local_whisper_json' || service.role === 'whisper_cpp');
  const endpoint = whisper && whisper.transcriptionRoute ? `http://127.0.0.1:${whisper.port}${whisper.transcriptionRoute}` : null;

  const freshCapture = !wavPath && process.env.TARX_VOICE_NATIVE_CAPTURE === '1'
    ? captureFreshNativeWav()
    : null;
  if (freshCapture?.wavPath) wavPath = freshCapture.wavPath;
  if (freshCapture && !freshCapture.ok && !freshCapture.wavPath) {
    const result = {
      ts: new Date().toISOString(),
      status: 'native_voice_stt_red',
      ok: false,
      routeGreen: false,
      semanticSpeechGreen: false,
      classification: 'environment_red',
      firstBlocker: freshCapture.firstBlocker || 'native_capture_failed',
      requiredSpokenPhrase,
      writtenDisplayPhrase,
      freshCapture,
      privacy: {
        supercomputerUsed: false,
        browserFallbackUsed: false,
        rawAudioLogged: false,
      },
    };
    fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  if (!wavPath) {
    throw new Error('missing_native_wav_set_TARX_VOICE_NATIVE_CAPTURE_or_TARX_NATIVE_CAPTURE_WAV');
  }
  if (!fs.existsSync(wavPath)) {
    throw new Error(`missing_native_wav:${wavPath}`);
  }

  const wav = fs.readFileSync(wavPath);
  const audioStats = freshCapture?.audioStats || readWavAudioStats(wavPath);
  const selectedDevice = freshCapture?.inventory?.selected || nativeDeviceInventory().selected || null;
  const captureStartedAt = new Date(Date.now() - Math.max(0, audioStats.duration_ms || 0)).toISOString();
  if (!audioStats.nonSilent) {
    const result = {
      ts: new Date().toISOString(),
      status: 'native_voice_stt_red',
      ok: false,
      routeGreen: false,
      semanticSpeechGreen: false,
      classification: 'environment_red',
      firstBlocker: audioStats.validWav ? 'capture_silent' : 'wav_format_invalid',
      requiredSpokenPhrase,
      writtenDisplayPhrase,
      wavPath,
      playback: wavPlaybackEvidence(wavPath, selectedDevice, '', false),
      humanListen: humanListenClassification(wavPath, selectedDevice, '', false, audioStats),
      audioStats,
      actualWhisperRoutesDiscovered: routes.map((service) => ({
        port: service.port,
        role: service.role,
        healthStatus: service.health?.status,
        transcriptionRoute: service.transcriptionRoute,
      })),
      selectedEndpoint: endpoint,
      freshCapture,
      privacy: {
        supercomputerUsed: false,
        browserFallbackUsed: false,
        rawAudioLogged: false,
      },
    };
    fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  const captureEvent = {
    schema: 'tarx-voice-capture-event.v1',
    session_id: process.env.TARX_RUNTIME_SESSION_ID || 'rt_electron_local',
    capture_id: `vc_native_stt_${Date.now()}`,
    source: 'electron_native',
    sample_rate: 16000,
    duration_ms: audioStats.duration_ms || 0,
    vad: {
      started_at: captureStartedAt,
      ended_at: new Date().toISOString(),
      confidence: 0.8,
    },
    privacy: {
      local_only: true,
      supercomputer_used: false,
    },
    evidence: {
      audio_ref: wavPath,
      audio_bytes: wav.length,
      raw_audio_logged: false,
      audio_stats: audioStats,
      selected_device: selectedDevice,
    },
  };
  const bridgeCapture = await postBridge('/v1/runtime/voice/capture-events', captureEvent);

  const stt = endpoint && whisper?.role === 'tarx_local_whisper_json'
    ? await transcribeWithTarxLocalWhisper(wav, endpoint)
    : endpoint
      ? await transcribeWithWhisper(wav, endpoint)
    : { ok: false, status: 0, transcript: '', transcriptPreview: '', blankAudio: false, raw: null, firstBlocker: 'local_whisper_route_not_found' };

  const sttResult = {
    schema: 'tarx-stt-result.v1',
    session_id: captureEvent.session_id,
    capture_id: captureEvent.capture_id,
    transcript_id: `stt_native_${Date.now()}`,
    model: 'whisper-base.en-int8',
    text: stt.transcript,
    confidence: stt.ok && !stt.blankAudio ? 0.8 : 0,
    latency_ms: stt.ms || 0,
    local_only: true,
    route: {
      local_only: true,
      supercomputer_used: false,
    },
    evidence: {
      audio_ref: wavPath,
      audio_bytes: wav.length,
      raw_audio_logged: false,
      endpoint,
      route_role: whisper?.role || null,
    },
  };
  const validation = validateSttResult(sttResult, captureEvent);
  const bridgeStt = validation.ok ? await postBridge('/v1/runtime/stt-results', sttResult) : null;
  const transcriptMeaningful = meaningfulTranscript(stt.transcript);
  const calibration = calibrationContext();
  const semanticSpeechGreen = validation.ok && stt.ok && !stt.blankAudio && transcriptMeaningful;
  const routeGreen = validation.ok && stt.ok;
  const playback = wavPlaybackEvidence(
    wavPath,
    selectedDevice,
    stt.transcript,
    semanticSpeechGreen
  );
  const humanListen = humanListenClassification(
    wavPath,
    selectedDevice,
    stt.transcript,
    semanticSpeechGreen,
    audioStats
  );

  const result = {
    ts: new Date().toISOString(),
    status: semanticSpeechGreen ? 'native_voice_stt_green' : (routeGreen ? 'native_voice_stt_route_green_semantic_speech_red' : 'native_voice_stt_red'),
    ok: semanticSpeechGreen,
    routeGreen,
    semanticSpeechGreen,
    classification: semanticSpeechGreen ? 'green' : (routeGreen ? 'harness_red' : 'environment_red'),
    firstBlocker: semanticSpeechGreen ? null : (routeGreen ? (stt.blankAudio ? 'whisper_blank_audio' : 'transcript_wrong') : 'native_wav_to_whisper_failed'),
    requiredSpokenPhrase,
    writtenDisplayPhrase,
    rawTranscript: stt.transcript,
    normalizedDisplayTranscript: displayTranscript(stt.transcript),
    audioStats,
    wavPath,
    playback,
    humanListen,
    durationMs: Date.now() - started,
    actualWhisperRoutesDiscovered: routes.map((service) => ({
      port: service.port,
      role: service.role,
      healthStatus: service.health?.status,
      transcriptionRoute: service.transcriptionRoute,
    })),
    selectedEndpoint: endpoint,
    calibration,
    captureEvent,
    freshCapture,
    sttResult,
    validation,
    stt,
    bridge: {
      capture: bridgeCapture,
      stt: bridgeStt,
      installedRuntimeAcceptedContracts: Boolean(bridgeCapture.ok && bridgeStt?.ok),
    },
    privacy: {
      supercomputerUsed: false,
      rawAudioLogged: false,
      telemetryDefaultIncludesRawAudio: false,
    },
  };

  fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(routeGreen ? 0 : 1);
}

main().catch((error) => {
  const result = {
    ts: new Date().toISOString(),
    status: 'native_voice_stt_red',
    ok: false,
    routeGreen: false,
    semanticSpeechGreen: false,
    classification: 'environment_red',
    firstBlocker: error.message,
  };
  fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
});
