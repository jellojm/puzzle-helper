/* Pointed check of the Table view (Map mode).
 *  - After a live sweep, each piece's picture is placed right: its outline,
 *    drawn through the placement recorded at its read, is centred on its
 *    table position, and every piece has the same rotation relative to the
 *    real table (one consistent map, not each piece at a random angle).
 *  - Joining scan groups moves a piece's picture exactly with the group.
 *  - Map geometry: scan groups laid out without overlap, fit shows
 *    everything, screen<->table round trip, tap hit-testing.
 * Run: node test/table-view.js   (a few seconds)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
globalThis.self = globalThis;
require('./lib/vision')(); // (the modules the app's worker loads)
const PH = globalThis.PH;
PH.CLOSE_SIDE = 40; // synthetic pieces are small (the phone's close reads: 150+ px); this test is about other things

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'tableView.js'), 'utf8');
  const TV = await import('data:text/javascript,' + encodeURIComponent(src));

  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 3 });
  const scat = S.scatter(cv, P, { scale: 2.2, seed: 5 });
  const FW = 1920, FH = 1080, zoom = 1.5, vw = FW / zoom, vh = FH / zoom, stops = [];
  for (let y = vh / 2; y <= scat.TH - vh / 2 + 1; y += vh * 0.45) for (let x = vw / 2; x <= scat.TW - vw / 2 + 1; x += vw * 0.3) for (let k = 0; k < 3; k++) stops.push([x + k * 6, y]);
  const eng = new PH.Engine({ checkedOnly: false }); // (Map geometry; checking is tested in moves.js / real-50.js)
  stops.forEach(([x, y], i) => { const fr = S.cameraFrame(cv, scat.table, x, y, Math.sin(i * 0.15) * 0.06, zoom, FW, FH); eng.processFrame(S.matSource(cv, fr), { still: true }); fr.delete(); });

  const data = eng.mapData();
  const placed = data.pieces.filter((p) => p.rd && p.corners);
  const unit = data.unit;
  // where a source-pixel point lands on the table through a piece's placement
  const toTable = (p, q) => { const r = p.rd; return [r.a * q[0] - r.b * q[1] + r.tx + p.pos[0] - r.pos0[0], r.b * q[0] + r.a * q[1] + r.ty + p.pos[1] - r.pos0[1]]; };
  let worstOff = 0;
  for (const p of placed) {
    const T = p.corners.map((q) => toTable(p, q));
    const cx = T.reduce((s, q) => s + q[0], 0) / 4, cy = T.reduce((s, q) => s + q[1], 0) / 4;
    worstOff = Math.max(worstOff, Math.hypot(cx - p.pos[0], cy - p.pos[1]) / unit);
  }
  const nShaped = data.pieces.filter((p) => p.shaped).length;
  check('every read piece has a placement for the map', placed.length > 30 && placed.length >= nShaped * 0.9, `${placed.length} of ${nShaped} shaped`);
  check('each picture is centred on its piece', worstOff < 0.3, `worst ${worstOff.toFixed(2)} piece widths off`);

  // One consistent map: each piece's drawn angle must equal its true angle
  // plus one common map rotation. Truth = a photo of the whole table
  // catalogued at scale 1 (its corners are in true-table pixels); live pieces
  // are paired with it by colour fingerprint, as in run-tests.js, and the map
  // -> true-table similarity is fitted on positions.
  const ref = new PH.Engine({ checkedOnly: false });
  ref.processSnap(S.matSource(cv, scat.table));
  const refs = [...ref.pieces.values()].filter((q) => q.t1);
  const corr = [];
  for (const p of placed) {
    const live = eng.pieces.get(p.id);
    let best = null;
    for (const q of refs) { const sim = PH.fpSimilarity(live.fp, q.fp); if (!best || sim > best.sim) best = { sim, q }; }
    if (best && best.sim > 0.8) corr.push({ src: p.pos, dst: best.q.t1.corners.reduce((s, c) => [s[0] + c[0] / 4, s[1] + c[1] / 4], [0, 0]), p, q: best.q });
  }
  const fit = PH.simRansac(corr, unit * 2, 200, PH.mulberry32(3));
  const mapRot = fit ? Math.atan2(fit.T.b, fit.T.a) : 0;
  const quarter = (a) => { let d = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2); return d > Math.PI / 4 ? d - Math.PI / 2 : d; };
  let worstAng = 0, n = 0;
  for (const k of fit ? fit.inliers : []) {
    const { p, q } = corr[k];
    const T = p.corners.map((c) => toTable(p, c));
    const drawn = Math.atan2(T[1][1] - T[0][1], T[1][0] - T[0][0]) + mapRot; // in true-table terms
    const truth = Math.atan2(q.t1.corners[1][1] - q.t1.corners[0][1], q.t1.corners[1][0] - q.t1.corners[0][0]);
    worstAng = Math.max(worstAng, Math.abs(quarter(drawn - truth)) * 180 / Math.PI); n++;
  }
  check('pieces are drawn at their true angle (one consistent map)', n > 20 && worstAng < 8, `worst ${worstAng.toFixed(1)} deg over ${n} pieces paired with a reference photo`);

  // Mixed sources (the browser test's sweep + photo + moves): pieces first
  // catalogued from a high-resolution photo, then half marked moved (picture
  // kept, angle out of date) and half without a placement (catalogued before
  // the map existed), then seen live. Every piece must end up placed again
  // from a live read, drawn at one piece's size - a photo's picture must never
  // be drawn through a live frame's placement (they differ in pixel scale).
  {
    const e2 = new PH.Engine({ checkedOnly: false, budgetMs: 400 }); // (placement logic, not read throughput: results must not depend on the machine's load)
    e2.processSnap(S.matSource(cv, scat.table));
    const before = new Map();
    for (const p of e2.pieces.values()) { if (p.id % 2) p.rd = null; else e2.markMoved(p); before.set(p.id, p.rd); }
    const seen = new Set(); // pieces the live sweep found again (pieces it never saw keep no placement)
    for (let pass = 0; pass < 3; pass++) stops.forEach(([x, y]) => { const fr = S.cameraFrame(cv, scat.table, x, y, 0, zoom, FW, FH); const o = e2.processFrame(S.matSource(cv, fr), { still: true }); for (const d of o.dets) if (d.id) seen.add(d.id); fr.delete(); });
    const d2 = e2.mapData(), sizes = [];
    let without = 0;
    for (const p of d2.pieces) {
      if (!p.shaped || !seen.has(p.id)) continue;
      const q = e2.pieces.get(p.id);
      if (!q.rd || q.rd.stale || q.rd === before.get(p.id)) { without++; continue; }
      // what is drawn: the stored corners through the stored placement
      const T = p.corners.map((c) => [p.rd.a * c[0] - p.rd.b * c[1], p.rd.b * c[0] + p.rd.a * c[1]]);
      let side = 0; for (let k = 0; k < 4; k++) side += Math.hypot(T[(k + 1) % 4][0] - T[k][0], T[(k + 1) % 4][1] - T[k][1]) / 4;
      sizes.push(side / d2.unit);
    }
    sizes.sort((x, y) => x - y);
    const shapedN = sizes.length + without;
    check('moved / unplaced pieces are placed again once seen live', without <= shapedN * 0.1, `${sizes.length} placed again, ${without} not`);
    check('every picture is drawn at the size of one piece', sizes.length > 0 && sizes[0] > 0.75 && sizes[sizes.length - 1] < 1.3, `drawn size / piece: ${sizes[0].toFixed(2)} - ${sizes[sizes.length - 1].toFixed(2)}`);
  }

  // A read from a distorted view (a wrong tilt reading stretches the far
  // side up to ~2x): the map draws it at the typical size, on the same spot.
  {
    const p = eng.pieces.get(placed[1].id), keep = p.rd;
    const centre = (q) => { const c = q.corners.reduce((s, c) => [s[0] + c[0] / 4, s[1] + c[1] / 4], [0, 0]); return toTable(q, c); };
    const was = centre(data.pieces.find((q) => q.id === p.id));
    // blow its read up 2x about its centre
    const c = p.t1.corners.reduce((s, c) => [s[0] + c[0] / 4, s[1] + c[1] / 4], [0, 0]), r = p.rd;
    const mx = r.a * c[0] - r.b * c[1] + r.tx, my = r.b * c[0] + r.a * c[1] + r.ty;
    p.rd = { a: 2 * r.a, b: 2 * r.b, tx: mx - 2 * (r.a * c[0] - r.b * c[1]), ty: my - 2 * (r.b * c[0] + r.a * c[1]), pos0: r.pos0 };
    const q = eng.mapData().pieces.find((x) => x.id === p.id);
    const T = q.corners.map((c) => [q.rd.a * c[0] - q.rd.b * c[1], q.rd.b * c[0] + q.rd.a * c[1]]);
    let side = 0; for (let k = 0; k < 4; k++) side += Math.hypot(T[(k + 1) % 4][0] - T[k][0], T[(k + 1) % 4][1] - T[k][1]) / 4;
    const now = centre(q), off = Math.hypot(now[0] - was[0], now[1] - was[1]) / unit;
    p.rd = keep;
    check('a stretched read is drawn at one piece size, on its spot', side / unit > 0.85 && side / unit < 1.15 && off < 0.05, `size ${(side / unit).toFixed(2)}, moved ${off.toFixed(3)} piece widths`);
  }

  // Joining scan groups: a piece moved by T must draw exactly where T puts its old drawing.
  {
    const p = eng.pieces.get(placed[0].id);
    const before = p.t1.corners.map((q) => toTable({ rd: p.rd, pos: p.pos }, q));
    const T = { a: Math.cos(0.7) * 1.3, b: Math.sin(0.7) * 1.3, tx: 500, ty: -200 };
    eng.moveWithGroup(p, T);
    const after = p.t1.corners.map((q) => toTable({ rd: p.rd, pos: p.pos }, q));
    const want = before.map((q) => PH.simApply(T, q[0], q[1]));
    const err = Math.max(...after.map((q, i) => Math.hypot(q[0] - want[i][0], q[1] - want[i][1])));
    check('joining scan groups moves the picture with the group', err < 1e-6, err.toExponential(1));
  }

  // Geometry helpers.
  {
    const pcs = [];
    for (let i = 0; i < 20; i++) pcs.push({ island: 1, pos: [i * 40, (i % 5) * 40] });
    for (let i = 0; i < 6; i++) pcs.push({ island: 2, pos: [9000 + i * 40, 50] });
    for (let i = 0; i < 3; i++) pcs.push({ island: 7, pos: [-4000, i * 40] });
    const off = TV.layoutIslands(pcs, 30);
    const box = (isl) => { const ps = pcs.filter((p) => p.island === isl).map((p) => [p.pos[0] + off.get(isl)[0], p.pos[1] + off.get(isl)[1]]); return [Math.min(...ps.map((q) => q[0])) - 30, Math.min(...ps.map((q) => q[1])) - 30, Math.max(...ps.map((q) => q[0])) + 30, Math.max(...ps.map((q) => q[1])) + 30]; };
    const B = [1, 2, 7].map(box);
    const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    check('scan groups are laid out side by side without overlap', !overlap(B[0], B[1]) && !overlap(B[0], B[2]) && !overlap(B[1], B[2]), JSON.stringify(B.map((b) => b.map(Math.round))));
    const pts = pcs.map((p) => [p.pos[0] + off.get(p.island)[0], p.pos[1] + off.get(p.island)[1]]);
    let worstIn = 0, rt = 0;
    for (const rot of [0, 0.6, Math.PI / 2, 2.5]) {
      const v = TV.fitView(pts, 414, 700, rot, 24), V = TV.makeView(v, 414, 700);
      for (const q of pts) {
        const [sx, sy] = V.toScreen(q[0], q[1]);
        worstIn = Math.max(worstIn, -Math.min(sx, sy, 414 - sx, 700 - sy));
        const [tx, ty] = V.toTable(sx, sy); rt = Math.max(rt, Math.hypot(tx - q[0], ty - q[1]));
      }
    }
    check('fit shows every piece, at any rotation', worstIn <= 0, `worst ${worstIn.toFixed(1)} px outside`);
    check('screen <-> table round trip', rt < 1e-6, rt.toExponential(1));
    const id = TV.hitTest([{ id: 5, sx: 100, sy: 100, r: 20 }, { id: 9, sx: 130, sy: 100, r: 20 }], 122, 101);
    check('tap picks the nearest piece under the finger', id === 9 && TV.hitTest([{ id: 5, sx: 100, sy: 100, r: 20 }], 300, 300) === null, `got ${id}`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
