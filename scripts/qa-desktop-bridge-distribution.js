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
  'native_dependency_declared',
  main.includes("const REQUIRED_BRIDGE_MODULES = ['better-sqlite3-multiple-ciphers'];"),
  'native sqlite dependency must be explicitly verified'
);
record(
  'lockfile_required_before_dependency_install',
  main.includes('bridge_runtime_lockfile_missing') && main.includes('package-lock.json'),
  'dependency bootstrap must refuse non-lockfile installs'
);
record(
  'dependency_probe_loads_native_module',
  main.includes('probeBridgeRuntimeDependencies') && main.includes('require.resolve(name)') && main.includes('require(name)'),
  'bootstrap must prove native dependency can be resolved and loaded'
);
record(
  'dependency_bootstrap_uses_npm_ci_omit_dev',
  main.includes("'ci'") && main.includes("'--omit=dev'") && main.includes('BRIDGE_DEPENDENCY_INSTALL_TIMEOUT_MS'),
  'runtime dependencies should install from lockfile without dev dependencies'
);
record(
  'dependency_install_failure_is_structured_hold',
  main.includes('bridge_runtime_dependency_install_failed') && main.includes('bridge_runtime_dependencies_missing'),
  'dependency bootstrap failures must be structured blockers'
);
record(
  'bootstrap_validates_distribution_before_health',
  ensureSlice.includes('const bridgeDistribution = ensureBridgeRuntimeAtApprovedSha();')
    && ensureSlice.includes('const dependencyBootstrap = ensureBridgeRuntimeDependencies(runtimeBridgeRepoPath());')
    && ensureSlice.indexOf('ensureBridgeRuntimeAtApprovedSha') < ensureSlice.indexOf('ensureBridgeRuntimeDependencies')
    && ensureSlice.indexOf('ensureBridgeRuntimeDependencies') < ensureSlice.indexOf('const existing = await getRuntimeHealth'),
  'runtime bootstrap must validate bridge source and dependencies before trusting health'
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
  'candidate_version_metadata_1_1_11',
  pkg.version === '1.1.11',
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
