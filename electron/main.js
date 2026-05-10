'use strict';

const { app, BrowserWindow, Menu, shell, ipcMain, nativeImage, dialog, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const isDev = process.env.NODE_ENV === 'development';

// Enable accessibility tree for TARX Vision (AX-based UI automation)
app.commandLine.appendSwitch('force-renderer-accessibility');

// URLs — primary is tarx.com, fallback is local Bridge
const PRIMARY_URL = 'https://tarx.com';
const FALLBACK_PORTS = [11440, 11441];
const FALLBACK_URL = 'http://localhost:11440'; // Updated dynamically
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const RUNTIME_HEALTH_URL = 'http://127.0.0.1:11440/health';
const RUNTIME_START_TIMEOUT_MS = 12_000;
const UPDATE_CHECK_INTERVAL_MS = 60_000;

let mainWindow = null;
let trayManager = null;
let currentUrl = PRIMARY_URL;
let isOnline = true;
let pendingDeepLink = null; // Stores deep link if received before window is ready
let updateState = { status: 'idle', updatedAt: null, version: null, error: null };
let runtimeState = { status: 'unknown', updatedAt: null, health: null, error: null, pid: null };
let composerIpcRegistered = false;

function diagnosticsDir() {
  const dir = path.join(app.getPath('userData'), 'diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeDiagnostic(name, payload) {
  try {
    fs.writeFileSync(path.join(diagnosticsDir(), name), JSON.stringify(payload, null, 2));
  } catch (error) {
    console.log(`[tarx] Failed to write ${name}:`, error.message);
  }
}

function setUpdateState(next) {
  updateState = {
    ...updateState,
    ...next,
    updatedAt: new Date().toISOString(),
  };
  mainWindow?.webContents.send('tarx:update-status', updateState);
  writeDiagnostic('updater-status.json', updateState);
}

function setRuntimeState(next) {
  runtimeState = {
    ...runtimeState,
    ...next,
    updatedAt: new Date().toISOString(),
  };
  mainWindow?.webContents.send('tarx:runtime-status', runtimeState);
  writeDiagnostic('runtime-status.json', runtimeState);
}

function userHome() {
  return app.getPath('home');
}

function runtimeBridgePath() {
  return path.join(userHome(), '.tarx', 'servers', 'tarx-ops', 'dist', 'bridge.js');
}

function runtimeLogPath() {
  return path.join(userHome(), '.tarx', 'logs', 'bridge.log');
}

function nodePath() {
  const bundled = path.join(userHome(), '.local', 'node', 'bin', 'node');
  if (fs.existsSync(bundled)) return bundled;
  return process.execPath;
}

async function getRuntimeHealth(timeoutMs = 2500) {
  const ok = await probe(RUNTIME_HEALTH_URL, false, timeoutMs);
  if (!ok) return null;
  return new Promise((resolve) => {
    const req = http.get(RUNTIME_HEALTH_URL, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ status: res.statusCode < 500 ? 'ok' : 'error' });
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function requestBridgeJson(pathname, { method = 'GET', body = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: 11440,
      path: pathname,
      method,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try {
          const data = text ? JSON.parse(text) : {};
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
        } catch {
          resolve({ ok: false, status: res.statusCode, data: { error: 'invalid_json', raw: text } });
        }
      });
    });
    req.on('error', (error) => resolve({ ok: false, status: 0, data: { error: error.message } }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, data: { error: 'timeout' } });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForRuntime(timeoutMs = RUNTIME_START_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const health = await getRuntimeHealth(2000);
    if (health) return health;
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  return null;
}

async function ensureLocalRuntime() {
  const existing = await getRuntimeHealth();
  if (existing) {
    setRuntimeState({ status: 'ready', health: existing, error: null, pid: null });
    return true;
  }

  const bridge = runtimeBridgePath();
  if (!fs.existsSync(bridge)) {
    setRuntimeState({
      status: 'missing',
      health: null,
      error: `Bridge runtime not found at ${bridge}`,
      pid: null,
    });
    return false;
  }

  try {
    fs.mkdirSync(path.dirname(runtimeLogPath()), { recursive: true });
    const out = fs.openSync(runtimeLogPath(), 'a');
    const child = spawn(nodePath(), [bridge], {
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        TARX_PHONE_HOME: process.env.TARX_PHONE_HOME || 'true',
      },
    });
    child.unref();
    setRuntimeState({ status: 'starting', health: null, error: null, pid: child.pid });
  } catch (error) {
    setRuntimeState({ status: 'error', health: null, error: error.message, pid: null });
    return false;
  }

  const health = await waitForRuntime();
  if (health) {
    setRuntimeState({ status: 'ready', health, error: null });
    return true;
  }
  setRuntimeState({ status: 'error', health: null, error: 'Bridge did not become healthy before timeout' });
  return false;
}

// ── Deep link protocol (tarx://) ─────────────────────────────────────────────
if (process.defaultApp) {
  // Dev mode: register with path to electron binary
  app.setAsDefaultProtocolClient('tarx', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('tarx');
}

// ── App single-instance lock ─────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  // Windows/Linux: deep link URL is in argv
  const deepLink = argv.find(arg => arg.startsWith('tarx://'));
  if (deepLink) handleDeepLink(deepLink);
});

// ── Window creation ──────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 24, y: 24 },
    roundedCorners: true,
    backgroundColor: '#0A0A0D',
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Web content fills the ENTIRE window. Traffic lights overlay on the sidebar.
  // The web app's CSS handles the traffic light clearance (padding-top on sidebar).

  // Inject desktop integration CSS + JS after each page load
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS(`
      /* Drag region for title bar */
      body::before {
        content: '';
        position: fixed;
        top: 0; left: 0; right: 0;
        height: 60px;
        -webkit-app-region: drag;
        z-index: 99998;
        pointer-events: none;
      }
      button, a, input, textarea, select, [role="button"], [contenteditable],
      [data-radix-popper-content-wrapper] {
        -webkit-app-region: no-drag;
      }
      /* Web shell owns chrome geometry. Native only supplies the drag region. */
      .light-mode aside, [data-theme="light"] aside {
        background: #F5F5F7 !important;
      }
      aside > div:first-child { margin-top: 0 !important; }
      body { padding-top: 0 !important; }
      /* Window background matches content — native macOS handles corner radius */
      html, body {
        background: var(--tarx-bg, #0A0A0D) !important;
      }
    `);

    // ── JS: expose version only — sidebar logic handled in React (AppShell) ──
    mainWindow.webContents.executeJavaScript(`
      (function() {
        if (window.__tarxDesktopInjected) return;
        window.__tarxDesktopInjected = true;
        var d = window.__TARX_DESKTOP__;
        if (d && d.getVersion) {
          d.getVersion().then(function(v) { window.__TARX_VERSION = v; });
        }
      })();
    `).catch(function() {});
  });

  // ── Voice: auto-grant microphone to TARX origins ──────────────────
  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const url = webContents.getURL();
      const isTarx = url.includes('tarx.com') || url.includes('localhost') || url.startsWith('file://');
      if ((permission === 'media' || permission === 'microphone') && isTarx) {
        callback(true);
      } else {
        callback(permission === 'clipboard-read' || permission === 'notifications');
      }
    }
  );
  mainWindow.webContents.session.setPermissionCheckHandler(
    (webContents, permission) => {
      if (permission === 'media' || permission === 'microphone') return true;
      return false;
    }
  );

  loadBestUrl();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!isDev) {
      checkForUpdates({ download: false });
      setInterval(() => checkForUpdates({ download: false, silent: true }), UPDATE_CHECK_INTERVAL_MS);
    }
  });

  // Handle external links — open in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://tarx.com') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedUrl) => {
    if (errorCode === -3) return;
    console.error(`[tarx] Load failed: ${errorCode} ${errorDesc} at ${validatedUrl}`);
    handleLoadFailure();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerComposerIpc() {
  if (composerIpcRegistered) return;
  composerIpcRegistered = true;

  ipcMain.on('open-composer', () => openComposerWindow());
  ipcMain.handle('open-composer', () => openComposerWindow());
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

function probe(url, secure, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const mod = secure ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      resolve(res.statusCode < 500);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── Floating Composer Window ─────────────────────────────────────────────────
let composerWindow = null;

function openComposerWindow() {
  if (composerWindow && !composerWindow.isDestroyed()) {
    composerWindow.focus();
    return;
  }

  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = display.workAreaSize;

  const composerW = 660;
  const composerH = 480;

  composerWindow = new BrowserWindow({
    width: composerW,
    height: composerH,
    x: Math.round((screenW - composerW) / 2),
    y: screenH - composerH - 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    roundedCorners: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load tarx.com/chat in the composer — just the chat interface
  const composerURL = currentUrl === FALLBACK_URL
    ? `${FALLBACK_URL}/chat`
    : `${PRIMARY_URL}/chat`;
  composerWindow.loadURL(composerURL);

  // Inject glassmorphic styling once loaded
  composerWindow.webContents.on('did-finish-load', () => {
    composerWindow.webContents.insertCSS(`
      /* Glassmorphic floating composer */
      html, body {
        background: transparent !important;
        border-radius: 24px !important;
        overflow: hidden !important;
      }
      /* Hide everything except the composer + COT */
      [class*="sidebar"], [class*="Sidebar"], aside,
      [class*="activity"], [class*="Activity"],
      header, nav, footer {
        display: none !important;
      }
      /* Make the main content area full-width */
      main, [class*="main"], [class*="content"], [class*="canvas"] {
        margin: 0 !important;
        padding: 16px !important;
        max-width: 100% !important;
        width: 100% !important;
      }
    `);
  });

  // Close on Escape
  composerWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      composerWindow.close();
    }
  });

  composerWindow.on('closed', () => {
    composerWindow = null;
  });

  composerWindow.on('blur', () => {
    // Don't auto-close on blur — user might be copying text
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
          click: () => checkForUpdates(),
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

// ── Auto-updater (consumer-friendly: no dialogs, footer-based) ──────────────
function checkForUpdates({ download = false, silent = false } = {}) {
  autoUpdater.autoDownload = download;
  autoUpdater.autoInstallOnAppQuit = true;
  if (!silent) setUpdateState({ status: 'checking', error: null });
  autoUpdater.checkForUpdates().catch((err) => {
    setUpdateState({ status: 'error', error: err.message });
    console.log('[tarx] Update check failed:', err.message);
  });
}

function downloadUpdate() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  setUpdateState({ status: 'downloading', error: null });
  const maybePromise = typeof autoUpdater.downloadUpdate === 'function'
    ? autoUpdater.downloadUpdate()
    : autoUpdater.checkForUpdates();
  return Promise.resolve(maybePromise).catch((err) => {
    setUpdateState({ status: 'error', error: err.message });
    console.log('[tarx] Update download failed:', err.message);
  });
}

autoUpdater.on('update-available', (info) => {
  console.log(`[tarx] Update available: ${info.version}`);
  setUpdateState({ status: 'available', version: info.version, error: null });
  mainWindow?.webContents.send('tarx:update-available', { version: info.version });
});

autoUpdater.on('update-not-available', (info) => {
  console.log(`[tarx] No update available: ${info.version || app.getVersion()}`);
  setUpdateState({ status: 'not-available', version: info.version || app.getVersion(), error: null });
});

autoUpdater.on('update-downloaded', (info) => {
  console.log(`[tarx] Update downloaded: ${info.version}`);
  setUpdateState({ status: 'downloaded', version: info.version, error: null });
  mainWindow?.webContents.send('tarx:update-ready', { version: info.version });
});

autoUpdater.on('error', (err) => {
  setUpdateState({ status: 'error', error: err.message });
  console.log('[tarx] Update error:', err.message);
});

// User clicks "Relaunch to update" in the footer
ipcMain.handle('tarx:relaunch-to-update', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('tarx:check-for-updates', () => {
  checkForUpdates({ download: false });
  return updateState;
});

ipcMain.handle('tarx:download-update', () => {
  downloadUpdate();
  return updateState;
});

ipcMain.handle('tarx:copy-text', (_event, value) => {
  clipboard.writeText(String(value || ''));
  return true;
});

// ── Deep link handler (tarx://auth/callback?token=...) ───────────────────────
// macOS: open-url fires when user clicks a tarx:// link (e.g., magic link email)
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function handleDeepLink(url) {
  if (!url || !url.startsWith('tarx://')) return;

  // If window isn't ready yet, queue the link for after creation
  if (!mainWindow) {
    pendingDeepLink = url;
    return;
  }

  // Convert tarx://auth/callback?token=X&email=Y
  // to     https://tarx.com/api/auth/callback/resend?token=X&email=Y
  try {
    const parsed = new URL(url);
    // tarx://auth/callback → host="auth", pathname="/callback"
    const fullPath = `/${parsed.host}${parsed.pathname}`; // e.g., /auth/callback
    const params = parsed.search; // e.g., ?token=X&email=Y

    if (fullPath.startsWith('/auth/callback')) {
      // Redirect to Auth.js callback with the token, redirecting to / after auth
      const webUrl = `${PRIMARY_URL}/api/auth/callback/resend${params}&callbackUrl=%2F`;

      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.loadURL(webUrl);

        // After auth callback processes, always navigate to home.
        // Auth.js sometimes lands on /settings or /login?error= — override both.
        mainWindow.webContents.once('did-finish-load', () => {
          const finalUrl = mainWindow.webContents.getURL();
          if (finalUrl.includes('/login?error=') || finalUrl.includes('/settings') || finalUrl.includes('/api/auth')) {
            mainWindow.loadURL(PRIMARY_URL);
          }
        });
      }

      console.log(`[tarx] Deep link auth: tarx://auth/callback → redirected (token redacted)`);
    }
  } catch (err) {
    console.error('[tarx] Deep link parse error:', err.message);
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Import tray after app is ready (requires display)
  const { TrayManager } = require('./tray');
  trayManager = new TrayManager({
    onOpen: () => mainWindow?.show(),
    onAskTarx: () => openComposerWindow(),
  });

  buildMenu();
  await ensureLocalRuntime();
  registerComposerIpc();
  createWindow();
  startHealthLoop();

  // Process any deep link received before window was ready
  if (pendingDeepLink) {
    handleDeepLink(pendingDeepLink);
    pendingDeepLink = null;
  }

  // macOS: check if launched via deep link (argv contains the URL)
  const launchUrl = process.argv.find(arg => arg.startsWith('tarx://'));
  if (launchUrl) handleDeepLink(launchUrl);
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
ipcMain.handle('tarx:version', () => app.getVersion());

ipcMain.handle('tarx:runtime-status', async () => {
  const health = await getRuntimeHealth().catch(() => null);
  if (health) setRuntimeState({ status: 'ready', health, error: null });
  return runtimeState;
});

ipcMain.handle('tarx:local-data-status', async () => {
  await ensureLocalRuntime();
  return requestBridgeJson('/api/local-data/status');
});

ipcMain.handle('tarx:restart-runtime', async () => {
  const result = await requestBridgeJson('/api/local-data/restart-runtime', { method: 'POST', body: {} });
  setRuntimeState({ status: 'restarting', health: null, error: null });
  setTimeout(() => ensureLocalRuntime(), 1500);
  return result;
});

ipcMain.handle('tarx:fresh-app-test', async () => {
  await ensureLocalRuntime();
  return requestBridgeJson('/api/local-data/fresh-app-test', { method: 'POST', body: {} });
});

ipcMain.handle('tarx:full-wipe-prepare', async () => {
  await ensureLocalRuntime();
  return requestBridgeJson('/api/local-data/full-wipe/prepare', { method: 'POST', body: {} });
});

ipcMain.handle('tarx:full-wipe-confirm', async (_event, payload) => {
  await ensureLocalRuntime();
  return requestBridgeJson('/api/local-data/full-wipe/confirm', { method: 'POST', body: payload || {} });
});

ipcMain.handle('tarx:vault-reset', async (_event, payload) => {
  await ensureLocalRuntime();
  return requestBridgeJson('/api/local-data/vault-reset', { method: 'POST', body: payload || {} });
});

ipcMain.handle('tarx:status', () => ({
  version: app.getVersion(),
  online: isOnline,
  currentUrl,
  platform: process.platform,
  arch: process.arch,
  update: updateState,
  runtime: runtimeState,
}));
