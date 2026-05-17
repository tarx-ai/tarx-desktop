#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = process.cwd();
const outDir = path.join(os.homedir(), '.tarx', 'runs', 'electron-black-screen-incident');
const latestPath = path.join(outDir, 'latest.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
}

function statFile(file) {
  try {
    const stat = fs.statSync(file);
    return { path: file, exists: true, bytes: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return { path: file, exists: false };
  }
}

function listRecent(dir, limit = 12) {
  try {
    return fs.readdirSync(dir)
      .map((entry) => {
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        return { path: full, bytes: stat.size, mtime: stat.mtime.toISOString(), directory: stat.isDirectory() };
      })
      .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function requestJson(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 'timeout' });
    });
    req.on('error', (error) => resolve({ ok: false, status: 'error', error: error.message }));
  });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const supportCandidates = [
    path.join(os.homedir(), 'Library', 'Application Support', 'TARX'),
    path.join(os.homedir(), 'Library', 'Application Support', 'tarx-desktop'),
    path.join(os.homedir(), 'Library', 'Application Support', pkg.name || 'tarx-desktop'),
  ];
  const diagnosticsDirs = supportCandidates.map((dir) => path.join(dir, 'diagnostics'));
  const crashDirs = [
    path.join(os.homedir(), 'Library', 'Application Support', 'CrashReporter'),
    path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports'),
  ];
  const logDirs = [
    path.join(os.homedir(), 'Library', 'Logs', 'TARX'),
    path.join(os.homedir(), 'Library', 'Logs', 'tarx-desktop'),
    ...diagnosticsDirs,
  ];

  const latestDiagnostics = diagnosticsDirs.flatMap((dir) => listRecent(dir, 20));
  const latestRoute = diagnosticsDirs
    .map((dir) => readJson(path.join(dir, 'latest-route-attempt.json')))
    .find(Boolean);
  const latestRefresh = diagnosticsDirs
    .map((dir) => readJson(path.join(dir, 'latest-refresh.json')))
    .find(Boolean);
  const latestSafeShell = diagnosticsDirs
    .map((dir) => readJson(path.join(dir, 'latest-safe-shell.json')))
    .find(Boolean);
  const latestRendererReady = diagnosticsDirs
    .map((dir) => readJson(path.join(dir, 'latest-renderer-ready.json')))
    .find(Boolean);

  const bridge = await requestJson('http://127.0.0.1:11440/health');
  const localOperator = await requestJson('http://127.0.0.1:11440/v1/runtime/status');

  const result = {
    schema: 'tarx-electron-black-screen-incident-evidence.v1',
    generated_at: new Date().toISOString(),
    incident: {
      machine: 'Skynet',
      trigger: 'Clicked Refresh TARX',
      observed_behavior: 'Electron black screen',
      manual_recovery: 'Quit/restart app; app fired back up',
      status: 'RECOVERED / ROOT CAUSE UNKNOWN',
      release_impact: 'PUBLIC ELECTRON RELEASE BLOCKED UNTIL RECOVERY QA GREEN',
    },
    app: {
      name: pkg.name || null,
      version: pkg.version || null,
      productName: pkg.build?.productName || null,
      appId: pkg.build?.appId || null,
      root,
    },
    flags: {
      TARX_SAFE_MODE: process.env.TARX_SAFE_MODE || '0',
      TARX_LOCAL_OPERATOR_BETA: process.env.TARX_LOCAL_OPERATOR_BETA || '0',
      TARX_VOICE_NATIVE_CAPTURE: process.env.TARX_VOICE_NATIVE_CAPTURE || '0',
      TARX_VOICE_MANUAL_INTERNAL: process.env.TARX_VOICE_MANUAL_INTERNAL || '0',
      TARX_VOICE_MEDIADEVICES_INTERNAL: process.env.TARX_VOICE_MEDIADEVICES_INTERNAL || '0',
      TARX_SUPERCOMPUTER_ESCALATION: process.env.TARX_SUPERCOMPUTER_ESCALATION || '0',
    },
    support_candidates: supportCandidates.map(statFile),
    logs: logDirs.map((dir) => ({ dir, recent: listRecent(dir) })),
    crash_reports: crashDirs.map((dir) => ({ dir, recent: listRecent(dir) })),
    diagnostics: {
      latestRoute,
      latestRefresh,
      latestSafeShell,
      latestRendererReady,
      recent: latestDiagnostics,
    },
    bridge_status: bridge,
    local_operator_status: localOperator,
    current_status: 'RECOVERED / ROOT CAUSE UNKNOWN',
    best_current_hypothesis: latestSafeShell?.firstError?.message
      || latestRefresh?.trigger
      || 'Refresh triggered a renderer hang/crash or failed navigation without a previous safe-shell fallback.',
  };

  fs.writeFileSync(latestPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ latest: latestPath, status: result.current_status, bridge: bridge.status }, null, 2));
}

main().catch((error) => {
  fs.mkdirSync(outDir, { recursive: true });
  const result = {
    schema: 'tarx-electron-black-screen-incident-evidence.v1',
    generated_at: new Date().toISOString(),
    ok: false,
    error: error.message,
  };
  fs.writeFileSync(latestPath, `${JSON.stringify(result, null, 2)}\n`);
  console.error(error);
  process.exit(1);
});
