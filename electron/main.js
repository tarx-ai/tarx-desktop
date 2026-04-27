'use strict';

const { app, BrowserWindow, Menu, shell, ipcMain, nativeImage, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const https = require('https');
const http = require('http');

const isDev = process.env.NODE_ENV === 'development';

// URLs — primary is tarx.com, fallback is local Bridge
const PRIMARY_URL = 'https://tarx.com';
const FALLBACK_PORTS = [11440, 11441];
const FALLBACK_URL = 'http://localhost:11440'; // Updated dynamically
const HEALTH_CHECK_INTERVAL_MS = 30_000;

let mainWindow = null;
let trayManager = null;
let currentUrl = PRIMARY_URL;
let isOnline = true;
let pendingDeepLink = null; // Stores deep link if received before window is ready

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
    trafficLightPosition: { x: 16, y: 14 },
    roundedCorners: true,
    vibrancy: undefined,
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

  // macOS Sequoia+ corner radius (10px system default)
  if (process.platform === 'darwin' && mainWindow.setWindowButtonVisibility) {
    mainWindow.setWindowButtonVisibility(true);
  }

  // Use a separate BrowserView offset 44px from the top.
  // The top 44px is native — traffic lights live there, nothing else.
  // Web content cannot bleed into it because it physically starts at y=44.
  const { BrowserView } = require('electron');
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.setBrowserView(view);

  const TITLE_BAR_HEIGHT = 44;

  function resizeView() {
    const [w, h] = mainWindow.getContentSize();
    view.setBounds({ x: 0, y: TITLE_BAR_HEIGHT, width: w, height: h - TITLE_BAR_HEIGHT });
  }
  resizeView();
  mainWindow.on('resize', resizeView);

  // Title bar: solid #0A0A0D, traffic lights left, "Ask TARX" CTA right.
  // CTA opens standalone floating composer window.
  mainWindow.webContents.loadURL(`data:text/html,
    <html style="margin:0;padding:0;background:%230A0A0D;-webkit-app-region:drag;height:${TITLE_BAR_HEIGHT}px;overflow:hidden;">
    <body style="margin:0;padding:0;display:flex;align-items:center;justify-content:flex-end;height:${TITLE_BAR_HEIGHT}px;padding-right:16px;">
      <button id="ask-tarx-btn"
        style="-webkit-app-region:no-drag;background:%2392B6DE;color:%230A0A0D;border:none;border-radius:10px;padding:6px 16px;font-size:12px;font-weight:600;font-family:system-ui,sans-serif;cursor:pointer;letter-spacing:0.02em;"
      >Ask TARX</button>
      <script>
        document.getElementById('ask-tarx-btn').addEventListener('click', () => {
          window.electronAPI?.openComposer?.() || fetch('http://127.0.0.1:11440/health');
        });
      </script>
    </body></html>
  `);

  // IPC: "Ask TARX" opens floating composer
  ipcMain.on('open-composer', () => openComposerWindow());

  // Also listen for the preload bridge
  ipcMain.handle('open-composer', () => openComposerWindow());

  // Replace the direct URL loading — the BrowserView loads the content now
  // Remove the old loadBestUrl call from mainWindow, use view instead
  mainWindow._tarxView = view;

  loadBestUrl();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!isDev) checkForUpdates();
  });

  // Handle navigation on the BrowserView (not mainWindow)
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://tarx.com') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  view.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedUrl) => {
    if (errorCode === -3) return;
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
    mainWindow?._tarxView?.webContents.loadURL(PRIMARY_URL);
    return;
  }

  const fallback = await probe(FALLBACK_URL + '/health', false);
  if (fallback) {
    currentUrl = FALLBACK_URL;
    isOnline = false;
    trayManager?.setStatus('local');
    mainWindow?._tarxView?.webContents.loadURL(FALLBACK_URL);
    return;
  }

  // Both unreachable — show offline page
  isOnline = false;
  trayManager?.setStatus('offline');
  mainWindow?._tarxView?.webContents.loadFile(path.join(__dirname, 'offline.html'));
}

function handleLoadFailure() {
  if (currentUrl === PRIMARY_URL) {
    probe(FALLBACK_URL + '/health', false).then((ok) => {
      if (ok) {
        currentUrl = FALLBACK_URL;
        trayManager?.setStatus('local');
        mainWindow?._tarxView?.webContents.loadURL(FALLBACK_URL);
      } else {
        trayManager?.setStatus('offline');
        mainWindow?._tarxView?.webContents.loadFile(path.join(__dirname, 'offline.html'));
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
      mainWindow?._tarxView?.webContents.loadURL(PRIMARY_URL);
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
    mainWindow._tarxView?.webContents.loadURL(PRIMARY_URL + '/settings');
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
      // Redirect to tarx.com auth callback inside the Electron window
      const webUrl = `${PRIMARY_URL}/api/auth/callback/resend${params}`;

      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        // Load the auth callback in the BrowserView
        const view = mainWindow._tarxView;
        if (view) {
          view.webContents.loadURL(webUrl);
        } else {
          mainWindow.loadURL(webUrl);
        }
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
  trayManager = new TrayManager({ onOpen: () => mainWindow?.show() });

  buildMenu();
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
ipcMain.handle('tarx:status', () => ({
  version: app.getVersion(),
  online: isOnline,
  currentUrl,
  platform: process.platform,
  arch: process.arch,
}));
