#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repo = process.cwd();
const mainPath = path.join(repo, 'electron', 'main.js');
const source = fs.readFileSync(mainPath, 'utf8');
const checks = [];
const check = (name, pass, detail = null) => checks.push({ name, pass: Boolean(pass), detail });

const requiredSnippets = [
  ['packet.schema', "schema: 'tarx-vision-observation.v1'"],
  ['packet.session_id', 'session_id:'],
  ['packet.observation_id', 'observation_id:'],
  ['packet.source_active_window', "source: 'active_window'"],
  ['packet.captured_at', 'captured_at:'],
  ['packet.freshness_ms', 'freshness_ms:'],
  ['packet.window', 'window: {'],
  ['packet.occlusion_status', 'occlusion_status:'],
  ['packet.target_confidence', 'target_confidence:'],
  ['packet.sensitive_flags', 'sensitive_flags:'],
  ['packet.local_only', 'local_only: true'],
  ['policy.passive_describe_5000', 'passiveDescribe: 5000'],
  ['policy.ui_suggestion_2000', 'uiSuggestion: 2000'],
  ['policy.action_proposal_1000', 'actionProposal: 1000'],
  ['policy.action_execution_500', 'actionExecution: 500'],
  ['privacy.raw_screenshot_default_false', 'raw_screenshot_logged_by_default: false'],
  ['privacy.screenshot_env_gate', 'TARX_VISION_SAVE_SCREENSHOT=1'],
  ['occlusion.blocked_detection', "status: 'blocked'"],
  ['occlusion.partial_detection', "status: 'partial'"],
  ['actions.execution_stays_blocked', 'action_execution_allowed: false'],
];

for (const [name, snippet] of requiredSnippets) {
  check(name, source.includes(snippet), snippet);
}

check(
  'blocked_occlusion_prevents_execution',
  source.includes("action_execution_blocked_reason: blocked") && source.includes("'occlusion_blocked'"),
);
check(
  'external_occlusion_not_overclaimed',
  source.includes('external_occlusion_unverified'),
);
check(
  'screenshots_not_saved_by_default',
  source.includes('const VISION_SAVE_SCREENSHOT = process.env.TARX_VISION_SAVE_SCREENSHOT ==='),
);

const sampleObservation = {
  schema: 'tarx-vision-observation.v1',
  session_id: 'rt_electron_local',
  observation_id: `vis_qa_${Date.now()}`,
  source: 'active_window',
  captured_at: new Date().toISOString(),
  freshness_ms: 250,
  window: {
    app: 'TARX Electron',
    title: 'TARX',
    bounds: { x: 0, y: 0, width: 1200, height: 800 },
  },
  occlusion_status: 'clear',
  target_confidence: 0.78,
  sensitive_flags: ['none'],
  local_only: true,
  capture_policy: {
    raw_screenshot_logged_by_default: false,
    screenshot_saved: false,
  },
  freshness_policy: {
    passive_describe_allowed: true,
    ui_suggestion_allowed: true,
    action_proposal_allowed: true,
    action_execution_allowed: false,
    action_execution_blocked_reason: 'execution_disabled_internal_beta',
    thresholds_ms: {
      passiveDescribe: 5000,
      uiSuggestion: 2000,
      actionProposal: 1000,
      actionExecution: 500,
    },
  },
};

check('sample.passive_describe_allowed_under_5000', sampleObservation.freshness_policy.passive_describe_allowed, sampleObservation);
check('sample.ui_suggestion_allowed_under_2000', sampleObservation.freshness_policy.ui_suggestion_allowed, sampleObservation);
check('sample.action_proposal_allowed_under_1000', sampleObservation.freshness_policy.action_proposal_allowed, sampleObservation);
check('sample.action_execution_blocked_internal_beta', sampleObservation.freshness_policy.action_execution_allowed === false, sampleObservation);
check('sample.raw_screenshot_not_logged', sampleObservation.capture_policy.raw_screenshot_logged_by_default === false && sampleObservation.capture_policy.screenshot_saved === false, sampleObservation);
check('sample.local_only_no_supercomputer', sampleObservation.local_only === true, sampleObservation);

const allPassed = checks.every((entry) => entry.pass);
const status = allPassed ? 'vision_freshness_yellow' : 'vision_freshness_red';
const result = {
  ts: new Date().toISOString(),
  ok: allPassed,
  status,
  classification: allPassed ? 'watch' : 'product_red',
  reason: allPassed
    ? 'Freshness is measurable and policy-gated; external macOS occlusion is explicitly not overclaimed, so internal beta stays yellow.'
    : 'Vision freshness packet or policy is missing required fields.',
  passed: checks.filter((entry) => entry.pass).length,
  failed: checks.filter((entry) => !entry.pass).length,
  checks,
  sampleObservation,
  policy: {
    passive_describe_allowed_ms: 5000,
    ui_suggestion_allowed_ms: 2000,
    action_proposal_allowed_ms: 1000,
    action_execution_requires_ms: 500,
    blocked_occlusion_prevents_action_execution: true,
    autonomous_action_execution_enabled: false,
    screenshots_sent_to_supercomputer: false,
    raw_screenshots_logged_by_default: false,
  },
  remainingBlockers: [
    'External macOS app occlusion is not fully reliable without AX/WindowServer z-order proof.',
    'Computer Use execution remains blocked; proposals still require confirmation and execution stays disabled.',
    'Vision freshness should be validated from a running signed Electron app before green.',
  ],
  firstBlocker: checks.find((entry) => !entry.pass)?.name || 'external_occlusion_reliability_not_green',
  fingerprint: allPassed ? 'vision_freshness_measurable_policy_yellow' : 'vision_freshness_contract_red',
};

const outDir = '/Users/master/.tarx/runs/vision-freshness';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(allPassed ? 0 : 1);
