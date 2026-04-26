'use strict';

const { app, BrowserWindow, Menu, shell, ipcMain, nativeImage, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const https = require('https');
const http = require('http');

const isDev = process.env.NODE_ENV === 'development';

// URLs — primary is tarx.com, fallback is local Bridge
const PRIMARY_URL = 'https://tarx.com';
const FALLBACK_URL = 'http://localhost:11440';
const HEALTH_CHECK_INTERVAL_MS = 30_000;

let mainWindow = null;
let trayManager = null;
let currentUrl = PRIMARY_URL;
let isOnline = true;

// ── App single-instance lock ─────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── Window creation ──────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0A0A0D',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  loadBestUrl();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!isDev) checkForUpdates();
  });

  // Handle navigation — open external links in browser, keep internal in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://tarx.com') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedUrl) => {
    if (errorCode === -3) return; // ERR_ABORTED — user navigation, ignore
    console.error(`[tarx] Load failed: ${errorCode} ${errorDesc} at ${validatedUrl}`);
    handleLoadFailure();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── URL routing with fallback ────────────────────────────────────────────────
async function loadBestUrl() {
  const primary = await probe(PRIMARY_URL + '/api/version', true);
  if (primary) {
    currentUrl = PRIMARY_URL;
    isOnline = true;
    trayManager?.setStatus('online');
    mainWindow?.loadURL(PRIMARY_URL);
    return;
  }

  const fallback = await probe(FALLBACK_URL + '/health', false);
  if (fallback) {
    currentUrl = FALLBACK_URL;
    isOnline = false;
    trayManager?.setStatus('local');
    mainWindow?.loadURL(FALLBACK_URL);
    return;
  }

  // Both unreachable — show offline page
  isOnline = false;
  trayManager?.setStatus('offline');
  mainWindow?.loadFile(path.join(__dirname, 'offline.html'));
}

function handleLoadFailure() {
  if (currentUrl === PRIMARY_URL) {
    probe(FALLBACK_URL + '/health', false).then((ok) => {
      if (ok) {
        currentUrl = FALLBACK_URL;
        trayManager?.setStatus('local');
        mainWindow?.loadURL(FALLBACK_URL);
      } else {
        trayManager?.setStatus('offline');
        mainWindow?.loadFile(path.join(__dirname, 'offline.html'));
      }
    });
  }
}

function probe(url, secure) {
  return new Promise((resolve) => {
    const mod = secure ? https : http;
    const req = mod.get(url, { timeout: 5000 }, (res) => {
      resolve(res.statusCode < 500);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── Periodic health check ────────────────────────────────────────────────────
function startHealthLoop() {
  setInterval(async () => {
    const primary = await probe(PRIMARY_URL + '/api/version', true);

    if (primary && currentUrl !== PRIMARY_URL) {
      // Came back online — reload primary
      currentUrl = PRIMARY_URL;
      isOnline = true;
      trayManager?.setStatus('online');
      mainWindow?.loadURL(PRIMARY_URL);
      return;
    }

    if (!primary) {
      isOnline = false;
      const fallback = await probe(FALLBACK_URL + '/health', false);
      trayManager?.setStatus(fallback ? 'local' : 'offline');
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

// ── Menu bar ─────────────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: 'TARX',
      submenu: [
        {
          label: 'About TARX',
          click: showAbout,
        },
        { type: 'separator' },
        {
          label: 'Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click: openPreferences,
        },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => checkForUpdates(true),
        },
        { type: 'separator' },
        {
          label: 'Quit TARX',
          accelerator: 'CmdOrCtrl+Q',
          role: 'quit',
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About TARX',
    message: 'TARX',
    detail: `Version ${app.getVersion()}\n\nThe AI that lives on your machine.\n\ntarx.com`,
    buttons: ['OK'],
  });
}

function openPreferences() {
  if (mainWindow && currentUrl === PRIMARY_URL) {
    mainWindow.loadURL(PRIMARY_URL + '/settings');
  } else if (mainWindow) {
    mainWindow.focus();
  }
}

// ── Auto-updater ─────────────────────────────────────────────────────────────
function checkForUpdates(manual = false) {
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Check',
        message: 'Could not check for updates.',
        detail: err.message,
        buttons: ['OK'],
      });
    }
  });
}

autoUpdater.on('update-available', (info) => {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Available',
    message: `TARX ${info.version} is available.`,
    detail: 'Downloading update in the background…',
    buttons: ['OK'],
  });
});

autoUpdater.on('update-downloaded', (info) => {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: `TARX ${info.version} is ready to install.`,
    detail: 'Restart TARX to apply the update.',
    buttons: ['Restart Now', 'Later'],
  }).then(({ response }) => {
    if (response === 0) autoUpdater.quitAndInstall();
  });
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Import tray after app is ready (requires display)
  const { TrayManager } = require('./tray');
  trayManager = new TrayManager({ onOpen: () => mainWindow?.show() });

  buildMenu();
  createWindow();
  startHealthLoop();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow?.show();
  }
});

// macOS: keep process alive when window is closed (tray app)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC — renderer can request status
ipcMain.handle('tarx:status', () => ({
  version: app.getVersion(),
  online: isOnline,
  currentUrl,
  platform: process.platform,
  arch: process.arch,
}));
