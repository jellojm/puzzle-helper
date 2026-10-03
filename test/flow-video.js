/* Run the thumbnail motion tracker over frames pulled from a real phone video.
 * There is no ground truth, so it checks what can be checked: the shift over
 * two steps must equal the sum of the two single steps (transitivity), the
 * confidence must be high while the camera is over pieces, and each call must
 * be cheap. Prints the per-step track so a human can sanity-check it against
 * the video.
 *
 * Usage: node test/flow-video.js <dir of fNNNN.jpg frames> [--thumb=96]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { readImage } = require('./imageio');
globalThis.self = globalThis;
for (const f of ['core', 'flow']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const THUMB = +((args.find((a) => a.startsWith('--thumb=')) || '').slice(8)) || 96;
if (!dir) { console.log('usage: node test/flow-video.js <dir>'); process.exit(2); }
const files = fs.readdirSync(dir).filter((f) => /^f\d+\.jpg$/.test(f)).sort();
let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

const grays = [];
let w = 0, h = 0;
for (const f of files) {
  const im = readImage(path.join(dir, f), THUMB);
  w = im.w; h = im.h;
  grays.push(PH.flowGray(im.data, w, h));
}
console.log(`${files.length} frames, thumbnails ${w}x${h}`);
const range = Math.round(Math.max(w, h) / 6);
let ms = 0, n = 0;
const steps = [];
for (let i = 1; i < grays.length; i++) {
  const t0 = process.hrtime.bigint();
  const r = PH.flowShift(grays[i - 1], grays[i], w, h, { range });
  ms += Number(process.hrtime.bigint() - t0) / 1e6; n++;
  steps.push(r);
}
// Transitivity on every 3rd triplet where both single steps were confident.
let tested = 0, bad = 0, worst = 0;
for (let i = 2; i < grays.length; i += 3) {
  const a = steps[i - 2], b = steps[i - 1]; // steps[k] = grays[k] -> grays[k+1]
  if (a.conf < 0.3 || b.conf < 0.3) continue;
  const ac = PH.flowShift(grays[i - 2], grays[i], w, h, { range: range * 2 });
  const err = Math.hypot(ac.dx - (a.dx + b.dx), ac.dy - (a.dy + b.dy));
  tested++; worst = Math.max(worst, err);
  if (err > 1.0) bad++;
}
const confident = steps.filter((s) => s.conf >= 0.3).length;
const moving = steps.filter((s) => Math.hypot(s.dx, s.dy) > 0.5).length;
console.log(`steps: ${steps.length}, confident ${confident}, moving ${moving}; per call ${(ms / n).toFixed(2)} ms`);
console.log('first 40 steps (dx,dy,conf):', steps.slice(0, 40).map((s) => `${s.dx.toFixed(1)},${s.dy.toFixed(1)},${s.conf.toFixed(2)}`).join(' | '));
check('two single steps add up to the double step', tested > 0 && bad / tested < 0.15, `${bad}/${tested} triplets off by >1 thumbnail px (worst ${worst.toFixed(2)})`);
check('tracker is confident over most of the video', confident / steps.length > 0.6, `${confident}/${steps.length}`);
check('cheap per call', ms / n < 3, `${(ms / n).toFixed(2)} ms`);
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
