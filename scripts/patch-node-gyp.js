'use strict';

// node-gyp's Visual Studio detector only knows VS major versions 15/16/17
// (2017/2019/2022). Visual Studio 18 (2026) falls through and is rejected as
// an "unknown version", even though its toolchain (MSBuild\Current + the v143
// toolset) is fully compatible. This script teaches the detector to treat any
// VS major >= 18 as 2022-compatible. It is idempotent and safe to re-run.

const fs = require('fs');
const path = require('path');

const MARKER = 'versionMajor >= 18';

const INSERT = `    if (ret.versionMajor >= 18) {
      // VS 2026 (v18) and newer: use the 2022-compatible toolchain (MSBuild
      // Current + v143 toolset). Patched by scripts/patch-node-gyp.js.
      ret.versionYear = 2022
      return ret
    }
`;

const ANCHOR = `    if (ret.versionMajor === 17) {
      ret.versionYear = 2022
      return ret
    }
`;

const targets = [
  path.join(__dirname, '..', 'node_modules', '@electron', 'node-gyp', 'lib', 'find-visualstudio.js'),
  path.join(__dirname, '..', 'node_modules', 'node-gyp', 'lib', 'find-visualstudio.js')
];

let patchedAny = false;

for (const file of targets) {
  if (!fs.existsSync(file)) {
    continue;
  }
  let src = fs.readFileSync(file, 'utf8');

  if (src.includes(MARKER)) {
    console.log(`patch-node-gyp: already patched -> ${file}`);
    continue;
  }

  if (!src.includes(ANCHOR)) {
    console.warn(`patch-node-gyp: anchor not found, skipping -> ${file}`);
    continue;
  }

  src = src.replace(ANCHOR, ANCHOR + INSERT);
  fs.writeFileSync(file, src, 'utf8');
  patchedAny = true;
  console.log(`patch-node-gyp: patched -> ${file}`);
}

if (!patchedAny) {
  console.log('patch-node-gyp: nothing to do.');
}
