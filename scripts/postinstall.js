'use strict';

// Applies the build patches and rebuilds node-pty against Electron. Guarded so
// that non-Windows clones or environments without the VS C++ toolchain don't
// hard-fail on `npm install`. Set VESHELL_SKIP_REBUILD=1 to skip entirely.

const { execSync } = require('child_process');

if (process.env.VESHELL_SKIP_REBUILD === '1') {
  console.log('VESHELL_SKIP_REBUILD=1 — skipping VEShell patches and native rebuild.');
  process.exit(0);
}

if (process.platform !== 'win32') {
  console.log(`platform is ${process.platform}, not win32 — skipping VEShell native rebuild.`);
  process.exit(0);
}

function run(cmd) {
  console.log('> ' + cmd);
  execSync(cmd, { stdio: 'inherit' });
}

try {
  run('node scripts/patch-node-gyp.js');
  run('node scripts/patch-winpty.js');
  run('npx electron-rebuild -f -w node-pty');
} catch (err) {
  console.error('\nVEShell postinstall failed. Ensure the Visual Studio C++ ' +
    'build tools are installed, then run `npm run rebuild`.');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}
