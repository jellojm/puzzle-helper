/* The Build view's layout (Engine.buildGroups): the puzzle built piece by
 * piece from confirmed joins (owner, 2026-10-11). A synthetic puzzle is
 * catalogued from a photo; the true joins of 3x3 blocks are confirmed (as
 * Fits taps would); each group must come out laid exactly like the true grid
 * - every piece in its cell and turned the right way, up to turning the
 * whole group - with no conflicts. A wrong join added on top must show up as
 * a conflict, not move pieces.
 * Run: node test/build-groups.js   (a few seconds)
 */
'use strict';
const S = require('./synth');
const PH = require('./lib/vision')();
PH.CLOSE_SIDE = 40;

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const cols = 8, rows = 6;
  const P = S.makePuzzle(cv, { cols, rows, cs: 48, seed: 4 });
  const scat = S.scatter(cv, P, { scale: 2.2, seed: 9 });
  const eng = new PH.Engine({ checkedOnly: false });
  eng.processSnap(S.matSource(cv, scat.table));
  const byCell = new Map();
  for (const p of eng.pieces.values()) {
    if (!p.t1) continue;
    const c = p.t1.corners, cx = c.reduce((s, q) => s + q[0], 0) / 4, cy = c.reduce((s, q) => s + q[1], 0) / 4;
    let best = null, bd = Infinity;
    for (const g of scat.gt) { const d = Math.hypot(g.x - cx, g.y - cy); if (d < bd) { bd = d; best = g; } }
    if (best && bd < scat.core * 0.3) byCell.set(best.r * cols + best.c, { p, g: best, cx, cy });
  }
  const DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const edgeFacing = (e, side) => {
    const [dx, dy] = DIR[side], co = Math.cos(e.g.rot), si = Math.sin(e.g.rot), tx = co * dx - si * dy, ty = si * dx + co * dy;
    const c = e.p.t1.corners; let best = -1, bd = -2;
    for (let k = 0; k < 4; k++) {
      const mx = (c[k][0] + c[(k + 1) % 4][0]) / 2 - e.cx, my = (c[k][1] + c[(k + 1) % 4][1]) / 2 - e.cy, l = Math.hypot(mx, my) || 1;
      const d = (mx * tx + my * ty) / l; if (d > bd) { bd = d; best = k; }
    }
    return best;
  };
  // one 3x3 block whose 9 pieces were all read
  let block = null;
  for (let r = 0; r + 2 < rows && !block; r++) for (let c = 0; c + 2 < cols && !block; c++) {
    const cells = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cells.push(byCell.get((r + i) * cols + c + j));
    if (cells.every(Boolean)) block = { r, c, cells };
  }
  check('a 3x3 block of read pieces to test with', !!block);
  if (!block) { process.exitCode = 1; return; }
  const at = (i, j) => block.cells[i * 3 + j];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    if (j < 2) eng.feedback({ kind: 'joined', a: at(i, j).p.id, ka: edgeFacing(at(i, j), 1), b: at(i, j + 1).p.id, kb: edgeFacing(at(i, j + 1), 3), source: 'test' });
    if (i < 2) eng.feedback({ kind: 'joined', a: at(i, j).p.id, ka: edgeFacing(at(i, j), 2), b: at(i + 1, j).p.id, kb: edgeFacing(at(i + 1, j), 0), source: 'test' });
  }
  const { groups, joins } = eng.buildGroups();
  check('12 joins logged', joins.length === 12, `${joins.length}`);
  check('one group of 9 pieces, no conflicts', groups.length === 1 && groups[0].pieces.length === 9 && groups[0].conflicts.length === 0, groups.map((g) => `${g.pieces.length} pcs, ${g.conflicts.length} conflicts`).join('; '));
  // laid like the true grid, up to turning the whole group: for some quarter
  // turn q, every piece's cell = q(true cell offset) from the first piece,
  // and every piece's edge facing true "up" faces direction q in the group
  const g = groups[0], pos = new Map(g.pieces.map((p) => [p.id, p]));
  let ok = false, why = '';
  for (let q = 0; q < 4 && !ok; q++) {
    const turn = ([x, y]) => { let v = [x, y]; for (let t = 0; t < q; t++) v = [-v[1], v[0]]; return v; };
    const o = pos.get(at(0, 0).p.id);
    ok = true;
    for (let i = 0; i < 3 && ok; i++) for (let j = 0; j < 3 && ok; j++) {
      const e = at(i, j), p = pos.get(e.p.id), [dx, dy] = turn([j, i]);
      if (!p || p.col - o.col !== dx || p.row - o.row !== dy) { ok = false; why = `#${e.p.id} cell`; break; }
      const up = edgeFacing(e, 0);
      if ((up + p.rot) % 4 !== q) { ok = false; why = `#${e.p.id} turn`; }
    }
  }
  check('every piece in its true cell, turned the right way (the group as a whole may be turned)', ok, ok ? 'all 9' : why);
  // a wrong join on top: reported as a conflict, the layout unchanged
  eng.feedback({ kind: 'joined', a: at(0, 0).p.id, ka: edgeFacing(at(0, 0), 3), b: at(2, 2).p.id, kb: edgeFacing(at(2, 2), 1), source: 'test' });
  const g2 = eng.buildGroups().groups[0];
  check('a wrong join shows as a conflict and moves nothing', g2.pieces.length === 9 && g2.conflicts.length >= 1 && g2.pieces.every((p) => { const o = pos.get(p.id); return o && o.col === p.col && o.row === p.row && o.rot === p.rot; }), `${g2.conflicts.length} conflicts`);
  console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
})();
