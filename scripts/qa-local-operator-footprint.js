#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.cwd();
const manifestPath = path.join(root, 'resources', 'local-operator-packs.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function safeExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function dirBytes(target) {
  if (!fs.existsSync(target)) return 0;
  const out = safeExec('/usr/bin/du', ['-sk', target]);
  const kb = Number(out.split(/\s+/)[0] || 0);
  return kb * 1024;
}

function resolvePackPath(value) {
  return String(value || '').replace(/^~(?=$|\/)/, '/Users/master');
}

function pidForPort(port) {
  if (!port) return null;
  const out = safeExec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  const pid = out.split(/\s+/).find(Boolean);
  return pid || null;
}

function processStats(pid) {
  if (!pid) return null;
  const out = safeExec('/bin/ps', ['-o', 'pid=,pcpu=,rss=,comm=', '-p', String(pid)]);
  const match = out.match(/^\s*(\d+)\s+([0-9.]+)\s+(\d+)\s+(.+)$/);
  if (!match) return { pid, running: true, raw: out };
  return {
    pid: Number(match[1]),
    cpu_percent: Number(match[2]),
    rss_bytes: Number(match[3]) * 1024,
    command: match[4],
  };
}

function fileBytes(target) {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
  }
}

function mb(bytes) {
  return Number((Number(bytes || 0) / 1024 / 1024).toFixed(2));
}

function scanForBundledPayloads(target) {
  const hits = [];
  const blocked = /\.(gguf|ggml|onnx|safetensors|pt|pth|ckpt|tflite|wav|webm|flac|mp3|jsonl)$/i;
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['.tarx', 'runs', 'models', 'diagnostics', 'voice-captures', 'vision-observations'].includes(entry.name)) {
          hits.push({ path: full, reason: 'blocked_directory' });
          continue;
        }
        walk(full);
      } else if (blocked.test(entry.name)) {
        hits.push({ path: full, reason: 'blocked_extension', bytes: fileBytes(full) });
      }
    }
  }
  walk(target);
  return hits;
}

function serviceFor(name, port) {
  const pid = pidForPort(port);
  return {
    name,
    port,
    running: Boolean(pid),
    pid: pid ? Number(pid) : null,
    process: processStats(pid),
  };
}

const packs = manifest.packs.map((pack) => {
  const installedPath = resolvePackPath(pack.installed_path);
  return {
    id: pack.id,
    version: pack.version,
    model_service_name: pack.model_service_name,
    expected_size: pack.expected_size,
    installed_path: installedPath,
    checksum: pack.checksum,
    required_ports: pack.required_ports,
    health_check_url: pack.health_check_url,
    install_status: fs.existsSync(installedPath) ? 'installed' : 'missing',
    installed_size_bytes: dirBytes(installedPath),
  };
});

const services = {
  bridge: serviceFor('Bridge', 11440),
  whisper: serviceFor('Whisper STT', 11447),
  tts: serviceFor('TTS', 11446),
  context: serviceFor('Gemma/context worker', 11435),
};

const portsInUse = [11440, 11435, 11446, 11447].map((port) => ({ port, pid: pidForPort(port) }));
const electronAppSizeBytes = dirBytes(root);
const packagedAppPath = path.join(root, 'dist', 'mac-arm64', 'TARX.app');
const dmgPath = path.join(root, 'dist', 'TARX-1.1.8-arm64.dmg');
const zipPath = path.join(root, 'dist', 'TARX-1.1.8-arm64-mac.zip');
const packagedAppSizeBytes = dirBytes(packagedAppPath);
const dmgSizeBytes = fileBytes(dmgPath);
const zipSizeBytes = fileBytes(zipPath);
const packagedPayloadHits = scanForBundledPayloads(packagedAppPath)
  .filter((hit) => !hit.path.includes('v8_context_snapshot'));
const missingServices = Object.values(services).filter((service) => !service.running).map((service) => service.name);
const footprintOk = packagedPayloadHits.length === 0;
const result = {
  ts: new Date().toISOString(),
  ok: footprintOk,
  status: footprintOk ? 'local_operator_footprint_measured' : 'local_operator_footprint_payload_red',
  classification: footprintOk ? 'watch' : 'product_red',
  electronAppSizeBytes,
  electronAppSizeMB: mb(electronAppSizeBytes),
  packagedArtifacts: {
    appPath: packagedAppPath,
    appSizeBytes: packagedAppSizeBytes,
    appSizeMB: mb(packagedAppSizeBytes),
    dmgPath,
    dmgSizeBytes,
    dmgSizeMB: mb(dmgSizeBytes),
    zipPath,
    zipSizeBytes,
    zipSizeMB: mb(zipSizeBytes),
    sizeComparison: {
      beforeAfterAvailable: false,
      note: 'Current package artifacts measured; no clean pre-control-plane rebuild artifact exists for delta comparison.',
    },
  },
  packs,
  expectedPackSizePlaceholders: Object.fromEntries(packs.map((pack) => [pack.id, pack.expected_size])),
  services,
  portsInUse,
  diskPaths: {
    electronRepo: root,
    packManifest: manifestPath,
    tarxHome: '/Users/master/.tarx',
    modelRoot: '/Users/master/.tarx/models',
  },
  coldStartEstimates: {
    electron: 'not measured by source-only QA',
    bridge: services.bridge.running ? 'running' : 'missing',
    whisper: services.whisper.running ? 'running' : 'missing',
    tts: services.tts.running ? 'running' : 'missing',
    context: services.context.running ? 'running' : 'missing',
  },
  missingServices,
  noHeavyModelsBundledInElectron: packs.every((pack) => !pack.installed_path.startsWith(root)),
  packagedPayloadScan: {
    appScanned: fs.existsSync(packagedAppPath),
    forbiddenPayloadHits: packagedPayloadHits,
    noForbiddenPayloads: packagedPayloadHits.length === 0,
  },
  firstBlocker: packagedPayloadHits[0] ? 'packaged_app_contains_forbidden_payload' : (missingServices[0] ? `missing_service:${missingServices[0]}` : null),
  fingerprint: `local_operator_footprint_measured__missing_${missingServices.length}`,
};

const outDir = '/Users/master/.tarx/runs/local-operator-footprint';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
