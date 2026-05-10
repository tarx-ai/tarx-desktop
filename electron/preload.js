'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal TARX bridge to the renderer (tarx.com web app)
contextBridge.exposeInMainWorld('__TARX_DESKTOP__', {
  getStatus: () => ipcRenderer.invoke('tarx:status'),
  openComposer: () => ipcRenderer.invoke('open-composer'),
  getVersion: () => ipcRenderer.invoke('tarx:version'),
  getRuntimeStatus: () => ipcRenderer.invoke('tarx:runtime-status'),
  getLocalDataStatus: () => ipcRenderer.invoke('tarx:local-data-status'),
  restartRuntime: () => ipcRenderer.invoke('tarx:restart-runtime'),
  freshAppTest: () => ipcRenderer.invoke('tarx:fresh-app-test'),
  prepareFullWipe: () => ipcRenderer.invoke('tarx:full-wipe-prepare'),
  confirmFullWipe: (payload) => ipcRenderer.invoke('tarx:full-wipe-confirm', payload),
  resetLocalVault: (payload) => ipcRenderer.invoke('tarx:vault-reset', payload),
  platform: process.platform,
  arch: process.arch,
  isElectron: true,
  // Update flow
  checkForUpdates: () => ipcRenderer.invoke('tarx:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('tarx:download-update'),
  onUpdateStatus: (cb) => ipcRenderer.on('tarx:update-status', (_e, info) => cb(info)),
  onUpdateAvailable: (cb) => ipcRenderer.on('tarx:update-available', (_e, info) => cb(info)),
  onUpdateReady: (cb) => ipcRenderer.on('tarx:update-ready', (_e, info) => cb(info)),
  onRuntimeStatus: (cb) => ipcRenderer.on('tarx:runtime-status', (_e, info) => cb(info)),
  relaunchToUpdate: () => ipcRenderer.invoke('tarx:relaunch-to-update'),
  copyText: (value) => ipcRenderer.invoke('tarx:copy-text', value),
});

// Also expose as electronAPI for the title bar button
contextBridge.exposeInMainWorld('electronAPI', {
  openComposer: () => ipcRenderer.invoke('open-composer'),
});
