'use strict';

/* Shared helpers for the claude -p children (ClaudeWhat + Verbose): bin
   resolution, output sanitizing, cwd resolution, one spawn pattern. */

const path = require('path'), fs = require('fs'), os = require('os');
const { spawn } = require('child_process');

// Resolve claude: honor an override, else the known install path, else PATH.
function resolveClaudeBin() {
  if (process.env.VESHELL_CLAUDE_BIN) return process.env.VESHELL_CLAUDE_BIN;
  const local = path.join(
    process.env.USERPROFILE || os.homedir(), '.local', 'bin', 'claude.exe'
  );
  try { if (fs.existsSync(local)) return local; } catch (_) {}
  return 'claude';
}

// resolveClaudeBin that never throws; callers spawn right after.
function safeClaudeBin() {
  try { return resolveClaudeBin(); } catch (_) { return 'claude'; }
}

// Strip control/escape bytes so stray ANSI can't reach markup; keep \t \n.
function sanitizeText(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // other controls
}

// Resolve config.cwd with an existsSync guard, like the pty spawn does.
function resolveCwd(config) {
  let cwd = (config && config.cwd) || process.env.USERPROFILE || os.homedir();
  try {
    if (!fs.existsSync(cwd)) cwd = process.env.USERPROFILE || os.homedir();
  } catch (_) {
    cwd = os.homedir();
  }
  return cwd;
}

// Spawn claude -p with extra args (caller adds the instruction).
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
