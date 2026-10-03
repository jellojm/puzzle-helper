/* Does the thumbnail motion tracker (js/vision/flow.js) recover a known camera
 * shift, and how long does it take? Frames come from the synthetic table so
 * the true shift is exact. Run: node test/flow-lab.js */
'use strict';
const path = require('path');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'flow']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 3 });
  const scat = S.scatter(cv, P, { scale: 2.2, seed: 5 });
  const FW = 1280, FH = 720, zoom = 1.5;
  const TW = 64, TH = 36; // thumbnail: 64 px wide, 2304 px total

  // Camera frame -> thumbnail grayscale (what the page would do with drawImage).
  const thumb = (cx, cy, phi) => {
    const fr = S.cameraFrame(cv, scat.table, cx, cy, phi, zoom, FW, FH);
    const small = new cv.Mat();
    cv.resize(fr, small, new cv.Size(TW, TH), 0, 0, cv.INTER_AREA);
    const g = PH.flowGray(small.data, TW, TH);
    fr.delete(); small.delete();
    return g;
  };
  // A move of (mx, my) table px in the camera's view at this zoom is mx*zoom
  // frame px, i.e. mx*zoom*TW/FW thumbnail px — the camera moves the other way
  // from the content, hence the sign.
  const toThumb = (m) => -m * zoom * TW / FW;

  const cx0 = scat.TW / 2, cy0 = scat.TH / 2;
  const base = thumb(cx0, cy0, 0);
  const cases = [[0, 0], [20, 0], [0, -30], [45, 25], [-60, 40], [100, -70]];
  let worst = 0, ms = 0, n = 0;
  for (const [mx, my] of cases) {
    const cur = thumb(cx0 + mx, cy0 + my, 0.01);
    const t0 = process.hrtime.bigint();
    const r = PH.flowShift(base, cur, TW, TH);
    ms += Number(process.hrtime.bigint() - t0) / 1e6; n++;
    const ex = toThumb(mx), ey = toThumb(my);
    const err = Math.hypot(r.dx - ex, r.dy - ey);
    worst = Math.max(worst, err);
    console.log(`move (${mx},${my}) table px -> expected (${ex.toFixed(2)},${ey.toFixed(2)}) got (${r.dx.toFixed(2)},${r.dy.toFixed(2)}) err ${err.toFixed(2)} thumb px, conf ${r.conf.toFixed(2)}`);
  }
  const frameErr = worst * FW / TW; // thumbnail px -> camera frame px
  check('tracker recovers camera shifts', worst < 0.75, `worst error ${worst.toFixed(2)} thumbnail px ≈ ${frameErr.toFixed(0)} px in a ${FW}-wide frame`);
  check('tracker is cheap enough for every display frame', ms / n < 2, `${(ms / n).toFixed(2)} ms per call on this machine`);
  // Featureless input must report low confidence rather than a random shift.
  const flat = new Float32Array(TW * TH);
  const r0 = PH.flowShift(flat, flat, TW, TH);
  check('featureless frames give zero confidence', r0.conf === 0 && r0.dx === 0 && r0.dy === 0, JSON.stringify(r0));
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
