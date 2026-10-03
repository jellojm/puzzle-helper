/* Shape reading (PH.analyzePiece) on a real high-resolution photo of loose
 * pieces — the owner reported edges not being picked up on colourful /
 * high-contrast pieces.
 *
 * No ground truth on a real photo, but two things are checkable:
 *  - success: share of single pieces whose shape reads at all;
 *  - flat-edge share: a tab lost from the mask reads as a FLAT edge. Pieces
 *    with a flat edge are only the border: 4 + 2(cols-2) + 2(rows-2) of
 *    cols*rows, i.e. 22% for 15x20. Far more than that means tabs are being
 *    misread as flat.
 * Draws test/out/<photo>-shapes.jpg (green = read, with flat edges in orange;
 * red = failed) and a contact sheet of failures, <photo>-fails.jpg.
 *
 * Usage: node test/shape-real.js <photo.jpg> [cols rows] [--opt=json for analyzePiece ctx]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
const { readImage, writeJpg } = require('./imageio');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && /\.(jpe?g|png)$/i.test(a));
const nums = args.filter((a) => /^\d+$/.test(a)).map(Number);
const cols = nums[0] || 15, rows = nums[1] || 20;
const extra = (() => { const a = args.find((x) => x.startsWith('--opt=')); return a ? JSON.parse(a.slice(6)) : {}; })();
if (!file) { console.log('usage: node test/shape-real.js <photo.jpg> [cols rows]'); process.exit(2); }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const img0 = readImage(file);
  const mat = new cv.Mat(img0.h, img0.w, cv.CV_8UC4); mat.data.set(img0.data);
  let src = S.matSource(cv, mat);
  const eng = new PH.Engine();
  // --autotilt: straighten with the engine's own photo-tilt estimate first
  // (perspective squashes near/far edges, which makes tabs look flat).
  if (args.includes('--autotilt')) {
    const est = eng.estimatePhotoTilt(src);
    if (est && est.tilt >= 8) { src = eng.straighten(src, { tilt: { down: est.down, fov: 66 } }).source; console.log(`straightened: pitch ${est.pitch} roll ${est.roll}`); }
  }
  // Same segmentation as a photo (Catalog from a photo): snap width, background model chosen by the engine.
  const proc = src.getProc(eng.opts.snapProcW);
  const b = eng.chooseBackground ? eng.chooseBackground(proc) : null;
  const seg = PH.segment(proc, eng.segOpts(b ? { bgModel: b.c } : {}));
  const dets = eng.classify(seg.dets, seg.unitArea);
  eng.frameCtx = { source: src, scale: proc.scale, bg: seg.bg, thresh: seg.thresh, lut: seg.lut, unitArea: seg.unitArea, still: true, deadline: Infinity };
  if (Object.keys(extra).length) { const a = PH.analyzePiece; PH.analyzePiece = (crop, ctx) => a(crop, Object.assign({}, ctx, extra)); }
  // draw on the image that was analysed (straightened if --autotilt)
  // full-resolution render of the analysed image (getProc at the source's own size)
  const full = src.getProc(Math.max(src.w, src.h));
  const img = { w: full.w, h: full.h, data: full.data };
  const canvas = new cv.Mat(img.h, img.w, cv.CV_8UC4); canvas.data.set(img.data);
  let single = 0, ok = 0, withFlat = 0, flats = 0, ms = 0;
  const flatPieces = [];
  const fails = [];
  const k = 1 / proc.scale;
  const draw = (pts, color, w) => {
    const pm = cv.matFromArray(pts.length / 2, 1, cv.CV_32SC2, pts.map(Math.round));
    const mv = new cv.MatVector(); mv.push_back(pm);
    cv.polylines(canvas, mv, true, new cv.Scalar(...color), w);
    pm.delete(); mv.delete();
  };
  for (const d of dets) {
    if (d.border || d.merged) continue;
    single++;
    const t0 = Date.now();
    const t1 = eng.detT1(d);
    ms += Date.now() - t0;
    if (t1) {
      ok++;
      const nf = t1.flats.filter(Boolean).length;
      flats += nf; if (nf) { withFlat++; flatPieces.push(t1); }
      // outline: the four corners, flat edges thicker in orange
      for (let e = 0; e < 4; e++) {
        const a = t1.corners[e], c = t1.corners[(e + 1) % 4];
        draw([a[0], a[1], c[0], c[1]], t1.flats[e] ? [255, 140, 0, 255] : [0, 230, 0, 255], t1.flats[e] ? 9 : 5);
      }
    } else {
      draw(Array.from(d.pts, (v) => v * k), [255, 40, 40, 255], 6);
      if (fails.length < 24) fails.push(d.bbox.map((v) => Math.round(v * k)));
    }
  }
  const expect = (4 + 2 * (cols - 2) + 2 * (rows - 2)) / (cols * rows);
  console.log(`${path.basename(file)} ${img0.w}x${img0.h}: ${single} single pieces, shape read ${ok} (${(100 * ok / Math.max(1, single)).toFixed(0)}%), ${(ms / Math.max(1, single)).toFixed(0)} ms each`);
  console.log(`pieces with a flat edge: ${withFlat} of ${ok} = ${(100 * withFlat / Math.max(1, ok)).toFixed(0)}% (a ${cols}x${rows} puzzle has ${(100 * expect).toFixed(0)}% edge/corner pieces); flat edges total ${flats}`);
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  const base = path.basename(file).replace(/\.\w+$/, '') + (process.env.TAG ? '-' + process.env.TAG : '');
  const small = new cv.Mat(); cv.resize(canvas, small, new cv.Size(Math.round(img.w / 2), Math.round(img.h / 2)));
  writeJpg(path.join(__dirname, 'out', base + '-shapes.jpg'), small.cols, small.rows, small.data);
  // Sheet of every piece read as having a flat edge, flat edges in orange:
  // the direct check of whether those edges really are straight.
  if (flatPieces.length) {
    const T = 220, per = 6, sheet = new cv.Mat(T * Math.ceil(flatPieces.length / per), T * per, cv.CV_8UC4, new cv.Scalar(40, 40, 40, 255));
    const clean = new cv.Mat(img.h, img.w, cv.CV_8UC4); clean.data.set(img.data);
    flatPieces.forEach((t1, i) => {
      const xs = t1.corners.map((c) => c[0]), ys = t1.corners.map((c) => c[1]);
      const m = (Math.max(...xs) - Math.min(...xs)) * 0.45;
      const x0 = Math.max(0, Math.floor(Math.min(...xs) - m)), y0 = Math.max(0, Math.floor(Math.min(...ys) - m));
      const x1 = Math.min(img.w, Math.ceil(Math.max(...xs) + m)), y1 = Math.min(img.h, Math.ceil(Math.max(...ys) + m));
      const roi = clean.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0)), tile0 = roi.clone();
      for (let e = 0; e < 4; e++) {
        const a = t1.corners[e], c = t1.corners[(e + 1) % 4];
        cv.line(tile0, new cv.Point(Math.round(a[0] - x0), Math.round(a[1] - y0)), new cv.Point(Math.round(c[0] - x0), Math.round(c[1] - y0)), t1.flats[e] ? new cv.Scalar(255, 140, 0, 255) : new cv.Scalar(0, 220, 0, 255), t1.flats[e] ? 3 : 1);
      }
      const s = T / Math.max(tile0.cols, tile0.rows), tile = new cv.Mat();
      cv.resize(tile0, tile, new cv.Size(Math.round(tile0.cols * s), Math.round(tile0.rows * s)));
      const dst = sheet.roi(new cv.Rect((i % per) * T, Math.floor(i / per) * T, tile.cols, tile.rows)); tile.copyTo(dst);
      [roi, tile0, tile, dst].forEach((q) => q.delete());
    });
    writeJpg(path.join(__dirname, 'out', base + '-flats.jpg'), sheet.cols, sheet.rows, sheet.data);
    clean.delete(); sheet.delete();
  }
  // contact sheet of failures (from the original photo)
  if (fails.length) {
    const T = 200, per = 6, sheet = new cv.Mat(T * Math.ceil(fails.length / per), T * per, cv.CV_8UC4, new cv.Scalar(40, 40, 40, 255));
    const orig = new cv.Mat(img.h, img.w, cv.CV_8UC4); orig.data.set(img.data);
    fails.forEach(([x, y, w, h], i) => {
      const m = Math.round(Math.max(w, h) * 0.15);
      const r = new cv.Rect(Math.max(0, x - m), Math.max(0, y - m), Math.min(img.w - Math.max(0, x - m), w + 2 * m), Math.min(img.h - Math.max(0, y - m), h + 2 * m));
      const roi = orig.roi(r), tile = new cv.Mat();
      const s = T / Math.max(r.width, r.height);
      cv.resize(roi, tile, new cv.Size(Math.max(1, Math.round(r.width * s)), Math.max(1, Math.round(r.height * s))));
      const dst = sheet.roi(new cv.Rect((i % per) * T, Math.floor(i / per) * T, tile.cols, tile.rows));
      tile.copyTo(dst);
      [roi, tile, dst].forEach((q) => q.delete());
    });
    writeJpg(path.join(__dirname, 'out', base + '-fails.jpg'), sheet.cols, sheet.rows, sheet.data);
    orig.delete(); sheet.delete();
  }
})();
