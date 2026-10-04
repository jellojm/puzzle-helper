/* Pointed check: pieces that are sometimes not detected must not be
 * catalogued twice.
 *
 * On the owner's white board pale pieces drop out of detection on some frames
 * (blur, low contrast). v0.9.1 then forgot a piece's table position after 7
 * missed frames, and when the piece was detected again it was catalogued as
 * NEW unless a strict shape match against an earlier (often blurry) reading
 * succeeded: report 15:52 had 566 entries (419 without a position) for ~150
 * pieces on the table.
 *
 * Here a live sweep runs while a seeded random 30% of piece detections are
 * dropped from every frame; the catalog must stay close to the true count.
 * Run: node test/dupes.js   (VISION=<dir> to run another copy of js/vision)
 */
'use strict';
const path = require('path');
const S = require('./synth');
globalThis.self = globalThis;
const VISION = process.env.VISION || path.join(__dirname, '..', 'js', 'vision');
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(VISION, f + '.js'));
const PH = globalThis.PH;

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const cols = 8, rows = 6, n = cols * rows;
  const P = S.makePuzzle(cv, { cols, rows, cs: 48, seed: 3 });
  const scat = S.scatter(cv, P, { scale: 2.2, seed: 5 });

  // What the owner's board does to pale pieces, modelled on the synthetic table:
  //  - persistent drop-outs: two thirds of the pieces are undetected two
  //    thirds of the time, in runs of ~12 frames (not random single frames),
  //  - on the second sweep the light differs (lamp, viewing angle), so a
  //    returning piece's colour fingerprint is shifted.
  const FW = 1920, FH = 1080, zoom = 1.5, viewW = FW / zoom, viewH = FH / zoom;
  const cam = { x: 0, y: 0, frame: 0, sweep: 0 };
  const phase = scat.gt.map((g, j) => ((j * 7919) % 97) / 97);
  // Report 15:52: median 16 detections per frame with far more pieces in
  // view, i.e. over half the pieces missing in a typical frame.
  const flaky = scat.gt.map((g, j) => j % 3 !== 0); // two thirds of the pieces
  const pieceAt = (X, Y) => { let b = -1, bd = Infinity; scat.gt.forEach((g, j) => { const d = Math.hypot(g.x - X, g.y - Y); if (d < bd) { bd = d; b = j; } }); return bd < scat.core * 0.6 ? b : -1; };
  const seg = PH.segment;
  PH.segment = function (img, opts) {
    const r = seg.call(this, img, opts);
    if (!opts || opts.splitBudgetMs === undefined) return r; // live frames only
    r.dets = r.dets.filter((d) => {
      if (d.border) return true;
      const X = (d.cx / img.scale - FW / 2) / zoom + cam.x, Y = (d.cy / img.scale - FH / 2) / zoom + cam.y;
      const j = pieceAt(X, Y);
      return !(j >= 0 && flaky[j] && Math.floor(cam.frame / 12 + phase[j] * 3) % 3 !== 0); // gone 2/3 of the time
    });
    if (cam.sweep === 1) for (const d of r.dets) if (d.fp) d.fp = Object.assign({}, d.fp, { L: d.fp.L + 14 });
    return r;
  };

  const stops = [];
  const stepX = viewW * 0.3, stepY = viewH * 0.45;
  let dir = 1;
  for (let y = viewH / 2; y <= scat.TH - viewH / 2 + stepY * 0.6; y += stepY) {
    const xs = [];
    for (let x = viewW / 2; x <= scat.TW - viewW / 2 + stepX * 0.6; x += stepX) xs.push(Math.min(x, scat.TW - viewW / 2));
    if (dir < 0) xs.reverse();
    for (const x of xs) for (let k = 0; k < 4; k++) stops.push([x + k * 6, Math.min(y, scat.TH - viewH / 2)]);
    dir = -dir;
  }
  const eng = new PH.Engine();
  //  - and, as in report 15:52 (0.57 shape reads per frame: segmentation ate
  //    the budget), most shape reads fail on the second sweep, so a returning
  //    piece can't be recognised by its outline either.
  const rnd = S.makeRng(77);
  const detT1 = eng.detT1.bind(eng);
  eng.detT1 = (d) => { if (cam.sweep === 1 && d.t1 === undefined && rnd() < 0.8) { d.t1 = null; return null; } return detT1(d); };
  // Two passes over the table, like sweeping back over scanned pieces.
  [stops, stops.slice().reverse()].forEach((pass, sweep) => {
    cam.sweep = sweep;
    pass.forEach(([x, y]) => {
      cam.x = x; cam.y = y; cam.frame++;
      const fr = S.cameraFrame(cv, scat.table, x, y, 0, zoom, FW, FH);
      eng.processFrame(S.matSource(cv, fr), { still: true });
      fr.delete();
    });
  });
  const c = eng.counts();
  const lost = [...eng.pieces.values()].filter((p) => !p.pos).length;
  console.log(`2/3 of pieces missing 2/3 of the time, light shifted and shape reads starved on sweep 2: ${c.pieces} catalogued for ${n} pieces, ${lost} without a table position, ${c.islands} island(s)`);
  check('pieces that drop out of detection are not catalogued twice', c.pieces <= n * 1.05, `${c.pieces} entries for ${n} pieces`);
  check('and keep their table position', lost <= n * 0.1, `${lost} without a position`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
