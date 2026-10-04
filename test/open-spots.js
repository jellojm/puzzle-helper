/* Pointed check: open spots of the assembled part of a puzzle.
 *
 * A. A 6x8 block with one piece missing inside (a hole) and one on its edge
 *    (a pocket), seen whole and then swept close up. The views are built up
 *    into one assembly, put on the box picture, and both spots are found on
 *    their box cells with the missing piece (lying loose) offered first.
 * B. The owner's case: the whole border done, the middle not. Followed close
 *    up all round (no loose pieces in view to keep the place, and never the
 *    whole border at once), it builds into ONE assembly, is recognised as
 *    the complete border, and the cells just inside it are open spots.
 * Run: node test/open-spots.js   (~1 min)
 */
'use strict';
const path = require('path');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

function setup(cv, cols, rows, seed, block) {
  const P = S.makePuzzle(cv, { cols, rows, cs: 48, seed });
  const photo = S.boxPhoto(cv, P);
  const box = PH.createBox({ w: photo.mat.cols, h: photo.mat.rows, data: photo.mat.data }, photo.corners, { cols, rows, pieces: cols * rows });
  const inBlock = (p) => p.r >= block.r0 && p.r < block.r0 + block.rows && p.c >= block.c0 && p.c < block.c0 + block.cols && !block.missing.some(([r, c]) => r === p.r && c === p.c);
  const subset = P.pieces.map((p, i) => i).filter((i) => !inBlock(P.pieces[i]));
  const scat = S.scatter(cv, P, { scale: 2.2, seed: seed + 14, subset, blocks: [block] });
  // spotEveryMs 0: node runs frames far faster than a phone (~5-8 a second),
  // so the live pacing (one assembly view per 0.4 s) would skip most stops.
  const eng = new PH.Engine({ spotEveryMs: 0 });
  eng.setBox(box);
  return { P, box, scat, eng, B: scat.blocks[0], k: 2.2 * 48 };
}
// Sweep views over the block: a serpentine of stops around its centre.
function sweep(cv, T, stops, zoom) {
  let out = null;
  for (const [dx, dy] of stops) for (let k = 0; k < 3; k++) {
    const fr = S.cameraFrame(cv, T.scat.table, T.B.x + dx + k * 2, T.B.y + dy, 0.05, zoom, 1440, 1080);
    out = T.eng.processFrame(S.matSource(cv, fr), { still: true });
    fr.delete();
  }
  return out;
}
const grid = (n, m, step) => { const s = []; for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) s.push([(j % 2 ? n - 1 - i : i) - (n - 1) / 2, j - (m - 1) / 2].map((v) => v * step)); return s; };
const biggest = (eng) => (eng.asms || []).reduce((a, b) => (!a || b.cells.size > a.cells.size ? b : a), null);

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;

  // ---------- A: block with a hole and a pocket ----------
  {
    const hole = [3, 4], pocket = [1, 6]; // [row, col]
    const T = setup(cv, 10, 8, 7, { r0: 1, c0: 1, rows: 6, cols: 8, missing: [hole, pocket] });
    const { eng, scat, box } = T;
    // catalogue the loose pieces from one photo of the loose area
    const loose = scat.table.roi(new cv.Rect(0, 0, scat.TW, Math.round(T.B.y - 520))), lc = loose.clone(); loose.delete();
    eng.processSnap(S.matSource(cv, lc)); lc.delete();
    const idAt = ([r, c]) => {
      const g = scat.gt.find((q) => q.r === r && q.c === c);
      let best = null, bd = Infinity;
      for (const p of eng.pieces.values()) {
        if (!p.t1) continue;
        const cs = p.t1.corners, cx = (cs[0][0] + cs[1][0] + cs[2][0] + cs[3][0]) / 4, cy = (cs[0][1] + cs[1][1] + cs[2][1] + cs[3][1]) / 4;
        const d = Math.hypot(cx - g.x, cy - g.y);
        if (d < bd) { bd = d; best = p.id; }
      }
      return bd < scat.core * 0.4 ? best : null;
    };
    const holeId = idAt(hole), pocketId = idAt(pocket);
    sweep(cv, T, [[0, 0]], 0.75);
    const out = sweep(cv, T, grid(3, 3, T.k * 1.6), 1.4);
    const A = biggest(eng), info = eng.assemblyInfo();
    console.log(`A: missing pieces #${holeId} (hole), #${pocketId} (pocket); ${eng.asms.length} assembl${eng.asms.length === 1 ? 'y' : 'ies'}, info ${JSON.stringify(info)}`);
    const truth = new Set(T.B.cells), got = A ? A.filledBoxCells(box) : new Set();
    const right = [...got].filter((c) => truth.has(c)).length;
    check('A: the views build one assembly, placed on the box', eng.asms.length === 1 && !!(A && A.place), A && A.place ? `score ${A.place.score}, margin ${A.place.margin}` : 'not placed');
    check('A: its filled cells are the block\'s cells', right >= truth.size * 0.9 && right >= got.size * 0.95, `${right} right of ${got.size} filled, block has ${truth.size}`);
    const spots = A ? A.spots(box) : [];
    const at = (rc) => spots.find((s) => s.cell && s.cell[0] === rc[1] && s.cell[1] === rc[0]);
    const h = at(hole), pk = at(pocket);
    check('A: the hole is an open spot on its box cell', !!h && h.n === 4, h ? `n=${h.n}, needs ${h.need.join('')}` : `not among ${spots.length} spots`);
    check('A: the pocket is an open spot on its box cell', !!pk && pk.n === 3, pk ? `n=${pk.n}, needs ${pk.need.join('')}` : 'not found');
    const outside = spots.filter((s) => !s.cell).length;
    check('A: spots all along the block\'s edge, none beyond the puzzle', spots.length >= 20 && !outside, `${spots.length} spots, ${outside} without a box cell`);
    // the spots drawn on the last view, with the pieces offered
    const shown = out.spots || [];
    const sh = shown.find((s) => s.cell && s.cell[0] === hole[1] && s.cell[1] === hole[0]);
    const sp = shown.find((s) => s.cell && s.cell[0] === pocket[1] && s.cell[1] === pocket[0]);
    check('A: the missing piece is offered first for the hole', !!sh && sh.best.length > 0 && sh.best[0].id === holeId, sh ? `offered ${sh.best.map((b) => '#' + b.id).join(', ') || 'nothing'}` : 'hole not drawn on the last view');
    check('A: the missing piece is offered first for the pocket', !!sp && sp.best.length > 0 && sp.best[0].id === pocketId, sp ? `offered ${sp.best.map((b) => '#' + b.id).join(', ') || 'nothing'}` : 'pocket not drawn on the last view');
    const looseN = T.P.pieces.length - T.B.cells.length;
    check('A: the block is never catalogued as loose pieces', eng.pieces.size <= looseN, `${eng.pieces.size} entries for ${looseN} loose pieces`);
  }

  // ---------- B: a finished border followed close up ----------
  {
    const cols = 8, rows = 6, missing = [];
    for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) missing.push([r, c]);
    const T = setup(cv, cols, rows, 11, { r0: 0, c0: 0, rows, cols, missing });
    const { eng, box } = T;
    // walk round the ring: stops along its edges (block axes are rotated, so
    // walk in the block's own frame), never the whole ring in one view
    const rot = (() => { // block angle from the ring's own outline: not known to the app, only used to aim the camera
      const fr = S.cameraFrame(cv, T.scat.table, T.B.x, T.B.y, 0, 0.5, 1440, 1080);
      const seg = PH.segment(S.matSource(cv, fr).getProc(640), {}); fr.delete();
      const d = seg.dets.sort((a, b) => b.area - a.area)[0];
      return d && d.rect ? (d.rect.angle * Math.PI) / 180 : 0;
    })();
    const W = cols * T.k, H = rows * T.k, stops = [];
    const path = [];
    for (let t = 0; t <= 1; t += 1 / 8) path.push([-W / 2 + t * W, -H / 2]);
    for (let t = 1 / 6; t <= 1; t += 1 / 6) path.push([W / 2, -H / 2 + t * H]);
    for (let t = 1 / 8; t <= 1; t += 1 / 8) path.push([W / 2 - t * W, H / 2]);
    for (let t = 1 / 6; t < 1; t += 1 / 6) path.push([-W / 2, H / 2 - t * H]);
    for (const [x, y] of path) for (const sgn of [1, -1]) {
      const c = Math.cos(rot), s = Math.sin(rot);
      stops.push([x * c - y * s, x * s + y * c]);
      if (sgn > 0) continue;
    }
    sweep(cv, T, stops.filter((_, i) => i % 2 === 0), 1.5);
    const A = eng.mainAssembly(), info = eng.assemblyInfo();
    console.log(`B: ${eng.asms.length} assembl${eng.asms.length === 1 ? 'y' : 'ies'}, info ${JSON.stringify(info)}`);
    // (a view that fails to line up can start a second one; the one shown is
    // the placed one, and it has to be the whole border)
    check('B: following the border close up builds one main assembly', eng.asms.length <= 2 && !!A, `${eng.asms.length} assemblies (${(eng.asms || []).map((a) => a.cells.size).join(', ')} cells)`);
    check('B: no border is marked from a close view of part of it', !eng.pframe);
    check('B: it is placed on the box picture', !!(A && A.place), A && A.place ? `score ${A.place.score}, margin ${A.place.margin}` : 'not placed');
    const bs = A && A.borderStatus(box);
    check('B: recognised as the complete border', !!bs && bs.done >= bs.total - 1 && bs.inside <= 1, bs ? `${bs.done} of ${bs.total} border cells, ${bs.inside} inside` : 'no status');
    const spots = A ? A.spots(box) : [];
    const inner = spots.filter((s) => s.cell && s.cell[0] >= 1 && s.cell[1] >= 1 && s.cell[0] <= cols - 2 && s.cell[1] <= rows - 2);
    check('B: the cells just inside the border are open spots', inner.length >= (2 * (cols - 2) + 2 * (rows - 2) - 4) * 0.8, `${inner.length} inside spots, ${spots.length} in all`);
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
