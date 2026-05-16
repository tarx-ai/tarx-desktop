#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const checks = [];
const check = (name, pass, detail = null) => checks.push({ name, pass: Boolean(pass), detail });
const manifestPath = path.join(root, 'resources', 'voice-pronunciation-rules.json');
const docPath = path.join(root, 'docs', 'TARX_VOICE_PRONUNCIATION_RULES.md');
const decisionPath = path.join(root, 'docs', 'TARX_LOCAL_OPERATOR_INTERNAL_BETA_DECISION_PACKET.md');
const statusPath = path.join(root, 'docs', 'TARX_LOCAL_OPERATOR_CONTROL_PLANE_STATUS.md');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const doc = fs.readFileSync(docPath, 'utf8');
const decision = fs.readFileSync(decisionPath, 'utf8');
const status = fs.readFileSync(statusPath, 'utf8');
const rule = manifest.rules.find((entry) => entry.token === 'TARX');

check('manifest.schema', manifest.schema === 'tarx-voice-pronunciation-rules.v1', manifest.schema);
check('manifest.tarx_rule_exists', Boolean(rule), rule || null);
check('manifest.display_tarx', rule?.display === 'TARX', rule?.display);
check('manifest.spoken_tars', rule?.spoken === 'TARS', rule?.spoken);
check('manifest.system_rule_text', /Always write\/display TARX as TARX\. Always speak\/pronounce TARX as TARS\./.test(rule?.rule || ''), rule?.rule);
check('manifest.tts_scope', rule?.scope?.includes('tts'), rule?.scope);
check('manifest.voice_qa_scope', rule?.scope?.includes('voice_qa'), rule?.scope);
check('manifest.stt_acceptance_scope', rule?.scope?.includes('stt_acceptance'), rule?.scope);
check('doc.system_rule', doc.includes('Speak and pronounce it as **TARS**'), null);
check('doc.bad_pronunciation_blocks_brand_gate', doc.includes('cannot pass the brand gate'), null);
check('decision.operator_instruction', decision.includes('Display/write `TARX`; speak/pronounce it as `TARS`.'), null);
check('decision.required_phrase_spoken_hint', decision.includes('spoken as “TARS, what are we working on today?”'), null);
check('status.next_blocker_spoken_hint', status.includes('spoken as “TARS, what are we working on today?”'), null);

const failed = checks.filter((entry) => !entry.pass);
const result = {
  ts: new Date().toISOString(),
  ok: failed.length === 0,
  status: failed.length === 0 ? 'voice_pronunciation_rule_green' : 'voice_pronunciation_rule_red',
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
  firstBlocker: failed[0]?.name || null,
  fingerprint: failed.length === 0 ? 'tarx_spoken_as_tars_rule_green' : 'tarx_pronunciation_rule_red'
};
const outDir = '/Users/master/.tarx/runs/voice-pronunciation-rule';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
