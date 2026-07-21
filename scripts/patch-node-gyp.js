'use strict';

/* node-gyp's VS detector only knows majors 15/16/17. VS 18 (2026) is rejected
   as unknown, though its v143 toolchain is 2022-compatible. Teach it to treat
   any VS major >= 18 as 2022. Idempotent, safe to re-run. */

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
