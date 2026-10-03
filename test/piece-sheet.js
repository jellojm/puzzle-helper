/* Contact sheet of catalogued pieces from a real photo with corners and edge types
 * (green = tab, magenta = blank, yellow = flat). Usage: node test/piece-sheet.js pieces-5 -> test/out/t1sheet.jpg */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
const { readImage, writeJpg } = require('./imageio');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;
(async () => {
  let cv = require('@techstark/opencv-js'); if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r)); PH.cv = cv;
  const bi = readImage('test/fixtures/chickens-box.jpg');
  const box = PH.createBox(bi, PH.detectBoxCorners(bi), { pieces: 1000 });
  const eng = new PH.Engine(); eng.setBox(box);
  if (process.env.TAUGHT) {
    const t = readImage(process.env.TAUGHT_FROM);
    for (const xy of process.env.TAUGHT.split(';')) {
      const [x, y] = xy.split(',').map(Number); const patch = new Uint8ClampedArray(81 * 4); let k = 0;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const i = ((y + dy) * t.w + x + dx) * 4; patch.set(t.data.subarray(i, i + 4), 4 * k++); }
      const L = PH.rgbaToLab(patch, 81, 1); const m = (c) => PH.median(Array.from({ length: 81 }, (_, j) => L[3 * j + c]));
      eng.teachBackground({ L: m(0), a: m(1), b: m(2) });
    }
  }
  const img = readImage(`test/fixtures/${process.argv[2] || 'pieces-5'}.jpg`);
  const mat = new cv.Mat(img.h, img.w, cv.CV_8UC4); mat.data.set(img.data);
  eng.processSnap(S.matSource(cv, mat));
  const pick = process.env.PICK ? process.env.PICK.split(',').map(Number) : null;
  const ps = [...eng.pieces.values()].filter((p) => p.t1).filter((p, i) => !pick || pick.includes(i)).slice(0, 24);
  const T = +(process.env.SIZE || 160), cols = +(process.env.COLS || 6), sheet = new cv.Mat(Math.ceil(ps.length / cols) * T, cols * T, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 255));
  ps.forEach((p, i) => {
    const cs = p.t1.corners;
    const cx = cs.reduce((s, c) => s + c[0], 0) / 4, cy = cs.reduce((s, c) => s + c[1], 0) / 4;
    const R = p.t1.meanSide * 1.0;
    const x0 = Math.max(0, Math.round(cx - R)), y0 = Math.max(0, Math.round(cy - R));
    const w = Math.min(img.w - x0, Math.round(2 * R)), h = Math.min(img.h - y0, Math.round(2 * R));
    const crop = mat.roi(new cv.Rect(x0, y0, w, h)).clone();
    const col = { T: [0, 255, 0, 255], B: [255, 0, 255, 255], F: [255, 255, 0, 255] };
    for (let e = 0; e < 4; e++) {
      const a = cs[e], b = cs[(e + 1) % 4], sig = p.t1.edges[e].sig, dx = b[0] - a[0], dy = b[1] - a[1];
      for (let k = 0; k + 2 < sig.length; k += 2) {
        const P1 = [a[0] + sig[k] * dx + sig[k + 1] * dy - x0, a[1] + sig[k] * dy - sig[k + 1] * dx - y0];
        const P2 = [a[0] + sig[k + 2] * dx + sig[k + 3] * dy - x0, a[1] + sig[k + 2] * dy - sig[k + 3] * dx - y0];
        cv.line(crop, new cv.Point(P1[0], P1[1]), new cv.Point(P2[0], P2[1]), new cv.Scalar(...col[p.t1.edges[e].type]), 2);
      }
      cv.circle(crop, new cv.Point(a[0] - x0, a[1] - y0), 4, new cv.Scalar(255, 0, 0, 255), -1);
      cv.putText(crop, String(e), new cv.Point(a[0] - x0 + 4, a[1] - y0 - 4), cv.FONT_HERSHEY_SIMPLEX, 0.9, new cv.Scalar(255, 0, 0, 255), 2);
    }
    const t = new cv.Mat(); cv.resize(crop, t, new cv.Size(T, T));
    t.copyTo(sheet.roi(new cv.Rect((i % cols) * T, Math.floor(i / cols) * T, T, T)));
    cv.putText(sheet, p.t1.code, new cv.Point((i % cols) * T + 4, Math.floor(i / cols) * T + 16), cv.FONT_HERSHEY_SIMPLEX, 0.5, new cv.Scalar(255, 255, 0, 255), 1);
    crop.delete(); t.delete();
  });
  writeJpg(`test/out/t1sheet-${process.argv[2] || 'pieces-5'}.jpg`, sheet.cols, sheet.rows, sheet.data);
})();
