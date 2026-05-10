#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const version = require(join(root, 'package.json')).version;
const latestPath = join(root, 'dist', 'latest-mac.yml');
const dmgName = `TARX-${version}-arm64.dmg`;
const dmgPath = join(root, 'dist', dmgName);

const sha512 = createHash('sha512').update(readFileSync(dmgPath)).digest('base64');
const size = statSync(dmgPath).size;
const lines = readFileSync(latestPath, 'utf8').split(/\r?\n/);

let inDmgEntry = false;
const next = lines.map((line) => {
  if (/^\s*-\s+url:\s+/.test(line)) {
    inDmgEntry = line.includes(dmgName);
    return line;
  }
  if (inDmgEntry && /^\s+sha512:\s+/.test(line)) return `    sha512: ${sha512}`;
  if (inDmgEntry && /^\s+size:\s+\d+/.test(line)) return `    size: ${size}`;
  return line;
});

writeFileSync(latestPath, next.join('\n'));
console.log(`refreshed ${latestPath} for ${dmgName}`);
