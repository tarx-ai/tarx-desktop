#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_ROOT = process.cwd();
function findPackagedApp(root = DEFAULT_ROOT) {
  return findPackagedApps(root)[0] || null;
}

function findPackagedApps(root = DEFAULT_ROOT) {
  const candidates = [
    path.join(root, 'dist', 'mac-arm64', 'TARX.app'),
    path.join(root, 'dist', 'mac-x64', 'TARX.app'),
    path.join(root, 'dist', 'mac-universal', 'TARX.app'),
    path.join(root, 'dist', 'mac', 'TARX.app'),
    path.join(root, 'dist', 'TARX.app'),
  ];
  return candidates.filter((candidate) => fs.existsSync(candidate));
}

function walkFiles(startDir, visit) {
  if (!fs.existsSync(startDir)) return;
  for (const entry of fs.readdirSync(startDir, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.cache') continue;
    const full = path.join(startDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, visit);
      continue;
    }
    if (entry.isFile()) visit(full);
  }
}

function productionDependencyGraph(root = DEFAULT_ROOT) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ls', '--omit=dev', '--json', '--long', '--silent'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`npm ls failed: ${result.stderr || result.stdout || `exit ${result.status}`}`.trim());
  }
  return JSON.parse(result.stdout || '{}');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function packageHasNativeSignals(packageDir) {
  const pkgPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  const pkg = readJson(pkgPath);
  if (pkg?.gypfile || pkg?.binary) return true;
  if (Array.isArray(pkg?.os) || Array.isArray(pkg?.cpu)) return true;
  let hasNodeBinary = false;
  walkFiles(packageDir, (filePath) => {
    if (filePath.endsWith('.node')) hasNodeBinary = true;
  });
  return hasNodeBinary;
}

function collectProductionPackages(tree, root = DEFAULT_ROOT) {
  const packages = new Map();
  const visited = new Set();

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    const pkgPath = typeof node.path === 'string' ? node.path : null;
    const pkgName = typeof node.name === 'string' ? node.name : null;
    if (pkgPath && pkgName && pkgPath.includes(`${path.sep}node_modules${path.sep}`) && !visited.has(pkgPath)) {
      visited.add(pkgPath);
      packages.set(pkgName, { name: pkgName, path: pkgPath });
    }
    const deps = node.dependencies && typeof node.dependencies === 'object' ? node.dependencies : null;
    if (!deps) return;
    for (const child of Object.values(deps)) visit(child);
  }

  const deps = tree?.dependencies && typeof tree.dependencies === 'object' ? tree.dependencies : null;
  if (!deps) return [];
  for (const child of Object.values(deps)) visit(child);
  return [...packages.values()].filter((entry) => fs.existsSync(entry.path) || entry.path.startsWith(root));
}

function collectPackagedNodeFiles(packageDir) {
  const files = [];
  walkFiles(packageDir, (filePath) => {
    if (filePath.endsWith('.node')) files.push(filePath);
  });
  return files;
}

function asarUnpackPatterns(root = DEFAULT_ROOT) {
  try {
    const pkg = readJson(path.join(root, 'package.json'));
    return Array.isArray(pkg?.build?.asarUnpack) ? pkg.build.asarUnpack : [];
  } catch {
    return [];
  }
}

function matchesAsarUnpackPattern(packageName, patterns) {
  const target = `node_modules/${packageName}/`;
  return patterns.some((pattern) => {
    const normalized = String(pattern).replace(/\\/g, '/');
    return normalized.includes(target) || normalized.includes(`node_modules/${packageName}/**`) || normalized.includes(`node_modules/${packageName}`);
  });
}

function scanNativePackaging(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const packagedApps = options.packagedApps || (options.packagedApp ? [options.packagedApp] : findPackagedApps(root));
  if (!packagedApps.length) {
    throw new Error('missing packaged TARX.app in dist/. Run the mac build first.');
  }

  const dependencyGraph = options.dependencyGraph || productionDependencyGraph(root);
  const productionPackages = collectProductionPackages(dependencyGraph, root);
  const nativePackages = productionPackages.filter((entry) => packageHasNativeSignals(entry.path));
  const patterns = options.asarUnpackPatterns || asarUnpackPatterns(root);
  const report = [];
  const missing = [];

  for (const packagedApp of packagedApps) {
    const artifactLabel = path.basename(path.dirname(packagedApp));
    for (const entry of nativePackages) {
      const packagedDir = path.join(packagedApp, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', ...entry.name.split('/'));
      const packagedExists = fs.existsSync(packagedDir);
      const packagedFiles = packagedExists ? collectPackagedNodeFiles(packagedDir) : [];
      const hasUnpackPattern = matchesAsarUnpackPattern(entry.name, patterns);
      const ok = packagedExists && packagedFiles.length > 0 && hasUnpackPattern;
      report.push({
        artifact_label: artifactLabel,
        artifact_path: packagedApp,
        package: entry.name,
        source_path: entry.path,
        unpack_pattern_present: hasUnpackPattern,
        packaged_dir: packagedDir,
        packaged_exists: packagedExists,
        packaged_node_files: packagedFiles,
        ok,
      });
      if (!ok) missing.push(`${artifactLabel}:${entry.name}`);
    }
  }

  return {
    ok: missing.length === 0,
    packaged_apps: packagedApps,
    native_packages: report,
    missing,
  };
}

function main() {
  try {
    const result = scanNativePackaging({ root: DEFAULT_ROOT });
    console.log(JSON.stringify(result, null, 2));
    if (result.missing.length > 0) {
      console.error(`[qa-electron-native-packaging] Missing native unpack(s): ${result.missing.join(', ')}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`[qa-electron-native-packaging] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_ROOT,
  asarUnpackPatterns,
  collectPackagedNodeFiles,
  collectProductionPackages,
  findPackagedApp,
  findPackagedApps,
  matchesAsarUnpackPattern,
  packageHasNativeSignals,
  productionDependencyGraph,
  scanNativePackaging,
  walkFiles,
};
