/* Which clock the engine's time budgets run on (performance.now), for tests.
 *   CLOCK=wall     the real clock (default): results depend on the machine
 *                  and on whatever else runs on it;
 *   CLOCK=cpu      this process's CPU time: other work on the machine (other
 *                  agents' tests) barely changes the result;
 *   CLOCK=step     every reading advances 0.02 ms: fully repeatable, but
 *                  budgets and waits no longer mean anything (logic checks);
 *   CLOCK=model[:k] a virtual clock that moves only by a fixed cost per heavy
 *                  step - each segmentation pass and each shape read, sized
 *                  from the phone's own reports (k scales them: 0.5 = a phone
 *                  twice as fast) - and, between frames, to the frame's time
 *                  (frameAt). Fully repeatable whatever else runs on the
 *                  machine, and paced like the phone.
 * Installed once, before the engine loads (test/lib/vision.js does it).
 */
'use strict';
let installed = null, V = 0, scale = 1, lastFrame = null;
const EPS = 0.0005; // ms per reading, so a loop that waits on the clock still ends
exports.install = function (mode) {
  if (installed) return installed;
  mode = (mode || 'wall').toLowerCase();
  const [kind, arg] = mode.split(':');
  installed = kind;
  if (kind === 'cpu') {
    const c0 = process.cpuUsage();
    performance.now = () => { const u = process.cpuUsage(c0); return (u.user + u.system) / 1000; };
  } else if (kind === 'step') {
    let t = 0;
    performance.now = () => (t += 0.02);
  } else if (kind === 'model') {
    scale = arg ? +arg : 1;
    performance.now = () => (V += EPS);
  } else if (kind !== 'wall') throw new Error('CLOCK=' + mode + ': use wall, cpu, step or model[:k]');
  return kind;
};
exports.mode = () => installed || 'wall';
/** model clock: a heavy step costs ms (phone ms, before scaling). */
exports.charge = (ms) => { if (installed === 'model') V += ms * scale; };
/** model clock: a new frame arrives at time tMs (video time); without one,
 *  frames come every PHONE.frameMs after the last frame's start. */
exports.frameAt = (tMs) => {
  if (installed !== 'model') return;
  const t = tMs === undefined ? (lastFrame === null ? V : lastFrame + PHONE.frameMs) : tMs;
  V = Math.max(V, t); lastFrame = V;
};
// Phone costs (iPhone XR, reports 2026-10-07 03-30-35 / 03-37-08): a
// segmentation pass ~75-115 ms for a 640x480 processing image, of which ~35
// ms is getting the pixels; a shape read ~130-210 ms for a ~350 px piece
// (a ~480x480 crop); frames every ~170-280 ms.
// v0.23.3: reads cost ~0.41 of what those reports showed (the phone's SIMD
// OpenCV build in node, the owner's photos: 25.3 -> 10.3 ms a read) - no
// unused whole-crop Laplacian, and the large dilation / erosion of a read
// done by rows of runs (PH.dilateDisc), the same pixels.
// Segmentation ~0.8 (same measure, a live frame: 45 -> 36 ms; medians of
// Lab bytes counted instead of sorted).
// MODEL_READ=<k> / MODEL_SEG=<k> scale the read / segmentation cost (2.44 /
// 1.25 = the engine before v0.23.3).
const PHONE = {
  segPerPx: 0.8 * 85 / (640 * 480) * (+process.env.MODEL_SEG || 1),
  readPerPx: 0.41 * 170 / (480 * 480) * (+process.env.MODEL_READ || 1),
  frameMs: 200,
};
exports.PHONE = PHONE;
/** Wrap the engine's heavy steps so the model clock charges for them. */
exports.hook = function (PH) {
  if (installed !== 'model' || PH.__clockHooked) return;
  PH.__clockHooked = true;
  const seg = PH.segment;
  PH.segment = function (proc, o) { exports.charge(PHONE.segPerPx * proc.w * proc.h); return seg.apply(this, arguments); };
  const read = PH.analyzePiece;
  PH.analyzePiece = function (crop) {
    const r0 = PH.readRetries || 0;
    exports.charge(PHONE.readPerPx * crop.w * crop.h);
    const out = read.apply(this, arguments);
    if ((PH.readRetries || 0) > r0) exports.charge(PHONE.readPerPx * crop.w * crop.h); // (a retried read is a second read)
    return out;
  };
  const pf = PH.Engine.prototype.processFrame;
  PH.Engine.prototype.processFrame = function () { if (!this.__clockFrame) exports.frameAt(); this.__clockFrame = false; return pf.apply(this, arguments); };
  // a test that knows the frame's time calls frameAt(t) itself, then marks it
  exports.frameAtFor = (eng, tMs) => { exports.frameAt(tMs); eng.__clockFrame = true; };
};
exports.frameAtFor = () => {};
