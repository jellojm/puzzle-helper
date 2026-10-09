/* Lens angle measured by tilting the phone (More -> Measure lens angle;
 * PH.fovFromSeries). Owner, 2026-10-09: "the angle in the settings seems
 * incorrect" - the one measurement in the reports read 98.9 deg (an XR's 1x
 * camera is ~67 deg across the long side). The old method took the median of
 * single tracker steps: a shift of a pixel or two of the 96 px thumbnail
 * (~20 video px each) over one instant gyro rate.
 *
 * Simulated run: the phone tilts back and forth, then side to side, over
 * 6 s (gyro events at 60 Hz with noise; tracker steps at ~30 Hz, the shift
 * rounded to whole thumbnail pixels as the tracker reports it, and losing
 * some of fast motion as it lags). Run: node test/fov-measure.js
 */
'use strict';
const PH = require('./lib/vision')();

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };

function simulate(fovTrue, seed, opts) {
  opts = opts || {};
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const L = 1920, f = L / 2 / Math.tan((fovTrue * Math.PI) / 360), thumbPx = L / 96;
  const series = [], old = [];
  let ab = 0, ag = 0, tb = 0, tg = 0, lastT = 0, tStep = 0, last = null;
  for (let t = 0; t <= 6000; t += 1000 / 60) {
    // true turn rate: forward/back for 3 s, then side to side (deg/s)
    const amp = opts.amp || 40, w = 2 * Math.PI * 0.8;
    const rb = t < 3000 ? amp * Math.sin((w * t) / 1000) : 0, rg = t >= 3000 ? amp * Math.sin((w * t) / 1000) : 0;
    const dt = (t - lastT) / 1000; lastT = t;
    tb += rb * dt; tg += rg * dt; // the phone's true angles
    const nb = rb + (rnd() - 0.5) * 6, ng = rg + (rnd() - 0.5) * 6; // gyro noise
    ab += nb * dt; ag += ng * dt;
    if (t - tStep >= 1000 / 30) {
      tStep = t;
      // picture shift = f * tan(angle); the tracker loses a little of fast
      // motion (lag) and reports whole thumbnail pixels
      const lag = opts.lag === undefined ? 1 : opts.lag;
      const sy = Math.round((f * Math.tan((tb * Math.PI) / 180) * lag) / thumbPx) * thumbPx;
      const sx = Math.round((-f * Math.tan((tg * Math.PI) / 180) * lag) / thumbPx) * thumbPx; // (opposite sign on this axis)
      const smp = { t, sx, sy, ab, ag, seg: '0' };
      series.push(smp);
      // the old method: one step's shift over the instant rate x step time
      if (last) {
        const b = Math.abs(nb), g = Math.abs(ng), sdt = (t - last.t) / 1000;
        const [wv, d] = b > 2 * g ? [b, Math.abs(sy - last.sy)] : g > 2 * b ? [g, Math.abs(sx - last.sx)] : [0, 0];
        const ang = (wv * sdt * Math.PI) / 180;
        if (wv >= 15 && d >= 2 && ang > 0) old.push(d / Math.tan(ang));
      }
      last = smp;
    }
  }
  const est = PH.fovFromSeries(series, L);
  old.sort((a, b) => a - b);
  const fovOld = old.length ? (2 * Math.atan(L / 2 / old[old.length >> 1]) * 180) / Math.PI : null;
  return { est, fovOld, nOld: old.length };
}

const errs = [], olds = [];
for (const fov of [60, 67, 75]) for (const seed of [1, 2, 3]) for (const amp of [25, 40, 70]) {
  const r = simulate(fov, seed * 7 + amp, { amp });
  errs.push(r.est ? Math.abs(r.est.fov - fov) : Infinity);
  olds.push(r.fovOld ? Math.abs(r.fovOld - fov) : Infinity);
}
errs.sort((a, b) => a - b); olds.sort((a, b) => a - b);
const med = (a) => a[a.length >> 1], worst = (a) => a[a.length - 1];
console.log(`27 simulated runs (60/67/75 deg, slow to fast tilts): new error median ${med(errs).toFixed(1)} deg, worst ${worst(errs).toFixed(1)}; old method median ${med(olds).toFixed(1)}, worst ${worst(olds).toFixed(1)}`);
check('the lens angle is measured within 3 deg (median)', med(errs) <= 3, `${med(errs).toFixed(1)} deg`);
check('and within 6 deg on every run', worst(errs) <= 6, `${worst(errs).toFixed(1)} deg`);
check('better than the old step-by-step median', med(errs) < med(olds), `${med(errs).toFixed(1)} vs ${med(olds).toFixed(1)}`);
const still = simulate(67, 5, { amp: 0.5 });
check('no answer from a phone held still', !still.est, still.est ? JSON.stringify(still.est) : 'null');
console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
