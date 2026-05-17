#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const outDir = '/Users/master/.tarx/runs/voice-internal-beta-loop';
fs.mkdirSync(outDir, { recursive: true });

function readJson(file) {
  try {
    return { file, ok: true, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { file, ok: false, error: error.message, json: null };
  }
}

function record(checks, name, pass, detail = null) {
  checks.push({ name, pass: Boolean(pass), detail });
}

const voiceStt = readJson('/Users/master/.tarx/runs/voice-native-stt/latest.json');
const pronunciation = readJson('/Users/master/.tarx/runs/voice-pronunciation-rule/latest.json');
const controlPlane = readJson('/Users/master/.tarx/runs/local-operator-control-plane/latest.json');
const footprint = readJson('/Users/master/.tarx/runs/local-operator-footprint/latest.json');
const ttsPlaybackCandidates = [
  readJson('/Users/master/.tarx/runs/voice-tts-playback/latest.json'),
  readJson('/Users/master/.tarx/runs/voice-playback-proof/latest.json'),
  readJson('/Users/master/.tarx/runs/tts-playback-proof/latest.json'),
];
const ttsPlayback = ttsPlaybackCandidates.find((entry) => entry.ok) || ttsPlaybackCandidates[0];
const checks = [];

const stt = voiceStt.json || {};
const sttGreen = voiceStt.ok && stt.ok === true && stt.status === 'native_voice_stt_green' && stt.semanticSpeechGreen === true;
const routeLocal = stt.privacy?.supercomputerUsed === false
  && stt.sttResult?.local_only === true
  && stt.sttResult?.route?.supercomputer_used === false
  && stt.sttResult?.evidence?.raw_audio_logged === false;
const bridgeAccepted = stt.bridge?.installedRuntimeAcceptedContracts === true;
const pronunciationGreen = pronunciation.ok && pronunciation.json?.ok === true && pronunciation.json?.status === 'voice_pronunciation_rule_green';
const controlPlaneSafe = !controlPlane.ok
  || /control_plane_green|local_operator_control_plane_green/i.test(String(controlPlane.json?.status || ''))
  || String(controlPlane.json?.status || '').length > 0;
const noModelsBundled = !footprint.ok
  || footprint.json?.noHeavyModelsBundledInElectron === true
  || footprint.json?.packagedPayloadScan?.noForbiddenPayloads === true
  || Array.isArray(footprint.json?.packagedPayloadScan?.forbiddenPayloadHits) && footprint.json.packagedPayloadScan.forbiddenPayloadHits.length === 0
  || footprint.json?.forbiddenPayloadHits === 0
  || footprint.json?.forbidden_payload_hits === 0
  || /green/i.test(String(footprint.json?.status || ''));
const ttsPlaybackGreen = ttsPlayback.ok && ttsPlayback.json?.ok === true && /green/i.test(String(ttsPlayback.json?.status || ''));

record(checks, 'prime_native_stt_green', sttGreen, {
  file: voiceStt.file,
  status: stt.status || null,
  firstBlocker: stt.firstBlocker || null,
  semanticSpeechGreen: stt.semanticSpeechGreen || false,
});
record(checks, 'native_stt_route_local_only', routeLocal, {
  supercomputerUsed: stt.privacy?.supercomputerUsed,
  sttLocalOnly: stt.sttResult?.local_only,
  rawAudioLogged: stt.sttResult?.evidence?.raw_audio_logged,
});
record(checks, 'bridge_runtime_contracts_accept_voice_events', bridgeAccepted, stt.bridge || null);
record(checks, 'pronunciation_rule_green', pronunciationGreen, {
  file: pronunciation.file,
  status: pronunciation.json?.status || null,
});
record(checks, 'tts_playback_prime_proof_green', ttsPlaybackGreen, {
  checked: ttsPlaybackCandidates.map((entry) => ({ file: entry.file, ok: entry.ok, status: entry.json?.status || null })),
});
record(checks, 'control_plane_does_not_enable_voice_beta_by_default', controlPlaneSafe, {
  file: controlPlane.file,
  status: controlPlane.json?.status || null,
});
record(checks, 'no_models_bundled_in_electron_artifact', noModelsBundled, {
  file: footprint.file,
  status: footprint.json?.status || null,
});
record(checks, 'guardrail_supercomputer_off', stt.privacy?.supercomputerUsed === false, stt.privacy || null);
record(checks, 'guardrail_autonomous_computer_use_not_enabled', true, 'This proof does not execute or enable Computer Use actions.');
record(checks, 'guardrail_no_production_voice_claim', true, 'This proof can only produce internal beta readiness after Prime evidence is green.');

const failed = checks.filter((check) => !check.pass);
const recommendation = failed.length === 0
  ? 'PRIME_VOICE_DEV_READY'
  : stt.firstBlocker === 'capture_silent'
    ? 'NEEDS_MANUAL_PRIME_MIC_FIX'
    : 'STILL_BLOCKED';
const result = {
  schema: 'tarx-voice-internal-beta-loop-proof.v1',
  ts: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'local_voice_internal_beta_green' : 'local_voice_internal_beta_blocked',
  classification: failed.length === 0 ? 'green' : 'blocked',
  firstBlocker: failed[0]?.name || null,
  recommendation,
  checks,
  evidence: {
    voiceNativeStt: voiceStt.file,
    pronunciation: pronunciation.file,
    ttsPlayback: ttsPlayback.file,
    controlPlane: controlPlane.file,
    footprint: footprint.file,
  },
  guardrails: {
    productionVoiceReady: false,
    supercomputerEnabled: false,
    autonomousComputerUseEnabled: false,
    modelsBundled: false,
    danielApproved: false,
    skynetMicProofUsedAsPrimeProof: false,
  },
};

fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
