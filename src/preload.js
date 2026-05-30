'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit API surface exposed to the renderer. No Node globals leak
// through (contextIsolation is on); the renderer can only do these things.
contextBridge.exposeInMainWorld('veshell', {
  // Dev/e2e flag — gates the renderer's debug hook so it never ships in prod.
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

  // session
  restart: (dims) => ipcRenderer.send('session:restart', dims)
});
