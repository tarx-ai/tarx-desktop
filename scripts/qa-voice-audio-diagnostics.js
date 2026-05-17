#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const outDir = '/Users/master/.tarx/runs/voice-audio-diagnostics';
fs.mkdirSync(outDir, { recursive: true });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function safeExec(command, args, timeout = 30000) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }),
      stderr: '',
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || ''),
      error: error.message,
    };
  }
}

function latestNativeWav() {
  const stt = readJson('/Users/master/.tarx/runs/voice-native-stt/latest.json');
  if (process.env.TARX_NATIVE_CAPTURE_WAV) return process.env.TARX_NATIVE_CAPTURE_WAV;
  if (stt?.wavPath) return stt.wavPath;
  try {
    const files = fs.readdirSync('/Users/master/.tarx/runs/voice-native-capture-proof')
      .filter((name) => name.endsWith('.wav'))
      .map((name) => path.join('/Users/master/.tarx/runs/voice-native-capture-proof', name))
      .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0]?.file || '';
  } catch {
    return '';
  }
}

function readWav(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`invalid_wav:${file}`);
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
  if (dataOffset < 0 || bitsPerSample !== 16) {
    throw new Error(`unsupported_wav:${file}`);
  }
  const end = Math.min(buffer.length, dataOffset + dataSize);
  const samples = [];
  for (let i = dataOffset; i + 1 < end; i += 2) {
    samples.push(buffer.readInt16LE(i) / 32768);
  }
  return { file, buffer, sampleRate, channelCount, bitsPerSample, samples };
}

function statsForSamples(samples, sampleRate, channelCount) {
  let sumSq = 0;
  let peak = 0;
  let zeroCount = 0;
  let crossings = 0;
  let prev = 0;
  for (const sample of samples) {
    sumSq += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    if (sample === 0) zeroCount += 1;
    if ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0)) crossings += 1;
    prev = sample;
  }
  const count = samples.length;
  const rms = count ? Math.sqrt(sumSq / count) : 0;
  const duration = sampleRate && channelCount && count ? count / sampleRate / channelCount : 0;
  const zeroCrossRate = count ? crossings / count : 0;
  return {
    duration,
    duration_ms: Math.round(duration * 1000),
    rms,
    rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
    peakAmplitude: peak,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    zeroRatio: count ? zeroCount / count : 1,
    zeroCrossRate,
    estimatedDominantHzFromZcr: Math.round((zeroCrossRate * sampleRate) / 2),
    nonSilent: rms > 0.0005 && peak > 0.003,
    speechEnergyLikely: rms > 0.01 && peak > 0.04 && zeroCrossRate > 0.005 && zeroCrossRate < 0.25,
  };
}

function wavStats(file) {
  const wav = readWav(file);
  const whole = statsForSamples(wav.samples, wav.sampleRate, wav.channelCount);
  const segmentSamples = wav.sampleRate * wav.channelCount;
  const segments = [];
  for (let start = 0; start < wav.samples.length; start += segmentSamples) {
    const slice = wav.samples.slice(start, start + segmentSamples);
    if (!slice.length) continue;
    segments.push({
      startSec: Number((start / segmentSamples).toFixed(2)),
      endSec: Number(((start + slice.length) / segmentSamples).toFixed(2)),
      ...statsForSamples(slice, wav.sampleRate, wav.channelCount),
    });
  }
  const activeSegments = segments.filter((segment) => segment.rms > Math.max(0.003, whole.rms * 0.35));
  return {
    validWav: true,
    fileSize: wav.buffer.length,
    sampleRate: wav.sampleRate,
    channelCount: wav.channelCount,
    bitsPerSample: wav.bitsPerSample,
    ...whole,
    activeSegmentCount: activeSegments.length,
    activeWindow: activeSegments.length ? {
      startSec: activeSegments[0].startSec,
      endSec: activeSegments[activeSegments.length - 1].endSec,
    } : null,
    segments,
  };
}

function writeVariant(input, output, filter) {
  const result = spawnSync('/opt/homebrew/bin/ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', input,
    '-ac', '1',
    '-ar', '16000',
    '-af', filter,
    output,
  ], { encoding: 'utf8', timeout: 30000 });
  return {
    ok: result.status === 0 && fs.existsSync(output),
    status: result.status,
    signal: result.signal,
    error: result.error?.message || null,
    stderr: String(result.stderr || '').slice(0, 1200),
  };
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
  const bases = ['http://127.0.0.1:11445', 'http://127.0.0.1:11447'];
  const probes = [];
  for (const base of bases) {
    const health = await probeJsonOrText(`${base}/health`);
    const root = await probeJsonOrText(`${base}/`);
    const transcribe = await probeJsonOrText(`${base}/transcribe`);
    const healthText = `${JSON.stringify(health.json || {})} ${health.text || ''}`;
    const transcribeText = `${JSON.stringify(transcribe.json || {})} ${transcribe.text || ''}`;
    const tarxJson = /tarx-local-whisper|audio_base64_required|POST \/transcribe with JSON audio base64/i.test(`${healthText} ${transcribeText}`)
      || ([400, 405, 415, 422].includes(Number(transcribe.status)) && /audio|base64|json|method|payload|required/i.test(transcribeText));
    const whisperCpp = /Whisper\.cpp Server|multipart\/form-data|Choose an audio file/i.test(root.text || '');
    const route = {
      base,
      healthStatus: health.status,
      transcribeStatus: transcribe.status,
      rootStatus: root.status,
      role: tarxJson ? 'tarx_local_whisper_json' : whisperCpp ? 'whisper_cpp' : null,
      endpoint: tarxJson ? `${base}/transcribe` : whisperCpp ? `${base}/inference` : null,
    };
    probes.push(route);
    if (route.endpoint) return { selected: route, probes };
  }
  return { selected: null, probes };
}

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

async function transcribe(file, route) {
  if (!route?.endpoint) return { ok: false, firstBlocker: 'stt_route_not_found' };
  const audio = fs.readFileSync(file);
  const started = Date.now();
  const response = route.role === 'tarx_local_whisper_json'
    ? await fetch(route.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        audio: audio.toString('base64'),
        audio_base64: audio.toString('base64'),
        mimeType: 'audio/wav',
        mime_type: 'audio/wav',
        language: 'en',
        initial_prompt: 'TARX is pronounced TARS. The phrase is: TARS, what are we working on today?',
      }),
      signal: AbortSignal.timeout(Number(process.env.TARX_WHISPER_TIMEOUT || 30000)),
    })
    : await (() => {
      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), path.basename(file));
      form.append('temperature', '0.0');
      form.append('response_format', 'json');
      return fetch(route.endpoint, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(Number(process.env.TARX_WHISPER_TIMEOUT || 30000)),
      });
    })();
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

async function main() {
  const input = latestNativeWav();
  if (!input || !fs.existsSync(input)) throw new Error('missing_native_wav_for_audio_diagnostics');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const normalized = path.join(outDir, `normalized-${stamp}.wav`);
  const trimmed = path.join(outDir, `trimmed-normalized-${stamp}.wav`);
  const normalizedResult = writeVariant(input, normalized, 'highpass=f=90,lowpass=f=7800,loudnorm=I=-18:TP=-2:LRA=7');
  const trimmedResult = writeVariant(input, trimmed, 'silenceremove=start_periods=1:start_duration=0.15:start_threshold=-42dB:stop_periods=1:stop_duration=0.35:stop_threshold=-42dB,highpass=f=90,lowpass=f=7800,loudnorm=I=-18:TP=-2:LRA=7');
  const route = await discoverSttRoute();
  const variants = [
    { name: 'raw', file: input, transform: { ok: true } },
    { name: 'normalized', file: normalized, transform: normalizedResult },
    { name: 'trimmed_normalized', file: trimmed, transform: trimmedResult },
  ];
  const analyzed = [];
  for (const variant of variants) {
    const exists = variant.transform.ok && fs.existsSync(variant.file);
    const stats = exists ? wavStats(variant.file) : null;
    const stt = exists ? await transcribe(variant.file, route.selected) : { ok: false, firstBlocker: 'variant_missing' };
    analyzed.push({
      ...variant,
      exists,
      stats,
      stt,
      semanticSpeechGreen: Boolean(stt.ok && !stt.blankAudio && meaningfulTranscript(stt.transcript)),
    });
  }
  const green = analyzed.find((variant) => variant.semanticSpeechGreen);
  const result = {
    schema: 'tarx-voice-audio-diagnostics.v1',
    ts: new Date().toISOString(),
    ok: Boolean(green),
    status: green ? 'voice_audio_diagnostics_semantic_green' : 'voice_audio_diagnostics_semantic_red',
    firstBlocker: green ? null : 'transcript_not_meaningful_after_audio_cleanup',
    input,
    selectedRoute: route.selected,
    routeProbes: route.probes,
    variants: analyzed,
    playback: analyzed.map((variant) => ({
      name: variant.name,
      file: variant.file,
      command: `/usr/bin/afplay "${variant.file}"`,
    })),
    selectedMic: readJson('/Users/master/.tarx/runs/voice-native-stt/latest.json')?.freshCapture?.inventory?.selected || null,
    routeTruth: {
      supercomputerUsed: false,
      browserFallbackUsed: false,
      rawAudioLogged: false,
    },
    recommendation: green
      ? 'native_voice_stt_green_candidate_found_rerun_qa_voice_native_stt_with_that_capture'
      : 'try_known_good_mic_or_speak_louder_closer_during_capture_then_rerun_native_stt',
  };
  fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
  const result = {
    schema: 'tarx-voice-audio-diagnostics.v1',
    ts: new Date().toISOString(),
    ok: false,
    status: 'voice_audio_diagnostics_error',
    firstBlocker: error.message,
  };
  fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
});
