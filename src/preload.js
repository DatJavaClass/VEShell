'use strict';

/* Preload bridge: exposes a minimal window.veshell API to the sandboxed
   renderer over IPC. Never leak raw ipcRenderer or Node globals. */

const { contextBridge, ipcRenderer } = require('electron');

// removeAllListeners first so a page reload can't stack duplicate handlers.
function subscribe(channel, cb) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (_e, arg) => cb(arg));
}

contextBridge.exposeInMainWorld('veshell', {
  e2e: !!process.env.VESHELL_E2E, // gates debug hook, never in prod
  ready: (dims) => ipcRenderer.send('renderer:ready', dims),

  // pty I/O
  onData: (cb) => subscribe('pty:data', cb),
  onExit: (cb) => subscribe('pty:exit', cb),
  sendInput: (data) => ipcRenderer.send('pty:input', data),
  resize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),

  // clipboard, routed through main
  copy: (text) => ipcRenderer.invoke('clip:write', text),
  paste: () => ipcRenderer.invoke('clip:read'),

  // ClaudeWhat: explain a selection. Returns { ok, text } or { ok:false, error }.
  claudeWhat: (instruction, context) =>
    ipcRenderer.invoke('claudewhat:explain', { instruction, context }),
  claudeWhatCancel: () => ipcRenderer.send('claudewhat:cancel'),

  // Verbose: headless claude -p streaming critical-segment callouts.
  verboseStart: (task) => ipcRenderer.send('verbose:start', task),
  verboseCancel: () => ipcRenderer.send('verbose:cancel'),
  verboseMarkVisited: (runId, index) =>
    ipcRenderer.send('verbose:markVisited', { runId, index }),
  verboseHistoryLoad: () => ipcRenderer.invoke('verbose:historyLoad'),
  onVerboseSegment: (cb) => subscribe('verbose:segment', cb),
  onVerboseStatus: (cb) => subscribe('verbose:status', cb),

  // session
  restart: (dims) => ipcRenderer.send('session:restart', dims)
});
