#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const outDir = '/Users/master/.tarx/runs/runtime-spine-readiness';
const outPath = path.join(outDir, 'latest.json');
fs.mkdirSync(outDir, { recursive: true });

function readJson(file) {
  try {
    return { file, ok: true, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { file, ok: false, error: error.message, json: null };
  }
}

function record(checks, name, pass, detail = null, severity = 'blocker') {
  checks.push({ name, pass: Boolean(pass), severity, detail });
}

const evidence = {
  localOperator: readJson('/Users/master/.tarx/runs/local-operator-control-plane/latest.json'),
  voiceEvidencePanel: readJson('/Users/master/.tarx/runs/voice-evidence-panel/latest.json'),
  voicePanelState: readJson('/Users/master/.tarx/runs/voice-panel-state-machine/latest.json'),
  voiceManualLoop: readJson('/Users/master/.tarx/runs/voice-manual-loop/latest.json'),
  voiceNativeStt: readJson('/Users/master/.tarx/runs/voice-native-stt/latest.json'),
  voicePrimeReadiness: readJson('/Users/master/.tarx/runs/voice-prime-readiness/latest.json'),
  voiceTtsPlayback: readJson('/Users/master/.tarx/runs/voice-tts-playback/latest.json'),
  voiceMediaDevicesProductCapture: readJson('/Users/master/.tarx/runs/voice-mediadevices-product-capture/latest.json'),
  voiceDeviceReadiness: readJson('/Users/master/.tarx/runs/voice-device-readiness/latest.json'),
  voiceMediaDevicesSpike: readJson('/Users/master/.tarx/runs/voice-mediadevices-spike/latest.json'),
  voicePipecatSpike: readJson('/Users/master/.tarx/runs/voice-pipecat-spike/latest.json'),
  visionFreshness: readJson('/Users/master/.tarx/runs/vision-freshness/latest.json'),
  actionSafetyGate: readJson('/Users/master/.tarx/runs/action-safety-gate/latest.json'),
  runtimePerformance: readJson('/Users/master/.tarx/runs/runtime-spine-performance/latest.json'),
};

const checks = [];
const manualLoop = evidence.voiceManualLoop.json || {};
const nativeStt = evidence.voiceNativeStt.json || {};
const pipecat = evidence.voicePipecatSpike.json || {};
const vision = evidence.visionFreshness.json || {};
const action = evidence.actionSafetyGate.json || {};
const performance = evidence.runtimePerformance.json || {};

const manualVoiceGreen = evidence.voiceManualLoop.ok && manualLoop.status === 'voice_manual_loop_green' && manualLoop.ok === true;
const strictWakeWordGreen = evidence.voiceNativeStt.ok && nativeStt.status === 'native_voice_stt_green' && nativeStt.semanticSpeechGreen === true;
const pipecatBlockedHonestly = evidence.voicePipecatSpike.ok
  && pipecat.status === 'voice_pipecat_spike_blocked'
  && pipecat.firstBlocker === 'pipecat_dependency_missing'
  && pipecat.guardrails?.supercomputerUsed === false;
const mediaDevicesWired = evidence.voiceMediaDevicesSpike.ok
  && evidence.voiceMediaDevicesSpike.json?.status === 'voice_mediadevices_spike_wired';
const mediaDevicesProductHardened = evidence.voiceMediaDevicesProductCapture.ok
  && ['voice_mediadevices_product_capture_green', 'voice_mediadevices_product_capture_static_green'].includes(evidence.voiceMediaDevicesProductCapture.json?.status)
  && evidence.voiceDeviceReadiness.ok
  && ['voice_device_readiness_green', 'voice_device_manager_green'].includes(evidence.voiceDeviceReadiness.json?.status);
const visionProposalReady = evidence.visionFreshness.ok
  && vision.status === 'vision_freshness_yellow'
  && vision.ok === true
  && vision.policy?.action_proposal_allowed_ms === 1000
  && vision.policy?.autonomous_action_execution_enabled === false;
const actionProposalSafe = evidence.actionSafetyGate.ok
  && action.status === 'action_safety_gate_green'
  && action.policy?.action_execution_enabled === false;
const controlPlaneGreen = evidence.localOperator.ok
  && evidence.localOperator.json?.status === 'local_operator_control_plane_green';
const performancePresent = evidence.runtimePerformance.ok
  && ['runtime_spine_performance_green', 'runtime_spine_performance_degraded'].includes(performance.status);
const mcpBoundaryPresent = Boolean(performance.mcp?.expectedGatesPresent);

record(checks, 'local_operator_control_plane_green', controlPlaneGreen, { file: evidence.localOperator.file, status: evidence.localOperator.json?.status || null });
record(checks, 'manual_voice_internal_loop_green', manualVoiceGreen, { file: evidence.voiceManualLoop.file, status: manualLoop.status || null });
record(checks, 'manual_voice_route_truth_computer', manualLoop.routeTruth?.computer === true && manualLoop.routeTruth?.supercomputerUsed === false && manualLoop.routeTruth?.browserFallbackUsed === false, manualLoop.routeTruth || null);
record(checks, 'strict_wake_word_not_required_for_manual_mode', manualVoiceGreen && !strictWakeWordGreen, { strictNativeSttStatus: nativeStt.status || null }, 'watch');
record(checks, 'wake_word_voice_blocked_until_strict_stt_green', !strictWakeWordGreen, { strictWakeWordGreen, status: nativeStt.status || null }, 'watch');
record(checks, 'media_devices_product_path_hardened_internal', mediaDevicesProductHardened, {
  productCapture: { file: evidence.voiceMediaDevicesProductCapture.file, status: evidence.voiceMediaDevicesProductCapture.json?.status || null },
  deviceReadiness: { file: evidence.voiceDeviceReadiness.file, status: evidence.voiceDeviceReadiness.json?.status || null },
  spike: { file: evidence.voiceMediaDevicesSpike.file, status: evidence.voiceMediaDevicesSpike.json?.status || null },
}, mediaDevicesWired ? 'watch' : 'blocker');
record(checks, 'pipecat_scaffold_blocked_until_dependency_adapters', pipecatBlockedHonestly, { file: evidence.voicePipecatSpike.file, status: pipecat.status || null, firstBlocker: pipecat.firstBlocker || null }, 'watch');
record(checks, 'tts_playback_green', evidence.voiceTtsPlayback.ok && evidence.voiceTtsPlayback.json?.status === 'voice_tts_playback_green', { file: evidence.voiceTtsPlayback.file, status: evidence.voiceTtsPlayback.json?.status || null });
record(checks, 'vision_yellow_acceptable_for_proposals', visionProposalReady, { file: evidence.visionFreshness.file, status: vision.status || null, firstBlocker: vision.firstBlocker || null });
record(checks, 'computer_use_proposal_only_green', actionProposalSafe, { file: evidence.actionSafetyGate.file, status: action.status || null });
record(checks, 'mcp_private_memory_boundary_declared', mcpBoundaryPresent, performance.mcp || null);
record(checks, 'runtime_spine_performance_evidence_present', performancePresent, { file: evidence.runtimePerformance.file, status: performance.status || null, firstBlocker: performance.firstBlocker || null }, performance.status === 'runtime_spine_performance_degraded' ? 'watch' : 'blocker');
record(checks, 'browser_fallback_off', manualLoop.guardrails?.browserFallbackUsed === false && pipecat.guardrails?.browserFallbackUsed === false, {
  manualLoop: manualLoop.guardrails || null,
  pipecat: pipecat.guardrails || null,
});
record(checks, 'supercomputer_off', manualLoop.guardrails?.supercomputerUsed === false && pipecat.guardrails?.supercomputerUsed === false, {
  manualLoop: manualLoop.guardrails || null,
  pipecat: pipecat.guardrails || null,
});
record(checks, 'computer_use_execution_disabled', manualLoop.guardrails?.computerUseExecutionEnabled === false && action.policy?.action_execution_enabled === false, {
  manualLoop: manualLoop.guardrails || null,
  actionPolicy: action.policy || null,
});
record(checks, 'no_release_voice_claim', manualLoop.guardrails?.productionVoiceReady === false && pipecat.guardrails?.releaseVoiceReady === false, {
  manualLoop: manualLoop.guardrails || null,
  pipecat: pipecat.guardrails || null,
});

const blockers = checks.filter((check) => !check.pass && check.severity === 'blocker');
const watches = checks.filter((check) => !check.pass && check.severity === 'watch');
const status = blockers.length > 0
  ? 'runtime_spine_blocked'
  : (performance.status === 'runtime_spine_performance_degraded' || watches.length > 0
    ? 'runtime_spine_degraded'
    : 'runtime_spine_ready_internal_manual');
const firstBlocker = blockers[0]?.name
  || (performance.status === 'runtime_spine_performance_degraded' ? performance.firstBlocker : null)
  || watches[0]?.name
  || null;

const result = {
  schema: 'tarx-runtime-spine-readiness.v1',
  ts: new Date().toISOString(),
  ok: blockers.length === 0,
  status,
  classification: status === 'runtime_spine_ready_internal_manual' ? 'green' : (status === 'runtime_spine_degraded' ? 'degraded' : 'blocked'),
  firstBlocker,
  recommendation: status === 'runtime_spine_ready_internal_manual'
    ? 'INTERNAL_MANUAL_RUNTIME_SPINE_READY'
    : (status === 'runtime_spine_degraded' ? 'MERGE_WITH_DEGRADED_RUNTIME_WATCH' : 'STILL_BLOCKED'),
  checks,
  evidence: Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key, value.file])),
  current: {
    manualVoiceInternal: manualVoiceGreen ? 'GREEN' : 'BLOCKED',
    wakeWordVoice: strictWakeWordGreen ? 'GREEN' : 'BLOCKED',
    mediaDevicesProductPath: mediaDevicesProductHardened ? 'HARDENED_INTERNAL' : (mediaDevicesWired ? 'WIRED_DRAFT' : 'MISSING'),
    pipecatOrchestration: pipecat.status || 'missing',
    visionFreshness: vision.status || 'missing',
    computerUse: actionProposalSafe ? 'PROPOSAL_ONLY_GREEN' : 'BLOCKED',
    mcpRuntimePerformance: performance.status || 'missing',
  },
  routeTruth: {
    computerDefault: true,
    supercomputerUsed: false,
    browserFallbackUsed: false,
    actionExecutionUsed: false,
  },
  guardrails: {
    productionVoiceReady: false,
    wakeWordModeEnabled: false,
    alwaysOnListeningEnabled: false,
    browserFallbackEnabled: false,
    supercomputerEnabled: false,
    computerUseExecutionEnabled: false,
    modelsBundled: false,
  },
  evidencePath: outPath,
};

fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = blockers.length === 0 ? 0 : 1;
