/* Pointed check of the late-puzzle aids (RESEARCH-ai-puzzle.md items 15, 16):
 *  - "Fill this spot": with part of the puzzle built (pieces marked in the
 *    puzzle), the right loose piece for a spot comes first more often than by
 *    its picture alone, because its edges fit the pieces around the spot.
 *  - Frame chain: "next along the border" names the true neighbour along the
 *    frame.
 * Run: node test/solve-aids.js   (about 15 seconds)
 */
'use strict';
const path = require('path');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  let fillN = 0, fillTop = 0, printTop = 0, chainN = 0, chainOk = 0;
  for (const [seed, cols, rows] of [[41, 10, 8], [43, 9, 7]]) {
    const P = S.makePuzzle(cv, { cols, rows, cs: 48, seed });
    const photo = S.boxPhoto(cv, P);
    const box = PH.createBox({ w: photo.mat.cols, h: photo.mat.rows, data: photo.mat.data }, photo.corners, { cols, rows, pieces: cols * rows });
    const scat = S.scatter(cv, P, { scale: 2.0, seed: seed + 2 });
    const eng = new PH.Engine();
    eng.setBox(box);
    eng.processSnap(S.matSource(cv, scat.table));
    const gtOf = new Map(), byCell = new Map();
    for (const p of eng.pieces.values()) {
      if (!p.t1) continue;
      const c = p.t1.corners, cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
      let g = null, bd = Infinity;
      for (const q of scat.gt) { const d = Math.hypot(q.x - cx, q.y - cy); if (d < bd) { bd = d; g = q; } }
      if (g && bd < scat.core * 0.3) { gtOf.set(p.id, g); byCell.set(g.c + ',' + g.r, p); }
    }
    // Frame chain, before anything is marked: each named neighbour is the true one?
    for (const p of eng.pieces.values()) {
      const g = gtOf.get(p.id);
      if (!g || !p.t1.edges.some((e) => e.type === 'F')) continue;
      for (const c of eng.chainFor(p, eng.matchesFor(p.id))) {
        const q = gtOf.get(c.id);
        if (!q) continue;
        chainN++;
        if (Math.abs(q.c - g.c) + Math.abs(q.r - g.r) === 1 && (q.r === 0 || q.r === rows - 1 || q.c === 0 || q.c === cols - 1)) chainOk++;
      }
    }
    // Build half the puzzle: a checkerboard of pieces marked in the puzzle
    // (each placed piece's box spot is its true cell here).
    for (const [key, p] of byCell) { const [c, r] = key.split(',').map(Number); if ((c + r) % 2 === 0 && p.t2 && p.t2.cands.length && p.t2.cands[0].col === c && p.t2.cands[0].row === r) eng.setInPuzzle(p.id, true); }
    for (const [key, p] of byCell) {
      if (p.inPuzzle) continue;
      const [c, r] = key.split(',').map(Number);
      const f = eng.fillSpot(c, r, 8);
      if (!f.neighbours) continue;
      fillN++;
      if (f.cands[0] && f.cands[0].id === p.id) fillTop++;
      // picture only: the loose piece with the best placement score at this cell
      let best = null;
      for (const q of eng.pieces.values()) {
        if (!q.t2 || q.inPuzzle) continue;
        for (const k of (q.t2.orig || q.t2).cands) if (k.col === c && k.row === r && (!best || k.score < best.s)) best = { id: q.id, s: k.score };
      }
      if (best && best.id === p.id) printTop++;
    }
  }
  check('fill this spot: the right piece comes first', fillN >= 30 && fillTop / fillN >= 0.85 && fillTop >= printTop, `${fillTop}/${fillN} first (picture alone: ${printTop}/${fillN})`);
  check('next along the border is the true neighbour', chainN >= 20 && chainOk / chainN >= 0.85, `${chainOk}/${chainN}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
