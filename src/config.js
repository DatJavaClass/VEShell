'use strict';

// ===========================================================================
// Config loading for the main process. Defaults can be overridden by a
// config.json placed next to the executable (portable) or in the install dir,
// then by a few VESHELL_* env vars. A missing or malformed file is ignored so
// the app always starts.
// ===========================================================================

const path = require('path');
const fs = require('fs');
const os = require('os');

const DEFAULT_CONFIG = {
  shell: 'powershell.exe',
  // -NoLogo: no banner. -NoExit: stay at a live PowerShell prompt after Claude
  // exits, so the window remains usable. -Command claude: invoke Claude Code.
  shellArgs: ['-NoLogo', '-NoExit', '-Command', 'claude'],
  cwd: process.env.USERPROFILE || os.homedir(),
  fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
  fontSize: 14,
  scrollback: 10000,
  copyOnSelect: false
};

// Look for config.json in several locations and merge the first one found over
// the defaults. `app` is passed in so this module stays free of an electron
// require at load time.
function loadConfig(app) {
  const candidates = [
    // For the single-file portable build, this points at the dir the user ran
    // the exe from (the real exe is extracted to a temp dir, so dirname(exe)
    // would miss a co-located config.json).
    process.env.PORTABLE_EXECUTABLE_DIR &&
      path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'config.json'),
    path.join(path.dirname(app.getPath('exe')), 'config.json'),
    path.join(app.getAppPath(), 'config.json'),
    path.join(app.getPath('userData'), 'config.json')
  ].filter(Boolean);

  let config = Object.assign({}, DEFAULT_CONFIG);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        config = Object.assign({}, DEFAULT_CONFIG, parsed);
        break;
      }
    } catch (err) {
      // Ignore a malformed config and fall through to defaults.
      console.error(`VEShell: failed to read ${file}:`, err.message);
    }
  }

  // Environment overrides (handy for testing and power users).
  if (process.env.VESHELL_SHELL) config.shell = process.env.VESHELL_SHELL;
  if (process.env.VESHELL_SHELLARGS) {
    try {
      const parsed = JSON.parse(process.env.VESHELL_SHELLARGS);
      if (Array.isArray(parsed)) config.shellArgs = parsed;
    } catch (_) { /* keep default args on bad JSON */ }
  }
  if (process.env.VESHELL_CWD) config.cwd = process.env.VESHELL_CWD;

  // Validate config shape so a malformed config.json can't crash pty.spawn.
  if (typeof config.shell !== 'string' || !config.shell) config.shell = DEFAULT_CONFIG.shell;
  if (!Array.isArray(config.shellArgs)) config.shellArgs = DEFAULT_CONFIG.shellArgs;

  return config;
}

module.exports = { DEFAULT_CONFIG, loadConfig };
