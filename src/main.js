'use strict';

const { app, BrowserWindow, ipcMain, clipboard, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// node-pty is a native module; it lives unpacked from the asar (see build.asarUnpack).
const pty = require('node-pty');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// Defaults can be overridden by a config.json placed next to the executable
// (portable) or in the install dir. Falls back to userData for safety.
const DEFAULT_CONFIG = {
  shell: 'powershell.exe',
  // -NoLogo: no banner. -NoExit: stay at a live PowerShell prompt after Claude
  // exits, so the window remains usable. -Command claude: invoke Claude Code.
  shellArgs: ['-NoLogo', '-NoExit', '-Command', 'claude'],
  cwd: process.env.USERPROFILE || os.homedir(),
  fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
  fontSize: 14,
  scrollback: 10000,
  copyOnSelect: false
};

function loadConfig() {
  const candidates = [
    // For the single-file portable build, this points at the dir the user ran
    // the exe from (the real exe is extracted to a temp dir, so dirname(exe)
    // would miss a co-located config.json).
    process.env.PORTABLE_EXECUTABLE_DIR &&
      path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'config.json'),
    path.join(path.dirname(app.getPath('exe')), 'config.json'),
    path.join(app.getAppPath(), 'config.json'),
    path.join(app.getPath('userData'), 'config.json')
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Object.assign({}, DEFAULT_CONFIG, parsed);
      }
    } catch (err) {
      // Ignore a malformed config and fall through to defaults.
      console.error(`VEShell: failed to read ${file}:`, err.message);
    }
  }
  return Object.assign({}, DEFAULT_CONFIG);
}

const config = loadConfig();

// Environment overrides (handy for testing and power users).
if (process.env.VESHELL_SHELL) config.shell = process.env.VESHELL_SHELL;
if (process.env.VESHELL_SHELLARGS) {
  try {
    const parsed = JSON.parse(process.env.VESHELL_SHELLARGS);
    if (Array.isArray(parsed)) config.shellArgs = parsed;
  } catch (_) { /* keep default args on bad JSON */ }
}
if (process.env.VESHELL_CWD) config.cwd = process.env.VESHELL_CWD;

// Validate config shape so a malformed config.json can't crash pty.spawn.
if (typeof config.shell !== 'string' || !config.shell) config.shell = DEFAULT_CONFIG.shell;
if (!Array.isArray(config.shellArgs)) config.shellArgs = DEFAULT_CONFIG.shellArgs;

// Hard gate: the e2e/debug hooks must never be reachable in a packaged build,
// even if VESHELL_E2E leaked into the environment. Clearing it here (before any
// window/renderer is spawned) keeps both the main hook and preload's flag off.
if (app.isPackaged) delete process.env.VESHELL_E2E;

const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');

let mainWindow = null;
let ptyProc = null;

// Buffer pty output that arrives before the renderer signals it is ready,
// then flush it so no early output (the PowerShell prompt / Claude banner) is lost.
let rendererReady = false;
let outputBuffer = [];

// ---------------------------------------------------------------------------
// PTY lifecycle
// ---------------------------------------------------------------------------
function spawnPty(cols, rows) {
  // Resolve and validate the working directory; a stale config cwd must not
  // take down the spawn.
  let cwd = config.cwd || process.env.USERPROFILE || os.homedir();
  try {
    if (!fs.existsSync(cwd)) cwd = process.env.USERPROFILE || os.homedir();
  } catch (_) {
    cwd = os.homedir();
  }

  let proc;
  try {
    proc = pty.spawn(config.shell, config.shellArgs, {
      name: 'xterm-256color',
      cols: cols || 120,
      rows: rows || 30,
      cwd,
      env: Object.assign({}, process.env, { VESHELL: '1', TERM: 'xterm-256color' })
    });
  } catch (err) {
    // Surface the failure to the renderer (shows the session-ended overlay)
    // instead of leaving a silent blank window.
    console.error('VEShell: failed to spawn shell:', err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', {
        exitCode: -1,
        signal: null,
        error: `Failed to start "${config.shell}": ${err && err.message ? err.message : err}`
      });
    }
    return null;
  }

  proc.onData((data) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (rendererReady) {
      mainWindow.webContents.send('pty:data', data);
    } else {
      outputBuffer.push(data);
    }
  });

  proc.onExit(({ exitCode, signal }) => {
    // Only act if this is still the current session — an old pty dying after a
    // restart must not null the new one or flash the overlay over it.
    if (ptyProc !== proc) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { exitCode, signal });
    }
    ptyProc = null;
  });

  return proc;
}

function flushBuffer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  for (const chunk of outputBuffer) {
    mainWindow.webContents.send('pty:data', chunk);
  }
  outputBuffer = [];
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 480,
    minHeight: 240,
    backgroundColor: '#1e1e1e',
    icon: ICON_PATH,
    title: 'VEShell',
    autoHideMenuBar: true,
    show: !process.env.VESHELL_E2E,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // Keep the terminal live (and timers un-throttled) when unfocused.
      backgroundThrottling: false
    }
  });

  // No application menu — copy/paste is handled in-terminal, not via a menu bar.
  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open external links (xterm web-links addon) in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (ptyProc) {
      try { ptyProc.kill(); } catch (_) { /* already gone */ }
      ptyProc = null;
    }
  });

  // Automated end-to-end driver hook. Dev-only: the tests/ dir is excluded from
  // the packaged app, so never run (or exit) on a stray VESHELL_E2E in prod.
  if (process.env.VESHELL_E2E && !app.isPackaged) {
    mainWindow.webContents.once('did-finish-load', () => {
      try {
        require('../tests/e2e-driver')({
          app, mainWindow, clipboard, getPty: () => ptyProc
        });
      } catch (err) {
        console.error('E2E driver failed to load:', err);
        app.exit(3);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.on('renderer:ready', (event, dims) => {
  rendererReady = true;
  if (!ptyProc) {
    ptyProc = spawnPty(dims && dims.cols, dims && dims.rows);
  }
  flushBuffer();
});

ipcMain.on('pty:input', (event, data) => {
  if (ptyProc) ptyProc.write(data);
});

ipcMain.on('pty:resize', (event, { cols, rows }) => {
  if (ptyProc && cols > 0 && rows > 0) {
    try { ptyProc.resize(cols, rows); } catch (_) { /* window mid-teardown */ }
  }
});

// Clipboard is routed through the main process for maximum reliability on
// Windows (avoids renderer focus/permission quirks of the async clipboard API).
ipcMain.handle('clip:write', (event, text) => {
  if (typeof text !== 'string') return false;
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('clip:read', () => clipboard.readText());

// Restart the PowerShell+Claude session in the existing window. The renderer
// passes the current grid dimensions so the new pty starts at the right size.
ipcMain.on('session:restart', (event, dims) => {
  if (ptyProc) {
    const old = ptyProc;
    ptyProc = null;            // detach first so old.onExit no-ops (ptyProc !== old)
    try { old.kill(); } catch (_) {}
  }
  ptyProc = spawnPty(dims && dims.cols, dims && dims.rows);
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
// Single instance — a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.victorycomputersystems.veshell');
    }
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (ptyProc) {
      try { ptyProc.kill(); } catch (_) {}
      ptyProc = null;
    }
    app.quit();
  });
}
