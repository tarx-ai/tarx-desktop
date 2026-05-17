#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const outDir = '/Users/master/.tarx/runs/voice-live-calibration';
fs.mkdirSync(outDir, { recursive: true });

const attempts = Number(process.env.TARX_VOICE_CALIBRATION_ATTEMPTS || 5);
const captureSeconds = Number(process.env.TARX_VOICE_CALIBRATION_SECONDS || 6);
const baselineSeconds = Number(process.env.TARX_VOICE_CALIBRATION_BASELINE_SECONDS || 2);
const promptEnabled = process.env.TARX_VOICE_CALIBRATION_PROMPT !== '0';
const requiredSpokenPhrase = 'TARS, what are we working on today?';
const requiredContentTokens = ['what', 'are', 'we', 'working', 'on', 'today'];
const ffmpeg = process.env.TARX_VOICE_NATIVE_CAPTURE_BIN || '/opt/homebrew/bin/ffmpeg';
const requestedDevice = String(process.env.TARX_VOICE_NATIVE_CAPTURE_DEVICE || '').trim();

function safeExecFile(command, args, timeout = 6000) {
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

function nativeDeviceInventory() {
  const av = safeExecFile(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
  const avRaw = (av.stdout || '') + (av.stderr || '');
  const system = safeExecFile('/usr/sbin/system_profiler', ['SPAudioDataType']);
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

function captureAttempt(inventory, attemptNumber) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `attempt-${String(attemptNumber).padStart(2, '0')}-${stamp}.wav`);
  const capture = spawnSync(inventory.ffmpeg, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'avfoundation',
    '-t', String(captureSeconds),
    '-i', inventory.selected.selector,
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    file,
  ], { encoding: 'utf8', timeout: (captureSeconds + 5) * 1000 });
  return {
    wavPath: file,
    audioStats: wavStats(file),
    captureExit: {
      status: capture.status,
      signal: capture.signal,
      error: capture.error?.message || null,
      stderr: String(capture.stderr || '').slice(0, 1200),
    },
  };
}

function captureAmbientBaseline(inventory) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `ambient-baseline-${stamp}.wav`);
  const capture = spawnSync(inventory.ffmpeg, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'avfoundation',
    '-t', String(baselineSeconds),
    '-i', inventory.selected.selector,
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    file,
  ], { encoding: 'utf8', timeout: (baselineSeconds + 5) * 1000 });
  return {
    wavPath: file,
    afplayCommand: `/usr/bin/afplay ${JSON.stringify(file)}`,
    audioStats: wavStats(file),
    captureExit: {
      status: capture.status,
      signal: capture.signal,
      error: capture.error?.message || null,
      stderr: String(capture.stderr || '').slice(0, 1200),
    },
  };
}

function speakPrompt(text) {
  if (!promptEnabled) return { attempted: false, skipped: true };
  const spoken = spawnSync('/usr/bin/say', [text], { encoding: 'utf8', timeout: 10000 });
  const tone = spawnSync('/usr/bin/afplay', ['/System/Library/Sounds/Ping.aiff'], { encoding: 'utf8', timeout: 5000 });
  return {
    attempted: true,
    say: { status: spoken.status, signal: spoken.signal, error: spoken.error?.message || null, stderr: String(spoken.stderr || '') },
    tone: { status: tone.status, signal: tone.signal, error: tone.error?.message || null, stderr: String(tone.stderr || '') },
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

async function transcribeWithWhisper(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, status: 0, transcript: '', firstBlocker: 'missing_wav' };
  const wavBuffer = fs.readFileSync(file);
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), path.basename(file));
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

function normalizeTranscript(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function snrDb(signalRms, noiseRms) {
  if (!signalRms || !noiseRms) return null;
  return 20 * Math.log10(signalRms / noiseRms);
}

function editDistance(left, right) {
  const a = left.split(' ').filter(Boolean);
  const b = right.split(' ').filter(Boolean);
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + 1);
    }
  }
  return dp[a.length][b.length];
}

function wordErrorRate(reference, hypothesis) {
  const referenceTokens = normalizeTranscript(reference).split(' ').filter(Boolean);
  if (!referenceTokens.length) return null;
  return editDistance(normalizeTranscript(reference), normalizeTranscript(hypothesis)) / referenceTokens.length;
}

function nextActionForFailure(failureClass, ambientBaselineContaminated = false) {
  if (ambientBaselineContaminated) {
    return 'Rerun in a quiet room with TV/speakers stopped; ambient baseline is too loud for reliable scoring.';
  }
  if (failureClass === 'pass') return 'Calibration attempt passed.';
  if (failureClass === 'background_audio') return 'Stop nearby audio or move the mic away from speakers, then rerun calibration.';
  if (failureClass === 'mic_quality') return 'Move 12-18 inches from the selected mic, face it directly, and confirm macOS input meter moves only when you speak.';
  if (failureClass === 'transcript_empty') return 'Speak after the tone during the 6 second capture window; check mic permission if this repeats.';
  if (failureClass === 'wake_word_misheard') return 'Repeat the wake word slowly as TARS; do not accept wake-word-only variants unless phrase content is also present.';
  if (failureClass === 'phrase_missing') return 'Use the exact phrase: TARS, what are we working on today?';
  if (failureClass === 'whisper_failure') return 'Listen to the WAV; if it clearly contains the phrase, preserve evidence as a Whisper semantic failure.';
  return 'Rerun calibration after checking input selection and room noise.';
}

function scoreTranscript(text, audioStats, baselineStats) {
  const normalized = normalizeTranscript(text);
  const tokens = new Set(normalized.split(' ').filter(Boolean));
  const exactWake = /\b(tars|tarx)\b/i.test(text || '');
  const taurusWake = /\btaurus\b/.test(normalized);
  const blankAudio = /^\[BLANK_AUDIO\]$/i.test(String(text || '').trim());
  const signalToNoiseDb = snrDb(audioStats.rms || 0, baselineStats?.rms || 0);
  const wakeWordScore = exactWake ? 1 : taurusWake ? 0.35 : 0;
  const matchedTokens = requiredContentTokens.filter((token) => tokens.has(token));
  const phraseContentScore = matchedTokens.length / requiredContentTokens.length;
  const phraseClose = /what.*working.*(on|for).*today|working.*(on|for).*today/.test(normalized);
  const semanticScore = Math.min(1, (wakeWordScore * 0.35) + (phraseContentScore * 0.45) + (phraseClose ? 0.2 : 0));
  const pass = wakeWordScore >= 1 && (phraseContentScore >= 0.83 || phraseClose) && semanticScore >= 0.85;
  let failureClass = 'pass';
  if (!audioStats.validWav || !audioStats.nonSilent) failureClass = 'mic_quality';
  else if (signalToNoiseDb !== null && signalToNoiseDb < 6) failureClass = 'mic_quality';
  else if (!text || blankAudio) failureClass = 'transcript_empty';
  else if (/\b(tv|episode|birthday|mother|sam|music|applause|laugh|laughing)\b/i.test(text)) failureClass = 'background_audio';
  else if (wakeWordScore < 1) failureClass = taurusWake && phraseContentScore >= 0.83 ? 'wake_word_misheard' : 'wake_word_misheard';
  else if (phraseContentScore < 0.83 && !phraseClose) failureClass = 'phrase_missing';
  else if (!pass) failureClass = 'whisper_failure';
  return {
    normalizedTranscript: normalized,
    wakeWordScore,
    phraseContentScore,
    matchedContentTokens: matchedTokens,
    wordErrorRate: wordErrorRate(requiredSpokenPhrase, text),
    semanticScore,
    signalToNoiseDb,
    pass,
    failureClass,
  };
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : 0;
}

(async () => {
  const inventory = nativeDeviceInventory();
  if (requestedDevice && !inventory.selected) {
    const result = {
      schema: 'tarx-voice-live-calibration.v1',
      ts: new Date().toISOString(),
      ok: false,
      status: 'voice_live_calibration_red',
      firstBlocker: 'requested_avfoundation_input_not_found',
      inventory,
      guardrails: { browserFallbackUsed: false, supercomputerUsed: false, rawAudioLogged: false, productionVoiceReady: false },
    };
    fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  if (!inventory.selected) {
    const result = {
      schema: 'tarx-voice-live-calibration.v1',
      ts: new Date().toISOString(),
      ok: false,
      status: 'voice_live_calibration_red',
      firstBlocker: 'no_avfoundation_input_device',
      inventory,
      guardrails: { browserFallbackUsed: false, supercomputerUsed: false, rawAudioLogged: false, productionVoiceReady: false },
    };
    fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const ambientBaseline = captureAmbientBaseline(inventory);
  const ambientBaselineContaminated = ambientBaseline.audioStats.rms > 0.05 || ambientBaseline.audioStats.peakAmplitude > 0.25;
  if (promptEnabled) {
    spawnSync('/usr/bin/say', ['TARX voice calibration starting. Say the phrase after each tone.'], { encoding: 'utf8', timeout: 10000 });
    spawnSync('/bin/sleep', ['1']);
  }
  const rows = [];
  for (let i = 1; i <= attempts; i += 1) {
    const prompt = speakPrompt(`Attempt ${i} of ${attempts}. After the tone, say: TARS, what are we working on today?`);
    const capture = captureAttempt(inventory, i);
    const stt = capture.audioStats.validWav && capture.audioStats.nonSilent
      ? await transcribeWithWhisper(capture.wavPath)
      : { ok: false, status: 0, transcript: '', transcriptPreview: '', raw: null };
    const score = scoreTranscript(stt.transcript, capture.audioStats, ambientBaseline.audioStats);
    rows.push({
      attempt: i,
      prompt,
      wavPath: capture.wavPath,
      afplayCommand: `/usr/bin/afplay ${JSON.stringify(capture.wavPath)}`,
      duration_ms: capture.audioStats.duration_ms || 0,
      rms: capture.audioStats.rms || 0,
      peak: capture.audioStats.peakAmplitude || 0,
      snrDb: score.signalToNoiseDb,
      transcript: stt.transcript,
      normalizedTranscript: score.normalizedTranscript,
      wakeWordScore: score.wakeWordScore,
      phraseContentScore: score.phraseContentScore,
      matchedContentTokens: score.matchedContentTokens,
      wordErrorRate: score.wordErrorRate,
      semanticScore: score.semanticScore,
      pass: score.pass,
      failureClass: score.failureClass,
      nextAction: nextActionForFailure(score.failureClass, ambientBaselineContaminated),
      audioStats: capture.audioStats,
      stt,
      captureExit: capture.captureExit,
    });
  }

  const passed = rows.filter((row) => row.pass);
  const fullPhrase = rows.some((row) => row.pass && row.phraseContentScore >= 0.83);
  const passRate = rows.length ? passed.length / rows.length : 0;
  const ok = passed.length >= 3 && fullPhrase;
  const dominantFailure = rows
    .filter((row) => !row.pass)
    .reduce((counts, row) => {
      counts[row.failureClass] = (counts[row.failureClass] || 0) + 1;
      return counts;
    }, {});
  const firstBlocker = ok ? null
    : Object.entries(dominantFailure).sort((a, b) => b[1] - a[1])[0]?.[0] || 'calibration_attempts_failed';
  const profile = {
    schema: 'tarx-prime-mic-profile.v1',
    ts: new Date().toISOString(),
    selectedDevice: inventory.selected,
    selector: inventory.selected.selector,
    averageRms: average(rows.map((row) => row.rms)),
    averagePeak: average(rows.map((row) => row.peak)),
    passRate,
    ambientBaseline,
    ambientBaselineContaminated,
    recommendedDistance: ok ? 'Keep current speaking distance; calibration passed.' : 'Move within 12-18 inches of the selected mic, face the mic, and speak after the tone.',
    backgroundNoiseNote: ambientBaselineContaminated
      ? 'Ambient baseline is too loud; rerun in a quieter room or stop nearby playback before calibration.'
      : dominantFailure.background_audio ? 'Background or unrelated speech was detected in failed attempts.' : 'No dominant background-audio pattern detected.',
    lastGreenAttemptPath: [...passed].pop()?.wavPath || null,
    attempts: rows.length,
    passed: passed.length,
    status: ok ? 'voice_live_calibration_green' : 'voice_live_calibration_red',
    nextAction: nextActionForFailure(firstBlocker, ambientBaselineContaminated),
  };
  fs.writeFileSync(path.join(outDir, 'prime-mic-profile.json'), `${JSON.stringify(profile, null, 2)}\n`);

  const result = {
    schema: 'tarx-voice-live-calibration.v1',
    ts: new Date().toISOString(),
    ok,
    status: ok ? 'voice_live_calibration_green' : 'voice_live_calibration_red',
    firstBlocker,
    requiredSpokenPhrase,
    protocol: {
      mode: 'live_human_guided_calibration',
      attemptsRequired: attempts,
      acceptanceRule: 'At least 3 of 5 attempts pass, with at least one full phrase attempt.',
      promptEnabled,
      ambientBaselineSeconds: baselineSeconds,
      captureSeconds,
      syntheticAcousticLoopIsSeparate: true,
      syntheticLoopCannotUnlockLiveVoice: true,
      metrics: [
        'ambient_baseline',
        'snr_db',
        'wake_word_score',
        'phrase_content_score',
        'semantic_score',
        'word_error_rate',
        'failure_class',
      ],
    },
    ambientBaseline,
    ambientBaselineContaminated,
    attempts: rows,
    summary: {
      totalAttempts: rows.length,
      passed: passed.length,
      failed: rows.length - passed.length,
      passRate,
      fullPhraseAttemptPresent: fullPhrase,
      failureClasses: dominantFailure,
      recommendation: ok ? 'RUN_NATIVE_STT_PROOF' : nextActionForFailure(firstBlocker, ambientBaselineContaminated),
    },
    selectedMic: inventory.selected,
    inventory,
    micProfilePath: path.join(outDir, 'prime-mic-profile.json'),
    evidencePath: path.join(outDir, 'latest.json'),
    guardrails: {
      browserFallbackUsed: false,
      supercomputerUsed: false,
      rawAudioLogged: false,
      productionVoiceReady: false,
      transcriptMocked: false,
      whisperBypassed: false,
    },
  };
  fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(ok ? 0 : 1);
})();
