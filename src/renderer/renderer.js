'use strict';

// ===========================================================================
// VEShell renderer. Builds the xterm.js terminal, wires it to the pty over the
// `veshell` bridge, and implements all the UI: copy/paste/cut, the right-click
// menu, session-restart overlay, toast, and the ClaudeWhat panel. It is
// sandboxed (no Node, strict CSP), so anything privileged goes through `veshell`.
// ===========================================================================

/* global Terminal, FitAddon, WebLinksAddon, veshell */

// ---------------------------------------------------------------------------
// Appearance (edit here to taste; shell/cwd live in config.json on the main side)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Terminal setup
// ---------------------------------------------------------------------------
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

const termEl = document.getElementById('terminal');
term.open(termEl);

function safeFit() {
  try { fitAddon.fit(); } catch (_) { /* not laid out yet */ }
}

safeFit();
// Refit once more after layout settles so xterm accounts for the bottom status
// bar's reserved height (the #terminal bottom inset). Avoids a clipped last row.
requestAnimationFrame(() => safeFit());
term.focus();

// Hand the pty its starting dimensions and let main spawn the session.
veshell.ready({ cols: term.cols, rows: term.rows });

// ---------------------------------------------------------------------------
// pty <-> terminal data flow
// ---------------------------------------------------------------------------
veshell.onData((data) => term.write(data));

term.onData((data) => veshell.sendInput(data));

// Keep the pty's view of the window in sync with xterm's grid.
term.onResize(({ cols, rows }) => veshell.resize(cols, rows));

// ---------------------------------------------------------------------------
// Clipboard actions
// ---------------------------------------------------------------------------
// Copy the current selection to the OS clipboard (via main). Returns false if
// nothing is selected, which the smart-Ctrl+C path uses to fall through to ^C.
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

// "Cut" on terminal output can only copy; scrollback text cannot be removed.
async function doCut() {
  const ok = await doCopy(true);
  if (ok) showToast('Cut (copied)');
}

// Paste clipboard text into the terminal. Uses xterm's bracketed-paste-aware
// term.paste so multiline content lands as one block in Claude's prompt.
async function doPaste() {
  const text = await veshell.paste();
  if (text && text.length) {
    // Strip NUL bytes (never valid terminal input); keep everything else so
    // bracketed paste can wrap multiline content faithfully.
    const clean = text.replace(/\x00/g, '');
    if (!clean.length) return;
    // term.paste respects bracketed-paste mode, so multiline pastes land in
    // Claude's prompt / readline correctly instead of executing line-by-line.
    term.paste(clean);
    showToast('Pasted');
  }
}

// ---------------------------------------------------------------------------
// Keyboard: intercept copy/paste/cut/select-all before xterm forwards to pty
// ---------------------------------------------------------------------------
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;

  const ctrl = e.ctrlKey;
  const shift = e.shiftKey;
  const alt = e.altKey;
  const key = (e.key || '').toLowerCase();

  // When we handle a shortcut ourselves we MUST preventDefault, otherwise the
  // browser's native copy/paste default action ALSO fires (xterm has its own
  // 'paste'/'copy' DOM handlers) and we'd paste/copy twice. Returning false
  // only tells xterm to skip the key, it does not stop the default action.
  const handle = (fn) => { e.preventDefault(); fn(); return false; };

  // Explicit, always-on shortcuts (never ambiguous with terminal control codes).
  if (ctrl && shift && key === 'c') return handle(() => doCopy(false));
  if (ctrl && shift && key === 'v') return handle(() => doPaste());
  if (ctrl && shift && key === 'x') return handle(() => doCut());
  if (ctrl && shift && key === 'a') return handle(() => term.selectAll());

  // Ctrl+Shift+W: ClaudeWhat, explain the current selection in context.
  if (ctrl && shift && key === 'w') return handle(() => openClaudeWhat());

  // Ctrl+Shift+R: Verbose run, describe a task and watch its critical steps.
  if (ctrl && shift && key === 'r') return handle(() => openVerbosePrompt());

  // Smart Ctrl+C: copy when there's a real (non-empty) selection, otherwise
  // send interrupt (^C). Gate on getSelection().length, not hasSelection(),
  // so a whitespace-only "phantom" selection can't swallow the interrupt.
  if (ctrl && !shift && !alt && key === 'c') {
    const sel = term.getSelection();
    if (sel && sel.length) return handle(() => doCopy(true));
    return true; // let xterm send \x03 to Claude
  }

  // Ctrl+V: paste.
  if (ctrl && !shift && !alt && key === 'v') return handle(() => doPaste());

  return true;
});

// ---------------------------------------------------------------------------
// Mouse: copy-on-select (optional), middle-click paste, right-click menu
// ---------------------------------------------------------------------------
if (APPEARANCE.copyOnSelect) {
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel && sel.length) veshell.copy(sel);
  });
}

// Middle-click paste (X11 convention; handy and predictable).
termEl.addEventListener('mousedown', (e) => {
  if (e.button === 1) {
    e.preventDefault();
    doPaste();
  }
});

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
const menu = document.getElementById('context-menu');

// Show the right-click menu at (x,y), greying out copy/cut when there's no
// selection, and clamped so it never spills outside the window.
function showMenu(x, y) {
  const hasSel = term.hasSelection();
  menu.querySelector('[data-action="copy"]').classList.toggle('disabled', !hasSel);
  menu.querySelector('[data-action="cut"]').classList.toggle('disabled', !hasSel);

  menu.classList.remove('hidden');
  // Clamp to viewport.
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 4);
  const py = Math.min(y, window.innerHeight - rect.height - 4);
  menu.style.left = px + 'px';
  menu.style.top = py + 'px';
}

function hideMenu() { menu.classList.add('hidden'); }

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
    case 'claudewhat': openClaudeWhat(); return; // panel takes focus; don't refocus term
    case 'verbose': openVerbosePrompt(); return; // panel takes focus; don't refocus term
    case 'clear': term.clear(); break;
    case 'restart': restartSession(); break;
  }
  term.focus();
});

// Dismiss the menu on any outside interaction.
window.addEventListener('mousedown', (e) => {
  if (!menu.contains(e.target)) hideMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideMenu();
});
window.addEventListener('blur', hideMenu);

// ---------------------------------------------------------------------------
// Resize handling
// ---------------------------------------------------------------------------
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(safeFit, 60);
});

// Refit once fonts are loaded (avoids an initial off-by-a-row grid).
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => safeFit());
}

// ---------------------------------------------------------------------------
// Session end / restart
// ---------------------------------------------------------------------------
const overlay = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');

// Tear down the dead terminal view and ask main to spawn a fresh session at the
// current grid size (used by the overlay button and the menu's Restart item).
function restartSession() {
  overlay.classList.add('hidden');
  term.reset();
  safeFit();
  // Pass the current grid so the new pty starts at the right size.
  veshell.restart({ cols: term.cols, rows: term.rows });
  term.focus();
}

veshell.onExit((info) => {
  const { exitCode, error } = info || {};
  overlayMsg.textContent = error
    ? error
    : `Session ended (exit code ${exitCode}).`;
  overlay.classList.remove('hidden');
});

document.getElementById('overlay-restart').addEventListener('click', restartSession);
window.addEventListener('keydown', (e) => {
  if (!overlay.classList.contains('hidden') && e.key === 'Enter') {
    e.preventDefault();
    restartSession();
  }
});

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
const toastEl = document.getElementById('toast');
let toastTimer = null;
let toastFadeTimer = null;

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden', 'fade');
  if (toastTimer) clearTimeout(toastTimer);
  if (toastFadeTimer) clearTimeout(toastFadeTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('fade');
    toastFadeTimer = setTimeout(() => toastEl.classList.add('hidden'), 260);
  }, 900);
}

// ---------------------------------------------------------------------------
// Status bar hint
// ---------------------------------------------------------------------------
// The bottom bar shows one hint at a time on its right side, alternating
// between the two shortcuts every few seconds. "ExplainPlease" is the bar's
// label for the ClaudeWhat feature; the feature is named ClaudeWhat everywhere
// else (menu, panel, button) and in code.
const statusHintEl = document.getElementById('status-hint');
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

// Keep focus on the terminal when clicking in the window, but not while the
// context menu or the session-ended overlay is up (don't steal their clicks).
window.addEventListener('mouseup', () => {
  if (menu.classList.contains('hidden') &&
      overlay.classList.contains('hidden') &&
      cwPanel.classList.contains('hidden') &&
      vrPanel.classList.contains('hidden') &&
      vrPrompt.classList.contains('hidden')) {
    term.focus();
  }
});

// ---------------------------------------------------------------------------
// ClaudeWhat: explain a selected snippet in the context of the terminal
// ---------------------------------------------------------------------------
// Flow: user selects text in a response -> Ctrl+Shift+W -> VEShell scrapes the
// selection plus surrounding scrollback, asks `claude -p` (in the main process)
// for a teaching explanation, and shows it in this panel. Everything stays in
// VEShell; nothing is injected into Claude's live TUI.
const cwPanel = document.getElementById('claudewhat');
const cwBody = document.getElementById('cw-body');
const cwTitle = document.getElementById('cw-title');
const cwBtnUp = document.getElementById('cw-pageup');
const cwBtnDown = document.getElementById('cw-pagedown');
const cwBtnMore = document.getElementById('cw-more');
const cwBtnReturn = document.getElementById('cw-return');

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

// How many lines of scrollback above the selection to include, so the prompt
// that caused a response is captured (that is what makes "why" answerable).
const CW_CONTEXT_BEFORE = 60;
const CW_CONTEXT_AFTER = 10;

// onClose: optional callback. When set, closeClaudeWhat() calls it instead of
// refocusing the terminal. Verbose run uses this to resume its panel.
const cwState = { selection: '', context: '', busy: false, onClose: null };

// Read the visible+nearby buffer as plain text, and find a window around the
// selection. xterm exposes the active buffer; we translate rows to strings.
function scrapeContext() {
  const buf = term.buffer.active;
  const total = buf.length;
  // Anchor the window on the SELECTION when we can (its y values are absolute
  // buffer rows, so this works even if the user scrolled), capturing the lines
  // above it that explain "why". Fall back to the viewport bottom otherwise.
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
  // Trim leading/trailing blank lines.
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

// Assemble the stdin payload for claude -p: the scraped transcript plus the
// highlighted selection, clearly delimited so the model knows what to explain.
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

function isClaudeWhatOpen() { return !cwPanel.classList.contains('hidden'); }

function openClaudeWhat() {
  const sel = term.getSelection();
  if (!sel || !sel.trim().length) {
    showToast('Select some text first');
    return;
  }
  cwState.selection = sel.trim();
  cwState.context = buildContextPayload(cwState.selection, scrapeContext());
  cwTitle.textContent = 'ClaudeWhat: explaining selection';
  cwPanel.classList.remove('hidden');
  requestExplanation(CW_INSTRUCTION);
}

function closeClaudeWhat() {
  cwPanel.classList.add('hidden');
  // Abort any in-flight explanation so it doesn't burn a generation we'll drop.
  if (cwState.busy) { try { veshell.claudeWhatCancel(); } catch (_) {} }
  cwState.busy = false;
  // If a caller wired up an onClose hook (e.g. verbose run), let it resume
  // instead of refocusing the terminal. The hook owns focus from here.
  if (cwState.onClose) {
    const cb = cwState.onClose;
    cwState.onClose = null;
    cb();
    return;
  }
  term.focus();
}

// Open ClaudeWhat seeded with arbitrary text (used by verbose run to explain a
// callout). Mirrors openClaudeWhat from cwTitle onward, but takes its selection
// and context from the passed text rather than the terminal selection.
function openClaudeWhatForText(text) {
  cwState.selection = text;
  cwState.context = buildContextPayload(text, '(from a verbose-run callout)');
  cwTitle.textContent = 'ClaudeWhat: explaining selection';
  cwPanel.classList.remove('hidden');
  requestExplanation(CW_INSTRUCTION);
}

function setCwButtonsEnabled(on) {
  for (const b of [cwBtnUp, cwBtnDown, cwBtnMore]) {
    b.classList.toggle('disabled', !on);
  }
}

// Drive one explanation round-trip: show "Thinking…", call main's claude -p,
// then render the result (or an error) into the panel body. The busy flag
// blocks overlapping calls; if the user closed the panel mid-wait we bail.
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
  if (!isClaudeWhatOpen()) return; // user closed it while waiting
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

// Page the explanation body by ~90% of its visible height.
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

// Panel key handling: PageUp/PageDown scroll, Esc returns. Capture-phase so it
// wins before anything else while the panel is open.
window.addEventListener('keydown', (e) => {
  if (!isClaudeWhatOpen()) return;
  if (e.key === 'Escape') { e.preventDefault(); closeClaudeWhat(); return; }
  if (e.key === 'PageUp') { e.preventDefault(); cwPage(-1); return; }
  if (e.key === 'PageDown') { e.preventDefault(); cwPage(1); return; }
}, true);

// ---------------------------------------------------------------------------
// Verbose run: describe a task, run it headless, watch the critical steps
// ---------------------------------------------------------------------------
// Flow: Ctrl+Shift+R -> prompt box -> the task runs via `claude -p` in main,
// which streams short "critical segment" callouts back. We reveal them one at a
// time in a full-window panel, paced by a timer the student can skip with Next.
// On any segment they can press ClaudeWhat to dig deeper; returning resets the
// timer. Which segments have been ClaudeWhat'd is persisted across restarts.
const vrPrompt = document.getElementById('vr-prompt');
const vrInput = document.getElementById('vr-input');
const vrGo = document.getElementById('vr-go');
const vrCancelPrompt = document.getElementById('vr-cancel-prompt');
const vrHistory = document.getElementById('vr-history');
const vrPanel = document.getElementById('vr-panel');
const vrLabel = document.getElementById('vr-label');
const vrSnippet = document.getElementById('vr-snippet');
const vrDetail = document.getElementById('vr-detail');
const vrTimer = document.getElementById('vr-timer');
const vrNext = document.getElementById('vr-next');
const vrClaudeWhat = document.getElementById('vr-claudewhat');
const vrExit = document.getElementById('vr-exit');

// Queue + timer state for the reveal loop. `segments` is the arrival-ordered
// list; `current` is the index showing now (-1 = none). `timer` is the 1s
// countdown interval, `remaining` its seconds left. `runState` tracks the run.
const vrState = {
  runId: null, segments: [], current: -1,
  timer: null, remaining: 0, runState: 'idle'
};

function vrIsPanelOpen() { return !vrPanel.classList.contains('hidden'); }

// Stop the countdown without advancing.
function vrClearTimer() {
  if (vrState.timer) { clearInterval(vrState.timer); vrState.timer = null; }
}

// Show a one-line status in the body instead of a segment (waiting/finished).
function vrShowMessage(text) {
  vrClearTimer();
  vrTimer.textContent = '';
  vrLabel.textContent = text;
  vrSnippet.textContent = '';
  vrSnippet.style.display = 'none';
  vrDetail.textContent = '';
}

// Render a segment and start its countdown from verboseTimerSec.
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

// Begin (or restart) the 1s countdown for the current segment. At 0 we advance.
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

// Move to the next segment if one exists; otherwise show waiting/finished
// depending on whether the run is still producing output.
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

// Build the history list: each run shows its task and segment labels. Visited
// segments get the .vr-visited class. data-* attrs let markVisited find entries.
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

// Add the visited mark to a segment's history entry, if it is on screen.
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
    // verboseHistoryLoad resolves to the runs ARRAY (see contract / main.js),
    // not a { runs } wrapper.
    const data = await veshell.verboseHistoryLoad();
    runs = Array.isArray(data) ? data : (data && data.runs) ? data.runs : [];
  } catch (_) { runs = []; }
  vrRenderHistory(runs);
  vrPrompt.classList.remove('hidden');
  vrInput.focus();
}

function closeVerbosePrompt() {
  vrPrompt.classList.add('hidden');
}

// Submit the prompt: start the run, switch to the panel, reset queue state.
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
  vrPanel.classList.remove('hidden');
  vrShowMessage('Working. The first critical step will appear shortly.');
  veshell.verboseStart(task);
}

// Leave the panel: stop the run and the timer, refocus the terminal.
function closeVerbosePanel() {
  vrClearTimer();
  try { veshell.verboseCancel(); } catch (_) {}
  vrState.runState = 'idle';
  vrPanel.classList.add('hidden');
  term.focus();
}

// ClaudeWhat the current segment: pause, mark it visited, open ClaudeWhat
// seeded with the segment text. On return, resume here and reset the timer.
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
  // When ClaudeWhat closes, come back to this segment with a fresh timer.
  cwState.onClose = () => { vrStartTimer(); };
  const parts = [seg.label, seg.snippet, seg.detail].filter((s) => s && s.length);
  openClaudeWhatForText(parts.join('\n\n'));
}

// Incoming segment from main. Push it; if nothing is showing yet, show it now.
veshell.onVerboseSegment((seg) => {
  if (!seg) return;
  if (vrState.runId == null && seg.runId != null) vrState.runId = seg.runId;
  vrState.segments[seg.index] = {
    label: seg.label, snippet: seg.snippet, detail: seg.detail, visited: false
  };
  // If the panel is parked on a waiting message (or showing nothing), reveal
  // the first not-yet-shown segment.
  if (vrIsPanelOpen() && vrState.current < 0) {
    vrShowSegment(0);
  } else if (vrIsPanelOpen() && vrState.current >= 0 &&
             vrState.timer === null && vrState.runState === 'running') {
    // We were parked on "Waiting for the next step." and a new one arrived.
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

// Esc handling for the verbose surfaces. The ClaudeWhat capture-phase handler
// already closes ClaudeWhat first when it is open, so only act here when it is
// NOT open: close the prompt box, or exit the panel.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (isClaudeWhatOpen()) return; // ClaudeWhat owns Esc while it is up
  if (!vrPrompt.classList.contains('hidden')) {
    e.preventDefault();
    closeVerbosePrompt();
    return;
  }
  if (vrIsPanelOpen()) {
    e.preventDefault();
    closeVerbosePanel();
  }
});

// Debug/test hook, only exposed under the e2e flag, never in normal/prod use.
// Lets the automated e2e driver reach the terminal and clipboard actions.
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
    // ClaudeWhat hooks for the e2e driver.
    claudeWhatOpen: () => isClaudeWhatOpen(),
    openClaudeWhat: () => openClaudeWhat(),
    closeClaudeWhat: () => closeClaudeWhat(),
    cwBodyText: () => cwBody.textContent,
    cwContext: () => cwState.context,
    cwScrapeContext: () => scrapeContext(),
    // Verbose run hooks for the e2e driver.
    openVerbosePrompt: () => openVerbosePrompt(),
    verboseStartTask: (t) => { vrInput.value = t; vrSubmit(); },
    vrSegments: () => vrState.segments,
    vrCurrent: () => vrState.current,
    vrIsOpen: () => !vrPanel.classList.contains('hidden'),
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
