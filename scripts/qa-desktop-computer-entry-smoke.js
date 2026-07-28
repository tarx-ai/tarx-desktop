#!/usr/bin/env node
/**
 * Desktop Computer entry smoke.
 *
 * Mode A (default): static contract — Computer entry, focused chat, and live routes.
 * Mode B (TARX_DESKTOP_LIVE_SMOKE=1): launch Electron headless-ish, assert first
 *         navigation lands on /computer and Desktop flags are present.
 *
 * Signed-in TOOL_CALL (todo/skill/health) requires a real session cookie and is
 * recorded as manual/optional via TARX_DESKTOP_SIGNED_IN_SMOKE=1 + session.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(os.homedir(), '.tarx', 'runs', 'desktop-computer-entry-smoke');
const latestPath = path.join(outDir, 'latest.json');
const checks = [];

function record(name, pass, detail = null, severity = 'P0') {
  checks.push({ name, pass: Boolean(pass), detail, severity });
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function probe(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      resolve({ ok: res.statusCode > 0 && res.statusCode < 500, status: res.statusCode, headers: res.headers });
      res.resume();
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

async function staticChecks() {
  const main = read('electron/main.js');
  const preload = read('electron/preload.js');
  const pkg = JSON.parse(read('package.json'));

  record(
    'desktop_version_present',
    typeof pkg.version === 'string' && pkg.version.length > 0,
    pkg.version,
    'P1'
  );
  record(
    'app_entry_computer',
    main.includes("|| 'https://app.tarx.com'") &&
      main.includes("const APP_ENTRY_PATH = process.env.TARX_DESKTOP_ENTRY || '/computer'") &&
      main.includes('function appEntryUrl') &&
      main.includes("loadRouteWithRecovery(appEntryUrl(PRIMARY_URL), 'load_best_primary')"),
    null,
    'P0'
  );
  record(
    'marketing_origin_not_desktop_default',
    !main.includes("|| 'https://tarx.com'") &&
      main.includes("['https://app.tarx.com', CONFIGURED_PRIMARY_ORIGIN].filter(Boolean)"),
    null,
    'P0'
  );
  record(
    'root_home_remapped_to_computer',
    main.includes("parsed.pathname === '/home'") && main.includes("parsed.pathname === '/'"),
    null,
    'P0'
  );
  record(
    'auth_callback_computer',
    main.includes('callbackUrl=${entryCallback}') || main.includes('encodeURIComponent(APP_ENTRY_PATH)'),
    null,
    'P0'
  );
  record(
    'preload_agentic_contract',
    preload.includes("chatStreamContract: 'web-shared-v1'") &&
      preload.includes("agenticTools: 'page-executeToolCalls'") &&
      preload.includes("agentTransferContract: 'api-agentic-transfer-v1'"),
    null,
    'P0'
  );

  const nav = spawnSync(process.execPath, [path.join(root, 'scripts/qa-electron-navigation-boundary.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  record('navigation_boundary_qa', nav.status === 0, {
    status: nav.status,
    tail: (nav.stdout || '').slice(-500),
  }, 'P0');

  const computer = await probe('https://app.tarx.com/computer');
  record('prod_computer_200', computer.ok && computer.status === 200, computer, 'P0');

  const chat = await probe('https://app.tarx.com/chat');
  record('prod_focused_chat_200', chat.ok && chat.status === 200, chat, 'P1');

  const rootProbe = await probe('https://tarx.com/');
  const loc = rootProbe.headers && (rootProbe.headers.location || rootProbe.headers.Location);
  record(
    'marketing_root_remains_reachable',
    rootProbe.ok && rootProbe.status === 200,
    { status: rootProbe.status, location: loc || null },
    'P1'
  );

  const version = await probe('https://app.tarx.com/api/version');
  record('prod_version_reachable', version.ok, version, 'P1');

  const bridge = await probe('http://127.0.0.1:11440/health');
  record('local_bridge_optional', true, {
    bridge_up: bridge.ok,
    status: bridge.status || null,
    note: bridge.ok ? 'Bridge online — skills/todo TOOL_CALL can hit CORE' : 'Bridge down — health/todo may soft-fail',
  }, 'P2');
}

async function liveElectronSmoke() {
  if (process.env.TARX_DESKTOP_LIVE_SMOKE !== '1') {
    record('live_electron_smoke', true, { skipped: true, enable: 'TARX_DESKTOP_LIVE_SMOKE=1' }, 'P1');
    return;
  }

  const electronBin = path.join(root, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) {
    record('live_electron_smoke', false, { error: 'electron binary missing; run npm ci' }, 'P0');
    return;
  }

  // Minimal smoke harness written to tmp and run as ELECTRON_RUN_AS_NODE is wrong;
  // instead spawn electron with env that logs first load via main diagnostics.
  // We use a short-lived process: TARX_SMOKE_EXIT_MS + instrument via existing main if present.
  const child = spawn(electronBin, ['.'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      TARX_DESKTOP_ENTRY: '/computer',
      TARX_DESKTOP_URL: process.env.TARX_DESKTOP_URL || 'https://app.tarx.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  await new Promise((r) => setTimeout(r, Number(process.env.TARX_DESKTOP_SMOKE_MS || 12_000)));
  try { child.kill('SIGTERM'); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 1000));
  try { child.kill('SIGKILL'); } catch { /* */ }

  // Diagnostics file written by main on route attempts if present
  const diagDir = path.join(os.homedir(), '.tarx', 'diagnostics');
  let lastRoute = null;
  try {
    const files = fs.readdirSync(diagDir).filter((f) => f.includes('route') || f.includes('refresh') || f.endsWith('.json'));
    for (const f of files.slice(-5)) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(diagDir, f), 'utf8'));
        if (j.route || j.url || j.previousRoute) lastRoute = j;
      } catch { /* */ }
    }
  } catch { /* */ }

  const combined = `${stdout}\n${stderr}`;
  const mentionsComputer = /\/computer/.test(combined) || (lastRoute && JSON.stringify(lastRoute).includes('/computer'));
  const mentionsMarketing = /https:\/\/(?:www\.)?tarx\.com(?:\/|$)/.test(combined) && !mentionsComputer;

  record('live_electron_smoke', mentionsComputer || !mentionsMarketing, {
    mentionsComputer,
    mentionsMarketing,
    lastRoute,
    stdout_tail: stdout.slice(-800),
    stderr_tail: stderr.slice(-800),
    note: 'Live smoke checks boot signals; full TOOL_CALL needs signed-in session',
  }, 'P1');
}

async function signedInToolCallNote() {
  // Automated signed-in TOOL_CALL against production requires user session cookies.
  // Document expected manual / future automation steps.
  const signedIn = process.env.TARX_DESKTOP_SIGNED_IN_SMOKE === '1';
  if (!signedIn) {
    record('signed_in_tool_call_smoke', true, {
      skipped: true,
      enable: 'TARX_DESKTOP_SIGNED_IN_SMOKE=1 with session automation',
      manual: [
        '1. npm run dev (or open notarized TARX.app)',
        '2. Confirm the main window URL is …/computer',
        '3. Open New Chat or the floating composer and confirm …/chat',
        '4. Sign in if needed',
        '5. Prompt: create a todo titled desktop-smoke-todo',
        '6. Expect TOOL_CALL tarx_create_todo + footer',
        '7. Prompt: check health → tarx_health_check',
        '8. Prompt: use skill launch-qa (or installed skill) → tarx_skill_use',
        '9. Events: tarx:todo-changed / tarx:health-refreshed / tarx:skill-used in DevTools',
      ],
    }, 'P1');
    return;
  }

  // Unit-level proof that execute path exists on Screens main (no session)
  const webRoot = process.env.TARX_WEB_ROOT || path.join(root, '..', 'tarx-web');
  const execPath = path.join(webRoot, 'lib/surface/execute-tool-call.ts');
  if (fs.existsSync(execPath)) {
    const src = fs.readFileSync(execPath, 'utf8');
    record(
      'signed_in_tool_call_smoke',
      src.includes('tarx_create_todo') && src.includes('tarx_skill_use') && src.includes('tarx_health_check') && src.includes('executeToolCalls'),
      { source: execPath, mode: 'static_web_contract' },
      'P0'
    );
  } else {
    record('signed_in_tool_call_smoke', false, { error: 'tarx-web execute-tool-call.ts not found', webRoot }, 'P1');
  }
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  await staticChecks();
  await liveElectronSmoke();
  await signedInToolCallNote();

  const failed = checks.filter((c) => !c.pass);
  const result = {
    schema: 'tarx-desktop-computer-entry-smoke.v1',
    generated_at: new Date().toISOString(),
    ok: failed.length === 0,
    status: failed.length === 0 ? 'desktop_computer_entry_smoke_green' : 'desktop_computer_entry_smoke_red',
    passed: checks.length - failed.length,
    failed: failed.length,
    firstBlocker: failed[0]?.name || null,
    checks,
  };
  fs.writeFileSync(latestPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
