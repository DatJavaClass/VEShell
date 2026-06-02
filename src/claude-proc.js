'use strict';

// ===========================================================================
// Shared helpers for the `claude -p` child processes (ClaudeWhat + Verbose).
// Keeps the bin resolution, output sanitizing, cwd resolution, and the
// spawn pattern in one place so both subsystems behave identically.
// ===========================================================================

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Resolve the claude executable: honor an override, else the known install
// path, else fall back to PATH ("claude").
function resolveClaudeBin() {
  if (process.env.VESHELL_CLAUDE_BIN) return process.env.VESHELL_CLAUDE_BIN;
  const local = path.join(
    process.env.USERPROFILE || os.homedir(), '.local', 'bin', 'claude.exe'
  );
  try { if (fs.existsSync(local)) return local; } catch (_) {}
  return 'claude';
}

// Like resolveClaudeBin but never throws: callers spawn right after.
function safeClaudeBin() {
  try { return resolveClaudeBin(); } catch (_) { return 'claude'; }
}

// Strip control/escape bytes so a stray ANSI sequence can't reach the renderer
// markup. Keep tabs and newlines.
function sanitizeText(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')  // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // other controls (keep \t \n)
}

// Resolve a working directory from config.cwd with an existsSync guard, the
// same way the pty spawn does. A stale config cwd must not take down the spawn.
function resolveCwd(config) {
  let cwd = (config && config.cwd) || process.env.USERPROFILE || os.homedir();
  try {
    if (!fs.existsSync(cwd)) cwd = process.env.USERPROFILE || os.homedir();
  } catch (_) {
    cwd = os.homedir();
  }
  return cwd;
}

// Spawn `claude -p` with the given extra args (after the instruction is added
// by the caller). Returns the child process or throws (caller handles).
function spawnClaude(args, options) {
  return spawn(safeClaudeBin(), ['-p'].concat(args), options || {});
}

module.exports = {
  resolveClaudeBin,
  safeClaudeBin,
  sanitizeText,
  resolveCwd,
  spawnClaude
};
