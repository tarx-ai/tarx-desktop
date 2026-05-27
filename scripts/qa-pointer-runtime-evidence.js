#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const checks = [];
function record(name, pass, detail = null) {
  checks.push({ name, pass: Boolean(pass), detail });
}

record('ipc.pointer_context_registered', main.includes("ipcMain.handle('tarx:pointer-context'") && main.includes('return getPointerContext(payload || {})'), null);
record('preload.pointer_context_exposed', preload.includes('const tarxPointerBridge') && preload.includes("ipcRenderer.invoke('tarx:pointer-context'") && preload.includes('pointer: tarxPointerBridge'), null);
record('native_cursor_source_used', main.includes('screen.getCursorScreenPoint()') && main.includes("source: 'native_helper'"), null);
record('dom_target_real_element_from_point', main.includes('document.elementFromPoint') && main.includes("evidence_source: 'dom'"), null);
record('unknown_fallback_present', main.includes("unavailablePointerContext('pointer_evidence_missing')") && main.includes("source: 'unavailable'"), null);
record('freshness_model_present', main.includes('POINTER_FRESHNESS_POLICY_MS') && main.includes("freshness === 'fresh' || freshness === 'aging'"), null);
record('permission_model_present', main.includes('electronPointerPermissions') && main.includes('screen_recording') && main.includes('accessibility') && main.includes('input_monitoring'), null);
record('evidence_not_persisted', main.includes('persisted: false') && main.includes("writeDiagnostic('latest-pointer-context.json'"), null);
record('execute_available_false', main.includes('execute_available: false') && main.includes('execute_requires_confirmation: true'), null);
record('no_click_type_send_limits', main.includes('can_click: false') && main.includes('can_type: false') && main.includes('can_send: false'), null);
record('proposal_only_actions', main.includes("'Explain', 'Draft', 'Correct TARX', 'Do with me'") && main.includes('proposal_only: true'), null);
record('qa_script_registered', pkg.scripts['qa:pointer-runtime-evidence'] === 'node scripts/qa-pointer-runtime-evidence.js', pkg.scripts['qa:pointer-runtime-evidence'] || null);

const publicControlClaims = [
  'TARX can click',
  'TARX can type',
  'TARX can send',
  'native control enabled',
  'TARX is seeing your screen',
];
record('no_public_control_claims', !publicControlClaims.some((claim) => main.includes(claim) || preload.includes(claim)), null);

const failed = checks.filter((check) => !check.pass);
const result = {
  schema: 'tarx-pointer-runtime-evidence-qa.v1',
  ts: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'pointer_runtime_evidence_green' : 'pointer_runtime_evidence_red',
  firstBlocker: failed[0]?.name || null,
  checks,
  guardrails: {
    native_click_enabled: false,
    native_type_enabled: false,
    native_send_enabled: false,
    evidence_persisted_by_default: false,
  },
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
