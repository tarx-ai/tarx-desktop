#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const wavPath = process.env.TARX_NATIVE_CAPTURE_WAV || '/Users/master/.tarx/runs/voice-native-capture-proof/native-proof.wav';
const configuredWhisperUrl = (process.env.TARX_WHISPER_URL || '').replace(/\/$/, '');
const outDir = path.join(root, 'dist-voice-beta-proof');
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

async function discoverSttRoute() {
  const bases = configuredWhisperUrl
    ? [configuredWhisperUrl]
    : ['http://127.0.0.1:11445', 'http://127.0.0.1:11447'];
  const probes = [];
  for (const base of bases) {
    const health = await probeJsonOrText(`${base}/health`);
    const rootProbe = await probeJsonOrText(`${base}/`);
    const transcribe = await probeJsonOrText(`${base}/transcribe`);
    const healthText = `${JSON.stringify(health.json || {})} ${health.text || ''}`;
    const transcribeText = `${JSON.stringify(transcribe.json || {})} ${transcribe.text || ''}`;
    const tarxJsonRouteAdvertised = /tarx-local-whisper|audio_base64_required|POST \/transcribe with JSON audio base64/i.test(`${healthText} ${transcribeText}`);
    const tarxJsonRouteNeedsPayload = [400, 405, 415, 422].includes(Number(transcribe.status))
      && /audio|base64|json|method|payload|required/i.test(transcribeText);
    const rootText = rootProbe.text || '';
    const whisperCpp = /Whisper\.cpp Server|multipart\/form-data|Choose an audio file/i.test(rootText);
    const fullUrlPath = (() => {
      try { return new URL(base).pathname; } catch { return ''; }
    })();
    const explicitTranscribe = configuredWhisperUrl && /\/transcribe\/?$/.test(fullUrlPath);
    const explicitInference = configuredWhisperUrl && /\/inference\/?$/.test(fullUrlPath);
    const normalizedBase = explicitTranscribe || explicitInference ? base.replace(/\/(transcribe|inference)\/?$/, '') : base;
    const discovered = {
      base,
      healthStatus: health.status,
      transcribeStatus: transcribe.status,
      rootStatus: rootProbe.status,
      role: null,
      endpoint: null,
    };
    if (tarxJsonRouteAdvertised || tarxJsonRouteNeedsPayload || explicitTranscribe) {
      discovered.role = 'tarx_local_whisper_json';
      discovered.endpoint = `${normalizedBase}/transcribe`;
    } else if (whisperCpp || explicitInference) {
      discovered.role = 'whisper_cpp';
      discovered.endpoint = `${normalizedBase}/inference`;
    }
    probes.push(discovered);
    if (discovered.endpoint) return { selected: discovered, probes };
  }
  return { selected: null, probes };
}

async function transcribeMultipart(audio, endpoint) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), path.basename(wavPath));
  form.append('temperature', '0.0');
  form.append('response_format', 'json');
  return fetch(endpoint, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(Number(process.env.TARX_WHISPER_TIMEOUT || 30000)),
  });
}

async function transcribeJsonBase64(audio, endpoint) {
  const audioBase64 = audio.toString('base64');
  return fetch(endpoint, {
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
}

async function main() {
  const started = Date.now();
  if (!fs.existsSync(wavPath)) {
    throw new Error(`missing_wav:${wavPath}`);
  }
  const audio = fs.readFileSync(wavPath);
  const route = await discoverSttRoute();
  if (!route.selected?.endpoint) {
    throw new Error('native_capture_stt_route_not_found');
  }
  const response = route.selected.role === 'tarx_local_whisper_json'
    ? await transcribeJsonBase64(audio, route.selected.endpoint)
    : await transcribeMultipart(audio, route.selected.endpoint);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const transcript = transcriptOf(json, text);
  const result = {
    ts: new Date().toISOString(),
    ok: response.ok && Boolean(transcript),
    status: response.status,
    ms: Date.now() - started,
    endpoint: route.selected.endpoint,
    routeRole: route.selected.role,
    routeProbes: route.probes,
    audioBytes: audio.length,
    transcriptChars: transcript.length,
    transcriptPreview: transcript.slice(0, 160),
    blankAudio: /^\[BLANK_AUDIO\]$/i.test(transcript),
    routeGreen: response.ok && Boolean(transcript),
    semanticSpeechGreen: response.ok && Boolean(transcript) && !/^\[BLANK_AUDIO\]$/i.test(transcript),
    classification: response.ok && Boolean(transcript)
      ? (/^\[BLANK_AUDIO\]$/i.test(transcript) ? 'harness_red' : 'green')
      : 'environment_red',
    firstBlocker: response.ok && Boolean(transcript)
      ? (/^\[BLANK_AUDIO\]$/i.test(transcript) ? 'native_capture_contains_no_spoken_phrase' : null)
      : 'native_capture_stt_route_failed',
    raw: json || text.slice(0, 500),
  };
  fs.writeFileSync(path.join(outDir, 'latest-native-capture-stt-route.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.routeGreen ? 0 : 1);
}

main().catch((error) => {
  const result = {
    ts: new Date().toISOString(),
    ok: false,
    classification: 'environment_red',
    firstBlocker: error.message,
  };
  fs.writeFileSync(path.join(outDir, 'latest-native-capture-stt-route.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
});
