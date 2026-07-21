'use strict';

/* ClaudeWhat: explain a selected snippet in terminal context. One-shot
   claude -p; the instruction is a fixed arg, variable content goes on stdin
   (then closed). Output is plain text (no ANSI in -p mode). */

const { spawnClaude, sanitizeText } = require('./claude-proc');

const CLAUDE_WHAT_TIMEOUT = 90000;

// Single in-flight child, so closing the panel aborts it and saves quota.
let claudeWhatProc = null;

// instruction: fixed teaching prompt. context: transcript + selection.
function runClaudeWhat(instruction, context) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnClaude([instruction], { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: 'Could not start claude: ' + (err && err.message) });
      return;
    }

    // Replace any prior child and register this one for cancellation.
    if (claudeWhatProc) { try { claudeWhatProc.kill(); } catch (_) {} }
    claudeWhatProc = proc;

    const outChunks = [], errChunks = [];
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };

    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      finish({ ok: false, error: 'Timed out waiting for an explanation.' });
    }, CLAUDE_WHAT_TIMEOUT);

    // Buffer raw and decode once; a multibyte char can split across events.
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
        finish({ ok: true, text }); // non-zero but produced output
      } else {
        finish({ ok: false, error: sanitizeText(err).trim() || ('claude exited with code ' + code) });
      }
    });

    // Feed context on stdin and close so claude proceeds immediately.
    try {
      proc.stdin.write(context || '');
      proc.stdin.end();
    } catch (_) { /* stdin gone; the close handler still resolves */ }
  });
}

// Wire the ClaudeWhat IPC channels. Call once from main.js.
function register(ipcMain) {
  ipcMain.handle('claudewhat:explain', (event, payload) => {
    const p = payload || {};
    const instruction = typeof p.instruction === 'string' ? p.instruction : '';
    const context = typeof p.context === 'string' ? p.context : '';
    if (!instruction) return Promise.resolve({ ok: false, error: 'No instruction.' });
    return runClaudeWhat(instruction, context);
  });

  // Abort the in-flight explanation; renderer ignores a closed-panel result.
  ipcMain.on('claudewhat:cancel', () => {
    if (claudeWhatProc) {
      try { claudeWhatProc.kill(); } catch (_) {}
      claudeWhatProc = null;
    }
  });
}

module.exports = { register };
