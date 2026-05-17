#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const evidencePath = '/Users/master/.tarx/runs/voice-pipecat-spike/latest.json';
const port = Number(process.env.TARX_VOICE_PIPECAT_SPIKE_PORT || 11458);
const enabled = process.env.TARX_VOICE_PIPECAT_INTERNAL === '1';

function hasPythonPipecat() {
  const probe = spawnSync('python3', ['-c', 'import pipecat; print(getattr(pipecat, "__version__", "unknown"))'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  return {
    ok: probe.status === 0,
    version: probe.status === 0 ? String(probe.stdout || '').trim() : null,
    error: probe.status === 0 ? null : String(probe.stderr || probe.stdout || probe.error?.message || 'pipecat_module_missing').trim(),
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { _missing: true, file, error: error.message };
  }
}

function localAnswer(transcript = '') {
  const manualLoop = readJson('/Users/master/.tarx/runs/voice-manual-loop/latest.json');
  if (/what.*working.*(on|for).*today|working.*(on|for).*today/i.test(transcript)) {
    return 'Today we are working on TARX voice orchestration. Manual Voice is green internally, MediaDevices is draft, Pipecat is scaffolded, wake-word and public release remain blocked, and Supercomputer is off.';
  }
  if (manualLoop.answer?.text) return manualLoop.answer.text;
  return 'TARX local voice orchestration is in an internal spike. Manual Voice remains the current green path.';
}

function baseEvidence(extra = {}) {
  const pipecat = hasPythonPipecat();
  const manualLoop = readJson('/Users/master/.tarx/runs/voice-manual-loop/latest.json');
  const transcript = extra.transcript || manualLoop.input?.transcript || '';
  const status = enabled && pipecat.ok && transcript
    ? 'voice_pipecat_spike_partial'
    : 'voice_pipecat_spike_blocked';
  const firstBlocker = !enabled
    ? 'TARX_VOICE_PIPECAT_INTERNAL_disabled'
    : !pipecat.ok
      ? 'pipecat_dependency_missing'
      : !transcript
        ? 'missing_transcript_or_audio_reference'
        : 'adapters_not_connected';
  return {
    schema: 'tarx-voice-pipecat-spike.v1',
    ts: new Date().toISOString(),
    ok: status === 'voice_pipecat_spike_green',
    status,
    serviceStatus: pipecat.ok ? 'pipecat_available_adapter_scaffold' : 'pipecat_spike_scaffolded_not_running',
    firstBlocker: status === 'voice_pipecat_spike_green' ? null : firstBlocker,
    session: {
      sessionId: extra.sessionId || `pipecat_spike_${Date.now()}`,
      mode: 'local_first_pipecat_scaffold',
    },
    selectedInput: extra.selectedInput || manualLoop.input?.selectedDevice || null,
    capture: {
      source: extra.captureSource || 'mediadevices_or_manual_voice_reference',
      audioRef: extra.audioRef || manualLoop.input?.wavPath || null,
      rawAudioLogged: false,
    },
    stt: {
      provider: 'local_whisper_adapter_todo',
      transcript,
    },
    answer: {
      provider: 'local_operating_brief_current_gates_adapter_todo',
      source: 'local_prime_operating_status_from_evidence',
      text: localAnswer(transcript),
    },
    tts: {
      provider: 'local_tts_adapter_todo',
      playbackStatus: manualLoop.tts?.playback?.ok ? 'last_manual_loop_playback_green' : 'not_run_by_pipecat_spike',
      wavPath: manualLoop.tts?.wavPath || null,
    },
    pipecat: {
      installed: pipecat.ok,
      version: pipecat.version,
      error: pipecat.error,
    },
    routeTruth: {
      computer: true,
      supercomputer: 'Off',
      supercomputerUsed: false,
      browserFallback: 'Off',
      browserFallbackUsed: false,
      rawAudioLogged: false,
    },
    guardrails: {
      releaseVoiceReady: false,
      wakeWordModeEnabled: false,
      alwaysOnListeningEnabled: false,
      browserFallbackUsed: false,
      supercomputerUsed: false,
      modelsBundledInElectron: false,
    },
    evidencePath,
  };
}

function writeEvidence(result) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

async function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/health') {
      return send(res, 200, writeEvidence(baseEvidence({ healthOnly: true })));
    }
    if (url.pathname === '/v1/voice/pipecat/session' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, writeEvidence(baseEvidence(body)));
    }
    return send(res, 404, { ok: false, error: 'not_found' });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({ ok: true, status: 'pipecat_spike_service_listening', port }));
  });
}

async function main() {
  const mode = process.argv[2] || 'once';
  if (mode === 'serve') return serve();
  const result = writeEvidence(baseEvidence());
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'voice_pipecat_spike_blocked' ? 2 : 0);
}

main().catch((error) => {
  const result = writeEvidence({
    ...baseEvidence(),
    status: 'voice_pipecat_spike_blocked',
    firstBlocker: error.message || 'pipecat_spike_failed',
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
});
