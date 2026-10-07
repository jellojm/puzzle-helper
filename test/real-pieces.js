/* Segment a real photo of loose pieces and draw what was found.
 * Usage: node test/real-pieces.js test/fixtures/pieces-1.jpg
 * Writes test/out/<name>-seg.jpg: green = single piece with shape read,
 * yellow = single piece (shape failed), orange = merged/touching, grey = border. */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
const { readImage, writeJpg } = require('./imageio');
globalThis.self = globalThis;
require('./lib/vision')(); // (the modules the app's worker loads)
const PH = globalThis.PH;
PH.DEBUG_SEG = !!process.env.DBG;

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const file = process.argv[2];
  const img = readImage(file);
  const mat = new cv.Mat(img.h, img.w, cv.CV_8UC4); mat.data.set(img.data);
  const eng = new PH.Engine();
  const boxFile = process.argv[3];
  if (boxFile) { const bi = readImage(boxFile); eng.setBox(PH.createBox(bi, PH.detectBoxCorners(bi), { pieces: 1000 })); }
  if (process.env.TAUGHT) {
    // "x,y;x,y" spots on the table (original pixels) -> taught background colors.
    // TAUGHT_FROM=photo.jpg samples them from a different photo of the same table.
    const src = process.env.TAUGHT_FROM ? readImage(process.env.TAUGHT_FROM) : img;
    for (const xy of process.env.TAUGHT.split(';')) {
      const [x, y] = xy.split(',').map(Number);
      const patch = new Uint8ClampedArray(81 * 4);
      let k = 0;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const i = ((y + dy) * src.w + x + dx) * 4; patch.set(src.data.subarray(i, i + 4), 4 * k++); }
      const L = PH.rgbaToLab(patch, 81, 1);
      const m = [0, 1, 2].map((c) => PH.median(Array.from({ length: 81 }, (_, j) => L[3 * j + c])));
      eng.teachBackground({ L: m[0], a: m[1], b: m[2] });
    }
    console.log('taught', JSON.stringify(eng.taught.map((t) => [t.L, t.a, t.b].map(Math.round))));
  }
  const t = Date.now();
  const res = eng.processSnap(S.matSource(cv, mat));
  console.log(`${path.basename(file)} ${img.w}x${img.h}: ${JSON.stringify(res)} in ${Date.now() - t} ms`);
  console.log('background', JSON.stringify(eng.bg), 'thresh', eng.thresh);
  // Re-run segmentation for drawing.
  const proc = S.matSource(cv, mat).getProc(eng.opts.snapProcW);
  const seg = PH.segment(proc, eng.segOpts({}));
  const dets = eng.classify(seg.dets, seg.unitArea);
  const k = 1 / proc.scale;
  let single = 0, merged = 0;
  for (const d of dets) {
    const pts = []; for (let i = 0; i < d.pts.length; i++) pts.push(Math.round(d.pts[i] * k));
    const pm = cv.matFromArray(pts.length / 2, 1, cv.CV_32SC2, pts);
    const mv = new cv.MatVector(); mv.push_back(pm);
    const col = d.border ? [150, 150, 150, 255] : d.merged ? [255, 140, 0, 255] : [0, 255, 0, 255];
    if (!d.border) d.merged ? merged++ : single++;
    cv.polylines(mat, mv, true, new cv.Scalar(...col), 4);
    pm.delete(); mv.delete();
  }
  console.log(`dets: ${dets.length} (single ${single}, merged ${merged}, border ${dets.length - single - merged}), median area ${PH.median(dets.map((d) => d.area)).toFixed(0)} px @ proc`);
  const s = new cv.Mat(); cv.resize(mat, s, new cv.Size(Math.round(img.w / 2), Math.round(img.h / 2)));
  writeJpg(path.join(__dirname, 'out', path.basename(file, '.jpg') + '-seg.jpg'), s.cols, s.rows, s.data);
})();
