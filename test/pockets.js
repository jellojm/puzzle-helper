/* Pockets (owner, 2026-10-07): three pieces of a 2x2 joined (Fits) leave an
 * inside corner; the fourth piece must fit BOTH open edges at once. Before,
 * every edge was matched on its own and the last piece of the set showed no
 * match. Engine.pockets / pocketFit / applyPockets.
 *
 * A synthetic puzzle (no box picture: shape and colour only) is catalogued
 * from a photo. For every 2x2 block whose four pieces were read, the "owner"
 * confirms the three joins of an L, and the fourth piece's suggestions are
 * checked: its two edges facing the L should offer exactly the two wall
 * pieces, first. Compared with pockets switched off.
 * Run: node test/pockets.js   (a few seconds)
 */
'use strict';
const path = require('path');
const S = require('./synth');
globalThis.self = globalThis;
require('./lib/vision')(); // (the modules the app's worker loads)
const PH = globalThis.PH;
PH.CLOSE_SIDE = 40; // synthetic pieces are small

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

  // catalogue piece -> true cell and turn; its read edge facing a box side
  const byCell = new Map();
  for (const p of eng.pieces.values()) {
    if (!p.t1) continue;
    const c = p.t1.corners, cx = c.reduce((s, q) => s + q[0], 0) / 4, cy = c.reduce((s, q) => s + q[1], 0) / 4;
    let best = null, bd = Infinity;
    for (const g of scat.gt) { const d = Math.hypot(g.x - cx, g.y - cy); if (d < bd) { bd = d; best = g; } }
    if (best && bd < scat.core * 0.3) byCell.set(best.r * cols + best.c, { p, g: best, cx, cy });
  }
  const DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // box sides: top, right, bottom, left
  const edgeFacing = (e, side) => {
    const [dx, dy] = DIR[side], co = Math.cos(e.g.rot), si = Math.sin(e.g.rot);
    const tx = co * dx - si * dy, ty = si * dx + co * dy; // the side's direction on the table
    const c = e.p.t1.corners;
    let best = -1, bd = -2;
    for (let k = 0; k < 4; k++) {
      const mx = (c[k][0] + c[(k + 1) % 4][0]) / 2 - e.cx, my = (c[k][1] + c[(k + 1) % 4][1]) / 2 - e.cy, l = Math.hypot(mx, my) || 1;
      const d = (mx * tx + my * ty) / l;
      if (d > bd) { bd = d; best = k; }
    }
    return best;
  };

  const run = (on) => {
    const keep = PH.POCKET_EDGE;
    if (!on) PH.POCKET_EDGE = -1; // no edge passes: pockets off
    let blocks = 0, both = 0, oneOrBoth = 0, falseFill = 0;
    for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
      const A = byCell.get(r * cols + c), B = byCell.get(r * cols + c + 1), C = byCell.get((r + 1) * cols + c), D = byCell.get((r + 1) * cols + c + 1);
      if (!A || !B || !C || !D) continue;
      blocks++;
      eng.fbLog = [];
      for (const q of eng.pieces.values()) q.joined = [false, false, false, false];
      eng.feedback({ kind: 'joined', a: A.p.id, ka: edgeFacing(A, 1), b: B.p.id, kb: edgeFacing(B, 3), source: 'test' });
      eng.feedback({ kind: 'joined', a: A.p.id, ka: edgeFacing(A, 2), b: C.p.id, kb: edgeFacing(C, 0), source: 'test' });
      const res = eng.matchesFor(D.p.id, { loops: true });
      const top = (k) => (res && res[k] && res[k].matches[0]) || null;
      const tB = top(edgeFacing(D, 0)), tC = top(edgeFacing(D, 3));
      const okB = !!tB && tB.id === B.p.id && tB.edge === edgeFacing(B, 2), okC = !!tC && tC.id === C.p.id && tC.edge === edgeFacing(C, 1);
      if (process.env.DBG && on && !(okB && okC)) {
        const pk = eng.pockets(), f = pk.map((x) => x.filler && { id: x.filler.id, sc: +x.filler.f.score.toFixed(2) });
        const want = pk.length ? eng.pocketFit(D.p, pk[0]) : null;
        const ed = (e, k) => { const x = e.p.t1.edges[k]; return x.type + (x.unc ? '?' : '') + ' len' + x.lenRel.toFixed(2); };
        const es = (x, kx, y, ky) => { const r2 = PH.edgeScore(x.p.t1.edges[kx], y.p.t1.edges[ky]); return r2 ? r2.score.toFixed(2) + '/sh' + r2.shape.toFixed(3) : 'null'; };
        console.log(`    edgeScore D-B ${es(D, edgeFacing(D, 0), B, edgeFacing(B, 2))} D-C ${es(D, edgeFacing(D, 3), C, edgeFacing(C, 1))} | pocket eB ${eng.pockets()[0] && eng.pockets()[0].eB} want ${edgeFacing(B, 2)}, eC ${eng.pockets()[0] && eng.pockets()[0].eC} want ${edgeFacing(C, 1)}, b #${eng.pockets()[0] && eng.pockets()[0].b} c #${eng.pockets()[0] && eng.pockets()[0].c}`);
        console.log(`    D top ${ed(D, edgeFacing(D, 0))} vs B bottom ${ed(B, edgeFacing(B, 2))} | D left ${ed(D, edgeFacing(D, 3))} vs C right ${ed(C, edgeFacing(C, 1))} | D code ${D.p.t1.code} true ${D.g.code}`);
        console.log(`  block r${r}c${c}: pockets ${pk.length} fillers ${JSON.stringify(f)} D=#${D.p.id} fit ${want ? want.score.toFixed(2) + ' eD ' + want.eD : 'none'} (want eD ${edgeFacing(D, 0)}) | top B-side ${tB && '#' + tB.id + ':' + tB.edge + ' p' + tB.prob.toFixed(2) + (tB.pocket ? ' pocket' : '')} want #${B.p.id}:${edgeFacing(B, 2)} | top C-side ${tC && '#' + tC.id + ':' + tC.edge + ' p' + tC.prob.toFixed(2) + (tC.pocket ? ' pocket' : '')} want #${C.p.id}:${edgeFacing(C, 1)}`);
      }
      if (okB && okC) both++;
      if (okB || okC) oneOrBoth++;
      // the true fourth piece not on the table: no other piece may claim the pocket
      if (on) {
        eng.pieces.delete(D.p.id); eng.version++;
        const pk = eng.pockets();
        if (pk.length) { eng.applyPockets({ id: -1 }, [], eng.checkedPieces()); if (pk.some((x) => x.filler)) falseFill++; }
        eng.pieces.set(D.p.id, D.p); eng.version++;
      }
    }
    PH.POCKET_EDGE = keep;
    return { blocks, both, oneOrBoth, falseFill };
  };
  if (process.env.PSUM) PH.POCKET_SUM = +process.env.PSUM;
  if (process.env.PEDGE) PH.POCKET_EDGE = +process.env.PEDGE;
  const off = run(false), on = run(true);
  console.log(`2x2 blocks with an L of 3 confirmed: ${on.blocks}; last piece offered both wall pieces first: pockets off ${off.both}, on ${on.both} (at least one: ${off.oneOrBoth} -> ${on.oneOrBoth})`);
  check('enough 2x2 blocks read to test', on.blocks >= 10, `${on.blocks}`);
  check('with pockets the last piece is offered both wall pieces first in >= 90% of blocks', on.both >= 0.9 * on.blocks, `${on.both}/${on.blocks}`);
  check('pockets do better than single edges', on.both > off.both, `${off.both} -> ${on.both}`);
  check('with the fourth piece missing, another piece claims the pocket in <= 15% of blocks', on.falseFill <= 0.15 * on.blocks, `${on.falseFill}/${on.blocks}`);
  console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
})();
