#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const checks = [];
const record = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail });
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

const pkg = JSON.parse(read('package.json'));
const main = read('electron/main.js');
const configPath = 'build/electron-builder.voice-beta.yml';
const workflowPath = '.github/workflows/voice-beta-electron.yml';
const config = exists(configPath) ? read(configPath) : '';
const workflow = exists(workflowPath) ? read(workflowPath) : '';
const entitlements = read('build/entitlements.mac.plist');

record('voice_beta.script_exists', Boolean(pkg.scripts['build:voice-beta']), pkg.scripts['build:voice-beta'] || '');
record('voice_beta.contract_script_exists', Boolean(pkg.scripts['qa:voice-beta-package-contract']), pkg.scripts['qa:voice-beta-package-contract'] || '');
record('voice_beta.builder_config_exists', exists(configPath), configPath);
record('voice_beta.separate_app_id', config.includes('appId: com.tarxan.tarx.voicebeta'), 'com.tarxan.tarx.voicebeta');
record('voice_beta.separate_product_name', config.includes('productName: TARX Voice Beta'), 'TARX Voice Beta');
record('voice_beta.no_publish', config.includes('publish: null'), 'publish disabled');
record('voice_beta.hardened_runtime', config.includes('hardenedRuntime: true'), 'hardened runtime');
record('voice_beta.entitlements_reused', config.includes('entitlements: build/entitlements.mac.plist'), 'entitlements file');
record('voice_beta.microphone_usage_copy', config.includes('NSMicrophoneUsageDescription'), 'microphone usage copy');
record('voice_beta.desktop_url_metadata', config.includes('tarxDesktopUrl: http://localhost:5173'), 'baked localhost beta metadata url');
record('voice_beta.main_reads_metadata_url', main.includes('packagedTarxDesktopUrl()') && main.includes('tarxDesktopUrl'), 'main metadata read');
record('voice_beta.main_keeps_prod_default', main.includes("|| 'https://tarx.com'"), 'prod default stays tarx.com');
record('voice_beta.env_override_still_available', main.includes('TARX_DESKTOP_URL') && main.includes('TARX_VOICE_BETA_DESKTOP_URL'), 'dev overrides');
record('voice_beta.microphone_entitlement', entitlements.includes('com.apple.security.device.microphone'), 'microphone entitlement');
record('voice_beta.audio_input_entitlement', entitlements.includes('com.apple.security.device.audio-input'), 'audio input entitlement');
record('voice_beta.github_workflow_exists', exists(workflowPath), workflowPath);
record('voice_beta.github_workflow_uses_csc_link', workflow.includes('CSC_LINK') && workflow.includes('APPLE_DEVELOPER_ID_CERT_P12'), 'GitHub signing cert secret');
record('voice_beta.github_workflow_uploads_artifacts', workflow.includes('actions/upload-artifact') && workflow.includes('dist-voice-beta'), 'artifact upload');

const failed = checks.filter((check) => !check.pass);
const outDir = path.join(root, 'dist-voice-beta-proof');
fs.mkdirSync(outDir, { recursive: true });
const result = {
  ts: new Date().toISOString(),
  ok: failed.length === 0,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
  firstBlocker: failed[0]?.name || 'signed_voice_beta_package_build_pending',
  fingerprint: failed.length === 0 ? 'voice_beta.package_contract_green_build_pending' : 'voice_beta.package_contract_red',
};
fs.writeFileSync(path.join(outDir, 'latest-package-contract.json'), `${JSON.stringify(result, null, 2)}
`);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
