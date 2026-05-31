'use strict';

// ===========================================================================
// Preload bridge. Runs with Node access but in an isolated world, and exposes a
// small, explicit `window.veshell` API to the renderer over IPC. This is the
// only surface the (sandboxed, no-Node) renderer can use to reach the main
// process. Keep it minimal; never expose raw ipcRenderer or Node globals.
// ===========================================================================

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit API surface exposed to the renderer. No Node globals leak
// through (contextIsolation is on); the renderer can only do these things.
contextBridge.exposeInMainWorld('veshell', {
  // Dev/e2e flag, gates the renderer's debug hook so it never ships in prod.
  e2e: !!process.env.VESHELL_E2E,

  // Tell main the renderer (and xterm) is ready, with initial dimensions.
  ready: (dims) => ipcRenderer.send('renderer:ready', dims),

  // pty I/O. removeAllListeners first so a page reload can't stack duplicate
  // handlers (which would double every chunk of output).
  onData: (cb) => {
    ipcRenderer.removeAllListeners('pty:data');
    ipcRenderer.on('pty:data', (_e, data) => cb(data));
  },
  onExit: (cb) => {
    ipcRenderer.removeAllListeners('pty:exit');
    ipcRenderer.on('pty:exit', (_e, info) => cb(info));
  },
  sendInput: (data) => ipcRenderer.send('pty:input', data),
  resize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),

  // clipboard (routed through main process)
  copy: (text) => ipcRenderer.invoke('clip:write', text),
  paste: () => ipcRenderer.invoke('clip:read'),

  // ClaudeWhat: explain a selected snippet in the context of the terminal.
  // Returns { ok, text } or { ok:false, error }.
  claudeWhat: (instruction, context) =>
    ipcRenderer.invoke('claudewhat:explain', { instruction, context }),
  claudeWhatCancel: () => ipcRenderer.send('claudewhat:cancel'),

  // session
  restart: (dims) => ipcRenderer.send('session:restart', dims)
});
