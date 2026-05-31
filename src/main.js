'use strict';

// ===========================================================================
// VEShell main process.
// Owns the app/window lifecycle, spawns the ConPTY-backed PowerShell->Claude
// session, and answers IPC from the sandboxed renderer (clipboard, ClaudeWhat,
// session restart). The renderer can't touch Node/OS APIs directly, so anything
// privileged (spawning processes, clipboard, file reads) happens here.
// ===========================================================================

const { app, BrowserWindow, ipcMain, clipboard, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// node-pty is a native module; it lives unpacked from the asar (see build.asarUnpack).
const pty = require('node-pty');

// child_process backs ClaudeWhat: a one-shot `claude -p` call that explains a
// selected snippet in the context of what is on the terminal. Plain require so
// it works the same in dev and packaged builds.
const { spawn } = require('child_process');

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

// Look for config.json in several locations (portable dir, exe dir, app dir,
// userData) and merge the first one found over the defaults. A missing or
// malformed file is ignored so the app always starts.
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
// Start the real shell behind a ConPTY at the given grid size and wire its
// output back to the renderer. Returns the process, or null on failure (in
// which case the renderer is told via a synthetic pty:exit so it can show the
// session-ended overlay instead of a blank window).
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

// Replay any pty output that arrived before the renderer was ready, so the
// PowerShell prompt / Claude banner is never lost on a slow first paint.
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
// IPC  (renderer -> main; the renderer's only path to anything privileged)
// ---------------------------------------------------------------------------
// Renderer signals it (and xterm) are ready: spawn the session at the reported
// grid size, then flush any buffered early output.
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

// ---------------------------------------------------------------------------
// ClaudeWhat: explain a selected snippet in the context of the terminal
// ---------------------------------------------------------------------------
// A one-shot `claude -p` call. The INSTRUCTION is a fixed argument (no user
// text on the command line, so nothing to shell-escape); all variable content
// (the selection + surrounding transcript) is fed on stdin, which we then close
// so claude doesn't wait for more. Output is plain text (no ANSI in -p mode).
const CLAUDE_WHAT_TIMEOUT = 90000;

// The single in-flight ClaudeWhat child, so closing the panel can abort it and
// stop wasting a generation/quota on a result nobody will see.
let claudeWhatProc = null;

// Resolve the claude executable: honor an override, else the known install
// path, else fall back to PATH ("claude").
function resolveClaudeBin() {
  if (process.env.VESHELL_CLAUDE_BIN) return process.env.VESHELL_CLAUDE_BIN;
  const local = path.join(
    process.env.USERPROFILE || os.homedir(), '.local', 'bin', 'claude.exe'
  );
  try { if (fs.existsSync(local)) return local; } catch (_) {}
  return 'claude';
}

// Strip control/escape bytes so a stray ANSI sequence can't reach the renderer
// markup. Keep tabs and newlines.
function sanitizeText(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')  // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // other controls (keep \t \n)
}

// instruction: the fixed teaching prompt. context: the transcript+selection.
function runClaudeWhat(instruction, context) {
  return new Promise((resolve) => {
    let bin;
    try { bin = resolveClaudeBin(); } catch (_) { bin = 'claude'; }

    let proc;
    try {
      proc = spawn(bin, ['-p', instruction], { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: 'Could not start claude: ' + (err && err.message) });
      return;
    }

    // Replace any prior in-flight child (shouldn't happen with the renderer's
    // busy guard, but stay safe) and register this one for cancellation.
    if (claudeWhatProc) { try { claudeWhatProc.kill(); } catch (_) {} }
    claudeWhatProc = proc;

    const outChunks = [];
    const errChunks = [];
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };

    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      finish({ ok: false, error: 'Timed out waiting for an explanation.' });
    }, CLAUDE_WHAT_TIMEOUT);

    // Accumulate raw Buffers and decode once, so a multibyte UTF-8 char split
    // across two data events (em-dash, curly quote) can't corrupt.
    proc.stdout.on('data', (d) => { outChunks.push(d); });
    proc.stderr.on('data', (d) => { errChunks.push(d); });

    proc.on('error', (e) => {
      clearTimeout(timer);
      if (claudeWhatProc === proc) claudeWhatProc = null;
      finish({ ok: false, error: 'claude failed to run: ' + (e && e.message) });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (claudeWhatProc === proc) claudeWhatProc = null;
      const out = Buffer.concat(outChunks).toString('utf8');
      const err = Buffer.concat(errChunks).toString('utf8');
      const text = sanitizeText(out).trim();
      if (code === 0 && text) {
        finish({ ok: true, text });
      } else if (text) {
        finish({ ok: true, text });           // non-zero but produced output
      } else {
        finish({ ok: false, error: sanitizeText(err).trim() || ('claude exited with code ' + code) });
      }
    });

    // Feed context on stdin and close it so claude proceeds immediately.
    try {
      proc.stdin.write(context || '');
      proc.stdin.end();
    } catch (_) { /* if stdin is gone, the close handler still resolves */ }
  });
}

ipcMain.handle('claudewhat:explain', (event, payload) => {
  const p = payload || {};
  const instruction = typeof p.instruction === 'string' ? p.instruction : '';
  const context = typeof p.context === 'string' ? p.context : '';
  if (!instruction) return Promise.resolve({ ok: false, error: 'No instruction.' });
  return runClaudeWhat(instruction, context);
});

// Abort the in-flight explanation (user closed the panel). The pending
// explain promise still resolves, but the renderer ignores a result for a
// closed panel, and we stop burning the generation here.
ipcMain.on('claudewhat:cancel', () => {
  if (claudeWhatProc) {
    try { claudeWhatProc.kill(); } catch (_) {}
    claudeWhatProc = null;
  }
});

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
