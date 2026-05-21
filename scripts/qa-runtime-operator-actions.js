#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = process.cwd();
const readinessPath = path.join(repo, 'scripts', 'qa-runtime-spine-readiness.js');
const latestPath = path.join(os.homedir(), '.tarx', 'runs', 'runtime-spine-readiness', 'latest.json');
const source = fs.readFileSync(readinessPath, 'utf8');
const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));

const checks = [];
function record(name, pass, detail = null) {
  checks.push({ name, pass: Boolean(pass), detail });
}

const actions = Array.isArray(latest.operatorActions) ? latest.operatorActions : [];
const kinds = new Set(actions.map((action) => action.kind));

record('readiness_builds_operator_actions_array', source.includes('const operatorActions = [];'), null);
record('voice_action_preserved_when_present', source.includes('voiceOperatorAction') && source.includes('operatorActions.push(normalizedVoiceOperatorAction)'), null);
record('pointer_context_action_declared', source.includes("kind: 'local_pointer_context_proof'") && kinds.has('local_pointer_context_proof'), actions);
record('computer_use_proposal_action_declared', source.includes("kind: 'computer_use_action_proposal_proof'") && kinds.has('computer_use_action_proposal_proof'), actions);
record('human_training_action_declared', source.includes("kind: 'human_training_session_proof'") && kinds.has('human_training_session_proof'), actions);
record('mcp_boundary_action_declared', source.includes("kind: 'developer_runtime_mcp_boundary_review'") && kinds.has('developer_runtime_mcp_boundary_review'), actions);
record('next_action_is_product_label', typeof latest.nextAction === 'string' && latest.nextAction.length > 0 && !latest.nextAction.includes('npm run'), latest.nextAction);
record('parallel_next_actions_present', Array.isArray(latest.parallelNextActions) && latest.parallelNextActions.length >= 3, latest.parallelNextActions);
record('operator_actions_have_route_truth', actions.every((action) => action.routeTruth?.computer === true && action.routeTruth?.supercomputerUsed === false), actions);
record('operator_actions_do_not_claim_execution', actions.every((action) => action.guardrails?.noAutonomousExecution === true), actions);
record('operator_actions_have_evidence', actions.every((action) => action.evidence && Object.keys(action.evidence).length > 0), actions);

const allPassed = checks.every((check) => check.pass);
const result = {
  schema: 'tarx-runtime-operator-actions-qa.v1',
  ts: new Date().toISOString(),
  ok: allPassed,
  status: allPassed ? 'runtime_operator_actions_green' : 'runtime_operator_actions_red',
  passed: checks.filter((check) => check.pass).length,
  failed: checks.filter((check) => !check.pass).length,
  checks,
  evidence: {
    readinessScript: readinessPath,
    readinessLatest: latestPath,
  },
  firstBlocker: checks.find((check) => !check.pass)?.name || null,
};

const outDir = path.join(os.homedir(), '.tarx', 'runs', 'runtime-operator-actions');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(allPassed ? 0 : 1);
