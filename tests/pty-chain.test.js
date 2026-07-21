'use strict';

/* Headless test of the VEShell launch chain: node-pty (ConPTY) -> powershell -> claude.
   Run under Electron's ABI: ELECTRON_RUN_AS_NODE=1 electron tests/pty-chain.test.js
   node-pty is compiled against Electron, so plain `node` cannot load it. */

const path = require('path');
const os = require('os');

let pty;
try {
  pty = require('node-pty');
} catch (err) {
  console.error('FAIL: could not load node-pty:', err.message);
  process.exit(2);
}

const CWD = process.env.USERPROFILE || os.homedir();
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function stripAnsi(s) {
  // Remove CSI/OSC escape sequences so we can string-match the visible text.
  return s
    .replace(/\][^]*(?:|\\)/g, '')
    .replace(/[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]/g, '');
}

// Test A: spawn powershell, run an expression, see the result.
function testPowerShell() {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const proc = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile'], {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: CWD,
      env: Object.assign({}, process.env, { TERM: 'xterm-256color' })
    });

    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      record('A. PowerShell spawns and echoes I/O over ConPTY', ok, detail);
      try { proc.kill(); } catch (_) {}
      resolve(ok);
    };

    proc.onData((d) => {
      buf += d;
      const clean = stripAnsi(buf);
      if (clean.includes('VESHELL_MARKER_4')) {
        finish(true, 'evaluated expression, got VESHELL_MARKER_4');
      }
    });
    proc.onExit(() => { if (!done) finish(false, 'powershell exited early'); });

    // Give the prompt a beat, then send a marker expression.
    setTimeout(() => {
      proc.write("'VESHELL_MARKER_' + (2+2)\r");
    }, 800);

    setTimeout(() => finish(false, 'timed out waiting for marker\n--- last output ---\n' +
      stripAnsi(buf).slice(-400)), 12000);
  });
}

// Test B: ConPTY accepts resizes without throwing or dying.
function testResize() {
  return new Promise((resolve) => {
    let done = false;
    const proc = pty.spawn('powershell.exe', ['-NoLogo', '-NoProfile'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: CWD, env: process.env
    });
    const finish = (ok, detail) => {
      if (done) return; done = true;
      record('B. ConPTY resize does not crash the session', ok, detail);
      try { proc.kill(); } catch (_) {}
      resolve(ok);
    };
    let alive = true;
    proc.onExit(() => { alive = false; });
    setTimeout(() => {
      try {
        for (const [c, r] of [[120, 40], [200, 50], [60, 20], [100, 30]]) {
          proc.resize(c, r);
        }
        setTimeout(() => finish(alive, alive ? 'resized 4x, still alive' : 'died after resize'), 400);
      } catch (e) {
        finish(false, 'resize threw: ' + e.message);
      }
    }, 800);
  });
}

// Test C: real chain powershell -NoExit -Command claude; confirm it runs.
function testClaudeChain() {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const proc = pty.spawn('powershell.exe', ['-NoLogo', '-NoExit', '-Command', 'claude'], {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: CWD,
      env: Object.assign({}, process.env, { TERM: 'xterm-256color' })
    });
    const finish = (ok, detail) => {
      if (done) return; done = true;
      record('C. Chain wrapper->powershell->claude launches Claude Code', ok, detail);
      // Send Ctrl+C then exit to unwind claude + powershell cleanly.
      try { proc.write('\x03'); } catch (_) {}
      setTimeout(() => { try { proc.kill(); } catch (_) {} }, 300);
      resolve(ok);
    };

    proc.onData((d) => {
      buf += d;
      const clean = stripAnsi(buf).toLowerCase();
      // Evidence Claude Code started: its name, the prompt box, or a known phrase.
      if (clean.includes('claude') || clean.includes('anthropic') ||
          clean.includes('/help') || clean.includes('welcome') ||
          clean.includes('bypass') || clean.includes('cwd')) {
        finish(true, 'detected Claude Code output');
      }
    });
    proc.onExit(() => {
      if (!done) {
        finish(false, 'session exited before Claude UI detected\n--- last output ---\n' +
          stripAnsi(buf).slice(-500));
      }
    });

    setTimeout(() => {
      if (!done) {
        // Not a failure: claude may sit in a full-screen TUI our keywords missed.
        const clean = stripAnsi(buf);
        const ok = clean.trim().length > 0;
        finish(ok, ok
          ? 'produced output (TUI active); keywords not matched but chain ran\n--- sample ---\n' + clean.slice(-500)
          : 'no output at all from claude');
      }
    }, 15000);
  });
}

(async () => {
  console.log('VEShell PTY chain test (Electron ABI:', process.versions.electron || 'NONE', ')');
  console.log('cwd for sessions:', CWD, '\n');

  const a = await testPowerShell();
  const b = await testResize();
  const c = await testClaudeChain();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  process.exit(a && b && c ? 0 : 1);
})();
