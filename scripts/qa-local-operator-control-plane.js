#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifestPath = path.join(root, 'resources', 'local-operator-packs.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const manifestBytes = fs.statSync(manifestPath).size;
const voiceBetaConfigPath = path.join(root, 'build', 'electron-builder.voice-beta.yml');
const voiceBetaConfig = fs.existsSync(voiceBetaConfigPath) ? fs.readFileSync(voiceBetaConfigPath, 'utf8') : '';
const checks = [];
const check = (name, pass, detail = null) => checks.push({ name, pass: Boolean(pass), detail });

const flags = [
  'TARX_VOICE_NATIVE_CAPTURE',
  'TARX_VOICE_BROWSER_FALLBACK',
  'TARX_VOICE_LOCAL_PACK',
  'TARX_VISION_LOCAL_PACK',
  'TARX_ACTION_PROPOSALS',
  'TARX_LOCAL_OPERATOR_BETA',
  'TARX_SUPERCOMPUTER_ESCALATION',
];

for (const flag of flags) {
  check(`flag.${flag}.declared`, main.includes(flag), flag);
  check(`flag.${flag}.defaults_off`, main.includes(`${flag}: process.env.${flag} === '1'`) || main.includes(`process.env.${flag} === '1'`), flag);
}

check('control_plane.ipc_handler_exists', main.includes("ipcMain.handle('tarx:local-operator-control-plane'"), null);
check('control_plane.preload_exposes_internal_bridge', preload.includes('localOperator: tarxLocalOperatorBridge'), null);
check('control_plane.ui_hidden_without_internal_flag', main.includes("visibility: LOCAL_OPERATOR_FLAGS.TARX_LOCAL_OPERATOR_BETA ? 'internal' : 'hidden'"), null);
check('control_plane.bridge_detection', main.includes("http://127.0.0.1:11440/health"), null);
check('control_plane.native_capture_hook_inert_without_flag', main.includes('if (!VOICE_NATIVE_CAPTURE_ENABLED)') && main.includes('TARX_VOICE_NATIVE_CAPTURE_disabled'), null);
check('control_plane.browser_fallback_labeled', main.includes('available_fallback_only') && main.includes('browser_capture_is_fallback'), null);
check('control_plane.supercomputer_off', main.includes("supercomputer: LOCAL_OPERATOR_FLAGS.TARX_SUPERCOMPUTER_ESCALATION ? 'requires_explicit_approval' : 'off'"), null);
check('control_plane.action_proposals_gated', main.includes('enableActionProposals') && main.includes('execution_enabled: false'), null);
check('control_plane.no_raw_private_logs', main.includes('raw_audio_logged_by_default: false') && main.includes('raw_screenshots_logged_by_default: false') && main.includes('full_transcripts_logged_by_default: false'), null);
check('control_plane.no_production_claims', main.includes('production_voice_claim: false') && main.includes('daniel_approved: false') && main.includes('vision_green_claim: false'), null);
for (const forbiddenClaim of ['production voice', 'Jarvis', 'autonomous operator', 'always-on', 'bundled local models', 'Supercomputer enabled']) {
  const haystack = `${main}\n${preload}`;
  check(`public_claims.no_${forbiddenClaim.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`, !haystack.toLowerCase().includes(forbiddenClaim.toLowerCase()), forbiddenClaim);
}

check('manifest.schema_present', manifest.schema === 'tarx-local-operator-packs.v1', manifest.schema);
check('manifest.small_file', manifestBytes < 20 * 1024, { bytes: manifestBytes });
check('manifest.no_embedded_binaries', !/base64|data:|downloadUrl|autoDownload|signedUrl/i.test(JSON.stringify(manifest)), { bytes: manifestBytes });
check('manifest.no_auto_download_behavior', !main.includes('downloadLocalVoicePack') && !main.includes('autoDownloadPack'), null);
const expectedPacks = ['voice-stt-whisper-base-en-int8', 'voice-tts-kokoro-daniel', 'context-gemma-worker', 'vision-observer'];
for (const id of expectedPacks) {
  const pack = manifest.packs.find((entry) => entry.id === id);
  check(`manifest.${id}.exists`, Boolean(pack), pack || null);
  if (pack) {
    check(`manifest.${id}.has_version`, Boolean(pack.version), pack);
    check(`manifest.${id}.has_service_name`, Boolean(pack.model_service_name), pack);
    check(`manifest.${id}.has_expected_size`, Boolean(pack.expected_size), pack);
    check(`manifest.${id}.has_installed_path`, Boolean(pack.installed_path), pack);
    check(`manifest.${id}.has_checksum`, Boolean(pack.checksum), pack);
    check(`manifest.${id}.has_required_ports`, Array.isArray(pack.required_ports), pack);
    check(`manifest.${id}.missing_safe`, pack.install_status === 'missing', pack);
  }
}

const largeBundledFiles = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'out', '.git'].includes(entry.name)) continue;
      walk(full);
    } else {
      const stat = fs.statSync(full);
      if (stat.size > 25 * 1024 * 1024) largeBundledFiles.push({ path: full, bytes: stat.size });
    }
  }
}
walk(path.join(root, 'resources'));
check('bundle.no_heavy_model_payloads', largeBundledFiles.length === 0, largeBundledFiles);
const packageFiles = JSON.stringify(pkg.build?.files || []);
const requiredExclusions = [
  '!**/.tarx/**',
  '!**/runs/**',
  '!**/diagnostics/**',
  '!**/models/**',
  '!**/*.gguf',
  '!**/*.ggml',
  '!**/*.onnx',
  '!**/*.safetensors',
  '!**/*.wav',
  '!**/*.jsonl',
];
for (const exclusion of requiredExclusions) {
  check(`package_exclusion.primary.${exclusion}`, packageFiles.includes(exclusion), exclusion);
  check(`package_exclusion.voice_beta.${exclusion}`, voiceBetaConfig.includes(exclusion), exclusion);
}
check('package.qa_script_registered', pkg.scripts['qa:local-operator-control-plane'] === 'node scripts/qa-local-operator-control-plane.js', pkg.scripts['qa:local-operator-control-plane']);

const ok = checks.every((entry) => entry.pass);
const result = {
  ts: new Date().toISOString(),
  ok,
  status: ok ? 'local_operator_control_plane_green' : 'local_operator_control_plane_red',
  classification: ok ? 'green' : 'product_red',
  passed: checks.filter((entry) => entry.pass).length,
  failed: checks.filter((entry) => !entry.pass).length,
  checks,
  flagsDefaultOff: flags,
  manifestPath,
  manifestBytes,
  noHeavyModelsBundled: largeBundledFiles.length === 0,
  firstBlocker: checks.find((entry) => !entry.pass)?.name || null,
  fingerprint: ok ? 'local_operator_control_plane_green_flags_off_no_models' : 'local_operator_control_plane_red',
};

const outDir = '/Users/master/.tarx/runs/local-operator-control-plane';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
