/* Regression guard for the owner's 1000-piece puzzle on the glass table
 * (dense piles of white pieces on dark glass, many touching). Photos are the
 * owner's own (gitignored): skipped, not failed, where they're missing.
 *  - The background vote must not pick an "inverted" model: in a dense pile
 *    the gaps between pieces are jigsaw-shaped too, and calling the pieces'
 *    own colour "table" turned pieces-1 into 4 pieces (all gaps). A model
 *    whose "pieces" are smoother than its "table" is now voted down.
 *  - Touching pieces with no narrow neck are cut between deep notches when
 *    both halves look like pieces (PH.splitConcave).
 * History (pieces catalogued from one photo): before 2026-10-03:
 *   pieces-1 4, pieces-3 31, straight-1 34; with both fixes: 22, 33, 39.
 * Run: node test/glass-table.js   (about 10 seconds)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
const { readImage } = require('./imageio');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

const CASES = [
  { file: 'pieces-1.jpg', minPieces: 18 },
  { file: 'pieces-3.jpg', minPieces: 31 },
  { file: 'straight-1.jpg', minPieces: 36 },
];

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  let failures = 0;
  for (const c of CASES) {
    const file = path.join(__dirname, 'fixtures', c.file);
    if (!fs.existsSync(file)) { console.log('skip (fixture not on this machine)', c.file); continue; }
    const im = readImage(file);
    const m = new cv.Mat(im.h, im.w, cv.CV_8UC4); m.data.set(im.data);
    const eng = new PH.Engine();
    eng.processSnap(S.matSource(cv, m));
    m.delete();
    const n = eng.counts().entries;
    const ok = n >= c.minPieces;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.file.padEnd(15)} ${n} pieces catalogued (need >= ${c.minPieces})`);
  }
  console.log(failures ? `\n${failures} photo(s) failed` : '\nAll photos passed');
  process.exitCode = failures ? 1 : 0;
})();
