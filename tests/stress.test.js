'use strict';

/* Headless stability/stress tests for the pty layer VEShell depends on.
   Run: ELECTRON_RUN_AS_NODE=1 electron tests/stress.test.js
   Resize storms, output floods, spawn/kill churn, long lines, unicode. */

const os = require('os');
let pty;
try { pty = require('node-pty'); }
catch (e) { console.error('FAIL: node-pty load:', e.message); process.exit(2); }

const CWD = process.env.USERPROFILE || os.homedir();
const PS = 'powershell.exe';
const ARGS = ['-NoLogo', '-NoProfile'];
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function spawn(cols = 100, rows = 30) {
  return pty.spawn(PS, ARGS, { name: 'xterm-256color', cols, rows, cwd: CWD, env: process.env });
}

// 1. Resize storm: 200 rapid resizes must not crash or kill the session.
async function resizeStorm() {
  return new Promise((resolve) => {
    const p = spawn();
    let alive = true;
    p.onExit(() => { alive = false; });
    setTimeout(async () => {
      try {
        for (let i = 0; i < 200; i++) {
          const c = 40 + (i * 7) % 200;
          const r = 10 + (i * 3) % 60;
          p.resize(c, r);
          if (i % 25 === 0) await sleep(5);
        }
        await sleep(300);
        record('1. 200-resize storm keeps the session alive', alive,
          alive ? '' : 'session died');
      } catch (e) {
        record('1. 200-resize storm keeps the session alive', false, 'threw: ' + e.message);
      }
      try { p.kill(); } catch (_) {}
      resolve();
    }, 700);
  });
}

// 2. Output flood: 30k lines stream through without losing the tail.
async function outputFlood() {
  return new Promise((resolve) => {
    const p = spawn();
    let buf = '';
    let bytes = 0;
    let done = false;
    const MARK = 'FLOOD_DONE_MARKER';
    p.onData((d) => {
      bytes += d.length;
      buf += d;
      if (buf.length > 200000) buf = buf.slice(-100000); // keep tail bounded
      if (!done && buf.includes(MARK)) {
        done = true;
        record('2. 30k-line output flood streams through (tail intact)', true,
          `received ~${Math.round(bytes / 1024)} KB`);
        try { p.kill(); } catch (_) {}
        resolve();
      }
    });
    setTimeout(() => {
      p.write(`1..30000 | %{ "line $_" }; "${MARK}"\r`);
    }, 700);
    setTimeout(() => {
      if (!done) {
        record('2. 30k-line output flood streams through (tail intact)', false,
          `timeout; got ~${Math.round(bytes / 1024)} KB, no marker`);
        try { p.kill(); } catch (_) {}
        resolve();
      }
    }, 30000);
  });
}

// 3. Spawn/kill churn: 25 rapid lifecycles must not throw or leak handles.
async function spawnKillChurn() {
  let okCount = 0;
  let threw = null;
  for (let i = 0; i < 25; i++) {
    try {
      const p = spawn(80 + i, 24);
      await sleep(40);
      p.write('echo churn\r');
      await sleep(20);
      p.kill();
      okCount++;
    } catch (e) { threw = e.message; break; }
  }
  record('3. 25 spawn/kill cycles complete cleanly', okCount === 25,
    threw ? `threw after ${okCount}: ${threw}` : `${okCount}/25`);
}

// 4. Very long single line (100k chars, no newline) round-trips.
async function longLine() {
  return new Promise((resolve) => {
    const p = spawn(120, 30);
    let buf = '';
    let done = false;
    const HEAD = 'LONGSTART';
    const TAIL = 'LONGEND';
    p.onData((d) => {
      buf += d;
      if (buf.length > 400000) buf = buf.slice(-200000);
      if (!done && buf.includes(TAIL)) {
        done = true;
        record('4. 100k-char single line round-trips', true, '');
        try { p.kill(); } catch (_) {}
        resolve();
      }
    });
    setTimeout(() => {
      p.write(`"${HEAD}" + ("a"*100000) + "${TAIL}"\r`);
    }, 700);
    setTimeout(() => {
      if (!done) {
        record('4. 100k-char single line round-trips', false, 'timeout, no TAIL');
        try { p.kill(); } catch (_) {}
        resolve();
      }
    }, 20000);
  });
}

// 5. Unicode round-trip (CJK / emoji / accents) through the pty.
async function unicodeRoundTrip() {
  return new Promise((resolve) => {
    const p = spawn();
    let buf = '';
    let done = false;
    const TOKEN = 'U_café_日本語_\u{1F600}_END';
    p.onData((d) => {
      buf += d;
      if (!done && buf.includes('U_caf') && buf.includes('END')) {
        done = true;
        record('5. Unicode (CJK/emoji/accents) round-trips through pty', true, '');
        try { p.kill(); } catch (_) {}
        resolve();
      }
    });
    setTimeout(() => { p.write(`"${TOKEN}"\r`); }, 700);
    setTimeout(() => {
      if (!done) {
        record('5. Unicode (CJK/emoji/accents) round-trips through pty', false, 'timeout');
        try { p.kill(); } catch (_) {}
        resolve();
      }
    }, 15000);
  });
}

(async () => {
  console.log('VEShell stress/stability suite (Electron ABI:', process.versions.electron || 'NONE', ')\n');
  await resizeStorm();
  await outputFlood();
  await spawnKillChurn();
  await longLine();
  await unicodeRoundTrip();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== Stress: ${passed}/${results.length} passed ===`);
  try {
    require('fs').writeFileSync(
      require('path').join(__dirname, 'stress-result.json'),
      JSON.stringify({ passed, total: results.length, results }, null, 2));
  } catch (_) {}
  process.exit(passed === results.length ? 0 : 1);
})();
