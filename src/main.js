'use strict';

/* VEShell main process: app/window/pty lifecycle, clipboard, and IPC for the
   sandboxed renderer. Feature modules wire in via one register() line each. */

const { app, BrowserWindow, ipcMain, clipboard, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const pty = require('node-pty'); // native; unpacked from asar (build.asarUnpack)

const { loadConfig } = require('./config');
const claudewhat = require('./claudewhat');
const verbose = require('./verbose');

const config = loadConfig(app);

// Hard gate: e2e/debug hooks must never survive into a packaged build.
if (app.isPackaged) delete process.env.VESHELL_E2E;

const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');

let mainWindow = null, ptyProc = null;

// Early pty output buffers here until the renderer says ready.
let rendererReady = false, outputBuffer = [];

// PTY lifecycle.

/* Spawn the shell behind a ConPTY and wire output to the renderer. Returns
   null on failure, after a synthetic pty:exit so the overlay shows. */
function spawnPty(cols, rows) {
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
    if (ptyProc !== proc) return; // a stale pty must not clobber a restart
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { exitCode, signal });
    }
    ptyProc = null;
  });

  return proc;
}

// Replay pre-ready output so the first prompt is never lost.
function flushBuffer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  for (const chunk of outputBuffer) {
    mainWindow.webContents.send('pty:data', chunk);
  }
  outputBuffer = [];
}

// Window.

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
      backgroundThrottling: false // terminal stays live when unfocused
    }
  });

  Menu.setApplicationMenu(null); // copy/paste lives in-terminal, no menu bar

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // xterm web links open in the system browser.
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

  // E2E driver hook. Dev only; tests/ never ships in the packaged app.
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

// IPC: the renderer's only path to anything privileged.

// Renderer ready: spawn at its grid size, then flush buffered output.
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

// Clipboard routes through main; renderer clipboard is flaky on Windows.
ipcMain.handle('clip:write', (event, text) => {
  if (typeof text !== 'string') return false;
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('clip:read', () => clipboard.readText());

// Feature subsystems each own their IPC channels.
claudewhat.register(ipcMain);
verbose.register(ipcMain, { getMainWindow: () => mainWindow, app, config });

// Restart in place, at the renderer's current grid size.
ipcMain.on('session:restart', (event, dims) => {
  if (ptyProc) {
    const old = ptyProc;
    ptyProc = null; // detach first so old.onExit no-ops
    try { old.kill(); } catch (_) {}
  }
  ptyProc = spawnPty(dims && dims.cols, dims && dims.rows);
});

// App lifecycle. Single instance: a second launch focuses the first.

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
