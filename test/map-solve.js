/* The map re-solved from many views at once (Engine.solveMap, v0.23.0).
 * A 8 x 6 table of pieces whose stored map has drifted the way a long
 * close-up sweep drifts (errors growing across the table to ~1.5 piece
 * sides), and the views the frames saw (3 x 3 pieces each, own position,
 * turn and scale, a little noise), 5% of their links wrong:
 *  - after solving, the map's shape matches the table again (error after a
 *    best overall fit: median under 0.1 piece side, from ~0.5);
 *  - the wrong links don't pull pieces off (worst under 0.3);
 *  - the map doesn't jump as a whole (its centre stays within 0.2 piece).
 * Run: node test/map-solve.js   (instant)
 */
'use strict';
const PH = require('./lib/vision')();

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const rnd = PH.mulberry32(11);
const U = 100;
const eng = new PH.Engine();
const truth = new Map();
let id = 1;
// drift: a random walk along the sweep (column by column, snaking), so the
// error grows along the path to ~1 piece side - not a stretch a whole-map
// fit would take out
const walk = [0, 0];
for (let c = 0; c < 8; c++) for (let rr = 0; rr < 6; rr++) {
  const r = c % 2 ? 5 - rr : rr;
  walk[0] += (rnd() - 0.5) * 0.6 * U; walk[1] += (rnd() - 0.5) * 0.6 * U;
  const t = [c * U * 1.4, r * U * 1.4];
  const pid = r * 8 + c + 1;
  eng.pieces.set(pid, { id: pid, pos: [t[0] + walk[0], t[1] + walk[1]], island: 1, area: U * U, gone: false }); truth.set(pid, t);
}
void id;
const ids = [...truth.keys()];
const err = () => { // the map's shape against the table: residuals after the best overall similarity
  const T = PH.simFit(ids.map((i) => eng.pieces.get(i).pos), ids.map((i) => truth.get(i)));
  const e = ids.map((i) => { const q = PH.simApply(T, ...eng.pieces.get(i).pos), t = truth.get(i); return Math.hypot(q[0] - t[0], q[1] - t[1]) / U; }).sort((a, b) => a - b);
  return { median: e[e.length >> 1], worst: e[e.length - 1] };
};
const centre = () => { let x = 0, y = 0; for (const i of ids) { x += eng.pieces.get(i).pos[0]; y += eng.pieces.get(i).pos[1]; } return [x / ids.length, y / ids.length]; };
const before = err(), c0 = centre();
// views: 3 x 3 windows, each through its own similarity (frame px), noise 0.05 piece
for (let v = 0; v < 160; v++) {
  const r0 = Math.floor(rnd() * 4), c0v = Math.floor(rnd() * 6);
  const ang = (rnd() - 0.5) * 0.6, sc = 0.8 + rnd() * 0.6, tx = rnd() * 500, ty = rnd() * 500;
  const Tinv = { a: Math.cos(ang) * sc, b: Math.sin(ang) * sc, tx, ty }; // table -> frame
  const g = [];
  for (let r = r0; r < r0 + 3; r++) for (let c = c0v; c < c0v + 3; c++) {
    const pid = r * 8 + c + 1;
    let t = truth.get(pid);
    if (rnd() < 0.05) t = truth.get(1 + Math.floor(rnd() * ids.length)); // a wrong link: another piece's place
    const f = PH.simApply(Tinv, t[0] + (rnd() - 0.5) * 0.1 * U, t[1] + (rnd() - 0.5) * 0.1 * U);
    g.push({ p: eng.pieces.get(pid), src: f });
  }
  eng.noteView(1, g);
}
const st = eng.solveMap();
const after = err(), c1 = centre();
console.log(`before: median ${before.median.toFixed(2)}, worst ${before.worst.toFixed(2)}; after: median ${after.median.toFixed(2)}, worst ${after.worst.toFixed(2)} piece sides; solve ${JSON.stringify(st)}`);
check('the map matches the table again', before.median > 0.3 && after.median < 0.1, `median ${before.median.toFixed(2)} -> ${after.median.toFixed(2)}`);
check('wrong links pull no piece off', after.worst < 0.3, `worst ${after.worst.toFixed(2)}`);
check('the map does not jump as a whole', Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) / U < 0.2, `centre moved ${(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) / U).toFixed(2)}`);
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
