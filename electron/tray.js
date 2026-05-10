'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const http = require('http');

/**
 * TrayManager — macOS menu bar tray for TARX desktop.
 *
 * V1 menu:
 *   TARX · [status]
 *   ─────────────────
 *   Ask TARX              ⌘T
 *   ─────────────────
 *   ☑ TARX on Supercomputer
 *   ─────────────────
 *   Open TARX
 *   Quit
 */
class TrayManager {
  constructor({ onOpen, onAskTarx }) {
    this._onOpen = onOpen;
    this._onAskTarx = onAskTarx;
    this._status = 'online';
    this._supercomputerOn = true; // default ON

    // Load template icon — macOS auto-tints for light/dark menu bar
    // File must be named "xxxTemplate.png" for macOS to recognize it
    let icon;
    try {
      icon = nativeImage.createFromPath(
        path.join(__dirname, '..', 'assets', 'TARXTemplate.png')
      );
      // Mark as template so macOS handles light/dark tinting
      icon.setTemplateImage(true);
      if (icon.isEmpty()) throw new Error('empty');
    } catch {
      // Fallback: use the tray-icon.png
      try {
        icon = nativeImage.createFromPath(
          path.join(__dirname, '..', 'assets', 'tray-icon.png')
        );
        icon.setTemplateImage(true);
      } catch {
        // Last resort: tiny dot
        icon = nativeImage.createEmpty();
      }
    }

    this._tray = new Tray(icon);
    this._tray.setToolTip('TARX');
    this._buildMenu();

    // Click tray icon → open main window
    this._tray.on('click', () => this._onOpen());

    // Check Supercomputer status on boot
    this._checkSupercomputer();
  }

  setStatus(status) {
    this._status = status;
    const labels = {
      online:  'TARX · connected',
      local:   'TARX · local only',
      offline: 'TARX · offline',
    };
    this._tray.setToolTip(labels[status] ?? 'TARX');
    this._buildMenu();
  }

  _buildMenu() {
    const statusLabel = {
      online:  'Connected to tarx.com',
      local:   'Bridge only (local)',
      offline: 'Offline',
    }[this._status] ?? 'Unknown';

    const statusIcon = {
      online: '🟢',
      local: '🟠',
      offline: '🔴',
    }[this._status] ?? '⚪';

    const menu = Menu.buildFromTemplate([
      {
        label: `TARX  ${statusIcon} ${statusLabel}`,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Ask TARX',
        accelerator: 'CmdOrCtrl+T',
        click: () => {
          if (this._onAskTarx) this._onAskTarx();
          else this._onOpen();
        },
      },
      { type: 'separator' },
      {
        label: this._supercomputerOn ? '◆ TARX on Supercomputer' : '◇ TARX on Device',
        click: () => {
          this._supercomputerOn = !this._supercomputerOn;
          this._toggleSupercomputer(this._supercomputerOn);
          this._buildMenu();
        },
      },
      { type: 'separator' },
      {
        label: 'Open TARX',
        click: () => this._onOpen(),
      },
      {
        label: `Version ${app.getVersion()}`,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Quit TARX',
        role: 'quit',
      },
    ]);
    this._tray.setContextMenu(menu);
  }

  /** Check if Supercomputer (port 11436) is running */
  _checkSupercomputer() {
    const req = http.get('http://localhost:11436/health', { timeout: 3000 }, (res) => {
      this._supercomputerOn = res.statusCode < 500;
      res.resume();
      this._buildMenu();
    });
    req.on('error', () => {
      this._supercomputerOn = false;
      this._buildMenu();
    });
    req.on('timeout', () => {
      req.destroy();
      this._supercomputerOn = false;
      this._buildMenu();
    });
  }

  /** Toggle Supercomputer on/off via Bridge API */
  _toggleSupercomputer(on) {
    // POST to Bridge to start/stop supercomputer
    const data = JSON.stringify({ action: on ? 'start' : 'stop' });
    const req = http.request({
      hostname: 'localhost',
      port: 11440,
      path: '/api/supercomputer/toggle',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 5000,
    }, (res) => {
      res.resume();
      // Re-check status after toggle
      setTimeout(() => this._checkSupercomputer(), 2000);
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(data);
    req.end();
  }
}

module.exports = { TrayManager };
