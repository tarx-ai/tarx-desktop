#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mainPath = path.join(root, 'electron', 'main.js');
const pkgPath = path.join(root, 'package.json');
const main = fs.readFileSync(mainPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const checks = [];

function record(name, pass, detail = null, severity = 'P0') {
  checks.push({ name, pass: Boolean(pass), detail, severity });
}

record(
  'exact_app_origin_allowlist',
  main.includes("const PRODUCTION_APP_ORIGINS = new Set(['https://tarx.com', 'https://www.tarx.com']);"),
  'allowed production origins must be exact app origins'
);
record(
  'no_wildcard_tarx_subdomain_allow',
  !/includes\(['"]tarx\.com['"]\)/.test(main) && !/\*\.tarx\.com/.test(main),
  'docs.tarx.com must not be first-party just because it contains tarx.com'
);
record(
  'navigation_guard_installed',
  main.includes("mainWindow.webContents.on('will-navigate'") && main.includes("mainWindow.webContents.on('will-redirect'"),
  'top-level navigation and redirects must be guarded'
);
record(
  'new_windows_guarded',
  main.includes('setWindowOpenHandler') && main.includes("openExternalUrl(url, 'new-window')"),
  'new windows for external origins must open externally'
);
record(
  'external_urls_use_system_browser',
  main.includes('shell.openExternal(url)') && main.includes('openExternalUrl(url'),
  'external docs/marketing/reference URLs must use the system browser'
);
record(
  'docs_not_allowed_origin',
  !/PRODUCTION_APP_ORIGINS[\s\S]*docs\.tarx\.com/.test(main),
  'docs.tarx.com must stay outside the app-origin allowlist'
);
record(
  'pricing_redirect_cannot_trap_docs_in_app',
  main.includes('external_redirect_blocked') && main.includes('safeAppFallbackUrl'),
  '/pricing or other app redirects to docs must be blocked and recover to the app'
);
record(
  'auth_callback_preserved',
  main.includes('tarx://auth/callback') && main.includes('/api/auth/callback/resend'),
  'magic-link auth callback must remain handled'
);
record(
  'desktop_entry_is_agentic_chat',
  main.includes("const APP_ENTRY_PATH = process.env.TARX_DESKTOP_ENTRY || '/chat'") &&
    main.includes('function appEntryUrl') &&
    main.includes('loadRouteWithRecovery(appEntryUrl(PRIMARY_URL), \'load_best_primary\')'),
  'Desktop must boot into /chat (agentic contract), not root → /home'
);
record(
  'no_legacy_home_entry_default',
  !main.includes("lastAllowedAppUrl = 'https://tarx.com/home'") &&
    !main.includes("return isAllowedAppUrl(lastAllowedAppUrl) ? lastAllowedAppUrl : 'https://tarx.com/home'"),
  'legacy /home must not be the Desktop fallback entry'
);
record(
  'auth_callback_lands_on_chat',
  main.includes('callbackUrl=${entryCallback}') || main.includes("callbackUrl=%2Fchat"),
  'post-auth redirect must land on APP_ENTRY_PATH (/chat)'
);
record(
  'update_feed_preserved',
  pkg.build?.publish?.url === 'https://tarx.com/api/download/electron',
  pkg.build?.publish?.url || null,
  'P1'
);

const failed = checks.filter((check) => !check.pass);
const result = {
  schema: 'tarx-electron-navigation-boundary-qa.v1',
  generated_at: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'electron_navigation_boundary_green' : 'electron_navigation_boundary_red',
  passed: checks.length - failed.length,
  failed: failed.length,
  firstBlocker: failed[0]?.name || null,
  checks,
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
