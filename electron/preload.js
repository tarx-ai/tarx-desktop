'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal TARX bridge to the renderer (tarx.com web app)
// The web app can detect it's running in Electron and adapt UX accordingly
contextBridge.exposeInMainWorld('__TARX_DESKTOP__', {
  getStatus: () => ipcRenderer.invoke('tarx:status'),
  openComposer: () => ipcRenderer.invoke('open-composer'),
  platform: process.platform,
  arch: process.arch,
  isElectron: true,
});

// Also expose as electronAPI for the title bar button
contextBridge.exposeInMainWorld('electronAPI', {
  openComposer: () => ipcRenderer.invoke('open-composer'),
});
