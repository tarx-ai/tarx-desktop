#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const assetsDir = path.join(root, 'assets');
const iconSource =
  process.env.TARX_ICON_SOURCE ||
  path.join(assetsDir, 'icon-base.png');

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function writeRoundedIconSvg(outputPath, imagePath) {
  const data = fs.readFileSync(imagePath).toString('base64');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <clipPath id="tarxRounded">
      <rect x="0" y="0" width="1024" height="1024" rx="220" ry="220"/>
    </clipPath>
  </defs>
  <image width="1024" height="1024" href="data:image/png;base64,${data}" clip-path="url(#tarxRounded)" preserveAspectRatio="xMidYMid slice"/>
</svg>
`;
  fs.writeFileSync(outputPath, svg);
}

function writeDmgBackgroundSvg(outputPath) {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fbfbfc"/>
      <stop offset="0.58" stop-color="#f3f4f7"/>
      <stop offset="1" stop-color="#eceff4"/>
    </linearGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="28" flood-color="#111827" flood-opacity="0.10"/>
    </filter>
  </defs>
  <rect width="640" height="420" fill="url(#bg)"/>
  <rect x="38" y="34" width="564" height="316" rx="28" fill="#ffffff" fill-opacity="0.54" stroke="#ffffff" stroke-opacity="0.88" filter="url(#softShadow)"/>
  <text x="320" y="72" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif" font-size="20" font-weight="650" fill="#171717">Install TARX</text>
  <text x="320" y="98" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" font-size="12" fill="#6b7280">Drag TARX into Applications to keep local AI on this Mac.</text>
  <path d="M282 211h62" fill="none" stroke="#9ca3af" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="5 7"/>
  <path d="M335 195l17 17-17 17" fill="none" stroke="#9ca3af" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="172" y="326" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" font-size="11" fill="#9ca3af">TARX</text>
  <text x="468" y="326" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" font-size="11" fill="#9ca3af">Applications</text>
</svg>
`;
  fs.writeFileSync(outputPath, svg);
}

function buildIcon() {
  assertFile(iconSource, 'Icon source');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tarx-assets-'));
  const roundedSvg = path.join(tmp, 'tarx-rounded.svg');
  const roundedPng = path.join(tmp, 'tarx-rounded.png');
  const iconset = path.join(tmp, 'TARX.iconset');

  writeRoundedIconSvg(roundedSvg, iconSource);
  run('sips', ['-s', 'format', 'png', roundedSvg, '--out', roundedPng]);

  fs.mkdirSync(iconset);
  const sizes = [16, 32, 128, 256, 512];
  for (const size of sizes) {
    run('sips', ['-z', String(size), String(size), roundedPng, '--out', path.join(iconset, `icon_${size}x${size}.png`)]);
    run('sips', ['-z', String(size * 2), String(size * 2), roundedPng, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)]);
  }

  run('iconutil', ['-c', 'icns', iconset, '-o', path.join(assetsDir, 'icon.icns')]);
}

function buildDmgBackground() {
  const source = path.join(assetsDir, 'dmg-background.svg');
  const output = path.join(assetsDir, 'dmg-background.png');
  writeDmgBackgroundSvg(source);
  run('sips', ['-s', 'format', 'png', source, '--out', output]);
}

buildIcon();
buildDmgBackground();
console.log('Built assets/icon.icns and assets/dmg-background.png');
