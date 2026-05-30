'use strict';

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

  // Explicit, always-on shortcuts (never ambiguous with terminal control codes).
  if (ctrl && shift && key === 'c') { doCopy(false); return false; }
  if (ctrl && shift && key === 'v') { doPaste(); return false; }
  if (ctrl && shift && key === 'x') { doCut(); return false; }
  if (ctrl && shift && key === 'a') { term.selectAll(); return false; }

  // Smart Ctrl+C: copy when there's a real (non-empty) selection, otherwise
  // send interrupt (^C). Gate on getSelection().length, not hasSelection(),
  // so a whitespace-only "phantom" selection can't swallow the interrupt.
  if (ctrl && !shift && !alt && key === 'c') {
    const sel = term.getSelection();
    if (sel && sel.length) { doCopy(true); return false; }
    return true; // let xterm send \x03 to Claude
  }

  // Ctrl+V: paste.
  if (ctrl && !shift && !alt && key === 'v') { doPaste(); return false; }

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
  if (menu.classList.contains('hidden') && overlay.classList.contains('hidden')) {
    term.focus();
  }
});

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
    }
  };
}
