/* PH.dilateDisc gives exactly cv.dilate's pixels (v0.23.3).
 * A read limits its piece to the split's outline grown by ~3% of the crop
 * (a 25-35 px disc); OpenCV's dilation of that was a quarter of a read's
 * time. dilateDisc grows each row's runs instead - it must change nothing:
 *  - random filled outlines (pieces, slivers, several blobs, touching the
 *    crop's border), radii 1-40: every pixel equal to cv.dilate's;
 *  - erodeDisc likewise equal to cv.erode (the seam check's ~50 px erosion);
 *  - and faster than cv.dilate at the read's radii.
 * Run: node test/dilate-disc.js   (a few seconds)
 */
'use strict';
globalThis.self = globalThis;
require('./lib/vision')();
const PH = globalThis.PH;

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const blob = (m, cx, cy, R, n) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n, rr = R * (0.55 + 0.6 * rnd());
      pts.push(Math.round(cx + rr * Math.cos(a)), Math.round(cy + rr * Math.sin(a)));
    }
    const pm = cv.matFromArray(n, 1, cv.CV_32SC2, pts), mv = new cv.MatVector(); mv.push_back(pm);
    cv.fillPoly(m, mv, new cv.Scalar(255));
    pm.delete(); mv.delete();
  };
  let cases = 0, bad = 0, worst = '', ebad = 0, eworst = '';
  let tCv = 0, tJs = 0;
  for (let t = 0; t < 120; t++) {
    const w = 40 + Math.floor(rnd() * 460), h = 40 + Math.floor(rnd() * 460);
    const m = cv.Mat.zeros(h, w, cv.CV_8UC1);
    const nb = 1 + Math.floor(rnd() * 3);
    for (let b = 0; b < nb; b++) blob(m, rnd() * w, rnd() * h, (0.15 + 0.4 * rnd()) * Math.min(w, h), 6 + Math.floor(rnd() * 60));
    if (t % 7 === 0) cv.line(m, new cv.Point(0, 0), new cv.Point(w - 1, Math.floor(h / 2)), new cv.Scalar(255), 1); // a 1 px sliver
    const r = t < 100 ? 1 + Math.floor(rnd() * 40) : 12 + Math.floor(rnd() * 6);
    const a = m.clone(), b = m.clone(), ea = m.clone(), eb = m.clone();
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * r + 1, 2 * r + 1));
    let t0 = performance.now(); cv.dilate(a, a, k); const dc = performance.now() - t0;
    t0 = performance.now(); PH.dilateDisc(b, r); const dj = performance.now() - t0;
    if (t >= 100) { tCv += dc; tJs += dj; }
    cv.erode(ea, ea, k); PH.erodeDisc(eb, r);
    let diff = 0, ediff = 0;
    for (let i = 0; i < a.data.length; i++) { if (a.data[i] !== b.data[i]) diff++; if (ea.data[i] !== eb.data[i]) ediff++; }
    cases++; if (diff) { bad++; worst = worst || `${w}x${h} r ${r}: ${diff} px differ`; }
    if (ediff) { ebad++; eworst = eworst || `${w}x${h} r ${r}: ${ediff} px differ`; }
    [m, a, b, ea, eb, k].forEach((x) => x.delete());
  }
  check('dilateDisc = cv.dilate, pixel for pixel', bad === 0, `${cases - bad}/${cases} masks identical${worst ? '; ' + worst : ''}`);
  check('erodeDisc = cv.erode, pixel for pixel', ebad === 0, `${cases - ebad}/${cases} masks identical${eworst ? '; ' + eworst : ''}`);
  check('faster than cv.dilate at the read\'s radii (12-17 px)', tJs < tCv, `${(tJs / 20).toFixed(2)} vs ${(tCv / 20).toFixed(2)} ms a mask`);
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
