/* Pointed check of "marks follow the camera": the thumbnail tracker
 * (js/vision/flow.js) measures how far the camera image moved after a frame
 * was analysed, and overlay.js frameMapping(..., shift) moves that frame's
 * marks by it. Here the camera pans over the synthetic table; marks computed
 * from the FIRST frame, shifted by the tracker, must land on the pieces where
 * they are in the LAST frame. Also checks tap hit-testing (toFrame) inverts
 * toScreen with a shift, untilted and tilted.
 * Run: node test/flow-overlay.js   (a few seconds)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'flow']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  // overlay.js is an ES module in a CommonJS package: load it from a data: URL.
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'overlay.js'), 'utf8');
  const { frameMapping } = await import('data:text/javascript,' + encodeURIComponent(src));

  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 3 });
  const scat = S.scatter(cv, P, { scale: 2.2, seed: 5 });

  // Portrait phone camera, as on the owner's iPhone, shown full-screen (cover).
  const FW = 720, FH = 1280, zoom = 1.4;
  const canvas = { clientWidth: 414, clientHeight: 848 };
  const procScale = 640 / FH; // live analysis width 640 on the long side
  const TMAX = 96;            // same thumbnail size as main.js
  const tw = Math.round(FW * TMAX / FH), th = TMAX, tscale = FW / tw;

  // Where table point (X, Y) appears in a camera frame centred on (cx, cy):
  // synth.cameraFrame with phi = 0 is a pure zoom about the frame centre.
  const toFrame = (X, Y, cx, cy) => [(X - cx) * zoom + FW / 2, (Y - cy) * zoom + FH / 2];
  const thumb = (cx, cy) => {
    const fr = S.cameraFrame(cv, scat.table, cx, cy, 0, zoom, FW, FH);
    const small = new cv.Mat();
    cv.resize(fr, small, new cv.Size(tw, th), 0, 0, cv.INTER_AREA);
    const g = PH.flowGray(small.data, tw, th);
    fr.delete(); small.delete();
    return g;
  };

  // A slow diagonal hand sweep: 12 steps at ~30 Hz after the analysed frame,
  // driven through PH.FlowTracker exactly as main.js does: push every step,
  // mark() at the grab, shift = total now - total at the grab.
  const c0 = [scat.TW * 0.45, scat.TH * 0.45], step = [5, 3.5];
  const T = new PH.FlowTracker(tw, th);
  T.push(thumb(c0[0] - step[0], c0[1] - step[1])); // tracker already running
  T.push(thumb(c0[0], c0[1]));
  T.mark();                                         // frame grabbed for analysis
  const base = T.total.slice();
  const N = 12;
  const t0 = process.hrtime.bigint();
  for (let i = 1; i <= N; i++) T.push(thumb(c0[0] + step[0] * i, c0[1] + step[1] * i));
  const pushMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  const low = T.lowConf;
  const c1 = [c0[0] + step[0] * N, c0[1] + step[1] * N];
  const shift = { dx: (T.total[0] - base[0]) * tscale, dy: (T.total[1] - base[1]) * tscale };
  const trueShift = { dx: -step[0] * N * zoom, dy: -step[1] * N * zoom };
  console.log(`camera moved ${(step[0] * N).toFixed(0)},${(step[1] * N).toFixed(0)} table px; image shift true (${trueShift.dx.toFixed(1)},${trueShift.dy.toFixed(1)}) measured (${shift.dx.toFixed(1)},${shift.dy.toFixed(1)}) frame px; ${low} low-confidence steps, ${T.rekeys} re-keys; ${pushMs.toFixed(2)} ms per push incl. thumbnail render`);

  // Fake analysis result for the FIRST frame: pieces at their proc-px positions.
  const res = { frameW: FW, frameH: FH, scale: procScale, rect: null };
  const M0 = frameMapping(null, canvas, res, null);          // marks as drawn without following
  const Mf = frameMapping(null, canvas, res, shift);         // marks shifted by the tracker
  const Mtrue = frameMapping(null, canvas, res, null);        // for the last frame's true positions
  let errFollow = 0, errStatic = 0, n = 0;
  for (const g of scat.gt) {
    const a = toFrame(g.x, g.y, c0[0], c0[1]), b = toFrame(g.x, g.y, c1[0], c1[1]);
    const inA = a[0] > 0 && a[1] > 0 && a[0] < FW && a[1] < FH, inB = b[0] > 0 && b[1] > 0 && b[0] < FW && b[1] < FH;
    if (!inA || !inB) continue;
    const p = [a[0] * procScale, a[1] * procScale];
    const want = Mtrue.toScreen(b[0] * procScale, b[1] * procScale);
    const got = Mf.toScreen(p[0], p[1]), stale = M0.toScreen(p[0], p[1]);
    errFollow = Math.max(errFollow, Math.hypot(got[0] - want[0], got[1] - want[1]));
    errStatic = Math.max(errStatic, Math.hypot(stale[0] - want[0], stale[1] - want[1]));
    n++;
  }
  check('tracker trusted every step of a slow sweep', low === 0, `${low}/${N} steps below confidence`);
  check('followed marks land on the pieces in the newer frame', n > 5 && errFollow < 3, `worst ${errFollow.toFixed(2)} css px over ${n} pieces (not following: ${errStatic.toFixed(1)} px)`);
  check('following is a real improvement', errStatic > 4 * Math.max(errFollow, 0.5), `${errStatic.toFixed(1)} -> ${errFollow.toFixed(2)} px`);

  // Tap hit-testing: toFrame must invert toScreen when a shift is applied.
  let inv = 0;
  for (const [x, y] of [[100, 200], [300, 600], [12, 840]]) {
    const q = Mf.toFrame(...Mf.toScreen(x, y));
    inv = Math.max(inv, Math.hypot(q[0] - x, q[1] - y));
  }
  // Tilted path: a mild homography (and its inverse) from rectify-style H.
  const a = 0.12, H = [1, 0.05, 3, -0.02, 1, 2, a / FW, 0.0001, 1];
  const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const d = det(H);
  const Hinv = [
    (H[4] * H[8] - H[5] * H[7]) / d, (H[2] * H[7] - H[1] * H[8]) / d, (H[1] * H[5] - H[2] * H[4]) / d,
    (H[5] * H[6] - H[3] * H[8]) / d, (H[0] * H[8] - H[2] * H[6]) / d, (H[2] * H[3] - H[0] * H[5]) / d,
    (H[3] * H[7] - H[4] * H[6]) / d, (H[1] * H[6] - H[0] * H[7]) / d, (H[0] * H[4] - H[1] * H[3]) / d,
  ];
  const Mt = frameMapping(null, canvas, Object.assign({}, res, { rect: { H, Hinv } }), shift);
  const Mt0 = frameMapping(null, canvas, Object.assign({}, res, { rect: { H, Hinv } }), null);
  let invT = 0, offT = 0;
  for (const [x, y] of [[100, 200], [300, 600], [200, 400]]) {
    const sp = Mt.toScreen(x, y), q = Mt.toFrame(...sp), s0 = Mt0.toScreen(x, y);
    invT = Math.max(invT, Math.hypot(q[0] - x, q[1] - y));
    // the shift is a pure screen-space translation on the tilted path too
    const k = Math.max(canvas.clientWidth / FW, canvas.clientHeight / FH);
    offT = Math.max(offT, Math.hypot(sp[0] - s0[0] - shift.dx * k, sp[1] - s0[1] - shift.dy * k));
  }
  check('tap hit-testing inverts the shifted mapping', inv < 1e-6 && invT < 1e-6, `untilted ${inv.toExponential(1)}, tilted ${invT.toExponential(1)} proc px`);
  check('shift is a pure screen translation with tilt correction', offT < 1e-6, offT.toExponential(1));

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
