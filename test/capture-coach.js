/* Pointed check of the capture coach and the advice it gives.
 *  - Pale pieces on a white board: half the detections barely differ from
 *    the board in colour, and few pieces read right. The coach must flag it
 *    (the page shows the tip at >= 30% over ~40 frames).
 *  - The advice works: the same pale pieces on a dark cloth all read right,
 *    and the coach stays quiet there and on a normal setup.
 * Run: node test/capture-coach.js   (about 30 seconds)
 */
'use strict';
const path = require('path');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const rotEq = (a, b) => { for (let r = 0; r < 4; r++) if (a === b.slice(r) + b.slice(0, r)) return true; return false; };
  const setups = { paleWhite: [[228, 226, 220], 0.22, 190], paleDark: [[40, 40, 46], 0.22, 190], normal: [[228, 226, 220], 0.93, 8] };
  const out = {};
  for (const [name, [felt, gain, offset]] of Object.entries(setups)) {
    const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 3 });
    const scat = S.scatter(cv, P, { scale: 2.2, seed: 5, felt, gain, offset, minSep: 0 });
    // live sweep: the coach's share of pieces that blend into the board
    const eng = new PH.Engine();
    const FW = 1920, FH = 1080, zoom = 1.5, vw = FW / zoom, vh = FH / zoom;
    let n = 0, low = 0;
    for (let y = vh / 2; y <= scat.TH - vh / 2 + 1; y += vh * 0.45) for (let x = vw / 2; x <= scat.TW - vw / 2 + 1; x += vw * 0.3) {
      const fr = S.cameraFrame(cv, scat.table, x, y, 0, zoom, FW, FH, felt);
      const o = eng.processFrame(S.matSource(cv, fr), { still: true });
      fr.delete();
      n += o.coach.n; low += o.coach.low;
    }
    // photo of the whole table: how many pieces read right (edge codes)
    const e2 = new PH.Engine();
    e2.processSnap(S.matSource(cv, scat.table));
    let right = 0;
    for (const p of e2.pieces.values()) {
      if (!p.t1) continue;
      const c = p.t1.corners, cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
      let g = null, bd = Infinity;
      for (const q of scat.gt) { const d = Math.hypot(q.x - cx, q.y - cy); if (d < bd) { bd = d; g = q; } }
      if (g && bd < scat.core * 0.3 && (rotEq(p.t1.code, g.code) || rotEq(p.t1.code, g.code.split('').reverse().join('')))) right++;
    }
    out[name] = { share: low / Math.max(1, n), n, right, total: scat.gt.length };
    scat.table.delete();
  }
  const f = (o) => `${Math.round(100 * o.share)}% of ${o.n} detections blend in; ${o.right}/${o.total} pieces read right`;
  check('pale pieces on a white board are flagged', out.paleWhite.share >= 0.3 && out.paleWhite.n >= 25, f(out.paleWhite));
  check('the advice works: on a dark cloth they read right', out.paleDark.right >= out.paleDark.total * 0.9 && out.paleWhite.right < out.paleWhite.total * 0.5, `dark: ${f(out.paleDark)}`);
  check('no tip on good setups', out.paleDark.share < 0.1 && out.normal.share < 0.1, `normal: ${f(out.normal)}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
