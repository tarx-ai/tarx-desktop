'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal TARX bridge to the renderer (tarx.com web app)
// The web app can detect it's running in Electron and adapt UX accordingly
contextBridge.exposeInMainWorld('__TARX_DESKTOP__', {
  // Returns { version, online, currentUrl, platform, arch }
  getStatus: () => ipcRenderer.invoke('tarx:status'),

  // Platform info
  platform: process.platform,
  arch: process.arch,
  isElectron: true,
});
