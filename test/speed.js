/* Speed benchmark for the live pipeline: Engine.processFrame on a synthetic
 * sweep and on real white-board frames (untilted and tilted, with a box
 * picture), plus match queries. Prints medians per stage so a change can be
 * compared against a previous version:
 *   node test/speed.js                     (this tree)
 *   VISION=<dir with js/vision files> node test/speed.js   (another version)
 * Node is ~10-25x faster than the phone; compare ratios, not absolute ms.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
const { readImage } = require('./imageio');
globalThis.self = globalThis;
const VISION = process.env.VISION || path.join(__dirname, '..', 'js', 'vision');
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(VISION, f + '.js'));
const PH = globalThis.PH;

const med = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const report = (label, outs, extra) => {
    const k = (key) => outs.map((o) => o.timings[key] || 0);
    console.log(`${label.padEnd(22)} frames ${String(outs.length).padStart(4)} | total med ${med(k('total')).toFixed(1).padStart(5)} mean ${mean(k('total')).toFixed(1).padStart(5)} | seg ${med(k('seg')).toFixed(1).padStart(5)} map ${med(k('map')).toFixed(1).padStart(4)} work ${med(k('work')).toFixed(1).padStart(5)} | shapes read ${k('t1').reduce((s, v) => s + v, 0)}${extra ? ' | ' + extra : ''}`);
  };

  // 1. Synthetic sweep, two passes (catalogue, then revisit).
  {
    const cols = 8, rows = 6;
    const P = S.makePuzzle(cv, { cols, rows, cs: 48, seed: 3 });
    const photo = S.boxPhoto(cv, P);
    const box = PH.createBox({ w: photo.mat.cols, h: photo.mat.rows, data: photo.mat.data }, photo.corners, { cols, rows, pieces: cols * rows });
    const scat = S.scatter(cv, P, { scale: 2.2, seed: 5 });
    const FW = 1920, FH = 1080, zoom = 1.5, viewW = FW / zoom, viewH = FH / zoom;
    const stops = [];
    for (let y = viewH / 2; y <= scat.TH - viewH / 2 + 1; y += viewH * 0.45) for (let x = viewW / 2; x <= scat.TW - viewW / 2 + 1; x += viewW * 0.3) for (let k = 0; k < 3; k++) stops.push([x + k * 6, y]);
    const frames = stops.map(([x, y], i) => S.cameraFrame(cv, scat.table, x, y, Math.sin(i * 0.15) * 0.06, zoom, FW, FH));
    const eng = new PH.Engine(); eng.setBox(box);
    const outs = [];
    for (let pass = 0; pass < 2; pass++) for (const fr of frames) outs.push(eng.processFrame(S.matSource(cv, fr), { still: true }));
    const c = eng.counts();
    // match queries: describe() every shaped piece once (what tapping does)
    const ids = [...eng.pieces.values()].filter((p) => p.t1).map((p) => p.id);
    const t0 = Date.now(); for (const id of ids) eng.describe(id); const qms = (Date.now() - t0) / Math.max(1, ids.length);
    report('synthetic sweep x2', outs, `${c.pieces} pieces, ${c.shaped} shaped | describe ${qms.toFixed(1)} ms/piece`);
    frames.forEach((f) => f.delete());
  }

  // 2. Real white-board frames (owner's), untilted + tilted, repeated.
  {
    const fx = (n) => path.join(__dirname, 'fixtures', n);
    const files = ['white-1.jpg', 'white-2.jpg', 'white-close-1.jpg', 'white-close-2.jpg'].filter((n) => fs.existsSync(fx(n)));
    if (files.length) {
      const mats = files.map((n) => { const im = readImage(fx(n)); const m = new cv.Mat(im.h, im.w, cv.CV_8UC4); m.data.set(im.data); return m; });
      const bi = readImage(fx(files[0]), 800);
      const eng = new PH.Engine();
      eng.setBox(PH.createBox(bi, [[0, 0], [bi.w, 0], [bi.w, bi.h], [0, bi.h]], { cols: 15, rows: 20, pieces: 300 }));
      const tilted = { down: [0.25, 0.08, Math.sqrt(1 - 0.0689)], fov: 66 };
      const outs = [];
      for (let r = 0; r < 6; r++) for (const m of mats) for (const tilt of [null, tilted]) outs.push(eng.processFrame(S.matSource(cv, m), { still: true, tilt }));
      const c = eng.counts();
      report('real white-board', outs.slice(mats.length * 2), `${c.pieces} pieces, ${c.shaped} shaped (from ${files.length} frames)`);
      mats.forEach((m) => m.delete());
    }
  }
})();
