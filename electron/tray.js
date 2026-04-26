'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

// Tiny 16×16 colored dot PNGs encoded as base64.
// Generated from minimal valid PNG: 1×1 pixel scaled with PNG filter bytes.
// Status: online=green #12B76A, local=orange #F97316, offline=red #F04438
const ICON_B64 = {
  online:  makeDotPNG(0x12, 0xB7, 0x6A),
  local:   makeDotPNG(0xF9, 0x73, 0x16),
  offline: makeDotPNG(0xF0, 0x44, 0x38),
};

/**
 * Build a minimal 16×16 RGBA PNG with a filled circle of the given RGB color.
 * Uses a pure-JS approach (zlib deflate via Node built-ins).
 */
function makeDotPNG(r, g, b) {
  const { deflateSync } = require('zlib');
  const W = 16, H = 16, R = 6;
  const cx = W / 2, cy = H / 2;

  // Build raw RGBA scanlines with filter byte 0 prepended
  const raw = Buffer.alloc(H * (1 + W * 4), 0);
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter byte = None
    for (let x = 0; x < W; x++) {
      const dx = x - cx + 0.5, dy = y - cy + 0.5;
      const inside = Math.sqrt(dx * dx + dy * dy) <= R;
      const off = y * (1 + W * 4) + 1 + x * 4;
      raw[off]     = inside ? r : 0;
      raw[off + 1] = inside ? g : 0;
      raw[off + 2] = inside ? b : 0;
      raw[off + 3] = inside ? 255 : 0;
    }
  }

  const idat = deflateSync(raw);

  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t   = Buffer.from(type);
    const crc = crc32(Buffer.concat([t, data]));
    const c   = Buffer.alloc(4); c.writeInt32BE(crc);
    return Buffer.concat([len, t, data, c]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  return png.toString('base64');
}

function crc32(buf) {
  let crc = -1 >>> 0;
  const table = crc32.table || (crc32.table = buildCrcTable());
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return ((crc ^ -1) >>> 0) | 0;
}
function buildCrcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
}

class TrayManager {
  constructor({ onOpen }) {
    this._onOpen = onOpen;
    this._status = 'online';

    // Try loading ICNS first; fall back to programmatic dot
    let icon;
    try {
      icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray-icon.png'));
      if (icon.isEmpty()) throw new Error('empty');
    } catch {
      icon = nativeImage.createFromDataURL(`data:image/png;base64,${ICON_B64.online}`);
    }

    this._tray = new Tray(icon);
    this._tray.setToolTip('TARX — online');
    this._buildMenu();
    this._tray.on('click', () => this._onOpen());
  }

  setStatus(status) {
    // status: 'online' | 'local' | 'offline'
    this._status = status;
    const labels = {
      online:  'TARX — connected to tarx.com',
      local:   'TARX — local Bridge only',
      offline: 'TARX — offline',
    };
    this._tray.setToolTip(labels[status] ?? 'TARX');

    // Update icon if no custom asset (use colored dot)
    const b64 = ICON_B64[status] ?? ICON_B64.offline;
    const img = nativeImage.createFromDataURL(`data:image/png;base64,${b64}`);
    if (!img.isEmpty()) this._tray.setImage(img);

    this._buildMenu();
  }

  _buildMenu() {
    const statusLabel = {
      online:  '● Connected',
      local:   '● Bridge only',
      offline: '● Offline',
    }[this._status] ?? '● Unknown';

    const menu = Menu.buildFromTemplate([
      { label: `TARX  ${statusLabel}`, enabled: false },
      { type: 'separator' },
      { label: 'Open TARX', click: () => this._onOpen() },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ]);
    this._tray.setContextMenu(menu);
  }
}

module.exports = { TrayManager };
