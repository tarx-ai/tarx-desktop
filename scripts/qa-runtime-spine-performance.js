#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const electronRepo = process.cwd();
const outDir = path.join(os.homedir(), '.tarx', 'runs', 'runtime-spine-performance');
const outPath = path.join(outDir, 'latest.json');
const tarxMcpRepo = process.env.TARX_MCP_REPO || path.resolve(electronRepo, '..', 'tarx-mcp');
const tarxOpsRepo = process.env.TARX_OPS_REPO || path.resolve(electronRepo, '..', 'tarx-ops');

fs.mkdirSync(outDir, { recursive: true });

function readJson(file) {
  try {
    return { file, ok: true, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { file, ok: false, error: error.message, json: null };
  }
}

function fileExists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

function requestJson({ name, port, pathname, method = 'GET', body = null, timeoutMs = 1500 }) {
  const started = Date.now();
  const payload = body ? JSON.stringify(body) : '';
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
        const latencyMs = Date.now() - started;
        resolve({
          name,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode,
          classification: latencyMs > timeoutMs ? 'degraded' : (res.statusCode >= 200 && res.statusCode < 300 ? 'green' : 'degraded'),
          latencyMs,
          timeoutMs,
          timedOut: false,
          method,
          port,
          pathname,
          json,
          textPreview: text.slice(0, 500),
        });
      });
    });
    req.on('error', (error) => {
      const latencyMs = Date.now() - started;
      resolve({
        name,
        ok: false,
        statusCode: 0,
        classification: error.message === 'timeout' ? 'timeout' : 'degraded',
        latencyMs,
        timeoutMs,
        timedOut: error.message === 'timeout',
        method,
        port,
        pathname,
        error: error.message,
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function runtimeProbePayloads() {
  const sessionId = 'runtime_spine_perf';
  const captureId = `vc_spine_perf_${Date.now()}`;
  const actionId = `act_spine_perf_${Date.now()}`;
  const trainingSessionId = `train_spine_perf_${Date.now()}`;
  return {
    captureEvent: {
      schema: 'tarx-voice-capture-event.v1',
      session_id: sessionId,
      capture_id: captureId,
      source: 'electron_native',
      sample_rate: 16000,
      duration_ms: 1,
      privacy: { local_only: true, supercomputer_used: false },
      evidence: { audio_ref: 'runtime-spine-performance-probe.wav', audio_bytes: 44, raw_audio_logged: false },
    },
    sttResult: {
      schema: 'tarx-stt-result.v1',
      session_id: sessionId,
      capture_id: captureId,
      transcript_id: `stt_spine_perf_${Date.now()}`,
      model: 'whisper-base.en-int8',
      text: 'performance probe',
      confidence: 0,
      latency_ms: 1,
      local_only: true,
      route: { local_only: true, supercomputer_used: false },
      evidence: { audio_ref: 'runtime-spine-performance-probe.wav', audio_bytes: 44, raw_audio_logged: false },
    },
    actionProposal: {
      session_id: sessionId,
      action_id: actionId,
      proposed_action: { type: 'click', target: 'runtime spine disabled probe', expected_result: 'proposal only' },
      grounding: {
        vision_observation_id: 'vis_spine_perf_probe',
        target_freshness_ms: 200,
        target_confidence: 0.9,
        target_bounds: { x: 0, y: 0, width: 1, height: 1 },
        occlusion_status: 'clear',
      },
      risk: { external_side_effect: false },
    },
    composerDraft: {
      session_id: sessionId,
      source: 'runtime_spine_performance_probe',
      text: 'Explain this screen from pointer evidence only.',
      pointer_context_id: `ptr_spine_perf_${Date.now()}`,
    },
    demoRun: {
      session_id: sessionId,
      workflow: 'operator_copilot_runtime_spine_probe',
      status: 'created',
      transcript: 'Runtime spine probe only; no demo execution occurred.',
    },
    actionConfirmBlocked: {
      action_id: actionId,
      confirmed: true,
      target_freshness_ms: 999999,
      injector_ready: false,
    },
    actionResultBlocked: {
      session_id: sessionId,
      action_id: actionId,
      status: 'blocked',
      evidence: { reason: 'runtime_spine_probe_no_injector_execution' },
      error: 'proposal_only_probe',
    },
    trainingStart: {
      session_id: trainingSessionId,
      user_id: 'runtime_spine_probe',
      mode: 'human_guided',
    },
    trainingCandidate: {
      session_id: trainingSessionId,
      category: 'workflow_step',
      prompt: 'User points at a UI element and asks TARX to explain it.',
      correction: 'Use pointer/OCR/AX evidence only.',
      review_status: 'staged',
      privacy_class: 'local_private',
    },
    trainingEnd: {
      session_id: trainingSessionId,
      payload: { reason: 'runtime_spine_probe_complete' },
    },
  };
}

function inspectTarxMcp() {
  const pkgPath = path.join(tarxMcpRepo, 'package.json');
  const mcpConfigPath = path.join(tarxMcpRepo, '.mcp.json');
  const canaryPath = process.env.TARX_MCP_CANARY_PATH || path.join(os.tmpdir(), 'tarx_mcp_operational_canary.json');
  const pkg = readJson(pkgPath);
  const mcpConfig = readJson(mcpConfigPath);
  const canary = readJson(canaryPath);
  return {
    repo: tarxMcpRepo,
    packagePresent: pkg.ok,
    mcpConfigPresent: mcpConfig.ok,
    scripts: pkg.json?.scripts || {},
    expectedGatesPresent: Boolean(pkg.json?.scripts?.['ops:gates'] && pkg.json?.scripts?.['ops:canary'] && pkg.json?.scripts?.['chatgpt:readiness']),
    configuredServers: mcpConfig.json?.mcpServers || null,
    latestCanary: canary.ok ? {
      file: canary.file,
      status: canary.json?.status || null,
      ok: canary.json?.ok ?? null,
      firstBlocker: canary.json?.firstBlocker || null,
    } : {
      file: canary.file,
      ok: false,
      error: canary.error,
    },
    note: 'This audit records local MCP readiness surfaces without running deploy/canary commands.',
  };
}

function inspectOpsContracts() {
  const runtimeContracts = path.join(tarxOpsRepo, 'src', 'runtime-contracts.ts');
  const bridge = path.join(tarxOpsRepo, 'src', 'bridge.ts');
  const runtimeText = fileExists(runtimeContracts) ? fs.readFileSync(runtimeContracts, 'utf8') : '';
  const bridgeText = fileExists(bridge) ? fs.readFileSync(bridge, 'utf8') : '';
  const schemas = [
    'tarx-runtime-session.v1',
    'tarx-voice-capture-event.v1',
    'tarx-stt-result.v1',
    'tarx-intent-classification.v1',
    'tarx-vision-observation.v1',
    'tarx-action-grounding.v1',
    'tarx-action-result.v1',
    'tarx-memory-candidate.v1',
    'tarx-supercomputer-escalation-request.v1',
  ];
  return {
    repo: tarxOpsRepo,
    runtimeContracts,
    bridge,
    sourcePresent: Boolean(runtimeText && bridgeText),
    schemas: Object.fromEntries(schemas.map((schema) => [schema, runtimeText.includes(schema) && bridgeText.includes(schema)])),
    routes: {
      runtimeContracts: bridgeText.includes('/v1/runtime/contracts'),
      voiceCapture: bridgeText.includes('/v1/runtime/voice/capture-events'),
      sttResults: bridgeText.includes('/v1/runtime/stt-results'),
      actionPropose: bridgeText.includes('/v1/runtime/actions/propose'),
      telemetry: bridgeText.includes('/v1/runtime/telemetry'),
      mcpRegistry: bridgeText.includes('/v1/mcp-registry'),
      systemMetrics: bridgeText.includes('/v1/system/metrics'),
    },
  };
}

function probeHasSemanticSttGateRejection(probe) {
  if (!probe || probe.name !== 'bridge.stt_result_contract' || probe.ok || probe.statusCode < 400) {
    return false;
  }
  const errors = Array.isArray(probe.json?.errors) ? probe.json.errors : [];
  const text = `${errors.join(' ')} ${probe.textPreview || ''}`.toLowerCase();
  return text.includes('semantic') || text.includes('production_voice_semantic_proof');
}

(async () => {
  const payloads = runtimeProbePayloads();
  const probes = [
    { name: 'tarx_core.computer_bridge_health', port: 11440, pathname: '/health', timeoutMs: 1000 },
    { name: 'tarx_core.inference_health', port: 11435, pathname: '/health', timeoutMs: 1000 },
    { name: 'tarx_core.embeddings_health', port: 11437, pathname: '/health', timeoutMs: 1000 },
    { name: 'tarx_core.mesh_health', port: 11436, pathname: '/health', timeoutMs: 1000 },
    { name: 'bridge.runtime_contracts', port: 11440, pathname: '/v1/runtime/contracts', timeoutMs: 1500 },
    { name: 'bridge.system_metrics', port: 11440, pathname: '/v1/system/metrics', timeoutMs: 2000 },
    { name: 'bridge.mcp_registry', port: 11440, pathname: '/v1/mcp-registry', timeoutMs: 2000 },
    { name: 'bridge.voice_capture_contract', port: 11440, pathname: '/v1/runtime/voice/capture-events', method: 'POST', body: payloads.captureEvent, timeoutMs: 1500 },
    { name: 'bridge.stt_result_contract', port: 11440, pathname: '/v1/runtime/stt-results', method: 'POST', body: payloads.sttResult, timeoutMs: 1500 },
    { name: 'bridge.action_proposal_contract', port: 11440, pathname: '/v1/runtime/actions/propose', method: 'POST', body: payloads.actionProposal, timeoutMs: 1500 },
    { name: 'operator.pointer_context', port: 11440, pathname: `/v1/pointer/context?session_id=${encodeURIComponent('runtime_spine_perf')}&x=10&y=20&active_app=runtime-spine-probe&target_label=Composer&target_confidence=0.8`, timeoutMs: 1500 },
    { name: 'operator.composer_draft', port: 11440, pathname: '/v1/composer/draft', method: 'POST', body: payloads.composerDraft, timeoutMs: 1500 },
    { name: 'operator.demo_run_packet', port: 11440, pathname: '/v1/demo/run', method: 'POST', body: payloads.demoRun, timeoutMs: 1500 },
    { name: 'operator.action_propose', port: 11440, pathname: '/v1/action/propose', method: 'POST', body: payloads.actionProposal, timeoutMs: 1500 },
    { name: 'operator.action_confirm_blocks_without_injector', port: 11440, pathname: '/v1/action/confirm', method: 'POST', body: payloads.actionConfirmBlocked, timeoutMs: 1500 },
    { name: 'operator.action_result_blocked_record', port: 11440, pathname: '/v1/action/result', method: 'POST', body: payloads.actionResultBlocked, timeoutMs: 1500 },
    { name: 'operator.training_session_start', port: 11440, pathname: '/v1/training/session/start', method: 'POST', body: payloads.trainingStart, timeoutMs: 1500 },
    { name: 'operator.training_candidate_stage', port: 11440, pathname: '/v1/training/session/candidate', method: 'POST', body: payloads.trainingCandidate, timeoutMs: 1500 },
    { name: 'operator.training_session_end', port: 11440, pathname: '/v1/training/session/end', method: 'POST', body: payloads.trainingEnd, timeoutMs: 1500 },
  ];

  const results = [];
  for (const probe of probes) {
    results.push(await requestJson(probe));
  }

  const semanticSttGateProbe = results.find(probeHasSemanticSttGateRejection) || null;
  const voiceSemanticGateWorking = Boolean(semanticSttGateProbe);
  const timedOut = results.filter((probe) => probe.timedOut);
  const degraded = results.filter((probe) => {
    if (probe.name === 'bridge.stt_result_contract' && voiceSemanticGateWorking) {
      return false;
    }
    return !probe.ok || probe.timedOut;
  });
  const shallowHealthGreen = results
    .filter((probe) => probe.name.startsWith('tarx_core.') && probe.name.endsWith('_health'))
    .every((probe) => probe.ok);
  const readinessGreen = degraded.length === 0;
  const mcp = inspectTarxMcp();
  const ops = inspectOpsContracts();

  const result = {
    schema: 'tarx-runtime-spine-performance.v1',
    ts: new Date().toISOString(),
    ok: readinessGreen,
    status: readinessGreen ? 'runtime_spine_performance_green' : 'runtime_spine_performance_degraded',
    classification: readinessGreen ? 'green' : 'degraded',
    firstBlocker: degraded[0]?.name || null,
    summary: {
      shallowHealthGreen,
      readinessGreen,
      probeCount: results.length,
      degradedCount: degraded.length,
      timeoutCount: timedOut.length,
      healthGreenDoesNotImplyReadinessGreen: shallowHealthGreen && !readinessGreen,
      voiceSemanticGateWorking,
    },
    probes: results,
    localInferenceTimeoutBehavior: {
      observedDuringPlanning: true,
      observedRoute: 'tarx_core.tarx_chat local Computer inference',
      observedLatencyMs: 90498,
      observedError: 'Computer inference unavailable (legacy-inference:The operation was aborted due to timeout)',
      mitigation: 'Runtime spine probes use fixed timeout budgets and classify timeout as degraded.',
    },
    mcp,
    canonicalContracts: ops,
    operatorCopilotContracts: {
      pointerContextGreen: results.some((probe) => probe.name === 'operator.pointer_context' && probe.ok),
      composerDraftGreen: results.some((probe) => probe.name === 'operator.composer_draft' && probe.ok && probe.json?.payload?.auto_submit === false),
      demoRunPacketGreen: results.some((probe) => probe.name === 'operator.demo_run_packet' && probe.ok),
      actionProposalGreen: results.some((probe) => probe.name === 'operator.action_propose' && probe.ok && probe.json?.execution_allowed === false),
      actionConfirmBlockedWithoutInjector: results.some((probe) => probe.name === 'operator.action_confirm_blocks_without_injector' && probe.ok && probe.json?.payload?.execution_allowed === false),
      actionResultRecordGreen: results.some((probe) => probe.name === 'operator.action_result_blocked_record' && probe.ok),
      trainingSessionLifecycleGreen: ['operator.training_session_start', 'operator.training_candidate_stage', 'operator.training_session_end']
        .every((name) => results.some((probe) => probe.name === name && probe.ok)),
      routeTruth: 'Operator Copilot probes create local evidence/proposals only; no injector execution is enabled by this QA.',
    },
    routeTruth: {
      computerDefault: true,
      supercomputerUsed: false,
      browserFallbackUsed: false,
      actionExecutionUsed: false,
    },
    guardrails: {
      productionVoiceReady: false,
      productionVoiceBlockedUntilSemanticSttProof: voiceSemanticGateWorking,
      wakeWordModeEnabled: false,
      alwaysOnListeningEnabled: false,
      browserFallbackEnabledByQa: false,
      supercomputerEnabledByQa: false,
      computerUseExecutionEnabledByQa: false,
      rawPrivateContentLogged: false,
    },
    evidencePath: outPath,
  };

  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 0;
})();
