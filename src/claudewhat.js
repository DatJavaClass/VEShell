'use strict';

// ===========================================================================
// ClaudeWhat: explain a selected snippet in the context of the terminal.
// A one-shot `claude -p` call. The INSTRUCTION is a fixed argument (no user
// text on the command line, so nothing to shell-escape); all variable content
// (the selection + surrounding transcript) is fed on stdin, which we then close
// so claude doesn't wait for more. Output is plain text (no ANSI in -p mode).
// ===========================================================================

const { spawnClaude, sanitizeText } = require('./claude-proc');

const CLAUDE_WHAT_TIMEOUT = 90000;

// The single in-flight ClaudeWhat child, so closing the panel can abort it and
// stop wasting a generation/quota on a result nobody will see.
let claudeWhatProc = null;

// instruction: the fixed teaching prompt. context: the transcript+selection.
function runClaudeWhat(instruction, context) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnClaude([instruction], { windowsHide: true });
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

// Wire the ClaudeWhat IPC channels. Call once from main.js.
function register(ipcMain) {
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
}

module.exports = { register };
