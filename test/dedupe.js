/* Duplicates after tracking loss: catalog the table, then catalog it again
 * from a different (rotated, closer) view as if the app had lost its place,
 * producing a second island full of copies. Checks: at most 4 corners are
 * counted (one per corner spot), and Tidy up / dedupeByCell merges the copies
 * back to ~one per piece and joins the islands.
 * Usage: node test/dedupe.js */
'use strict';
const path = require('path');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;
(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  let failures = 0;
  const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
  const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 3 });
  const sc = S.scatter(cv, P, { scale: 2.2, seed: 5 });
  const ph = S.boxPhoto(cv, P);
  const box = PH.createBox({ w: ph.mat.cols, h: ph.mat.rows, data: ph.mat.data }, ph.corners, { pieces: 48 });
  const eng = new PH.Engine();
  eng.setBox(box);
  eng.processSnap(S.matSource(cv, sc.table));
  // second view: rotated 17 degrees, 10% closer, and pretend tracking was lost
  const v = S.cameraFrame(cv, sc.table, sc.TW / 2, sc.TH / 2, 0.3, 1.1, Math.round(sc.TW * 1.2), Math.round(sc.TH * 1.3));
  // On the phone, copies appear when neither the map nor the shape check
  // recognised the pieces (e.g. shapes not read yet); switch both off here.
  const relo = eng.relocalizeByShape, moved = eng.findMoved, mergeI = eng.mergeIslandsByShape;
  eng.relocalizeByShape = () => null; eng.findMoved = () => null; eng.mergeIslandsByShape = () => 0;
  eng.processSnap(S.matSource(cv, v));
  eng.relocalizeByShape = relo; eng.findMoved = moved; eng.mergeIslandsByShape = mergeI; v.delete();
  const before = eng.counts();
  const corners0 = [...eng.pieces.values()].filter((p) => PH.edgeFlags(p).corner).length;
  console.log(`after a lost-tracking second scan: ${before.pieces} pieces in ${before.islands} islands, ${corners0} corner-shaped -> counted corners ${before.corner} (+${before.cornerDoubt} doubtful)`);
  check('at most 4 corners are counted', before.corner <= 4, `${before.corner} counted of ${corners0} corner-shaped`);
  const t0 = Date.now();
  const res = eng.tidy();
  const after = eng.counts();
  console.log(`Tidy up: removed ${res.removed}, joined ${res.joinedIslands} island(s) in ${Date.now() - t0} ms -> ${after.pieces} pieces in ${after.islands} islands, corners ${after.corner} (+${after.cornerDoubt})`);
  check('duplicates merged back to about one per piece', after.pieces <= 48 * 1.15, `${after.pieces} for 48 pieces`);
  check('the two scan islands are joined', after.islands === 1, `${after.islands} islands`);
  check('exactly 4 corners', after.corner === 4, `${after.corner}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
})();
