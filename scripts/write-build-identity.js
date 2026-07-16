'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let commit = 'unknown';
let dirty = false;
try {
  commit = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  // Only tracked file dirtiness blocks release; generated build-identity.json is gitignored.
  dirty = execSync('git status --porcelain --untracked-files=no', { cwd: root, encoding: 'utf8' }).trim().length > 0;
} catch {}
if (dirty) {
  console.error('[build-identity] Working tree is dirty. Refuse packaging from dirty tree.');
  process.exit(1);
}
const identity = {
  product: 'TARX Computer',
  bundleId: pkg.build?.appId || 'com.tarx.computer',
  version: pkg.version,
  channel: 'private-beta',
  arch: process.arch,
  sourceCommit: commit,
  sourceDirty: false,
  builtAt: new Date().toISOString(),
  launchMode: 'packaged-local-chat',
};
const out = path.join(root, 'resources', 'build-identity.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(identity, null, 2) + '\n');
console.log('[build-identity]', out, identity.sourceCommit, identity.version);
