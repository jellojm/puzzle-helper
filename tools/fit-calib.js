/* Fit the match-probability model's starting weights (PH.CALIB_PRIOR) on
 * synthetic puzzles with known answers, and print how well calibrated the
 * result is on puzzles it was not fitted on.
 *
 * Each run catalogues a synthetic puzzle from a photo of the table (corners
 * are then in table pixels, so every candidate can be labelled exactly: is
 * it the piece across that edge, with the facing edge?), leaves out 30% of
 * the pieces (partners not scanned yet, as on a real table), with or
 * without a box picture, and with or without the 2x2 loop check.
 *
 * Run: node tools/fit-calib.js        (about a minute)
 * Then copy the printed weights into PH.CALIB_PRIOR (js/vision/matcher.js).
 * The owner's Fits/No answers refit the model on the real puzzle anyway;
 * this only sets where it starts.
 */
'use strict';
const path = require('path');
const S = require('../test/synth');
globalThis.self = globalThis;
require('../test/lib/vision')(); // (the modules the app's worker loads)
const PH = globalThis.PH;

// Labelled candidates from one synthetic table.
function samples(cv, seed, scale, withBox) {
  const cols = 8, rows = 6;
  const P = S.makePuzzle(cv, { cols, rows, cs: 48, seed });
  const scat = S.scatter(cv, P, { scale, seed: seed + 2 });
  const eng = new PH.Engine();
  if (withBox) {
    const photo = S.boxPhoto(cv, P);
    eng.setBox(PH.createBox({ w: photo.mat.cols, h: photo.mat.rows, data: photo.mat.data }, photo.corners, { cols, rows, pieces: cols * rows }));
  }
  eng.processSnap(S.matSource(cv, scat.table));
  const rnd = S.makeRng(seed * 7 + 1);
  for (const p of [...eng.pieces.values()]) if (rnd() < 0.3) eng.removePiece(p.id);
  const centre = (c) => [(c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4];
  const mid = (c, k) => [(c[k][0] + c[(k + 1) % 4][0]) / 2, (c[k][1] + c[(k + 1) % 4][1]) / 2];
  // The scatter turned each piece by gt.rot (table = R(rot) * puzzle), so an
  // edge's outward direction turned back by -rot is its direction in the
  // solved puzzle: one of up/right/down/left as [dc, dr].
  const dirOf = (q, k, rot) => {
    const c = centre(q.t1.corners), m = mid(q.t1.corners, k);
    const vx = m[0] - c[0], vy = m[1] - c[1], cs = Math.cos(-rot), sn = Math.sin(-rot);
    const px = cs * vx - sn * vy, py = sn * vx + cs * vy;
    return Math.abs(px) > Math.abs(py) ? [Math.sign(px), 0] : [0, Math.sign(py)];
  };
  const gtOf = new Map();
  for (const p of eng.pieces.values()) {
    if (!p.t1) continue;
    const [cx, cy] = centre(p.t1.corners);
    let best = null, bd = Infinity;
    for (const g of scat.gt) { const d = Math.hypot(g.x - cx, g.y - cy); if (d < bd) { bd = d; best = g; } }
    if (best && bd < scat.core * 0.3) gtOf.set(p.id, best);
  }
  const out = [];
  let i = 0;
  for (const p of eng.pieces.values()) {
    if (!p.t1 || !gtOf.has(p.id)) continue;
    const res = eng.matchesFor(p.id, { loops: i++ % 2 === 0 });
    const a = gtOf.get(p.id);
    for (const r of res) {
      // where edge k points in the solved puzzle: [dc, dr]
      const da = dirOf(p, r.edge, a.rot);
      r.matches.slice(0, 3).forEach((m, rank) => {
        const q = eng.pieces.get(m.id);
        if (!gtOf.has(m.id)) return;
        const b = gtOf.get(m.id), db = dirOf(q, m.edge, b.rot);
        const y = b.c === a.c + da[0] && b.r === a.r + da[1] && db[0] === -da[0] && db[1] === -da[1];
        out.push({ x: m.x.slice(), y: y ? 1 : 0, pSoft: m.pSoft, rank, score: m.score });
      });
    }
  }
  return out;
}

function report(label, S, w) {
  let ll = 0;
  const bins = [[0, 0.2], [0.2, 0.5], [0.5, 0.8], [0.8, 0.95], [0.95, 1.01]].map(([lo, hi]) => ({ lo, hi, n: 0, y: 0, p: 0 }));
  for (const s of S) {
    const p = w ? PH.calibProb(w, s.x) : PH.clamp(s.pSoft, 1e-4, 1 - 1e-4);
    ll -= s.y ? Math.log(p) : Math.log(1 - p);
    const b = bins.find((b) => p >= b.lo && p < b.hi); b.n++; b.y += s.y; b.p += p;
  }
  const ece = bins.reduce((e, b) => e + (b.n ? Math.abs(b.y / b.n - b.p / b.n) * b.n : 0), 0) / S.length;
  console.log(`${label.padEnd(26)} log-loss ${(ll / S.length).toFixed(3)}  ECE ${ece.toFixed(3)}  | ` +
    bins.map((b) => `${b.lo}-${Math.min(1, b.hi)}: ${b.n ? `${Math.round((100 * b.y) / b.n)}% of ${b.n}` : '-'}`).join('  '));
}

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const train = [], test = [];
  for (const [seed, scale, box] of [[3, 2.2, true], [5, 1.8, false], [7, 2.0, true], [9, 1.6, false], [11, 2.4, true], [13, 1.7, true]]) train.push(...samples(cv, seed, scale, box));
  for (const [seed, scale, box] of [[21, 2.0, true], [23, 1.7, false], [25, 2.2, false]]) test.push(...samples(cv, seed, scale, box));
  console.log(`train ${train.length} candidates (${train.filter((s) => s.y).length} true), test ${test.length} (${test.filter((s) => s.y).length} true)`);
  // Neutral start; 'confirmed' never varies in photo catalogues (one view
  // each), so it keeps this value - a modest bonus for shapes seen twice.
  const neutral = [0, 1, 0, 0, 0, 0.5, 0, 0, 0];
  const w = PH.fitCalib(train, neutral, 1, 30);
  console.log('weights', PH.CALIB_FEATURES.map((f, i) => `${f} ${w[i].toFixed(2)}`).join(', '));
  report('softmax only (test)', test, null);
  report('current prior (test)', test, PH.CALIB_PRIOR);
  report('fitted (test)', test, w);
  if (process.env.ADJ) { const T = train.concat(test); const m = (f) => { const S = T.filter(f); return (S.reduce((t, s) => t + s.x[6], 0) / Math.max(1, S.length)).toFixed(3) + ' over ' + S.length + ', >0: ' + S.filter((s) => s.x[6] > 0).length; }; console.log('box adjacency mean: true partners', m((s) => s.y), '| wrong', m((s) => !s.y)); }
  // how often the best-scored candidate is the true partner (matching quality itself)
  const tops = train.concat(test).filter((s) => s.x && s.rank === 0);
  console.log(`top suggestion right: ${tops.filter((s) => s.y).length}/${tops.length} (${(100 * tops.filter((s) => s.y).length / tops.length).toFixed(1)}%)`);
  // precision by evidence (all candidates, train + test)
  const all = train.concat(test), prec = (f) => { const S = all.filter(f), n = S.filter((s) => s.y).length; return `${n}/${S.length}`; };
  console.log(`right: mutual ${prec((s) => s.x[3])}, one 2x2 loop ${prec((s) => s.x[4] && !s.x[8])}, 2x3 (loops on both sides) ${prec((s) => s.x[8])}, mutual + 2x3 ${prec((s) => s.x[3] && s.x[8])}, neither ${prec((s) => !s.x[3] && !s.x[4])}`);
  console.log(`PH.CALIB_PRIOR = [${w.map((v) => +v.toFixed(2)).join(', ')}];`);
})();
