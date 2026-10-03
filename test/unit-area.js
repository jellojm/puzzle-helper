/* WP1 acceptance: the live "one piece" area must stay stable when pale print
 * makes pieces fall apart. Live sweep over the synthetic table where, in every
 * frame, 30% of the visible pieces get a table-coloured band painted across
 * them (they break into fragments, like pale pieces on a white table).
 * Checks: running unit within 20% of the true piece area throughout, and the
 * catalog stays near the real count. Compares with stableUnit off (old way).
 * Usage: node test/unit-area.js */
'use strict';
const path = require('path');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;
const { robustUnit } = require('./seg-metrics');

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 3 });
  const sc = S.scatter(cv, P, { scale: 2.2, seed: 5 });
  const n = P.pieces.length;
  const FW = 1920, FH = 1080, zoom = 1.5, viewW = FW / zoom, viewH = FH / zoom, felt = [38, 92, 60];
  const path_ = [];
  for (let y = viewH / 2; y <= sc.TH - viewH / 2 + 1; y += viewH * 0.45) {
    for (let x = viewW / 2; x <= sc.TW - viewW / 2 + 1; x += viewW * 0.3) for (let k = 0; k < 3; k++) path_.push([x + k * 6, y]);
  }
  // true one-piece area at the live analysis width, from a clean frame
  const ref = (() => {
    const fr = S.cameraFrame(cv, sc.table, path_[0][0], path_[0][1], 0, zoom, FW, FH);
    const proc = S.matSource(cv, fr).getProc(640);
    fr.delete();
    return robustUnit(PH.segment(proc, { lightW: 0.5 }).dets);
  })();

  const run = (stable) => {
    const rnd = PH.mulberry32(99);
    const pale = sc.gt.map(() => rnd() < 0.3), paleAngle = sc.gt.map(() => rnd() * Math.PI);
    const eng = new PH.Engine({ stableUnit: stable });
    let worst = 0, outside = 0, frames = 0;
    path_.forEach(([cx, cy], i) => {
      const fr = S.cameraFrame(cv, sc.table, cx, cy, 0, zoom, FW, FH);
      // paint bands across ~30% of visible pieces (table frame px = (t - c) * zoom + F/2)
      sc.gt.forEach((g, gi) => {
        const fx = (g.x - cx) * zoom + FW / 2, fy = (g.y - cy) * zoom + FH / 2;
        // the same 30% of pieces are "pale" in every frame, as on a real table
        if (fx < 0 || fy < 0 || fx > FW || fy > FH || !pale[gi]) return;
        const a = paleAngle[gi], L = sc.core * zoom * 0.8;
        cv.line(fr, new cv.Point(fx - Math.cos(a) * L, fy - Math.sin(a) * L), new cv.Point(fx + Math.cos(a) * L, fy + Math.sin(a) * L),
          new cv.Scalar(felt[0], felt[1], felt[2], 255), Math.round(sc.core * zoom * 0.22));
      });
      eng.processFrame(S.matSource(cv, fr), { still: true });
      fr.delete();
      // the unit that drives splitting/merging this frame
      const u = stable ? eng.unitLive : eng.lastSegUnit;
      if (u) { frames++; const err = Math.abs(u / ref - 1); worst = Math.max(worst, err); if (err > 0.2) outside++; }
    });
    return { worst, outside, frames, pieces: eng.counts().pieces, sections: eng.counts().sections };
  };
  const off = run(false), on = run(true);
  const fmt = (r) => `worst unit error ${(r.worst * 100).toFixed(0)}%, frames >20% off: ${r.outside}/${r.frames}, catalog ${r.pieces} pieces + ${r.sections} sections (true ${n})`;
  console.log(`true unit ≈ ${ref.toFixed(0)} px² at 640 wide, ${path_.length} frames, the same 30% of pieces broken in every frame`);
  console.log('old (per-frame unit):  ' + fmt(off));
  console.log('WP1 (stable unit):     ' + fmt(on));
  const ok = on.worst <= 0.2 && on.pieces <= n * 1.05;
  console.log(ok ? 'PASS  stable unit within 20% and catalog within 5%' : 'FAIL  stable unit / catalog out of bounds');
  process.exitCode = ok ? 0 : 1;
})();
