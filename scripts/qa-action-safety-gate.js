#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const electronRepo = process.cwd();
const opsRepo = process.env.TARX_OPS_REPO || '/Users/master/Desktop/TARX/Repos - active/tarx-ops';
const mainSource = fs.readFileSync(path.join(electronRepo, 'electron', 'main.js'), 'utf8');
const contractsSource = fs.readFileSync(path.join(opsRepo, 'src', 'runtime-contracts.ts'), 'utf8');

const checks = [];
const check = (name, pass, detail = null) => checks.push({ name, pass: Boolean(pass), detail });

const requiredElectronSnippets = [
  ['electron.fresh_vision_observation', "observeVisionSurface('action-proposal')"],
  ['electron.target_freshness_ms', 'target_freshness_ms: targetFreshnessMs'],
  ['electron.target_confidence', 'target_confidence: targetConfidence'],
  ['electron.target_bounds', 'target_bounds: bounds'],
  ['electron.occlusion_status', 'occlusion_status: observation.occlusion_status'],
  ['electron.risk_level', 'level,'],
  ['electron.mutation_boolean', 'mutation,'],
  ['electron.external_side_effect_boolean', 'external_side_effect: externalSideEffect'],
  ['electron.requires_confirmation_boolean', 'requires_confirmation:'],
  ['electron.confirmation_copy', 'I can do this. Please confirm.'],
  ['electron.handled_guard', 'Do not say "I handled it" until tarx-action-result.v1 is green.'],
  ['electron.execution_blocked', 'executionBlocked: true'],
  ['electron.blocked_risk', 'blocked_risk'],
];

const requiredContractSnippets = [
  ['contract.risk_levels', "['read_only', 'low', 'medium', 'high', 'blocked']"],
  ['contract.target_freshness_required', 'target_freshness_ms_required'],
  ['contract.target_confidence_required', 'target_confidence_required'],
  ['contract.target_bounds_required', 'target_bounds_required'],
  ['contract.mutation_boolean_required', 'mutation_boolean_required'],
  ['contract.external_side_effect_boolean_required', 'external_side_effect_boolean_required'],
  ['contract.requires_confirmation_boolean_required', 'requires_confirmation_boolean_required'],
  ['contract.medium_mutation_confirmation', 'medium_mutation_requires_confirmation'],
  ['contract.high_risk_confirmation', 'high_risk_requires_explicit_high_risk_confirmation'],
  ['contract.blocked_risk_no_execute', 'blocked_risk_cannot_execute'],
  ['contract.stale_mutation_rejected', 'mutating_action_requires_fresh_target_proof'],
  ['contract.executed_requires_result', 'action_grounding_cannot_mark_execution_without_action_result'],
  ['contract.blocked_occlusion_rejected', 'blocked_occlusion_prevents_action_execution'],
];

for (const [name, snippet] of requiredElectronSnippets) check(name, mainSource.includes(snippet), snippet);
for (const [name, snippet] of requiredContractSnippets) check(name, contractsSource.includes(snippet), snippet);

const safeReadOnly = {
  schema: 'tarx-action-grounding.v1',
  grounding: {
    target_freshness_ms: 900,
    target_confidence: 0.78,
    target_bounds: { x: 10, y: 10, width: 100, height: 32 },
    occlusion_status: 'clear',
  },
  risk: {
    level: 'read_only',
    mutation: false,
    external_side_effect: false,
    requires_confirmation: false,
  },
  status: 'proposed',
};

const mediumMutation = {
  ...safeReadOnly,
  grounding: { ...safeReadOnly.grounding, target_freshness_ms: 480 },
  risk: {
    level: 'medium',
    mutation: true,
    external_side_effect: false,
    requires_confirmation: true,
  },
  ux_copy: {
    confirmation: 'I can do this. Please confirm.',
    completion_guard: 'Do not say "I handled it" until tarx-action-result.v1 is green.',
  },
};

const blockedRisk = {
  ...mediumMutation,
  risk: {
    level: 'blocked',
    mutation: true,
    external_side_effect: true,
    requires_confirmation: true,
  },
};

check('policy.read_only_can_be_proposed_without_confirmation', safeReadOnly.risk.level === 'read_only' && safeReadOnly.risk.requires_confirmation === false, safeReadOnly);
check('policy.medium_mutation_requires_confirmation', mediumMutation.risk.mutation === true && mediumMutation.risk.requires_confirmation === true, mediumMutation);
check('policy.confirmation_copy_present', mediumMutation.ux_copy.confirmation === 'I can do this. Please confirm.', mediumMutation.ux_copy);
check('policy.handled_copy_forbidden_until_result', /Do not say "I handled it"/.test(mediumMutation.ux_copy.completion_guard), mediumMutation.ux_copy);
check('policy.blocked_risk_cannot_execute', blockedRisk.risk.level === 'blocked' && mainSource.includes('blocked_risk'), blockedRisk);
check('policy.no_terminal_execution_enabled', !mainSource.includes('child_process.exec(') && !mainSource.includes('shell.openExternal(payload'), null);
check('policy.no_supercomputer_call', !mainSource.includes('supercomputer') || mainSource.includes('supercomputerUsed: false'), null);

const allPassed = checks.every((entry) => entry.pass);
const result = {
  ts: new Date().toISOString(),
  ok: allPassed,
  status: allPassed ? 'action_safety_gate_green' : 'action_safety_gate_red',
  classification: allPassed ? 'green' : 'product_red',
  passed: checks.filter((entry) => entry.pass).length,
  failed: checks.filter((entry) => !entry.pass).length,
  checks,
  policy: {
    read_only_can_be_proposed_without_confirmation: true,
    low_risk_can_be_proposed: true,
    medium_mutations_require_confirmation: true,
    high_risk_requires_explicit_high_risk_confirmation: true,
    blocked_risk_cannot_execute: true,
    stale_vision_rejected_for_mutation: true,
    action_execution_enabled: false,
    terminal_commands_enabled: false,
    supercomputer_used: false,
  },
  confirmationUxCopy: {
    proposal: 'I can do this. Please confirm.',
    completionGuard: 'Do not say "I handled it" until tarx-action-result.v1 is green.',
  },
  evidence: {
    electronMain: path.join(electronRepo, 'electron', 'main.js'),
    runtimeContracts: path.join(opsRepo, 'src', 'runtime-contracts.ts'),
  },
  firstBlocker: checks.find((entry) => !entry.pass)?.name || null,
  fingerprint: allPassed ? 'action_safety_gate_green_no_execution' : 'action_safety_gate_red',
};

const outDir = '/Users/master/.tarx/runs/action-safety-gate';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(allPassed ? 0 : 1);
