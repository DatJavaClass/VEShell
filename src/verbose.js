'use strict';

/* Verbose run: headless claude -p that streams critical-segment callouts.
   Instruction is a fixed arg; task text goes on stdin (then closed). Each
   complete <<CW_SEGMENT>>..<<CW_END>> callout is parsed and sent to the renderer. */

const path = require('path'), fs = require('fs');
const { StringDecoder } = require('string_decoder');

const { spawnClaude, sanitizeText, resolveCwd } = require('./claude-proc');
const { parseSegments } = require('./verbose-parse');

const VERBOSE_TIMEOUT = 300000;

// Fixed instruction: do the task, emit callouts in the parser's format.
const VERBOSE_INSTRUCTION = `You are completing a programming task for a beginning student, inside their
project folder. The task itself is provided on stdin. Do the task fully and
normally (read and edit files as needed).

As you finish each genuinely important part of the work, emit a callout line in
EXACTLY this format, on its own line:
<<CW_SEGMENT>>{"label":"...","snippet":"...","detail":"..."}<<CW_END>>
- label: a short descriptive title for the critical part (a few words).
- snippet: a few key lines of the relevant code, or "" if not useful.
- detail: 1 to 3 sentences explaining what this part does and why it matters.
Emit between 3 and 6 callouts total, and ONLY for the parts that genuinely make
the thing work, never routine boilerplate or trivial helpers.

Write every label, snippet comment, and detail in plain, impersonal, descriptive
language for a beginner: say what the code does, not who did it. Do not use the
first person. Do not mention being an AI, model, or assistant. Do not use
em-dashes. The JSON must be valid (escape quotes and newlines inside strings).`;

// Single in-flight child, so a new run or cancel aborts it.
let verboseProc = null;

// Wire the Verbose IPC channels. deps: { getMainWindow, app, config }.
function register(ipcMain, deps) {
  const { getMainWindow, app, config } = deps;

  // Persisted run history path (legacy claudewhat name).
  const historyPath = () => path.join(app.getPath('userData'), 'claudewhat-history.json');

  // Read history; missing or malformed becomes { runs: [] }.
  const readHistory = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
      if (parsed && Array.isArray(parsed.runs)) return parsed;
    } catch (_) { /* missing or malformed -> empty history */ }
    return { runs: [] };
  };

  // Write history, capped to the most recent 50 runs; failures ignored.
  const writeHistory = (history) => {
    try {
      const runs = Array.isArray(history.runs) ? history.runs : [];
      const capped = runs.slice(Math.max(0, runs.length - 50));
      fs.writeFileSync(historyPath(), JSON.stringify({ runs: capped }));
    } catch (err) {
      console.error('VEShell: failed to write verbose history:', err && err.message);
    }
  };

  ipcMain.on('verbose:start', (event, task) => {
    // Single in-flight run: kill any prior child first.
    if (verboseProc) { try { verboseProc.kill(); } catch (_) {} verboseProc = null; }

    const taskText = typeof task === 'string' ? task : '';
    const runId = 'r' + Date.now();
    const startedAt = Date.now();
    const cwd = resolveCwd(config);

    const send = (channel, payload) => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    };

    send('verbose:status', { runId, state: 'running', task: taskText });

    // === VERBOSE TEST STUB (DISABLED: uncomment the if-block below to re-enable) =
    // Exercises the full panel / timer / ClaudeWhat / history path WITHOUT a live
    // file-editing run. Trip it by submitting a task like "write hello world 30x
    // in C#". It feeds canned callouts over the normal IPC path (staggered, so the
    // reveal feels live); ClaudeWhat on a segment still makes a real claude -p
    // call, so a successful explanation proves the integration end to end.
    /* if (/hello world/i.test(taskText) && /\b30\b/.test(taskText)) {
      const demoSegments = [
        { label: 'The line that prints text',
          snippet: 'Console.WriteLine("Hello, World!");',
          detail: 'Console.WriteLine sends one line of text to the console and then moves to the next line. This is the statement that produces each greeting.' },
        { label: 'The loop that repeats 30 times',
          snippet: 'for (int i = 0; i < 30; i++)\n{\n    Console.WriteLine("Hello, World!");\n}',
          detail: 'A for loop runs the block inside it a fixed number of times. Here i counts from 0 up to 29, so the print statement runs 30 times.' },
        { label: 'The program entry point',
          snippet: 'static void Main(string[] args)',
          detail: 'Main is where a C# program starts running. The loop is placed inside Main so it runs when the program launches.' },
        { label: 'The full program together',
          snippet: 'using System;\n\nclass Program\n{\n    static void Main(string[] args)\n    {\n        for (int i = 0; i < 30; i++)\n        {\n            Console.WriteLine("Hello, World!");\n        }\n    }\n}',
          detail: 'The using directive brings in the Console type, the class wraps the code, and Main holds the loop. Together they print the greeting 30 times.' }
      ];
      const stubStored = [];
      const stubTimers = [];
      demoSegments.forEach((s, i) => {
        stubTimers.push(setTimeout(() => {
          stubStored.push({ index: i, label: s.label, snippet: s.snippet, detail: s.detail, visited: false });
          send('verbose:segment', { runId, index: i, label: s.label, snippet: s.snippet, detail: s.detail });
          if (i === demoSegments.length - 1) {
            const history = readHistory();
            history.runs.push({ id: runId, task: taskText, startedAt, segments: stubStored });
            writeHistory(history);
            send('verbose:status', { runId, state: 'done' });
            if (verboseProc && verboseProc.__stub) verboseProc = null;
          }
        }, i * 900));
      });
      // A fake proc so verbose:cancel / a new run aborts the pending stub timers.
      verboseProc = { __stub: true, kill: () => stubTimers.forEach(clearTimeout) };
      return;
    } */
    // === END VERBOSE TEST STUB =================================================

    let proc;
    try {
      proc = spawnClaude(
        ['--permission-mode', 'acceptEdits', VERBOSE_INSTRUCTION],
        { cwd, windowsHide: true }
      );
    } catch (err) {
      send('verbose:status', {
        runId, state: 'error',
        error: 'Could not start claude: ' + (err && err.message)
      });
      return;
    }
    verboseProc = proc;

    // Stream-parse state: emitted count, unconsumed tail, stored segments, stderr.
    let emitted = 0, pending = '';
    const stored = [], errChunks = [];
    // Incremental decode so a split multibyte char can't corrupt a callout.
    const decoder = new StringDecoder('utf8');

    // Emit segments past the emitted watermark, storing each for history.
    const emitNew = (segments) => {
      for (let i = emitted; i < segments.length; i++) {
        const s = segments[i];
        const seg = {
          runId, index: i,
          label: sanitizeText(s.label),
          snippet: sanitizeText(s.snippet),
          detail: sanitizeText(s.detail)
        };
        stored.push({ index: i, label: seg.label, snippet: seg.snippet, detail: seg.detail, visited: false });
        send('verbose:segment', seg);
      }
      emitted = segments.length;
    };

    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      if (verboseProc === proc) verboseProc = null;
      send('verbose:status', { runId, state: 'error', error: 'Timed out waiting for the task to finish.' });
    }, VERBOSE_TIMEOUT);

    proc.stdout.on('data', (d) => {
      pending += decoder.write(d);
      const { segments, rest } = parseSegments(pending);
      emitNew(segments);
      pending = rest;
    });

    proc.stderr.on('data', (d) => { errChunks.push(d); });

    proc.on('error', (e) => {
      clearTimeout(timer);
      if (verboseProc === proc) verboseProc = null;
      send('verbose:status', { runId, state: 'error', error: 'claude failed to run: ' + (e && e.message) });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (verboseProc === proc) verboseProc = null;

      // Flush the decoder's final bytes and parse once more.
      pending += decoder.end();
      const { segments } = parseSegments(pending);
      emitNew(segments);

      // Persist the run (segments visited:false).
      const history = readHistory();
      history.runs.push({ id: runId, task: taskText, startedAt, segments: stored });
      writeHistory(history);

      if (code !== 0 && stored.length === 0) {
        const err = sanitizeText(Buffer.concat(errChunks).toString('utf8')).trim();
        send('verbose:status', { runId, state: 'error', error: err || ('claude exited with code ' + code) });
      } else {
        send('verbose:status', { runId, state: 'done' });
      }
    });

    // Feed the task on stdin and close so claude proceeds.
    try {
      proc.stdin.write(taskText);
      proc.stdin.end();
    } catch (_) { /* if stdin is gone, the close handler still reports */ }
  });

  ipcMain.on('verbose:cancel', () => {
    if (verboseProc) {
      try { verboseProc.kill(); } catch (_) {}
      verboseProc = null;
    }
  });

  ipcMain.on('verbose:markVisited', (event, payload) => {
    const p = payload || {};
    const history = readHistory();
    const run = history.runs.find((r) => r && r.id === p.runId);
    if (run && Array.isArray(run.segments) && run.segments[p.index]) {
      run.segments[p.index].visited = true;
      writeHistory(history);
    }
  });

  ipcMain.handle('verbose:historyLoad', () => readHistory().runs);
}

module.exports = { register };
