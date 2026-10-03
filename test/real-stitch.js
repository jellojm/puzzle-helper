/* Multi-photo stitching on real photos: snaps several overlapping photos into
 * one catalog and reports whether each joins the table map and how many
 * pieces it adds (overlap should add few).
 * Usage: node test/real-stitch.js box.jpg photo1.jpg photo2.jpg ... */
'use strict';
const path = require('path');
const S = require('./synth');
const { readImage } = require('./imageio');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;
(async () => {
  let cv = require('@techstark/opencv-js'); if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r)); PH.cv = cv;
  const [boxFile, ...photos] = process.argv.slice(2);
  const eng = new PH.Engine();
  const bi = readImage(boxFile);
  eng.setBox(PH.createBox(bi, PH.detectBoxCorners(bi), { pieces: 1000 }));
  if (process.env.TEACH) {
    // TEACH="photo.jpg:x,y;x,y" -> table colors tapped once, used for every photo
    const [tf, spots] = process.env.TEACH.split(':');
    const ti = readImage(tf);
    for (const xy of spots.split(';')) {
      const [x, y] = xy.split(',').map(Number);
      const patch = new Uint8ClampedArray(81 * 4); let k = 0;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const i = ((y + dy) * ti.w + x + dx) * 4; patch.set(ti.data.subarray(i, i + 4), 4 * k++); }
      const L = PH.rgbaToLab(patch, 81, 1);
      eng.teachBackground({ L: PH.median(Array.from({ length: 81 }, (_, j) => L[3 * j])), a: PH.median(Array.from({ length: 81 }, (_, j) => L[3 * j + 1])), b: PH.median(Array.from({ length: 81 }, (_, j) => L[3 * j + 2])) });
    }
  }
  // Record every cross-photo identification (shape fused into an existing piece)
  // and save side-by-side crops so they can be checked by eye.
  const pairs = [];
  let cur = null, prevImgs = new Map();
  const analyze = PH.analyzePiece;
  PH.analyzePiece = function (crop, ctx) { const t = analyze(crop, ctx); if (t) t.photo = cur; return t; };
  for (const f of photos) {
    cur = f;
    const img = readImage(f);
    prevImgs.set(f, img);
    const mat = new cv.Mat(img.h, img.w, cv.CV_8UC4); mat.data.set(img.data);
    const firstPhoto = new Map([...eng.pieces.values()].map((p) => [p.id, p.t1 && p.t1.photo]));
    const r = eng.processSnap(S.matSource(cv, mat));
    for (const k of r.recognized) if (k.corners && k.firstCorners) pairs.push({ a: k.firstCorners, aImg: firstPhoto.get(k.id), b: k.corners, bImg: f });
    mat.delete();
    const islands = new Set([...eng.pieces.values()].filter((p) => p.pos).map((p) => p.island));
    console.log(`${path.basename(f)}: found ${r.found}, new ${r.added}, joined map: ${r.located}, total ${eng.pieces.size}, islands ${islands.size}, ${r.ms.toFixed(0)} ms`);
  }
  if (pairs.length) {
    const { writeJpg } = require('./imageio');
    const T = 200, sheet = new cv.Mat(pairs.length * T, 2 * T, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 255));
    pairs.forEach((p, i) => {
      [[p.a, p.aImg], [p.b, p.bImg]].forEach(([cs, f], j) => {
        const im = prevImgs.get(f);
        const cx = cs.reduce((s, c) => s + c[0], 0) / 4, cy = cs.reduce((s, c) => s + c[1], 0) / 4;
        const R = Math.hypot(cs[0][0] - cs[2][0], cs[0][1] - cs[2][1]) * 0.75;
        const x0 = Math.max(0, Math.round(cx - R)), y0 = Math.max(0, Math.round(cy - R));
        const w = Math.min(im.w - x0, Math.round(2 * R)), h = Math.min(im.h - y0, Math.round(2 * R));
        const m = new cv.Mat(im.h, im.w, cv.CV_8UC4); m.data.set(im.data);
        const c = m.roi(new cv.Rect(x0, y0, w, h)).clone(), t = new cv.Mat();
        cv.resize(c, t, new cv.Size(T, T)); t.copyTo(sheet.roi(new cv.Rect(j * T, i * T, T, T)));
        [m, c, t].forEach((q) => q.delete());
      });
    });
    writeJpg(path.join(__dirname, 'out', 'stitch-pairs.jpg'), sheet.cols, sheet.rows, sheet.data);
    console.log(`${pairs.length} cross-photo identifications -> test/out/stitch-pairs.jpg`);
  }
})();
