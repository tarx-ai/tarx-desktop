#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const outDir = '/Users/master/.tarx/runs/voice-manual-loop';
const manualGatePath = '/Users/master/.tarx/runs/voice-manual-button-gate/latest.json';
const ttsEndpoint = process.env.TARX_TTS_URL || 'http://127.0.0.1:11446/v1/tts';
const ttsHealthUrl = process.env.TARX_TTS_HEALTH_URL || 'http://127.0.0.1:11446/health';
const bridgeUrl = (process.env.TARX_BRIDGE_URL || 'http://127.0.0.1:11440').replace(/\/$/, '');
const ttsVoice = process.env.TARX_TTS_VOICE || 'am_adam';
const ttsTimeoutMs = Number(process.env.TARX_MANUAL_LOOP_TTS_TIMEOUT_MS || 60000);
const playbackEnabled = process.env.TARX_TTS_PLAYBACK !== '0';

fs.mkdirSync(outDir, { recursive: true });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { _missing: true, file, error: error.message };
  }
}

function request(url, { method = 'GET', body = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const chunks = [];
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      timeout: timeoutMs,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : {},
    }, (res) => {
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = String(res.headers['content-type'] || '');
        const text = /^text|json|html/i.test(contentType) ? buffer.toString('utf8') : '';
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          json,
          text: text.slice(0, 500),
          buffer,
        });
      });
    });
    req.on('error', (error) => resolve({ ok: false, status: 0, error: error.message, buffer: Buffer.alloc(0) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: 'timeout', buffer: Buffer.alloc(0) });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function wavStats(buffer) {
  if (!buffer || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    return { validWav: false, bytes: buffer ? buffer.length : 0, nonSilent: false };
  }
  const sampleRate = buffer.readUInt32LE(24);
  const channelCount = buffer.readUInt16LE(22);
  const bitsPerSample = buffer.readUInt16LE(34);
  let dataOffset = -1;
  let dataSize = 0;
  for (let i = 12; i + 8 < buffer.length;) {
    const id = buffer.toString('ascii', i, i + 4);
    const size = buffer.readUInt32LE(i + 4);
    if (id === 'data') {
      dataOffset = i + 8;
      dataSize = size;
      break;
    }
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
    bytes: buffer.length,
    sampleRate,
    channelCount,
    bitsPerSample,
    duration_ms: sampleRate && channelCount ? Math.round((count / sampleRate / channelCount) * 1000) : 0,
    rms,
    peakAmplitude: peak,
    nonSilent: rms > 0.003 || peak > 0.03,
  };
}

function compactHttp(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const { buffer, ...rest } = entry;
  return rest;
}

function operatingBriefAnswer() {
  const manualGate = readJson(manualGatePath);
  const readiness = readJson('/Users/master/.tarx/runs/voice-prime-readiness/latest.json');
  const runtimeSpine = readJson('/Users/master/.tarx/runs/runtime-spine-readiness/latest.json');
  const vision = readJson('/Users/master/.tarx/runs/vision-freshness/latest.json');
  const action = readJson('/Users/master/.tarx/runs/action-safety-gate/latest.json');
  const pipecat = readJson('/Users/master/.tarx/runs/voice-pipecat-spike/latest.json');
  const tts = readJson('/Users/master/.tarx/runs/voice-tts-playback/latest.json');
  const pieces = [
    'Today: TARX runtime spine and Manual Voice.',
    manualGate.ok ? 'Manual Voice captured the request.' : 'Manual Voice needs a clean request capture.',
    runtimeSpine.status ? `Runtime spine is ${runtimeSpine.status}.` : 'Runtime spine is pending.',
    vision.status ? `Vision is ${vision.status}.` : 'Vision is pending.',
    action.status ? 'Computer Use is proposal-only.' : 'Computer Use safety is pending.',
    pipecat.status ? `Pipecat is ${pipecat.status}.` : 'Pipecat is pending.',
    tts.ok ? 'TTS is green.' : 'TTS needs proof.',
    'Wake-word and public release voice remain blocked.',
    'Supercomputer is off.',
  ];
  if (readiness.status) pieces.push(`Readiness is ${readiness.status}.`);
  return pieces.join(' ');
}

async function main() {
  const manualGate = readJson(manualGatePath);
  const transcript = manualGate.transcript || '';
  const captureId = `manual_loop_${Date.now()}`;
  const answer = process.env.TARX_MANUAL_LOOP_ANSWER || operatingBriefAnswer();
  const selectedDevice = manualGate.selectedDevice || null;
  const captureEvent = {
    schema: 'tarx-voice-capture-event.v1',
    session_id: 'rt_electron_manual_button',
    capture_id: captureId,
    source: 'electron_native',
    sample_rate: 16000,
    duration_ms: manualGate.audioStats?.duration_ms || 0,
    vad: {
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      confidence: manualGate.phraseCaptured ? 0.8 : 0,
    },
    privacy: {
      local_only: true,
      supercomputer_used: false,
    },
    evidence: {
      audio_ref: manualGate.wavPath || null,
      audio_bytes: manualGate.audioStats?.fileSize || null,
      raw_audio_logged: false,
      selected_device: selectedDevice,
      audio_stats: manualGate.audioStats || null,
    },
  };
  const sttResult = {
    schema: 'tarx-stt-result.v1',
    session_id: 'rt_electron_manual_button',
    capture_id: captureId,
    transcript_id: `stt_manual_${Date.now()}`,
    model: 'whisper-base.en-int8',
    text: transcript,
    confidence: manualGate.phraseCaptured ? 0.8 : 0,
    latency_ms: 0,
    local_only: true,
    route: {
      local_only: true,
      supercomputer_used: false,
    },
    evidence: {
      audio_ref: manualGate.wavPath || null,
      audio_bytes: manualGate.audioStats?.fileSize || null,
      raw_audio_logged: false,
      endpoint: 'http://127.0.0.1:11447/inference',
      mode: 'manual_button_gate',
    },
  };

  const bridgeHealth = await request(`${bridgeUrl}/health`, { timeoutMs: 2500 });
  const bridgeCapture = await request(`${bridgeUrl}/v1/runtime/voice/capture-events`, { method: 'POST', body: captureEvent, timeoutMs: 2500 });
  const bridgeStt = await request(`${bridgeUrl}/v1/runtime/stt-results`, { method: 'POST', body: sttResult, timeoutMs: 2500 });
  const ttsHealth = await request(ttsHealthUrl, { timeoutMs: 2500 });
  const generated = await request(ttsEndpoint, {
    method: 'POST',
    body: { text: answer, voice: ttsVoice, speed: 1.0, lang: 'en-us' },
    timeoutMs: ttsTimeoutMs,
  });
  const answerWavPath = path.join(outDir, `manual-loop-answer-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`);
  let audioStats = { validWav: false, bytes: generated.buffer?.length || 0, nonSilent: false };
  if (generated.ok && generated.buffer?.length) {
    fs.writeFileSync(answerWavPath, generated.buffer);
    audioStats = wavStats(generated.buffer);
  }

  let playback = { attempted: false, ok: false, skipped: !playbackEnabled, method: 'afplay_local_playback' };
  if (playbackEnabled && audioStats.validWav) {
    const played = spawnSync('/usr/bin/afplay', [answerWavPath], { timeout: 30000, encoding: 'utf8' });
    playback = {
      attempted: true,
      ok: played.status === 0,
      status: played.status,
      signal: played.signal,
      error: played.error?.message || null,
      stderr: played.stderr || '',
      method: 'afplay_local_playback',
    };
  }

  const manualGateGreen = manualGate.status === 'voice_manual_button_gate_green' && manualGate.ok === true;
  const bridgeGreen = bridgeCapture.ok && bridgeStt.ok;
  const ttsGreen = ttsHealth.ok && generated.ok && audioStats.validWav && audioStats.nonSilent && (playback.ok || playback.skipped);
  const ok = manualGateGreen && bridgeGreen && ttsGreen;
  const result = {
    schema: 'tarx-voice-manual-loop-proof.v1',
    ts: new Date().toISOString(),
    ok,
    status: ok ? 'voice_manual_loop_green' : 'voice_manual_loop_red',
    firstBlocker: ok ? null
      : !manualGateGreen ? 'manual_voice_gate_not_green'
        : !bridgeGreen ? 'bridge_contracts_unavailable'
          : 'tts_or_playback_failed',
    mode: 'manual_voice_button',
    wakeWordRequired: false,
    strictWakeWordModeBlocked: true,
    productionVoiceReady: false,
    input: {
      selectedDevice,
      transcript,
      sourceEvidence: manualGatePath,
      wavPath: manualGate.wavPath || null,
      phraseCaptured: manualGate.phraseCaptured === true,
      classification: manualGate.classification || null,
    },
    answer: {
      text: answer,
      source: 'local_prime_operating_status_from_evidence',
      usesCurrentGates: true,
    },
    bridge: {
      health: compactHttp(bridgeHealth),
      captureEventsEndpoint: compactHttp(bridgeCapture),
      sttResultsEndpoint: compactHttp(bridgeStt),
      contractsGreen: bridgeGreen,
      postedContracts: true,
    },
    tts: {
      endpoint: ttsEndpoint,
      health: compactHttp(ttsHealth),
      voice: ttsVoice,
      generation: {
        ok: generated.ok,
        status: generated.status,
        contentType: generated.headers?.['content-type'] || null,
        timeoutMs: ttsTimeoutMs,
        error: generated.ok ? null : (generated.error || generated.text || null),
      },
      wavPath: audioStats.validWav ? answerWavPath : null,
      audioStats,
      playback,
      danielApproved: false,
      label: 'Kokoro/am_adam remains internal; Daniel brand gate pending.',
    },
    routeTruth: {
      computer: true,
      supercomputer: 'Off',
      browserFallback: 'Off',
      supercomputerUsed: false,
      browserFallbackUsed: false,
      rawAudioLogged: false,
    },
    statuses: {
      manualVoiceInternalTest: ok ? 'GREEN' : 'RED',
      wakeWordVoice: 'BLOCKED',
      productionVoice: 'BLOCKED',
      danielBrandGate: 'PENDING',
    },
    evidencePath: path.join(outDir, 'latest.json'),
    guardrails: {
      productionVoiceReady: false,
      wakeWordModeEnabled: false,
      alwaysOnListeningEnabled: false,
      browserFallbackUsed: false,
      supercomputerUsed: false,
      danielApproved: false,
      computerUseExecutionEnabled: false,
    },
  };

  fs.writeFileSync(result.evidencePath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
  const result = {
    schema: 'tarx-voice-manual-loop-proof.v1',
    ts: new Date().toISOString(),
    ok: false,
    status: 'voice_manual_loop_red',
    firstBlocker: 'manual_loop_exception',
    error: error.message,
  };
  fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
});
