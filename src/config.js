'use strict';

/* Config for the main process. Defaults, overridden by a co-located or
   install-dir config.json, then by VESHELL_* env vars. A bad file is ignored. */

const path = require('path'), fs = require('fs'), os = require('os');

const DEFAULT_CONFIG = {
  shell: 'powershell.exe',
  // -NoLogo quiet, -NoExit keeps the prompt live, -Command claude launches it.
  shellArgs: ['-NoLogo', '-NoExit', '-Command', 'claude'],
  cwd: process.env.USERPROFILE || os.homedir(),
  fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
  fontSize: 14,
  scrollback: 10000,
  copyOnSelect: false
};

/* Merge the first config.json found over the defaults. app is passed in so
   this module needs no electron require at load time. */
function loadConfig(app) {
  const candidates = [
    // Portable build: dir the user ran the exe from (exe is temp-extracted).
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
      console.error(`VEShell: failed to read ${file}:`, err.message);
    }
  }

  // Env overrides, handy for testing and power users.
  if (process.env.VESHELL_SHELL) config.shell = process.env.VESHELL_SHELL;
  if (process.env.VESHELL_SHELLARGS) {
    try {
      const parsed = JSON.parse(process.env.VESHELL_SHELLARGS);
      if (Array.isArray(parsed)) config.shellArgs = parsed;
    } catch (_) { /* keep default args on bad JSON */ }
  }
  if (process.env.VESHELL_CWD) config.cwd = process.env.VESHELL_CWD;

  // Guard shape so a malformed config.json can't crash pty.spawn.
  if (typeof config.shell !== 'string' || !config.shell) config.shell = DEFAULT_CONFIG.shell;
  if (!Array.isArray(config.shellArgs)) config.shellArgs = DEFAULT_CONFIG.shellArgs;

  return config;
}

module.exports = { DEFAULT_CONFIG, loadConfig };
