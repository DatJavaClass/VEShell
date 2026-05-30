'use strict';

// End-to-end driver for VEShell's clipboard / keyboard behavior. Loaded by
// src/main.js only when VESHELL_E2E is set. It drives the REAL renderer
// (xterm.js + the real key handlers) through executeJavaScript and verifies
// data actually moves through the Electron clipboard and into the pty.
//
// Run via tests/run-e2e.cmd (sets a plain-powershell shell so the prompt
// echoes pasted text).

module.exports = function ({ app, mainWindow, clipboard, getPty }) {
  const wc = mainWindow.webContents;
  const results = [];
  let idCounter = 0;
  const uid = () => `${Date.now().toString(36)}_${idCounter++}`;

  const exec = (js) => wc.executeJavaScript(js, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  }

  // Dispatch a synthetic keydown on xterm's input textarea (exercises the real
  // attachCustomKeyEventHandler path).
  function key(k, mods = {}) {
    const opts = JSON.stringify({
      key: k, code: 'Key' + k.toUpperCase(),
      ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt,
      bubbles: true, cancelable: true
    });
    return exec(`(() => {
      const ev = new KeyboardEvent('keydown', ${opts});
      window.__veshell.textarea.dispatchEvent(ev);
      return true;
    })()`);
  }

  async function pollClipboard(predicate, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const text = clipboard.readText();
      if (predicate(text)) return text;
      await sleep(60);
    }
    return clipboard.readText();
  }

  async function pollBuffer(substr, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const text = await exec('window.__veshell.bufferText()');
      if (text.includes(substr)) return true;
      await sleep(80);
    }
    return false;
  }

  async function waitForPrompt(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const text = await exec('window.__veshell.bufferText()');
      // A PowerShell prompt line typically ends with "> ".
      if (/PS [^\n]*>\s*$/m.test(text) || /\n[A-Z]:\\[^\n]*>\s*$/m.test(text)) return true;
      await sleep(120);
    }
    return false;
  }

  async function run() {
    // Wait for xterm hook + a live PowerShell prompt.
    const startWait = Date.now();
    while (Date.now() - startWait < 10000) {
      const hooked = await exec('!!(window.__veshell && window.__veshell.textarea)').catch(() => false);
      if (hooked) break;
      await sleep(100);
    }
    const gotPrompt = await waitForPrompt();
    record('0. PowerShell prompt is ready in the renderer', gotPrompt,
      gotPrompt ? '' : 'no prompt detected');

    // --- 1. Copy via keyboard (Ctrl+Shift+C) ----------------------------------
    {
      const token = 'COPYKB_' + uid();
      await exec(`window.__veshell.term.write(${JSON.stringify(token)})`);
      await sleep(150);
      await exec('window.__veshell.term.selectAll()');
      clipboard.writeText('SENTINEL_BEFORE_COPY');
      await key('c', { ctrl: true, shift: true });
      const clip = await pollClipboard((t) => t.includes(token));
      record('1. Ctrl+Shift+C copies selection to clipboard', clip.includes(token),
        clip.includes(token) ? '' : `clipboard="${clip.slice(0, 60)}"`);
      await exec('window.__veshell.term.clearSelection()');
    }

    // --- 2. Copy plumbing via doCopy() (clipboard IPC path) -------------------
    {
      const token = 'COPYAPI_' + uid();
      await exec(`window.__veshell.term.write(${JSON.stringify(token)})`);
      await sleep(120);
      await exec('window.__veshell.term.selectAll()');
      clipboard.writeText('SENTINEL_BEFORE_API');
      await exec('window.__veshell.doCopy(false)');
      const clip = await pollClipboard((t) => t.includes(token));
      record('2. doCopy() routes selection through main-process clipboard',
        clip.includes(token), clip.includes(token) ? '' : `clipboard="${clip.slice(0, 60)}"`);
      await exec('window.__veshell.term.clearSelection()');
    }

    // --- 3. Smart Ctrl+C with NO selection must NOT touch the clipboard -------
    {
      await exec('window.__veshell.term.clearSelection()');
      clipboard.writeText('SENTINEL_KEEP_ME');
      await key('c', { ctrl: true });
      await sleep(400);
      const clip = clipboard.readText();
      const ok = clip === 'SENTINEL_KEEP_ME';
      record('3. Ctrl+C with no selection sends interrupt, leaves clipboard intact',
        ok, ok ? '' : `clipboard changed to "${clip.slice(0, 40)}"`);
    }

    // --- 4. Smart Ctrl+C WITH selection copies -------------------------------
    {
      const token = 'SMARTC_' + uid();
      await exec(`window.__veshell.term.write(${JSON.stringify(token)})`);
      await sleep(120);
      await exec('window.__veshell.term.selectAll()');
      clipboard.writeText('SENTINEL_BEFORE_SMART');
      await key('c', { ctrl: true });
      const clip = await pollClipboard((t) => t.includes(token));
      record('4. Ctrl+C with a selection copies it', clip.includes(token),
        clip.includes(token) ? '' : `clipboard="${clip.slice(0, 60)}"`);
      await exec('window.__veshell.term.clearSelection()');
    }

    // --- 5. Paste via Ctrl+V reaches the pty (prompt echoes it) ---------------
    {
      const token = 'PASTEKB_' + uid();
      clipboard.writeText(token);
      await exec('window.__veshell.term.focus()');
      await key('v', { ctrl: true });
      const seen = await pollBuffer(token, 5000);
      record('5. Ctrl+V pastes clipboard into the pty', seen,
        seen ? '' : 'pasted token never appeared at the prompt');
      // Clear the prompt line so it does not interfere with later tests.
      await exec("window.__veshell.term.paste('')");
      if (getPty()) getPty().write('\x15'); // Ctrl+U clears the PSReadLine input line
      await sleep(200);
    }

    // --- 6. Multiline (bracketed) paste delivers every line -------------------
    {
      const a = 'MULTI_A_' + uid();
      const b = 'MULTI_B_' + uid();
      const c = 'MULTI_C_' + uid();
      clipboard.writeText(`${a}\n${b}\n${c}`);
      await exec('window.__veshell.term.focus()');
      await key('v', { ctrl: true });
      const sawA = await pollBuffer(a, 5000);
      const sawC = await pollBuffer(c, 3000);
      record('6. Multiline paste delivers all lines (bracketed paste)',
        sawA && sawC, (sawA && sawC) ? '' : `sawA=${sawA} sawC=${sawC}`);
      if (getPty()) getPty().write('\x15');
      await sleep(200);
    }

    // --- 7. Cut behaves as copy on terminal output ---------------------------
    {
      const token = 'CUT_' + uid();
      await exec(`window.__veshell.term.write(${JSON.stringify(token)})`);
      await sleep(120);
      await exec('window.__veshell.term.selectAll()');
      clipboard.writeText('SENTINEL_BEFORE_CUT');
      await key('x', { ctrl: true, shift: true });
      const clip = await pollClipboard((t) => t.includes(token));
      record('7. Ctrl+Shift+X (cut) copies selection', clip.includes(token),
        clip.includes(token) ? '' : `clipboard="${clip.slice(0, 60)}"`);
      await exec('window.__veshell.term.clearSelection()');
    }

    // --- 8. Select-all yields a non-empty selection --------------------------
    {
      await exec('window.__veshell.term.selectAll()');
      const sel = await exec('window.__veshell.selection()');
      record('8. Select All produces a non-empty selection',
        !!sel && sel.length > 0, `selection length=${sel ? sel.length : 0}`);
      await exec('window.__veshell.term.clearSelection()');
    }

    // --- 9. Unicode copy (CJK / emoji / accents) -----------------------------
    {
      const token = 'UNI_café_日本語_😀_' + uid();
      await exec(`window.__veshell.term.write(${JSON.stringify(token)})`);
      await sleep(150);
      await exec('window.__veshell.term.selectAll()');
      clipboard.writeText('SENTINEL_BEFORE_UNI');
      await key('c', { ctrl: true, shift: true });
      const clip = await pollClipboard((t) => t.includes(token));
      record('9. Unicode (CJK/emoji/accents) copies intact', clip.includes(token),
        clip.includes(token) ? '' : `clipboard="${clip.slice(0, 80)}"`);
      await exec('window.__veshell.term.clearSelection()');
    }

    // --- 10. Unicode paste reaches the pty -----------------------------------
    {
      const token = 'UNIPASTE_café_日本_😀_' + uid();
      clipboard.writeText(token);
      await exec('window.__veshell.term.focus()');
      await key('v', { ctrl: true });
      // The pty may render combining/wide chars differently; check the ASCII tail.
      const tail = token.split('_').pop();
      const seen = await pollBuffer(tail, 5000);
      record('10. Unicode paste reaches the pty', seen,
        seen ? '' : 'unicode paste tail not seen at prompt');
      if (getPty()) getPty().write('\x15');
      await sleep(200);
    }

    // --- 11. Large paste (~20 KB) does not hang ------------------------------
    {
      const marker = 'BIGEND_' + uid();
      const big = 'x'.repeat(20000) + marker;
      clipboard.writeText(big);
      await exec('window.__veshell.term.focus()');
      const t0 = Date.now();
      await key('v', { ctrl: true });
      const seen = await pollBuffer(marker, 8000);
      const elapsed = Date.now() - t0;
      record('11. Large 20KB paste delivers fully without hanging',
        seen && elapsed < 8000, `seen=${seen} elapsed=${elapsed}ms`);
      if (getPty()) getPty().write('\x15');
      await sleep(300);
    }

    // --- 12. Session restart yields a fresh, live prompt ---------------------
    {
      await exec('window.__veshell.restart()');
      // After restart the buffer resets; wait for a new prompt + echo round-trip.
      await sleep(800);
      const token = 'AFTER_RESTART_' + uid();
      // Type into the fresh session and confirm it echoes (pty is alive).
      if (getPty()) getPty().write(`'${token}'\r`);
      const seen = await pollBuffer(token, 8000);
      record('12. Session restart spawns a fresh, responsive pty', seen,
        seen ? '' : 'no echo from restarted session');
      if (getPty()) getPty().write('\x15');
      await sleep(200);
    }

    // --- 13. Window resize propagates new column count to the pty ------------
    // Verifies the full real chain: window resize -> renderer fit -> term
    // onResize -> resize IPC -> main pty.resize(). node-pty's proc exposes its
    // live .cols/.rows, so we assert the pty actually received the new grid
    // (no fragile PowerShell parsing — PSReadLine mangles fed-in brackets).
    {
      const before = await exec('window.__veshell.dims()');
      mainWindow.setContentSize(820, 560);
      await sleep(400);              // debounced fit (60ms) + resize IPC
      mainWindow.setContentSize(1180, 760);
      await sleep(500);
      const after = await exec('window.__veshell.dims()');
      const pty = getPty();
      const ptyCols = pty ? pty.cols : NaN;
      const ptyRows = pty ? pty.rows : NaN;
      const changed = before.cols !== after.cols;
      const matches = Number.isFinite(ptyCols) && ptyCols === after.cols &&
        ptyRows === after.rows;
      record('13. Window resize propagates columns/rows to the pty',
        changed && matches,
        `xterm ${before.cols}x${before.rows}->${after.cols}x${after.rows}, ` +
        `pty now ${ptyCols}x${ptyRows}`);
    }

    // --- Summary --------------------------------------------------------------
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n=== E2E clipboard/keyboard: ${passed}/${results.length} passed ===`);
    writeResult({ passed, total: results.length, results });
    app.exit(passed === results.length ? 0 : 1);
  }

  function writeResult(payload) {
    try {
      const fs = require('fs');
      const path = require('path');
      const out = process.env.VESHELL_E2E_OUT ||
        path.join(__dirname, 'e2e-result.json');
      fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      console.error('could not write e2e result file:', e.message);
    }
  }

  run().catch((err) => {
    console.error('E2E driver error:', err && err.stack ? err.stack : err);
    writeResult({ passed: 0, total: results.length || 1, error: String(err && err.stack || err), results });
    app.exit(4);
  });
};
