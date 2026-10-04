/* Pointed check: false edge pieces (owner, 2026-10-04).
 * Chunks cut out of an assembled section read as "edge pieces": their
 * straight side is a cut, and the seam between two real pieces runs through
 * their middle. PH.innerSeam must see that seam, and must not mistake print
 * (text, a drawn line with gaps) for one.
 * Run: node test/edge-verify.js   (a few seconds)
 */
'use strict';
const path = require('path');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const W = 140, H = 140, side = 100;
  // A pale "piece" (L ~ 215 with mild texture) inside a filled outline mask.
  const make = (draw) => {
    const img = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(215));
    const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
    for (let p = 0; p < W * H; p++) img.data[p] = 205 + Math.floor(rnd() * 20);
    if (draw) draw(img);
    const lab = new Uint8Array(W * H * 3);
    for (let p = 0; p < W * H; p++) { lab[3 * p] = img.data[p]; lab[3 * p + 1] = 128; lab[3 * p + 2] = 128; }
    img.delete();
    const mask = cv.Mat.zeros(H, W, cv.CV_8UC1);
    cv.rectangle(mask, new cv.Point(20, 20), new cv.Point(120, 120), new cv.Scalar(255), -1);
    const r = PH.innerSeam(lab, W, H, mask, side);
    mask.delete();
    return r;
  };
  const curve = (img, gaps) => { // a jigsaw-like seam across the piece: down, a knob, down again
    const pts = [];
    for (let y = 10; y <= 130; y += 2) {
      let x = 70;
      if (y > 55 && y < 85) x = 70 + 16 * Math.sin(((y - 55) / 30) * Math.PI);
      pts.push([x, y]);
    }
    for (let i = 1; i < pts.length; i++) {
      if (gaps && i % 6 < 2) continue;
      cv.line(img, new cv.Point(pts[i - 1][0], pts[i - 1][1]), new cv.Point(pts[i][0], pts[i][1]), new cv.Scalar(70), 2);
    }
  };
  check('a seam across a pale piece is seen', make((img) => curve(img, false)) === true);
  check('a plain pale piece has no seam', make(null) === false);
  check('text on a piece is not a seam', make((img) => {
    cv.putText(img, 'Chicken', new cv.Point(24, 60), cv.FONT_HERSHEY_SIMPLEX, 0.8, new cv.Scalar(60), 2);
    cv.putText(img, 'quotes', new cv.Point(30, 95), cv.FONT_HERSHEY_SIMPLEX, 0.8, new cv.Scalar(60), 2);
  }) === false);
  check('a dashed drawn line is not a seam', make((img) => curve(img, true)) === false);
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
