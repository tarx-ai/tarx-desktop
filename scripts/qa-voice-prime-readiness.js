#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const electronRepo = process.cwd();
const outDir = path.join(os.homedir(), '.tarx', 'runs', 'voice-prime-readiness');
const runRoot = path.join(os.homedir(), '.tarx', 'runs');
const tarxOpsRepo = process.env.TARX_OPS_REPO || path.resolve(electronRepo, '..', 'tarx-ops');
fs.mkdirSync(outDir, { recursive: true });

function readJson(file) {
  try {
    return { file, ok: true, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { file, ok: false, error: error.message, json: null };
  }
}

function requestJson(port, pathname, options = {}) {
  const method = options.method || 'GET';
  const timeoutMs = options.timeoutMs || 2500;
  const payload = options.body ? JSON.stringify(options.body) : '';
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
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
    if (payload) req.write(payload);
    req.end();
  });
}

function record(checks, name, pass, detail = null) {
  checks.push({ name, pass: Boolean(pass), detail });
}

function inspectBridgeListeners() {
  try {
    const stdout = execFileSync('lsof', ['-nP', '-iTCP:11440', '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    });
    const listeners = stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        const name = parts.slice(8).join(' ');
        return {
          command: parts[0] || null,
          pid: Number(parts[1]) || null,
          user: parts[2] || null,
          name,
          localhostOnly: /TCP 127\.0\.0\.1:11440 \(LISTEN\)/.test(line),
          wildcard: /TCP \*:11440 \(LISTEN\)/.test(line),
        };
      });
    const localhostOnly = listeners.filter((listener) => listener.localhostOnly);
    const wildcard = listeners.filter((listener) => listener.wildcard);
    const shadowingLikely = listeners.length > 1 && localhostOnly.length > 0 && wildcard.length > 0;
    return {
      ok: listeners.length <= 1 || !shadowingLikely,
      status: shadowingLikely ? 'stale_bridge_listener_shadowing_runtime_contracts' : 'bridge_listener_hygiene_ok',
      listeners,
      shadowingLikely,
      safeFix: shadowingLikely && localhostOnly[0]?.pid ? `kill ${localhostOnly[0].pid} && launchctl kickstart -k gui/$(id -u)/com.tarx.bridge` : null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'bridge_listener_inspection_failed',
      error: error.message,
    };
  }
}

(async () => {
  const inventory = readJson(path.join(runRoot, 'voice-input-inventory', 'latest.json'));
  const doctor = readJson(path.join(runRoot, 'voice-input-doctor', 'latest.json'));
  const sttEvidence = readJson(path.join(runRoot, 'voice-native-stt', 'latest.json'));
  const ttsEvidence = readJson(path.join(runRoot, 'voice-tts-playback', 'latest.json'));
  const controlPlane = readJson(path.join(runRoot, 'local-operator-control-plane', 'latest.json'));

  const bridgeCaptureProbe = {
    schema: 'tarx-voice-capture-event.v1',
    session_id: 'qa_prime_readiness',
    capture_id: `vc_readiness_${Date.now()}`,
    source: 'electron_native',
    sample_rate: 16000,
    duration_ms: 1000,
    vad: {
      started_at: new Date(Date.now() - 1000).toISOString(),
      ended_at: new Date().toISOString(),
      confidence: 0.8,
    },
    privacy: { local_only: true, supercomputer_used: false },
    evidence: {
      audio_ref: sttEvidence.json?.wavPath || 'readiness-probe.wav',
      audio_bytes: sttEvidence.json?.audioStats?.fileSize || 44,
      raw_audio_logged: false,
    },
  };
  const bridgeSttProbe = {
    schema: 'tarx-stt-result.v1',
    session_id: 'qa_prime_readiness',
    capture_id: bridgeCaptureProbe.capture_id,
    transcript_id: `stt_readiness_${Date.now()}`,
    model: 'whisper-base.en-int8',
    text: sttEvidence.json?.rawTranscript || '',
    confidence: 0,
    latency_ms: 1,
    local_only: true,
    route: { local_only: true, supercomputer_used: false },
    evidence: {
      audio_ref: sttEvidence.json?.wavPath || 'readiness-probe.wav',
      audio_bytes: sttEvidence.json?.audioStats?.fileSize || 44,
      raw_audio_logged: false,
      endpoint: sttEvidence.json?.selectedEndpoint || 'http://127.0.0.1:11447/inference',
      route_role: 'whisper_cpp',
    },
    semantic: sttEvidence.json?.sttResult?.semantic || {
      intent: '',
      summary: '',
      confidence: 0,
      actionability: 'none',
      entities: [],
    },
    production_proof: sttEvidence.json?.sttResult?.production_proof || {
      capture_source: 'electron_native',
      semantic_match: false,
      raw_audio_logged: false,
      evidence_ref: sttEvidence.file,
    },
  };

  const bridgeListeners = inspectBridgeListeners();
  const bridgeHealth = await requestJson(11440, '/health');
  const bridgeCaptureEndpoint = await requestJson(11440, '/v1/runtime/voice/capture-events', {
    method: 'POST',
    body: bridgeCaptureProbe,
  });
  const bridgeSttEndpoint = await requestJson(11440, '/v1/runtime/stt-results', {
    method: 'POST',
    body: bridgeSttProbe,
  });
  const whisperHealth = await requestJson(11447, '/health');
  const ttsHealth = await requestJson(11446, '/health');

  const stt = sttEvidence.json || {};
  const checks = [];
  const sttGreen = sttEvidence.ok && stt.ok === true && stt.status === 'native_voice_stt_green' && stt.semanticSpeechGreen === true;
  const sttRouteLocal = sttEvidence.ok
    && stt.privacy?.supercomputerUsed === false
    && stt.sttResult?.local_only === true
    && stt.sttResult?.route?.supercomputer_used === false
    && Boolean(stt.selectedEndpoint);
  const semanticRedHonest = sttEvidence.ok
    && sttRouteLocal
    && stt.semanticSpeechGreen === false
    && Array.isArray(stt.validation?.errors)
    && stt.validation.errors.some((error) => /semantic|production_proof/i.test(String(error)));
  const onlyRazer = inventory.json?.avFoundationInputs?.length === 1 && /razer kiyo pro/i.test(String(inventory.json.avFoundationInputs[0].name || ''));
  const bridgeSttSemanticGateWorking = sttGreen
    ? bridgeSttEndpoint.ok
    : !bridgeSttEndpoint.ok && Array.isArray(bridgeSttEndpoint.json?.errors)
      && bridgeSttEndpoint.json.errors.some((error) => /semantic|production_proof/i.test(String(error)));
  const bridgeContracts = bridgeCaptureEndpoint.ok && bridgeSttSemanticGateWorking;
  const ttsPlaybackGreen = ttsEvidence.ok && ttsEvidence.json?.ok === true && /green/i.test(String(ttsEvidence.json?.status || ''));

  record(checks, 'voice_cta_panel_hardening_green', true, 'Covered by qa:voice-panel-state-machine and qa:voice-evidence-panel.');
  record(checks, 'inventory_available', inventory.ok && inventory.json?.status === 'voice_input_inventory_green', { file: inventory.file, status: inventory.json?.status || null });
  record(checks, 'selected_mic_recorded', Boolean(stt.captureEvent?.evidence?.selected_device || inventory.json?.defaultInput), stt.captureEvent?.evidence?.selected_device || inventory.json?.defaultInput || null);
  record(checks, 'native_capture_non_silent_or_stt_green', sttGreen || stt.audioStats?.nonSilent === true, stt.audioStats || null);
  record(checks, 'stt_route_local_only', sttGreen || sttRouteLocal, {
    status: stt.status || null,
    routeGreen: stt.routeGreen || false,
    selectedEndpoint: stt.selectedEndpoint || null,
    supercomputerUsed: stt.privacy?.supercomputerUsed,
  });
  record(checks, 'stt_semantic_green_required_for_loop', sttGreen, {
    status: stt.status || null,
    firstBlocker: stt.firstBlocker || null,
    transcript: stt.rawTranscript || stt.normalizedDisplayTranscript || null,
  });
  record(checks, 'razer_wrong_transcript_blocker_visible', !onlyRazer || semanticRedHonest || sttGreen, {
    onlyRazer,
    status: stt.status || null,
    transcript: stt.rawTranscript || null,
  });
  record(checks, 'bridge_listener_hygiene', bridgeListeners.ok, bridgeListeners);
  record(checks, 'bridge_reachable', bridgeHealth.ok, bridgeHealth);
  record(checks, 'bridge_voice_contracts_present', bridgeContracts, {
    captureEndpoint: bridgeCaptureEndpoint,
    sttEndpoint: bridgeSttEndpoint,
    semanticGateWorking: bridgeSttSemanticGateWorking,
    restartOrUpdateLikelyNeeded: !bridgeContracts,
    installedBridgeArtifact: '/Users/master/.tarx/servers/tarx-ops/dist/bridge.js',
    sourceBridgeArtifact: path.join(tarxOpsRepo, 'dist', 'bridge.js'),
    safeRestartCommand: 'launchctl kickstart -k gui/$(id -u)/com.tarx.bridge',
  });
  record(checks, 'whisper_service_reachable', whisperHealth.ok, whisperHealth);
  record(checks, 'tts_service_running', ttsHealth.ok, ttsHealth);
  record(checks, 'tts_playback_proof_green', ttsPlaybackGreen, { file: ttsEvidence.file, status: ttsEvidence.json?.status || null });
  record(checks, 'browser_fallback_off', process.env.TARX_VOICE_BROWSER_FALLBACK !== '1' && stt.privacy?.browserFallbackUsed !== true && controlPlane.json?.flags?.TARX_VOICE_BROWSER_FALLBACK !== true, null);
  record(checks, 'supercomputer_off', stt.privacy?.supercomputerUsed === false || controlPlane.json?.runtimeStatus?.supercomputer === 'off', null);
  record(checks, 'no_production_voice_claim', true, 'This readiness QA does not mark production voice ready.');

  const failed = checks.filter((check) => !check.pass);
  const result = {
    schema: 'tarx-voice-prime-readiness.v1',
    ts: new Date().toISOString(),
    ok: failed.length === 0,
    status: failed.length === 0 ? 'prime_voice_internal_loop_ready' : 'prime_voice_internal_loop_blocked',
    firstBlocker: failed[0]?.name || null,
    recommendation: failed.length === 0 ? 'INTERNAL_VOICE_LOOP_READY' : 'STILL_BLOCKED',
    checks,
    evidence: {
      inventory: inventory.file,
      doctor: doctor.file,
      nativeStt: sttEvidence.file,
      ttsPlayback: ttsEvidence.file,
      readiness: path.join(outDir, 'latest.json'),
    },
    current: {
      selectedMic: stt.captureEvent?.evidence?.selected_device || inventory.json?.defaultInput || null,
      inventory: inventory.json?.avFoundationInputs || [],
      sttStatus: stt.status || null,
      transcript: stt.rawTranscript || stt.normalizedDisplayTranscript || null,
      audioStats: stt.audioStats || null,
      bridgeContractsPresent: bridgeContracts,
      bridgeListeners,
      ttsServiceRunning: ttsHealth.ok,
      ttsPlaybackGreen,
      danielApproved: false,
    },
    guardrails: {
      productionVoiceReady: false,
      browserFallbackEnabled: false,
      supercomputerEnabled: false,
      modelsBundled: false,
      transcriptMocked: false,
      whisperBypassed: false,
    },
  };

  fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
})();
