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
  copyOnSelect: false
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

// "Cut" on terminal output can only copy — scrollback text cannot be removed.
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
  // only tells xterm to skip the key — it does not stop the default action.
  const handle = (fn) => { e.preventDefault(); fn(); return false; };

  // Explicit, always-on shortcuts (never ambiguous with terminal control codes).
  if (ctrl && shift && key === 'c') return handle(() => doCopy(false));
  if (ctrl && shift && key === 'v') return handle(() => doPaste());
  if (ctrl && shift && key === 'x') return handle(() => doCut());
  if (ctrl && shift && key === 'a') return handle(() => term.selectAll());

  // Ctrl+Shift+W: ClaudeWhat — explain the current selection in context.
  if (ctrl && shift && key === 'w') return handle(() => openClaudeWhat());

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

// Keep focus on the terminal when clicking in the window — but not while the
// context menu or the session-ended overlay is up (don't steal their clicks).
window.addEventListener('mouseup', () => {
  if (menu.classList.contains('hidden') &&
      overlay.classList.contains('hidden') &&
      cwPanel.classList.contains('hidden')) {
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

const cwState = { selection: '', context: '', busy: false };

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
  cwTitle.textContent = 'ClaudeWhat — explaining selection';
  cwPanel.classList.remove('hidden');
  requestExplanation(CW_INSTRUCTION);
}

function closeClaudeWhat() {
  cwPanel.classList.add('hidden');
  // Abort any in-flight explanation so it doesn't burn a generation we'll drop.
  if (cwState.busy) { try { veshell.claudeWhatCancel(); } catch (_) {} }
  cwState.busy = false;
  term.focus();
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

// Debug/test hook — only exposed under the e2e flag, never in normal/prod use.
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
    cwScrapeContext: () => scrapeContext()
  };
}
