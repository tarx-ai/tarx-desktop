#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const wavPath = process.env.TARX_NATIVE_CAPTURE_WAV || '/Users/master/.tarx/runs/voice-native-capture-proof/native-proof.wav';
const bridgeUrl = (process.env.TARX_BRIDGE_URL || 'http://127.0.0.1:11440').replace(/\/$/, '');
const candidateServices = [
  { port: 11445, expectedRole: 'vision_or_gemma', paths: ['/health', '/', '/transcribe', '/inference', '/v1/audio/transcriptions'] },
  { port: 11447, expectedRole: 'whisper_cpp', paths: ['/health', '/', '/transcribe', '/inference', '/v1/audio/transcriptions'] },
];
const outDir = '/Users/master/.tarx/runs/voice-native-stt';
fs.mkdirSync(outDir, { recursive: true });

function transcriptOf(payload, fallbackText = '') {
  return String(
    payload?.text ||
    payload?.transcript ||
    payload?.result?.text ||
    payload?.segments?.map?.((segment) => segment.text).join(' ') ||
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
    const role = /Whisper\.cpp Server|multipart\/form-data|Choose an audio file/i.test(root?.text || '')
      ? 'whisper_cpp'
      : /llama|OpenAI-compatible|static build of the frontend/i.test(root?.text || '')
        ? 'vision_or_gemma'
        : service.expectedRole;
    const transcriptionRoute = role === 'whisper_cpp' && probes.find((probe) => probe.route === '/inference')?.status === 404
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
  const whisper = routes.find((service) => service.role === 'whisper_cpp' && service.port === 11447) || routes.find((service) => service.role === 'whisper_cpp');
  const endpoint = whisper ? `http://127.0.0.1:${whisper.port}/inference` : null;

  if (!fs.existsSync(wavPath)) {
    throw new Error(`missing_native_wav:${wavPath}`);
  }

  const wav = fs.readFileSync(wavPath);
  const captureEvent = {
    schema: 'tarx-voice-capture-event.v1',
    session_id: process.env.TARX_RUNTIME_SESSION_ID || 'rt_electron_local',
    capture_id: `vc_native_stt_${Date.now()}`,
    source: 'electron_native',
    sample_rate: 16000,
    duration_ms: 0,
    vad: {
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      confidence: 0,
    },
    privacy: {
      local_only: true,
      supercomputer_used: false,
    },
    evidence: {
      audio_ref: wavPath,
      audio_bytes: wav.length,
      raw_audio_logged: false,
    },
  };
  const bridgeCapture = await postBridge('/v1/runtime/voice/capture-events', captureEvent);

  const stt = endpoint
    ? await transcribeWithWhisper(wav, endpoint)
    : { ok: false, status: 0, transcript: '', transcriptPreview: '', blankAudio: false, raw: null, firstBlocker: 'whisper_cpp_route_not_found' };

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
    },
  };
  const validation = validateSttResult(sttResult, captureEvent);
  const bridgeStt = validation.ok ? await postBridge('/v1/runtime/stt-results', sttResult) : null;
  const semanticSpeechGreen = validation.ok && stt.ok && !stt.blankAudio;
  const routeGreen = validation.ok && stt.ok;

  const result = {
    ts: new Date().toISOString(),
    status: semanticSpeechGreen ? 'native_voice_stt_green' : (routeGreen ? 'native_voice_stt_route_green_semantic_speech_red' : 'native_voice_stt_red'),
    ok: semanticSpeechGreen,
    routeGreen,
    semanticSpeechGreen,
    classification: semanticSpeechGreen ? 'green' : (routeGreen ? 'harness_red' : 'environment_red'),
    firstBlocker: semanticSpeechGreen ? null : (routeGreen ? 'native_capture_contains_no_spoken_phrase' : 'native_wav_to_whisper_failed'),
    durationMs: Date.now() - started,
    actualWhisperRoutesDiscovered: routes.map((service) => ({
      port: service.port,
      role: service.role,
      healthStatus: service.health?.status,
      transcriptionRoute: service.transcriptionRoute,
    })),
    selectedEndpoint: endpoint,
    captureEvent,
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
