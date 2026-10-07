/* Pointed check: the live pipeline must not leak OpenCV (WebAssembly) memory.
 * OpenCV.js Mats are not garbage-collected; a missing .delete() — or an
 * undeleted MatVector.get() / roi() view, which pins its parent's buffer —
 * grows the heap every frame. v0.9.0 leaked ~0.5 MB per frame on the owner's
 * white-board frames (a roi() view in the pile splitter), i.e. ~128 MB every
 * two minutes on the phone.
 *
 * Runs Engine.processFrame on real white-board frames (untilted and tilted,
 * with a box picture) and fails if the WebAssembly heap grows after warm-up.
 * Run: node test/leak-check.js   (~30 s)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
const { readImage } = require('./imageio');
globalThis.self = globalThis;
require('./lib/vision')(); // (the modules the app's worker loads)
const PH = globalThis.PH;

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const fx = (n) => path.join(__dirname, 'fixtures', n);
  const files = ['white-1.jpg', 'white-2.jpg', 'white-close-1.jpg'].filter((n) => fs.existsSync(fx(n)));
  if (!files.length) { console.log('SKIP  no white-board fixtures in test/fixtures'); process.exit(0); }
  const mats = files.map((n) => { const im = readImage(fx(n)); const m = new cv.Mat(im.h, im.w, cv.CV_8UC4); m.data.set(im.data); return m; });
  const eng = new PH.Engine();
  // A box picture so shape reading + box placement run too (any image will do for memory).
  const bi = readImage(fx(files[0]), 800);
  eng.setBox(PH.createBox(bi, [[0, 0], [bi.w, 0], [bi.w, bi.h], [0, bi.h]], { cols: 15, rows: 20, pieces: 300 }));
  const heapMB = () => cv.HEAP8.buffer.byteLength / 1048576;
  const tilted = { down: [0.3, 0.1, Math.sqrt(0.9)], fov: 66 };
  let frames = 0;
  const pass = () => { for (const m of mats) for (const tilt of [null, tilted]) { eng.processFrame(S.matSource(cv, m), { still: true, tilt }); frames++; } };
  for (let i = 0; i < 3; i++) pass();
  const h0 = heapMB();
  const N = Math.ceil(120 / (mats.length * 2));
  for (let i = 0; i < N; i++) pass();
  const h1 = heapMB();
  const ok = h1 <= h0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  WebAssembly heap stable over live frames  — ${h0} MB after warm-up, ${h1} MB after ${N * mats.length * 2} more frames (${files.join(', ')})`);
  console.log(ok ? '\nAll checks passed' : '\n1 check(s) failed');
  process.exit(ok ? 0 : 1);
})();
