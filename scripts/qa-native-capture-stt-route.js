#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const wavPath = process.env.TARX_NATIVE_CAPTURE_WAV || '/Users/master/.tarx/runs/voice-native-capture-proof/native-proof.wav';
const whisperUrl = (process.env.TARX_WHISPER_URL || 'http://127.0.0.1:11447').replace(/\/$/, '');
const outDir = path.join(root, 'dist-voice-beta-proof');
fs.mkdirSync(outDir, { recursive: true });

function transcriptOf(payload, fallbackText = '') {
  return String(payload?.text || payload?.transcript || payload?.result?.text || fallbackText || '').trim();
}

async function main() {
  const started = Date.now();
  if (!fs.existsSync(wavPath)) {
    throw new Error(`missing_wav:${wavPath}`);
  }
  const audio = fs.readFileSync(wavPath);
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/wav' }), path.basename(wavPath));
  form.append('temperature', '0.0');
  form.append('response_format', 'json');
  const response = await fetch(`${whisperUrl}/inference`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(Number(process.env.TARX_WHISPER_TIMEOUT || 30000)),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const transcript = transcriptOf(json, text);
  const result = {
    ts: new Date().toISOString(),
    ok: response.ok && Boolean(transcript),
    status: response.status,
    ms: Date.now() - started,
    endpoint: `${whisperUrl}/inference`,
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
