/* Pointed check of the tilt-corrected (straightened) processing image.
 *  - Same bytes as the reference implementation (the per-pixel JS loop it
 *    replaced, kept below), at several tilts, rolls and both orientations:
 *    the off-camera corners get alpha 0, everything else is unchanged.
 *  - Prints the time per frame for both (node is much faster than the
 *    phone, where the JS loop cost up to ~90 ms; compare the ratio).
 * Run: node test/rectify-proc.js   (a few seconds)
 */
'use strict';
const path = require('path');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'rectify']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

// Reference: the straightened processing image as it was built before
// (per-pixel JS loop marking the invalid corners).
function referenceProc(cv, base, rect, maxW) {
  const mul3 = (A, B) => { const C = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[3 * i + j] += A[3 * i + k] * B[3 * k + j]; return C; };
  const scale = Math.min(1, maxW / Math.max(rect.w, rect.h));
  const ow = Math.round(rect.w * scale), oh = Math.round(rect.h * scale);
  const srcImg = base.getProc(Math.min(Math.max(base.w, base.h), maxW * 1.3));
  const si = srcImg.scale;
  const M = mul3([scale, 0, 0, 0, scale, 0, 0, 0, 1], mul3(rect.H, [1 / si, 0, 0, 0, 1 / si, 0, 0, 0, 1]));
  const src = new cv.Mat(srcImg.h, srcImg.w, cv.CV_8UC4); src.data.set(srcImg.data);
  const m = cv.matFromArray(3, 3, cv.CV_64F, M), dst = new cv.Mat();
  cv.warpPerspective(src, dst, m, new cv.Size(ow, oh), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
  const out = { w: ow, h: oh, data: new Uint8ClampedArray(dst.data), scale };
  const ones = new cv.Mat(srcImg.h, srcImg.w, cv.CV_8UC1, new cv.Scalar(255)), valid = new cv.Mat();
  cv.warpPerspective(ones, valid, m, new cv.Size(ow, oh), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  cv.erode(valid, valid, k);
  let invalid = 0;
  for (let p = 0; p < ow * oh; p++) if (!valid.data[p]) { out.data[4 * p + 3] = 0; invalid++; }
  out.invalid = invalid > 0;
  [src, m, dst, ones, valid, k].forEach((x) => x.delete());
  return out;
}

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 3 });
  const scat = S.scatter(cv, P, { scale: 2.2, seed: 5 });
  let worst = 0, cases = 0, flagsOk = true, anyInvalid = false, tRef = 0, tNew = 0;
  for (const [FW, FH] of [[1920, 1080], [1080, 1920]]) {
    const fr = S.cameraFrame(cv, scat.table, scat.TW / 2, scat.TH / 2, 0, 1, FW, FH);
    const base = S.matSource(cv, fr);
    for (const [pitch, roll] of [[10, 0], [25, 5], [35, -10], [45, 20], [60, 0]]) {
      const down = PH.downFromAngles(pitch, roll);
      const rect = PH.tiltHomography(FW, FH, PH.focalPx(FW, FH, 66), down, 3);
      if (!rect) continue;
      const rs = PH.rectifiedSource(base, rect);
      let a, b;
      for (let rep = 0; rep < 5; rep++) {
        let t = process.hrtime.bigint(); a = referenceProc(cv, base, rect, 640); tRef += Number(process.hrtime.bigint() - t) / 1e6;
        t = process.hrtime.bigint(); b = rs.getProc(640); tNew += Number(process.hrtime.bigint() - t) / 1e6;
      }
      cases++;
      if (a.w !== b.w || a.h !== b.h || a.scale !== b.scale) { worst = Infinity; continue; }
      let diff = 0;
      for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) diff++;
      worst = Math.max(worst, diff);
      if (a.invalid !== b.invalid) flagsOk = false;
      anyInvalid = anyInvalid || a.invalid;
    }
    fr.delete();
  }
  check('straightened image identical to the reference', cases >= 8 && worst === 0, `${cases} tilts, worst ${worst} differing bytes`);
  check('off-camera corners flagged the same', flagsOk && anyInvalid);
  console.log(`time per tilted frame (node): reference ${(tRef / cases / 5).toFixed(2)} ms, now ${(tNew / cases / 5).toFixed(2)} ms`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
