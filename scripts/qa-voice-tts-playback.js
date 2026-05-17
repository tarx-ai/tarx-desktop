#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const outDir = '/Users/master/.tarx/runs/voice-tts-playback';
const endpoint = process.env.TARX_TTS_URL || 'http://127.0.0.1:11446/v1/tts';
const healthUrl = process.env.TARX_TTS_HEALTH_URL || 'http://127.0.0.1:11446/health';
const phrase = process.env.TARX_TTS_PROOF_TEXT || 'TARX local voice playback proof is running on Prime.';
const voice = process.env.TARX_TTS_VOICE || 'am_adam';
const playbackEnabled = process.env.TARX_TTS_PLAYBACK !== '0';
fs.mkdirSync(outDir, { recursive: true });

function requestJson(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text: text.slice(0, 500) });
      });
    });
    req.on('error', (error) => resolve({ ok: false, status: 0, error: error.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: 'timeout' });
    });
    req.end();
  });
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

function wavStats(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    return { validWav: false, bytes: buffer.length };
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

(async () => {
  const health = await requestJson(healthUrl);
  const generated = await requestWav(endpoint, { text: phrase, voice, speed: 1.0, lang: 'en-us' });
  const wavPath = path.join(outDir, `tts-prime-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`);
  let stats = { validWav: false, bytes: generated.buffer?.length || 0 };
  if (generated.ok && generated.buffer?.length) {
    fs.writeFileSync(wavPath, generated.buffer);
    stats = wavStats(generated.buffer);
  }

  let playback = { attempted: false, ok: false, skipped: !playbackEnabled };
  if (playbackEnabled && stats.validWav) {
    const played = spawnSync('/usr/bin/afplay', [wavPath], { timeout: 15000, encoding: 'utf8' });
    playback = {
      attempted: true,
      ok: played.status === 0,
      status: played.status,
      signal: played.signal,
      error: played.error?.message || null,
      stderr: played.stderr || '',
    };
  }

  const ok = health.ok && generated.ok && stats.validWav && stats.nonSilent && (playback.ok || playback.skipped);
  const result = {
    schema: 'tarx-voice-tts-playback-proof.v1',
    ts: new Date().toISOString(),
    ok,
    status: ok ? 'voice_tts_playback_green' : 'voice_tts_playback_red',
    firstBlocker: ok ? null
      : !health.ok ? 'tts_service_unavailable'
        : !generated.ok ? 'tts_generation_failed'
          : !stats.validWav ? 'tts_output_not_wav'
            : !stats.nonSilent ? 'tts_output_silent'
              : 'playback_failed',
    endpoint,
    health,
    generation: {
      ok: generated.ok,
      status: generated.status,
      contentType: generated.headers?.['content-type'] || null,
      latencyMs: Number(generated.headers?.['x-tts-latency-ms'] || 0) || null,
      error: generated.error || generated.text || null,
    },
    playback,
    wavPath: stats.validWav ? wavPath : null,
    audioStats: stats,
    phrase,
    voice,
    danielApproved: false,
    label: 'Kokoro am_adam is internal/unapproved; this proof does not mark Daniel approved.',
    guardrails: {
      localOnly: true,
      supercomputerUsed: false,
      browserFallbackUsed: false,
      productionVoiceReady: false,
      modelsBundled: false,
    },
  };

  fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
})();
