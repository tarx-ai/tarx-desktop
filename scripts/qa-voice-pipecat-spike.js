#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.cwd();
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const servicePath = path.join(root, 'scripts', 'voice-pipecat-spike-service.js');
const out = '/Users/master/.tarx/runs/voice-pipecat-spike/latest.json';
const checks = [];
const record = (name, pass, detail = null) => checks.push({ name, pass: Boolean(pass), detail });

const run = spawnSync(process.execPath, [servicePath, 'once'], {
  cwd: root,
  env: {
    ...process.env,
    TARX_VOICE_PIPECAT_INTERNAL: process.env.TARX_VOICE_PIPECAT_INTERNAL || '1',
  },
  encoding: 'utf8',
  timeout: 10000,
});

let evidence = null;
try {
  evidence = JSON.parse(fs.readFileSync(out, 'utf8'));
} catch {}

record('feature_flag_declared', main.includes('TARX_VOICE_PIPECAT_INTERNAL') && preload.includes('runPipecatSpike'), null);
record('feature_flag_defaults_off', main.includes("process.env.TARX_VOICE_PIPECAT_INTERNAL === '1'"), null);
record('service_scaffold_exists', fs.existsSync(servicePath), servicePath);
record('service_supports_health', fs.readFileSync(servicePath, 'utf8').includes("url.pathname === '/health'"), null);
record('service_supports_start_session', fs.readFileSync(servicePath, 'utf8').includes('/v1/voice/pipecat/session'), null);
record('evidence_file_written', fs.existsSync(out) && Boolean(evidence), out);
record('status_is_honest', ['voice_pipecat_spike_green', 'voice_pipecat_spike_partial', 'voice_pipecat_spike_blocked'].includes(evidence?.status), evidence?.status);
record('scaffold_not_fake_green_without_dependency', evidence?.pipecat?.installed === true || evidence?.status !== 'voice_pipecat_spike_green', evidence?.pipecat || null);
record('route_truth_computer', evidence?.routeTruth?.computer === true, evidence?.routeTruth || null);
record('supercomputer_off', evidence?.routeTruth?.supercomputerUsed === false && evidence?.guardrails?.supercomputerUsed === false, evidence?.routeTruth || null);
record('browser_fallback_off', evidence?.routeTruth?.browserFallbackUsed === false && evidence?.guardrails?.browserFallbackUsed === false, evidence?.routeTruth || null);
record('raw_audio_not_logged', evidence?.routeTruth?.rawAudioLogged === false && evidence?.capture?.rawAudioLogged === false, evidence?.capture || null);
record('no_release_voice_claim', evidence?.guardrails?.releaseVoiceReady === false && !/production voice ready/i.test(main), evidence?.guardrails || null);
record('panel_state_wired', main.includes('Pipecat Spike') && main.includes('Pipecat spike') && main.includes('tarx:voice-pipecat-spike-run'), null);
record('qa_script_registered', pkg.scripts?.['qa:voice-pipecat-spike'] === 'node scripts/qa-voice-pipecat-spike.js', null);

const failed = checks.filter((check) => !check.pass);
const result = {
  schema: 'tarx-voice-pipecat-spike-qa.v1',
  ts: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'voice_pipecat_spike_qa_green' : 'voice_pipecat_spike_qa_red',
  firstBlocker: failed[0]?.name || null,
  serviceRun: {
    status: run.status,
    signal: run.signal,
    error: run.error?.message || null,
    stderr: String(run.stderr || '').slice(0, 1000),
  },
  evidencePath: out,
  spikeStatus: evidence?.status || null,
  spikeFirstBlocker: evidence?.firstBlocker || null,
  recommendation: evidence?.status === 'voice_pipecat_spike_green' ? 'MERGE_PIPECAT_INTERNAL_SPIKE' : 'MERGE_PIPECAT_SPIKE_SCAFFOLD',
  checks,
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
