#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const outDir = '/Users/master/.tarx/runs/voice-acoustic-loop';
fs.mkdirSync(outDir, { recursive: true });

const phrase = process.env.TARX_ACOUSTIC_LOOP_PHRASE || 'TARS, what are we working on today?';
const displayPhrase = 'TARX, what are we working on today?';
const ttsEndpoint = process.env.TARX_TTS_URL || 'http://127.0.0.1:11446/v1/tts';
const bridgeUrl = (process.env.TARX_BRIDGE_URL || 'http://127.0.0.1:11440').replace(/\/$/, '');
const captureSeconds = Number(process.env.TARX_ACOUSTIC_LOOP_CAPTURE_SECONDS || 8);
const ffmpeg = process.env.TARX_VOICE_NATIVE_CAPTURE_BIN || '/opt/homebrew/bin/ffmpeg';
const requestedDevice = String(process.env.TARX_VOICE_NATIVE_CAPTURE_DEVICE || '').trim();

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

function inputInventory() {
  const av = safeExec(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
  const system = safeExec('/usr/sbin/system_profiler', ['SPAudioDataType']);
  const avRaw = (av.stdout || '') + (av.stderr || '');
  const avFoundationInputs = parseAvFoundationAudioDevices(avRaw);
  const systemInputs = parseSystemAudio(system.stdout || system.stderr || '');
  const defaultInput = systemInputs.find((device) => device.defaultInput) || null;
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

function requestWav(url, body, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const chunks = [];
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          buffer,
          text: /^text|json|html/i.test(String(res.headers['content-type'] || '')) ? buffer.toString('utf8').slice(0, 500) : '',
        });
      });
    });
    req.on('error', (error) => resolve({ ok: false, status: 0, error: error.message, buffer: Buffer.alloc(0) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: 'timeout', buffer: Buffer.alloc(0) });
    });
    req.write(payload);
    req.end();
  });
}

function wavStats(file) {
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

function transcriptOf(payload, fallbackText = '') {
  if (payload && typeof payload === 'object') {
    if (typeof payload.text === 'string') return payload.text.trim();
    if (typeof payload.transcript === 'string') return payload.transcript.trim();
    if (typeof payload.result?.text === 'string') return payload.result.text.trim();
    if (Array.isArray(payload.segments)) return payload.segments.map((segment) => segment.text).join(' ').trim();
  }
  return String(fallbackText || '').trim();
}

async function transcribeWithWhisper(wavPath) {
  const wav = fs.readFileSync(wavPath);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), path.basename(wavPath));
  form.append('temperature', '0.0');
  form.append('response_format', 'json');
  const started = Date.now();
  const response = await fetch('http://127.0.0.1:11447/inference', {
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
    raw: json || text.slice(0, 500),
  };
}

function meaningfulTranscript(text) {
  const normalized = String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /\b(tars|tarx|taurus)\b/.test(normalized) && /what.*working.*today|working.*on.*today/.test(normalized);
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

function writeLatest(result) {
  fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

(async () => {
  const ts = new Date().toISOString();
  const stamp = ts.replace(/[:.]/g, '-');
  const inventory = inputInventory();
  const ttsPath = path.join(outDir, `tts-required-${stamp}.wav`);
  const capturePath = path.join(outDir, `mic-capture-${stamp}.wav`);

  if (requestedDevice && !inventory.selected) {
    const result = {
      schema: 'tarx-voice-acoustic-loop-proof.v1',
      ts,
      ok: false,
      status: 'voice_acoustic_loop_red',
      firstBlocker: 'requested_avfoundation_input_not_found',
      inventory,
      guardrails: { browserFallbackUsed: false, supercomputerUsed: false, productionVoiceReady: false },
    };
    writeLatest(result);
    process.exit(1);
  }
  if (!inventory.selected) {
    const result = {
      schema: 'tarx-voice-acoustic-loop-proof.v1',
      ts,
      ok: false,
      status: 'voice_acoustic_loop_red',
      firstBlocker: 'no_avfoundation_input_device',
      inventory,
      guardrails: { browserFallbackUsed: false, supercomputerUsed: false, productionVoiceReady: false },
    };
    writeLatest(result);
    process.exit(1);
  }

  const tts = await requestWav(ttsEndpoint, { text: phrase, voice: process.env.TARX_TTS_VOICE || 'am_adam', speed: 0.92, lang: 'en-us' });
  if (tts.ok && tts.buffer?.length) fs.writeFileSync(ttsPath, tts.buffer);
  const ttsStats = wavStats(ttsPath);

  const capture = spawn(ffmpeg, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'avfoundation',
    '-t', String(captureSeconds),
    '-i', inventory.selected.selector,
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    capturePath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  await new Promise((resolve) => setTimeout(resolve, 650));
  const playback = ttsStats.validWav
    ? spawnSync('/usr/bin/afplay', [ttsPath], { timeout: 20000, encoding: 'utf8' })
    : { status: null, signal: null, error: new Error('tts_wav_invalid'), stderr: '' };

  const captureExit = await new Promise((resolve) => {
    let stderr = '';
    capture.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    capture.on('close', (status, signal) => resolve({ status, signal, stderr: stderr.slice(0, 1200) }));
    capture.on('error', (error) => resolve({ status: null, signal: null, error: error.message, stderr: stderr.slice(0, 1200) }));
  });

  const captureStats = wavStats(capturePath);
  const stt = captureStats.validWav && captureStats.nonSilent
    ? await transcribeWithWhisper(capturePath)
    : { ok: false, status: 0, ms: 0, transcript: '', transcriptPreview: '', raw: null };
  const semanticSpeechGreen = stt.ok && meaningfulTranscript(stt.transcript);

  const captureEvent = {
    schema: 'tarx-voice-capture-event.v1',
    session_id: 'rt_electron_acoustic_loop',
    capture_id: `vc_acoustic_loop_${Date.now()}`,
    source: 'electron_native',
    sample_rate: 16000,
    duration_ms: captureStats.duration_ms || 0,
    vad: {
      started_at: new Date(Date.now() - Math.max(0, captureStats.duration_ms || 0)).toISOString(),
      ended_at: new Date().toISOString(),
      confidence: captureStats.nonSilent ? 0.8 : 0,
    },
    privacy: { local_only: true, supercomputer_used: false },
    evidence: {
      audio_ref: capturePath,
      audio_bytes: captureStats.fileSize || 0,
      raw_audio_logged: false,
      audio_stats: captureStats,
      selected_device: inventory.selected,
      synthetic_prompt_audio_ref: ttsPath,
    },
  };
  const bridgeCapture = await postBridge('/v1/runtime/voice/capture-events', captureEvent);
  const sttResult = {
    schema: 'tarx-stt-result.v1',
    session_id: captureEvent.session_id,
    capture_id: captureEvent.capture_id,
    transcript_id: `stt_acoustic_loop_${Date.now()}`,
    model: 'whisper-base.en-int8',
    text: stt.transcript,
    confidence: stt.ok ? 0.8 : 0,
    latency_ms: stt.ms || 0,
    local_only: true,
    route: { local_only: true, supercomputer_used: false },
    evidence: {
      audio_ref: capturePath,
      audio_bytes: captureStats.fileSize || 0,
      raw_audio_logged: false,
      endpoint: 'http://127.0.0.1:11447/inference',
      route_role: 'whisper_cpp',
    },
  };
  const bridgeStt = stt.transcript ? await postBridge('/v1/runtime/stt-results', sttResult) : null;
  const bridgeAccepted = Boolean(bridgeCapture.ok && bridgeStt?.ok);
  const ok = semanticSpeechGreen && bridgeAccepted;
  const result = {
    schema: 'tarx-voice-acoustic-loop-proof.v1',
    ts,
    ok,
    status: ok ? 'voice_acoustic_loop_green' : 'voice_acoustic_loop_red',
    firstBlocker: ok ? null
      : !tts.ok ? 'tts_generation_failed'
        : !ttsStats.validWav ? 'tts_wav_invalid'
          : playback.status !== 0 ? 'tts_playback_failed'
            : !captureStats.validWav ? 'mic_capture_invalid'
              : !captureStats.nonSilent ? 'mic_capture_silent'
                : !stt.ok ? 'mic_capture_to_whisper_failed'
                  : !semanticSpeechGreen ? 'transcript_wrong'
                    : 'bridge_contracts_rejected',
    requiredSpokenPhrase: phrase,
    writtenDisplayPhrase: displayPhrase,
    selectedMic: inventory.selected,
    tts: {
      endpoint: ttsEndpoint,
      ok: tts.ok,
      status: tts.status,
      wavPath: ttsPath,
      audioStats: ttsStats,
      playback: {
        attempted: true,
        ok: playback.status === 0,
        status: playback.status,
        signal: playback.signal,
        error: playback.error?.message || null,
        stderr: String(playback.stderr || ''),
      },
    },
    capture: {
      wavPath: capturePath,
      afplayCommand: `/usr/bin/afplay ${JSON.stringify(capturePath)}`,
      audioStats: captureStats,
      exit: captureExit,
    },
    stt: {
      ...stt,
      semanticSpeechGreen,
    },
    bridge: {
      capture: bridgeCapture,
      stt: bridgeStt,
      installedRuntimeAcceptedContracts: bridgeAccepted,
    },
    evidence: {
      latest: path.join(outDir, 'latest.json'),
      ttsWav: ttsPath,
      capturedWav: capturePath,
    },
    guardrails: {
      browserFallbackUsed: false,
      supercomputerUsed: false,
      productionVoiceReady: false,
      transcriptMocked: false,
      whisperBypassed: false,
    },
  };
  writeLatest(result);
  process.exit(ok ? 0 : 1);
})();
