/* Re-reads of one spot that differ only by a stretch agree (v0.22.2).
 * The owner's videos: every pair of close reads with the same edge types that
 * failed to agree failed on the edge-length gate alone - one direction of the
 * piece ~13-24% longer than in the other read (another viewing angle, a tilt
 * corrected a little differently). Synthetic: the table read straight, and
 * again stretched (x 0.89, y 1.12: ~23% aspect change).
 *  - the same piece, straight vs stretched, agrees (PH.shapeAgree) for most
 *    pieces (without the stretch tolerance: about half).
 * Run: node test/stretch-agree.js   (a few seconds)
 */
'use strict';
const path = require('path');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 3 });
  const sc = S.scatter(cv, P, { scale: 2.2, seed: 5 });
  const SX = 0.89, SY = 1.12;
  const reads = (mat) => {
    const eng = new PH.Engine({ checkedOnly: false, autoTilt: false });
    eng.processSnap(S.matSource(cv, mat));
    return [...eng.pieces.values()].filter((p) => p.t1).map((p) => { const c = p.t1.corners; return { t1: p.t1, x: c.reduce((s, q) => s + q[0], 0) / 4, y: c.reduce((s, q) => s + q[1], 0) / 4 }; });
  };
  const A = reads(sc.table);
  const st = new cv.Mat();
  cv.resize(sc.table, st, new cv.Size(Math.round(sc.TW * SX), Math.round(sc.TH * SY)), 0, 0, cv.INTER_AREA);
  const B = reads(st); st.delete();
  // the same piece: nearest stretched read to where the straight one lands
  const unit = Math.sqrt(PH.median(A.map((a) => a.t1.meanSide ** 2)));
  const pairs = [];
  for (const a of A) {
    let best = null, bd = unit * 0.4;
    for (const b of B) { const d = Math.hypot(b.x - a.x * SX, b.y - a.y * SY); if (d < bd) { bd = d; best = b; } }
    if (best && PH.codeDistance(a.t1.code, best.t1.code) === 0) pairs.push([a, best]);
  }
  const plain = (x, y) => { const al = PH.shapeAlign(x, y); return al.r >= 0 && al.d < PH.ANCHOR_SHAPE; };
  const same = pairs.filter(([a, b]) => PH.shapeAgree(a.t1, b.t1)).length, samePlain = pairs.filter(([a, b]) => plain(a.t1, b.t1)).length;
  check('the same piece, straight vs stretched, agrees', pairs.length >= 20 && same >= pairs.length * 0.8, `${same}/${pairs.length} (without the stretch tolerance ${samePlain})`);
  // (No false-agreement check here: the synthetic generator cuts near-
  // identical tabs, so different pieces with one code already agree by
  // outline ~3 times in 4 without the tolerance - why identity also compares
  // the print, PH.samePiece, which stays strict. Shape agreement is only used
  // for re-reads of the piece already linked to that spot; on the owner's
  // IMG_3593 all 11 pairs the tolerance rescues are the right piece per its key.)
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
