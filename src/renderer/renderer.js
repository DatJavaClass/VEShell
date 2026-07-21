'use strict';

/* VEShell renderer: xterm.js UI, clipboard, menus, ClaudeWhat and Verbose
   panels. Sandboxed (no Node, strict CSP); privileged work goes via `veshell`. */

/* global Terminal, FitAddon, WebLinksAddon, veshell */

const $ = (id) => document.getElementById(id);
const isHidden = (el) => el.classList.contains('hidden');
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

// Appearance lives here; shell/cwd live in config.json on the main side.
const APPEARANCE = {
  fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
  fontSize: 14,
  scrollback: 10000,
  copyOnSelect: false,
  verboseTimerSec: 45
};

const THEME = {
  background: '#1e1e1e',
  foreground: '#e6e6e6',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  black: '#1e1e1e', red: '#f14c4c', green: '#23d18b', yellow: '#f5f543',
  blue: '#3b8eea', magenta: '#d670d6', cyan: '#29b8db', white: '#e6e6e6',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
  brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
  brightCyan: '#29b8db', brightWhite: '#ffffff'
};

// Terminal setup.

const term = new Terminal({
  fontFamily: APPEARANCE.fontFamily,
  fontSize: APPEARANCE.fontSize,
  scrollback: APPEARANCE.scrollback,
  cursorBlink: true,
  allowProposedApi: true,
  macOptionIsMeta: false,
  rightClickSelectsWord: false,
  theme: THEME
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
try {
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
} catch (_) { /* web-links optional */ }

const termEl = $('terminal');
term.open(termEl);

function safeFit() {
  try { fitAddon.fit(); } catch (_) { /* not laid out yet */ }
}

safeFit();
requestAnimationFrame(() => safeFit()); // refit once layout settles; status bar inset
term.focus();

veshell.ready({ cols: term.cols, rows: term.rows }); // main spawns the session

// pty <-> terminal data flow.

veshell.onData((data) => term.write(data));

term.onData((data) => veshell.sendInput(data));

term.onResize(({ cols, rows }) => veshell.resize(cols, rows)); // keep pty in sync

// Clipboard actions.

/* Copy the selection via main. False when nothing selected;
   smart-Ctrl+C uses that to fall through to ^C. */
async function doCopy(clearAfter) {
  const sel = term.getSelection();
  if (sel && sel.length) {
    await veshell.copy(sel);
    if (clearAfter) term.clearSelection();
    showToast('Copied');
    return true;
  }
  return false;
}

// Scrollback can't be removed, so cut just copies.
async function doCut() {
  const ok = await doCopy(true);
  if (ok) showToast('Cut (copied)');
}

async function doPaste() {
  const text = await veshell.paste();
  if (text && text.length) {
    const clean = text.replace(/\x00/g, ''); // NUL is never valid input
    if (!clean.length) return;
    // term.paste is bracketed-paste aware; multiline lands as one block.
    term.paste(clean);
    showToast('Pasted');
  }
}

// Keyboard: intercept copy/paste/cut/select-all before xterm forwards to pty.

term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;

  const ctrl = e.ctrlKey, shift = e.shiftKey, alt = e.altKey;
  const key = (e.key || '').toLowerCase();

  /* preventDefault is mandatory here: xterm has its own copy/paste DOM
     handlers, and letting the default fire too would paste/copy twice. */
  const handle = (fn) => { e.preventDefault(); fn(); return false; };

  // Explicit shortcuts, never ambiguous with terminal control codes.
  if (ctrl && shift && key === 'c') return handle(() => doCopy(false));
  if (ctrl && shift && key === 'v') return handle(() => doPaste());
  if (ctrl && shift && key === 'x') return handle(() => doCut());
  if (ctrl && shift && key === 'a') return handle(() => term.selectAll());
  if (ctrl && shift && key === 'w') return handle(() => openClaudeWhat());
  if (ctrl && shift && key === 'r') return handle(() => openVerbosePrompt());

  /* Smart Ctrl+C: copy a real selection, else interrupt. Gate on
     getSelection().length so a phantom selection can't swallow ^C. */
  if (ctrl && !shift && !alt && key === 'c') {
    const sel = term.getSelection();
    if (sel && sel.length) return handle(() => doCopy(true));
    return true; // let xterm send \x03
  }

  if (ctrl && !shift && !alt && key === 'v') return handle(() => doPaste());

  return true;
});

// Mouse: copy-on-select (optional), middle-click paste, right-click menu.

if (APPEARANCE.copyOnSelect) {
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel && sel.length) veshell.copy(sel);
  });
}

termEl.addEventListener('mousedown', (e) => {
  if (e.button === 1) { // middle-click paste, X11 style
    e.preventDefault();
    doPaste();
  }
});

// Context menu.

const menu = $('context-menu');

// Show at (x,y), grey out copy/cut without a selection, clamp to viewport.
function showMenu(x, y) {
  const hasSel = term.hasSelection();
  menu.querySelector('[data-action="copy"]').classList.toggle('disabled', !hasSel);
  menu.querySelector('[data-action="cut"]').classList.toggle('disabled', !hasSel);

  show(menu);
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 4);
  const py = Math.min(y, window.innerHeight - rect.height - 4);
  menu.style.left = px + 'px';
  menu.style.top = py + 'px';
}

function hideMenu() { hide(menu); }

termEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showMenu(e.clientX, e.clientY);
});

menu.addEventListener('click', (e) => {
  const item = e.target.closest('.ctx-item');
  if (!item || item.classList.contains('disabled')) return;
  const action = item.dataset.action;
  hideMenu();
  switch (action) {
    case 'copy': doCopy(false); break;
    case 'cut': doCut(); break;
    case 'paste': doPaste(); break;
    case 'selectAll': term.selectAll(); break;
    case 'claudewhat': openClaudeWhat(); return; // panel takes focus
    case 'verbose': openVerbosePrompt(); return; // panel takes focus
    case 'clear': term.clear(); break;
    case 'restart': restartSession(); break;
  }
  term.focus();
});

// Any outside interaction dismisses the menu.
window.addEventListener('mousedown', (e) => {
  if (!menu.contains(e.target)) hideMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideMenu();
});
window.addEventListener('blur', hideMenu);

// Resize handling.

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(safeFit, 60);
});

// Refit after fonts load; dodges an off-by-a-row first grid.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => safeFit());
}

// Session end / restart.

const overlay = $('overlay'), overlayMsg = $('overlay-msg');

// Reset the dead view, ask main for a fresh session at the current grid.
function restartSession() {
  hide(overlay);
  term.reset();
  safeFit();
  veshell.restart({ cols: term.cols, rows: term.rows });
  term.focus();
}

veshell.onExit((info) => {
  const { exitCode, error } = info || {};
  overlayMsg.textContent = error
    ? error
    : `Session ended (exit code ${exitCode}).`;
  show(overlay);
});

$('overlay-restart').addEventListener('click', restartSession);
window.addEventListener('keydown', (e) => {
  if (!isHidden(overlay) && e.key === 'Enter') {
    e.preventDefault();
    restartSession();
  }
});

// Toast.

const toastEl = $('toast');
let toastTimer = null, toastFadeTimer = null;

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden', 'fade');
  if (toastTimer) clearTimeout(toastTimer);
  if (toastFadeTimer) clearTimeout(toastFadeTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('fade');
    toastFadeTimer = setTimeout(() => hide(toastEl), 260);
  }, 900);
}

/* Status bar hint. The bar says "ExplainPlease"; everywhere else the
   feature keeps its ClaudeWhat name. Deliberate. */

const statusHintEl = $('status-hint');
const STATUS_HINTS = [
  'Ctrl+Shift+R  ·  Verbose mode',
  'Ctrl+Shift+W  ·  ExplainPlease'
];
let statusHintIndex = 0;

function showStatusHint() {
  statusHintEl.textContent = STATUS_HINTS[statusHintIndex];
  statusHintIndex = (statusHintIndex + 1) % STATUS_HINTS.length;
}

showStatusHint();
setInterval(showStatusHint, 4500);

// Click refocuses the terminal unless a surface is up (don't steal clicks).
window.addEventListener('mouseup', () => {
  if (isHidden(menu) && isHidden(overlay) && isHidden(cwPanel) &&
      isHidden(vrPanel) && isHidden(vrPrompt)) {
    term.focus();
  }
});

/* ClaudeWhat: explain a selected snippet in terminal context.
   Selection + scrollback go to `claude -p` in main; the answer lands in this
   panel. Nothing is injected into Claude's live TUI. */

const cwPanel = $('claudewhat'), cwBody = $('cw-body'), cwTitle = $('cw-title');
const cwBtnUp = $('cw-pageup'), cwBtnDown = $('cw-pagedown'),
      cwBtnMore = $('cw-more'), cwBtnReturn = $('cw-return');

const CW_INSTRUCTION =
  'You are a teaching assistant embedded in a terminal. The user is learning ' +
  'and has highlighted a snippet from what is on their screen. Using the ' +
  'terminal context provided on stdin, explain the highlighted selection in ' +
  'that context: what it is, and why it appears here. Be concrete and ' +
  'reference the surrounding commands/output. Keep it clear for a learner. ' +
  'Plain text only, no markdown headers.';

const CW_MORE_INSTRUCTION =
  'You are a teaching assistant. The user already saw a short explanation of a ' +
  'highlighted snippet and wants to go deeper. Using the terminal context on ' +
  'stdin, give a more thorough explanation of the selection: edge cases, ' +
  'alternatives, and the underlying concept, still aimed at a learner. Plain ' +
  'text only, no markdown headers.';

/* Scrollback window around the selection; the lines above it are what
   make "why" answerable. */
const CW_CONTEXT_BEFORE = 60;
const CW_CONTEXT_AFTER = 10;

/* onClose: when set, closeClaudeWhat() calls it instead of refocusing the
   terminal. Verbose run uses it to resume its panel. */
const cwState = { selection: '', context: '', busy: false, onClose: null };

/* Window the active buffer around the selection (absolute rows, so scroll
   position doesn't matter); fall back to the viewport bottom. */
function scrapeContext() {
  const buf = term.buffer.active;
  const total = buf.length;
  let anchorTop, anchorBottom;
  let selPos = null;
  try { selPos = term.getSelectionPosition(); } catch (_) { selPos = null; }
  if (selPos && selPos.start && selPos.end) {
    anchorTop = selPos.start.y;
    anchorBottom = selPos.end.y;
  } else {
    const viewportBottom = buf.baseY + term.rows;
    anchorTop = viewportBottom - term.rows;
    anchorBottom = viewportBottom;
  }
  const start = Math.max(0, anchorTop - CW_CONTEXT_BEFORE);
  const end = Math.min(total, anchorBottom + CW_CONTEXT_AFTER);
  let lines = [];
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true).replace(/\s+$/g, ''));
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

// Stdin payload: transcript plus selection, clearly delimited.
function buildContextPayload(selection, transcript) {
  return [
    'TERMINAL CONTEXT (recent lines on screen):',
    '----------------------------------------',
    transcript,
    '----------------------------------------',
    '',
    'HIGHLIGHTED SELECTION:',
    selection
  ].join('\n');
}

function isClaudeWhatOpen() { return !isHidden(cwPanel); }

function openClaudeWhat() {
  const sel = term.getSelection();
  if (!sel || !sel.trim().length) {
    showToast('Select some text first');
    return;
  }
  cwState.selection = sel.trim();
  cwState.context = buildContextPayload(cwState.selection, scrapeContext());
  cwTitle.textContent = 'ClaudeWhat: explaining selection';
  show(cwPanel);
  requestExplanation(CW_INSTRUCTION);
}

function closeClaudeWhat() {
  hide(cwPanel);
  // Abort in-flight work; no point burning a generation we'll drop.
  if (cwState.busy) { try { veshell.claudeWhatCancel(); } catch (_) {} }
  cwState.busy = false;
  // An onClose hook (verbose run) owns focus from here.
  if (cwState.onClose) {
    const cb = cwState.onClose;
    cwState.onClose = null;
    cb();
    return;
  }
  term.focus();
}

// Same panel, seeded from passed text instead of the terminal selection.
function openClaudeWhatForText(text) {
  cwState.selection = text;
  cwState.context = buildContextPayload(text, '(from a verbose-run callout)');
  cwTitle.textContent = 'ClaudeWhat: explaining selection';
  show(cwPanel);
  requestExplanation(CW_INSTRUCTION);
}

function setCwButtonsEnabled(on) {
  for (const b of [cwBtnUp, cwBtnDown, cwBtnMore]) {
    b.classList.toggle('disabled', !on);
  }
}

/* One explanation round-trip. busy blocks overlaps; a closed panel drops
   the result on the floor. */
async function requestExplanation(instruction) {
  if (cwState.busy) return;
  cwState.busy = true;
  setCwButtonsEnabled(false);
  cwBody.textContent = 'Thinking…';
  cwBody.scrollTop = 0;
  let res;
  try {
    res = await veshell.claudeWhat(instruction, cwState.context);
  } catch (e) {
    res = { ok: false, error: 'Request failed.' };
  }
  cwState.busy = false;
  if (!isClaudeWhatOpen()) return;
  if (res && res.ok) {
    cwBody.textContent = res.text;
  } else {
    cwBody.textContent = 'Could not get an explanation.\n\n' +
      ((res && res.error) ? res.error : 'Unknown error.');
  }
  cwBody.scrollTop = 0;
  setCwButtonsEnabled(true);
  updateCwPageButtons();
}

// Page by ~90% of the visible height.
function cwPage(dir) {
  const step = Math.max(40, Math.floor(cwBody.clientHeight * 0.9));
  cwBody.scrollTop += dir * step;
  updateCwPageButtons();
}

function updateCwPageButtons() {
  const atTop = cwBody.scrollTop <= 0;
  const atBottom = cwBody.scrollTop + cwBody.clientHeight >= cwBody.scrollHeight - 1;
  cwBtnUp.classList.toggle('disabled', atTop);
  cwBtnDown.classList.toggle('disabled', atBottom);
}

cwBtnUp.addEventListener('click', () => { if (!cwBtnUp.classList.contains('disabled')) cwPage(-1); });
cwBtnDown.addEventListener('click', () => { if (!cwBtnDown.classList.contains('disabled')) cwPage(1); });
cwBtnMore.addEventListener('click', () => { if (!cwBtnMore.classList.contains('disabled')) requestExplanation(CW_MORE_INSTRUCTION); });
cwBtnReturn.addEventListener('click', () => closeClaudeWhat());
cwBody.addEventListener('scroll', updateCwPageButtons);

// Capture-phase so the panel wins the keys while it is open.
window.addEventListener('keydown', (e) => {
  if (!isClaudeWhatOpen()) return;
  if (e.key === 'Escape') { e.preventDefault(); closeClaudeWhat(); return; }
  if (e.key === 'PageUp') { e.preventDefault(); cwPage(-1); return; }
  if (e.key === 'PageDown') { e.preventDefault(); cwPage(1); return; }
}, true);

/* Verbose run: describe a task, run it headless via `claude -p` in main,
   reveal each critical-segment callout on a skippable timer. ClaudeWhat can
   dig into any segment; visited segments persist across restarts. */

const vrPrompt = $('vr-prompt'), vrInput = $('vr-input'), vrGo = $('vr-go'),
      vrCancelPrompt = $('vr-cancel-prompt'), vrHistory = $('vr-history');
const vrPanel = $('vr-panel'), vrLabel = $('vr-label'),
      vrSnippet = $('vr-snippet'), vrDetail = $('vr-detail'),
      vrTimer = $('vr-timer'), vrNext = $('vr-next'),
      vrClaudeWhat = $('vr-claudewhat'), vrExit = $('vr-exit');

/* segments is arrival-ordered; current is the showing index (-1 = none);
   timer is the 1s countdown interval with remaining seconds left. */
const vrState = {
  runId: null, segments: [], current: -1,
  timer: null, remaining: 0, runState: 'idle'
};

function vrIsPanelOpen() { return !isHidden(vrPanel); }

function vrClearTimer() {
  if (vrState.timer) { clearInterval(vrState.timer); vrState.timer = null; }
}

// One-line status in the body instead of a segment (waiting/finished).
function vrShowMessage(text) {
  vrClearTimer();
  vrTimer.textContent = '';
  vrLabel.textContent = text;
  vrSnippet.textContent = '';
  vrSnippet.style.display = 'none';
  vrDetail.textContent = '';
}

// Render segment i and start its countdown.
function vrShowSegment(i) {
  const seg = vrState.segments[i];
  if (!seg) return;
  vrState.current = i;
  vrLabel.textContent = seg.label || '';
  if (seg.snippet && seg.snippet.length) {
    vrSnippet.textContent = seg.snippet;
    vrSnippet.style.display = '';
  } else {
    vrSnippet.textContent = '';
    vrSnippet.style.display = 'none';
  }
  vrDetail.textContent = seg.detail || '';
  vrStartTimer();
}

// 1s countdown from verboseTimerSec; at 0 we advance.
function vrStartTimer() {
  vrClearTimer();
  vrState.remaining = APPEARANCE.verboseTimerSec;
  vrTimer.textContent = vrState.remaining + 's';
  vrState.timer = setInterval(() => {
    vrState.remaining -= 1;
    if (vrState.remaining <= 0) {
      vrTimer.textContent = '0s';
      vrAdvance();
    } else {
      vrTimer.textContent = vrState.remaining + 's';
    }
  }, 1000);
}

// Next segment if one exists, else waiting/finished by run state.
function vrAdvance() {
  vrClearTimer();
  const next = vrState.current + 1;
  if (next < vrState.segments.length) {
    vrShowSegment(next);
  } else if (vrState.runState === 'running') {
    vrShowMessage('Waiting for the next step.');
  } else {
    vrShowMessage('Finished. Return to your project when ready.');
  }
}

/* History list: task + segment labels per run; visited get .vr-visited.
   data-* attrs let markVisited find entries later. */
function vrRenderHistory(runs) {
  vrHistory.textContent = '';
  if (!runs || !runs.length) return;
  for (const run of runs) {
    const runEl = document.createElement('div');
    runEl.className = 'vr-history-run';
    const taskEl = document.createElement('div');
    taskEl.className = 'vr-history-task';
    taskEl.textContent = run.task || '(untitled run)';
    runEl.appendChild(taskEl);
    const segs = run.segments || [];
    for (const seg of segs) {
      const segEl = document.createElement('div');
      segEl.className = 'vr-history-seg' + (seg.visited ? ' vr-visited' : '');
      segEl.dataset.runId = run.id;
      segEl.dataset.index = seg.index;
      segEl.textContent = seg.label || '(segment)';
      runEl.appendChild(segEl);
    }
    vrHistory.appendChild(runEl);
  }
}

function vrMarkHistoryVisited(runId, index) {
  const entry = vrHistory.querySelector(
    '.vr-history-seg[data-run-id="' + runId + '"][data-index="' + index + '"]'
  );
  if (entry) entry.classList.add('vr-visited');
}

// Open the prompt box, populate recent runs, focus the textarea.
async function openVerbosePrompt() {
  hideMenu();
  let runs = [];
  try {
    // verboseHistoryLoad resolves to the runs ARRAY, not a { runs } wrapper.
    const data = await veshell.verboseHistoryLoad();
    runs = Array.isArray(data) ? data : (data && data.runs) ? data.runs : [];
  } catch (_) { runs = []; }
  vrRenderHistory(runs);
  show(vrPrompt);
  vrInput.focus();
}

function closeVerbosePrompt() {
  hide(vrPrompt);
}

// Start the run, switch to the panel, reset queue state.
function vrSubmit() {
  const task = (vrInput.value || '').trim();
  if (!task) { showToast('Type a task first'); return; }
  closeVerbosePrompt();
  vrState.runId = null;
  vrState.segments = [];
  vrState.current = -1;
  vrState.remaining = 0;
  vrState.runState = 'running';
  vrClearTimer();
  show(vrPanel);
  vrShowMessage('Working. The first critical step will appear shortly.');
  veshell.verboseStart(task);
}

// Leave the panel: stop run and timer, refocus terminal.
function closeVerbosePanel() {
  vrClearTimer();
  try { veshell.verboseCancel(); } catch (_) {}
  vrState.runState = 'idle';
  hide(vrPanel);
  term.focus();
}

/* ClaudeWhat the current segment: pause, mark visited, dig in. On return,
   resume here with a fresh timer. */
function vrClaudeWhatCurrent() {
  const i = vrState.current;
  const seg = vrState.segments[i];
  if (!seg) return;
  vrClearTimer();
  if (vrState.runId != null) {
    try { veshell.verboseMarkVisited(vrState.runId, i); } catch (_) {}
    seg.visited = true;
    vrMarkHistoryVisited(vrState.runId, i);
  }
  cwState.onClose = () => { vrStartTimer(); };
  const parts = [seg.label, seg.snippet, seg.detail].filter((s) => s && s.length);
  openClaudeWhatForText(parts.join('\n\n'));
}

// Incoming segment: push it; reveal it now if nothing is showing.
veshell.onVerboseSegment((seg) => {
  if (!seg) return;
  if (vrState.runId == null && seg.runId != null) vrState.runId = seg.runId;
  vrState.segments[seg.index] = {
    label: seg.label, snippet: seg.snippet, detail: seg.detail, visited: false
  };
  if (vrIsPanelOpen() && vrState.current < 0) {
    vrShowSegment(0);
  } else if (vrIsPanelOpen() && vrState.current >= 0 &&
             vrState.timer === null && vrState.runState === 'running') {
    // Parked on "Waiting for the next step." and a new one arrived.
    const next = vrState.current + 1;
    if (next < vrState.segments.length && next === seg.index) vrShowSegment(next);
  }
});

veshell.onVerboseStatus((s) => {
  if (!s) return;
  if (s.runId != null) vrState.runId = s.runId;
  vrState.runState = s.state;
  if (s.state === 'error' && vrIsPanelOpen()) {
    vrShowMessage('Could not complete the run.' + (s.error ? ' ' + s.error : ''));
  } else if (s.state === 'done' && vrIsPanelOpen() &&
             vrState.current < 0 && vrState.segments.length === 0) {
    vrShowMessage('Finished with no critical steps to show.');
  }
});

vrGo.addEventListener('click', vrSubmit);
vrCancelPrompt.addEventListener('click', closeVerbosePrompt);
vrNext.addEventListener('click', () => { if (vrState.current >= 0) vrAdvance(); });
vrClaudeWhat.addEventListener('click', vrClaudeWhatCurrent);
vrExit.addEventListener('click', closeVerbosePanel);

// Ctrl+Enter submits from the textarea.
vrInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    vrSubmit();
  }
});

/* Esc for the verbose surfaces. ClaudeWhat owns Esc while open (its
   capture-phase handler fires first), so only act when it is not. */
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (isClaudeWhatOpen()) return;
  if (!isHidden(vrPrompt)) {
    e.preventDefault();
    closeVerbosePrompt();
    return;
  }
  if (vrIsPanelOpen()) {
    e.preventDefault();
    closeVerbosePanel();
  }
});

/* Debug/test hook, e2e flag only, never in prod. The automated driver
   reaches the terminal and clipboard actions through this. */
if (veshell.e2e) {
  window.__veshell = {
    term,
    textarea: term.textarea,
    doCopy: (clear) => doCopy(clear),
    doCut: () => doCut(),
    doPaste: () => doPaste(),
    restart: () => restartSession(),
    selection: () => term.getSelection(),
    dims: () => ({ cols: term.cols, rows: term.rows }),
    bufferText: () => {
      const b = term.buffer.active;
      let s = '';
      for (let i = 0; i < b.length; i++) {
        const line = b.getLine(i);
        if (line) s += line.translateToString(true) + '\n';
      }
      return s;
    },
    claudeWhatOpen: () => isClaudeWhatOpen(),
    openClaudeWhat: () => openClaudeWhat(),
    closeClaudeWhat: () => closeClaudeWhat(),
    cwBodyText: () => cwBody.textContent,
    cwContext: () => cwState.context,
    cwScrapeContext: () => scrapeContext(),
    openVerbosePrompt: () => openVerbosePrompt(),
    verboseStartTask: (t) => { vrInput.value = t; vrSubmit(); },
    vrSegments: () => vrState.segments,
    vrCurrent: () => vrState.current,
    vrIsOpen: () => !isHidden(vrPanel),
    vrMarkVisited: (i) => {
      const seg = vrState.segments[i];
      if (!seg) return;
      if (vrState.runId != null) {
        try { veshell.verboseMarkVisited(vrState.runId, i); } catch (_) {}
        seg.visited = true;
        vrMarkHistoryVisited(vrState.runId, i);
      }
    },
    vrHistory: () => veshell.verboseHistoryLoad()
  };
}
