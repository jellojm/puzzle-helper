/* Pointed check: the finished border found by itself, and the puzzle read
 * cell by cell against the box (js/vision/border.js).
 * A. Synthetic: the whole puzzle assembled except some pieces, on the felt.
 *    Live frames: the border is marked automatically (box top-left in the
 *    right corner), missing pieces are voted open, the rest filled, and the
 *    open spots are drawn with their box cells.
 * B. The owner's photo of the whole puzzle (test/fixtures/real, not in the
 *    repo; skipped without it): the border is found on the puzzle (not the
 *    box lid next to it), the right way up, and most cells are judged.
 * Run: node test/border-auto.js   (~30 s)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'frame', 'border', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  if (process.env.DBG) PH.DEBUG_BORDER = (...a) => console.log('BORDER', ...a);

  // ---------- A: synthetic ----------
  {
    const cols = 10, rows = 8;
    const P = S.makePuzzle(cv, { cols, rows, cs: 48, seed: 5 });
    const photo = S.boxPhoto(cv, P);
    const box = PH.createBox({ w: photo.mat.cols, h: photo.mat.rows, data: photo.mat.data }, photo.corners, { cols, rows, pieces: cols * rows });
    const missing = [[2, 3], [2, 4], [3, 4], [5, 2], [4, 7], [6, 6]]; // [row, col]
    const block = { r0: 0, c0: 0, rows, cols, missing };
    const inBlock = (p) => !missing.some(([r, c]) => r === p.r && c === p.c);
    const subset = P.pieces.map((p, i) => i).filter((i) => !inBlock(P.pieces[i]));
    const scat = S.scatter(cv, P, { scale: 2.2, seed: 9, subset, blocks: [block] });
    const B = scat.blocks[0];
    const eng = new PH.Engine({ spotEveryMs: 0 });
    eng.setBox(box);
    let out = null, found = false;
    for (let i = 0; i < 14; i++) {
      eng.borderAt = undefined; // node runs frames far faster than a phone: try on every frame
      const fr = S.cameraFrame(cv, scat.table, B.x + (i % 3) * 4, B.y, 0.02, 0.62, 1440, 1080);
      out = eng.processFrame(S.matSource(cv, fr), { still: true });
      fr.delete();
      if (out.borderFound) found = true;
      if (process.env.DBG) console.log('frame', i, 'pframe', !!eng.pframe, 'fails', eng.borderFails, 'sharp', JSON.stringify(eng.lastSharp), 'at', eng.borderAt);
      if (eng.pframe) eng.pfLoc.t = 0; // look for it again on every frame
    }
    check('A: the finished border is found by itself', found && !!eng.pframe);
    const want = new Set(missing.map(([r, c]) => r * cols + c));
    let openOk = 0, openBad = 0, filledOk = 0, filledBad = 0, known = 0;
    for (let i = 0; i < cols * rows; i++) {
      const s = eng.cellState(i);
      if (!s) continue;
      known++;
      if (s < 0) { if (want.has(i)) openOk++; else openBad++; } else if (want.has(i)) filledBad++; else filledOk++;
    }
    if (process.env.DBG) {
      const fr = S.cameraFrame(cv, scat.table, B.x, B.y, 0.02, 0.62, 1440, 1080), pr = S.matSource(cv, fr).getProc(640); fr.delete();
      const d = {}; PH.readCells(pr, eng.pfLoc.H, box, d);
      for (const f of d.feats) { const i = f.r * cols + f.c, st = eng.cellState(i); if ((want.has(i) && st !== -1) || (!want.has(i) && st === -1)) console.log('cell', JSON.stringify(f), 'votes', eng.cellVotes.f[i], eng.cellVotes.o[i], want.has(i) ? 'HOLE' : 'filled'); }
    }
    console.log(`A: votes over ${eng.cellVotes ? eng.cellVotes.views : 0} views: ${known} cells judged; open ${openOk} right / ${openBad} wrong; filled ${filledOk} right / ${filledBad} wrong`);
    check('A: missing pieces are voted open', openOk >= missing.length - 1, `${openOk} of ${missing.length}`);
    // (the generated picture has a pale strip along one edge that its box
    // photo shows differently: at most 2 cells along it may read open)
    check('A: at most 2 assembled cells are called open', openBad <= 2, `${openBad} wrong`);
    check('A: most assembled cells are called filled', filledOk >= (cols * rows - missing.length) * 0.8 && filledBad === 0, `${filledOk} of ${cols * rows - missing.length}`);
    const shown = (out.spots || []).filter((s) => s.cell && want.has(s.cell[1] * cols + s.cell[0]));
    check('A: the open spots are drawn on the view with their box cells', shown.length >= missing.length - 1, `${shown.length} drawn`);
    const info = out.assembly;
    check('A: the status says how many spots are open', !!info && info.fromBorder && info.spots >= missing.length - 1, JSON.stringify(info && { spots: info.spots, cells: info.cells }));
  }

  // ---------- B: the owner's photo ----------
  const fx = (n) => path.join(__dirname, 'fixtures', 'real', n);
  if (!fs.existsSync(fx('whole-puzzle.jpg')) || !fs.existsSync(fx('box-chickens.jpg'))) console.log('SKIP  B: no owner photo in test/fixtures/real');
  else {
    const { readImage } = require('./imageio');
    const bi = readImage(fx('box-chickens.jpg'));
    const box = PH.createBox(bi, [[0, 0], [bi.w, 0], [bi.w, bi.h], [0, bi.h]], { cols: 27, rows: 37, pieces: 999 });
    const img = readImage(fx('whole-puzzle.jpg'), 480);
    const q = PH.findBorderQuad(img, box);
    // hand-checked on the photo (1440 px tall): TL 218,112  TR 857,104  BR 1033,1011  BL 140,1049
    const truth = [[218, 112], [857, 104], [1033, 1011], [140, 1049]], k = 1440 / Math.max(img.w, img.h);
    const err = q ? Math.max(...q.corners.map((p, i) => Math.hypot(p[0] * k - truth[i][0], p[1] * k - truth[i][1]))) : Infinity;
    check('B: the border is found on the owner\'s photo, the right way up', !!q && err < 25, q ? `worst corner ${err.toFixed(0)} px off (1440 px image), match ${q.score.toFixed(2)} vs ${(q.score - q.margin).toFixed(2)} turned round` : 'not found');
    if (q) {
      const big = readImage(fx('whole-puzzle.jpg'), 960), kk = big.w / img.w;
      const H = PH.quadHomography([[0, 0], [27, 0], [27, 37], [0, 37]], q.corners.map(([x, y]) => [x * kk, y * kk]));
      const r = PH.readCells(big, H, box);
      console.log(`B: ${r.stats.filled} filled, ${r.stats.open} open, ${999 - r.stats.filled - r.stats.open} unsure (one view)`);
      check('B: most of the assembled puzzle reads as filled, and some cells as open', r.stats.filled >= 500 && r.stats.open >= 30 && r.stats.open <= 250, JSON.stringify(r.stats));
    }
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
