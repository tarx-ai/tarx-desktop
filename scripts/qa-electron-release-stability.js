#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.cwd();
const outDir = path.join(os.homedir(), '.tarx', 'runs', 'electron-release-stability');
const latestPath = path.join(outDir, 'latest.json');
const checks = [];

function record(name, pass, detail = null, severity = 'P1') {
  checks.push({ name, pass: Boolean(pass), detail, severity });
}

function run(name, args, severity = 'P1') {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  record(name, result.status === 0, {
    command: args.join(' '),
    status: result.status,
    stdout: result.stdout.trim().slice(-3000),
    stderr: result.stderr.trim().slice(-3000),
  }, severity);
}

function scanForModelPayloads() {
  const roots = ['resources', 'dist', 'dist-voice-beta'].map((entry) => path.join(root, entry));
  const hits = [];
  const forbidden = /\.(gguf|ggml|onnx|safetensors|pt|pth)$/i;
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git'].includes(entry.name)) continue;
        walk(full);
      } else {
        const stat = fs.statSync(full);
        if (forbidden.test(entry.name) || stat.size > 300 * 1024 * 1024) hits.push({ path: full, bytes: stat.size });
      }
    }
  }
  roots.forEach(walk);
  return hits;
}

fs.mkdirSync(outDir, { recursive: true });

run('black_screen_recovery_qa', [process.execPath, 'scripts/qa-electron-black-screen-recovery.js'], 'P0');
run('local_operator_control_plane_qa', [process.execPath, 'scripts/qa-local-operator-control-plane.js'], 'P1');
run('native_capture_contract_qa', [process.execPath, 'scripts/qa-native-voice-capture-contract.js'], 'P1');

const modelHits = scanForModelPayloads();
record('no_model_bundling_scan', modelHits.length === 0, modelHits, 'P0');

const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
record('safe_mode_boot_qa', main.includes('SAFE_MODE') && main.includes("showSafeShell('safe_mode_boot'") && preload.includes('safeRecovery'), null, 'P0');
record('refresh_qa', main.includes("refreshTarx('menu-refresh')") && main.includes('armRendererReadyTimer(`refresh:${trigger}`'), null, 'P0');

const failed = checks.filter((check) => !check.pass);
const result = {
  schema: 'tarx-electron-release-stability-qa.v1',
  generated_at: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'electron_release_stability_green' : 'electron_release_stability_red',
  recommendation: failed.length === 0 ? 'RELEASE STABILITY GREEN' : 'RELEASE BLOCKED',
  passed: checks.length - failed.length,
  failed: failed.length,
  firstBlocker: failed[0]?.name || null,
  checks,
};

fs.writeFileSync(latestPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
