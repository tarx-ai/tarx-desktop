#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.cwd();
const outDir = path.join(os.homedir(), '.tarx', 'runs', 'electron-black-screen-recovery');
const latestPath = path.join(outDir, 'latest.json');
const checks = [];

function record(name, pass, detail = null, severity = 'P1') {
  checks.push({ name, pass: Boolean(pass), detail, severity });
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

fs.mkdirSync(outDir, { recursive: true });

const main = read('electron/main.js');
const preload = read('electron/preload.js');
const pkg = JSON.parse(read('package.json'));

const evidenceRun = spawnSync(process.execPath, ['scripts/collect-electron-black-screen-incident.js'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 8000,
});

record('incident_evidence_collector_runs', evidenceRun.status === 0, {
  status: evidenceRun.status,
  stdout: evidenceRun.stdout.trim().slice(0, 1000),
  stderr: evidenceRun.stderr.trim().slice(0, 1000),
}, 'P1');

record('refresh_custom_action_registered', main.includes("label: 'Refresh TARX'") && main.includes("refreshTarx('menu-refresh')"), null, 'P0');
record('previous_route_stored_before_refresh', main.includes('previousRouteBeforeRefresh = currentWebContentsUrl()') && main.includes("writeDiagnostic('latest-refresh.json'"), null, 'P0');
record('renderer_heartbeat_timer_after_refresh', main.includes('armRendererReadyTimer(`refresh:${trigger}`') && main.includes('RENDERER_READY_TIMEOUT_MS'), null, 'P0');
record('renderer_ready_signal_from_preload', preload.includes("ipcRenderer.send('tarx:renderer-ready'") && preload.includes("notifyRendererReady('domcontentloaded')"), null, 'P0');
record('main_receives_renderer_ready', main.includes("ipcMain.on('tarx:renderer-ready'") && main.includes('markRendererReady(payload)'), null, 'P0');
record('timeout_shows_safe_shell', main.includes("showSafeShell('renderer_ready_timeout'") && main.includes('The workspace failed to load.'), null, 'P0');
record('did_fail_load_recovery', main.includes("mainWindow.webContents.on('did-fail-load'") && main.includes('handleLoadFailure(errorCode, errorDesc, validatedUrl)'), null, 'P0');
record('render_process_gone_recovery', main.includes("mainWindow.webContents.on('render-process-gone'") && main.includes("showSafeShell('render_process_gone'"), null, 'P0');
record('unresponsive_recovery', main.includes("mainWindow.webContents.on('unresponsive'") && main.includes("showSafeShell('renderer_unresponsive'"), null, 'P0');
record('missing_bridge_safe_shell', main.includes("showSafeShell('primary_and_fallback_unreachable'") && !main.includes("mainWindow?.loadFile(path.join(__dirname, 'offline.html'))"), null, 'P0');
record('safe_mode_flag', main.includes("process.env.TARX_SAFE_MODE === '1'") && main.includes("'--tarx-safe-mode'"), null, 'P0');
record('safe_mode_skips_runtime_boot', main.includes('if (!SAFE_MODE) await ensureLocalRuntime()'), null, 'P0');
record('safe_mode_bypasses_voice_injection', main.includes('if (safeShellVisible || SAFE_MODE)') && main.includes("showSafeShell('safe_mode_boot'"), null, 'P0');
record('safe_shell_recovery_actions_visible', ['Reload', 'Restart app', 'Open safe mode', 'Copy diagnostics', 'Open logs', 'Quit'].every((label) => main.includes(label)), null, 'P0');
record('safe_shell_exposes_version_route_error', ['Version', 'Last route', 'First error'].every((label) => main.includes(label)), null, 'P0');
record('preload_exposes_safe_recovery', preload.includes('safeRecovery') && preload.includes('copyDiagnostics') && preload.includes('openLogs'), null, 'P0');
record('refresh_api_exposed', preload.includes('refreshTarx') && main.includes("ipcMain.handle('tarx:refresh'"), null, 'P1');
record('local_operator_flags_do_not_enable_execution', main.includes('execution_enabled: false') && main.includes("supercomputer_default_off: true"), null, 'P0');
record('voice_flags_do_not_change_release_voice', main.includes('production_voice_claim: false') && main.includes('VOICE_BROWSER_FALLBACK_ENABLED') && main.includes("process.env.TARX_VOICE_BROWSER_FALLBACK === '1'"), null, 'P0');
const recoverySlice = main.slice(main.indexOf('function showSafeShell'), main.indexOf("ipcMain.handle('tarx:vision-observe'"));
record('no_user_data_deletion_in_recovery', !/rmSync|removeSync|unlinkSync|full-wipe-confirm|vault-reset/.test(recoverySlice), null, 'P0');
record('qa_script_registered', pkg.scripts['qa:electron-black-screen-recovery'] === 'node scripts/qa-electron-black-screen-recovery.js', pkg.scripts['qa:electron-black-screen-recovery'] || null, 'P1');

const failed = checks.filter((check) => !check.pass);
const result = {
  schema: 'tarx-electron-black-screen-recovery-qa.v1',
  generated_at: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'electron_black_screen_recovery_green' : 'electron_black_screen_recovery_red',
  passed: checks.length - failed.length,
  failed: failed.length,
  firstBlocker: failed[0]?.name || null,
  evidence_path: '/Users/master/.tarx/runs/electron-black-screen-incident/latest.json',
  checks,
};

fs.writeFileSync(latestPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
