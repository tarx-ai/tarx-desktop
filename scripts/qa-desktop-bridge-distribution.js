#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = process.cwd();
const outDir = path.join(os.homedir(), '.tarx', 'runs', 'desktop-bridge-distribution');
const latestPath = path.join(outDir, 'latest.json');
const checks = [];

function record(name, pass, detail = null, severity = 'P0') {
  checks.push({ name, pass: Boolean(pass), detail, severity });
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

fs.mkdirSync(outDir, { recursive: true });

const main = read('electron/main.js');
const pkg = JSON.parse(read('package.json'));
const ensureStart = main.indexOf('async function ensureLocalRuntime()');
const ensureEnd = main.indexOf('// ── Deep link protocol');
const ensureSlice = ensureStart >= 0 && ensureEnd > ensureStart ? main.slice(ensureStart, ensureEnd) : '';

record(
  'approved_bridge_sha_pinned',
  main.includes("const APPROVED_BRIDGE_SHA = '71b44b0afd3c65a44b80341fdb8a955a22903396';"),
  'approved bridge SHA must be explicit'
);
record(
  'approved_bridge_ref_pinned',
  main.includes("const APPROVED_BRIDGE_REF = 'codex/bridge-cors-code-worker-retry-v1';"),
  'approved source ref must be explicit'
);
record(
  'runtime_path_is_user_tarx_ops_checkout',
  main.includes("'.tarx', 'servers', 'tarx-ops'") && main.includes("'dist', 'bridge.js'"),
  'Desktop should use the controlled user runtime checkout'
);
record(
  'clean_install_clone_path_exists',
  main.includes("'clone'") && main.includes('TARX_OPS_REPO_URL') && main.includes('--single-branch'),
  'missing checkout should clone the approved runtime source'
);
record(
  'stale_checkout_fetches_approved_ref',
  main.includes("'fetch'") && main.includes('APPROVED_BRIDGE_REF') && main.includes("'checkout'") && main.includes('--detach'),
  'stale checkout should fetch and detach to the approved SHA'
);
record(
  'dirty_runtime_blocks_update',
  main.includes("'status', '--porcelain=v1'") && main.includes('bridge_runtime_dirty') && main.includes('refusing to update automatically'),
  'dirty runtime must fail closed'
);
record(
  'approved_dist_required',
  main.includes('bridge_runtime_missing_dist') && main.includes('fs.existsSync(bridgePath)'),
  'approved checkout must contain dist/bridge.js'
);
record(
  'bootstrap_validates_distribution_before_health',
  ensureSlice.includes('const bridgeDistribution = ensureBridgeRuntimeAtApprovedSha();')
    && ensureSlice.indexOf('ensureBridgeRuntimeAtApprovedSha') < ensureSlice.indexOf('const existing = await getRuntimeHealth'),
  'runtime bootstrap must validate bridge source before trusting health'
);
record(
  'runtime_status_uses_bootstrap',
  main.includes("ipcMain.handle('tarx:runtime-status'") && main.includes('await ensureLocalRuntime();\n  return runtimeState;'),
  'runtime status should not bypass bridge SHA validation'
);
record(
  'updated_running_bridge_requires_restart',
  main.includes("status: 'restart_required'") && main.includes('reloads the approved bridge.js'),
  'a newly updated runtime must not silently claim an already-running bridge process is current'
);
record(
  'release_feed_unchanged',
  pkg.build?.publish?.url === 'https://tarx.com/api/download/electron',
  pkg.build?.publish?.url || null,
  'P1'
);
record(
  'candidate_version_not_bumped',
  pkg.version === '1.1.10',
  pkg.version,
  'P1'
);

const failed = checks.filter((check) => !check.pass);
const result = {
  schema: 'tarx-desktop-bridge-distribution-qa.v1',
  generated_at: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'desktop_bridge_distribution_green' : 'desktop_bridge_distribution_red',
  passed: checks.length - failed.length,
  failed: failed.length,
  firstBlocker: failed[0]?.name || null,
  approvedBridgeSha: '71b44b0afd3c65a44b80341fdb8a955a22903396',
  bridgePath: path.join(os.homedir(), '.tarx', 'servers', 'tarx-ops', 'dist', 'bridge.js'),
  evidencePath: latestPath,
  checks,
};

fs.writeFileSync(latestPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
