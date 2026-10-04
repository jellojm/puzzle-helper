/* Real photo taken at an angle: estimate tilt from the pieces, straighten it,
 * and catalog it. Usage: node test/real-tilt.js test/fixtures/tilted-1.jpg [box.jpg]
 * Writes test/out/<name>-straight.jpg (the virtual top-down view). */
'use strict';
const path = require('path');
const S = require('./synth');
const { readImage, writeJpg } = require('./imageio');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;
(async () => {
  let cv = require('@techstark/opencv-js'); if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r)); PH.cv = cv;
  const file = process.argv[2];
  const eng = new PH.Engine();
  if (process.argv[3]) { const bi = readImage(process.argv[3]); eng.setBox(PH.createBox(bi, PH.detectBoxCorners(bi), { pieces: 1000 })); }
  const img = readImage(file);
  const mat = new cv.Mat(img.h, img.w, cv.CV_8UC4); mat.data.set(img.data);
  const src = S.matSource(cv, mat);
  const est = eng.estimatePhotoTilt(src);
  console.log(path.basename(file), `${img.w}x${img.h}`, 'estimated tilt', est && `pitch ${est.pitch}°, roll ${est.roll}° (total ${est.tilt.toFixed(0)}°), uniformity gain ${est.gain.toFixed(3)}`);
  if (est) {
    const rect = PH.tiltHomography(img.w, img.h, PH.focalPx(img.w, img.h), est.down, 3);
    const rs = PH.rectifiedSource(src, rect);
    const v = rs.getProc(1400);
    writeJpg(path.join(__dirname, 'out', path.basename(file, '.jpg') + '-straight.jpg'), v.w, v.h, v.data);
  }
  for (const auto of [false, true]) {
    const e = new PH.Engine({ autoTilt: auto });
    if (eng.box) e.setBox(eng.box);
    const r = e.processSnap(src);
    console.log(`  ${auto ? 'with' : 'without'} tilt correction: ${r.found} pieces catalogued,  ${r.shaped} shapes read (tilt used ${r.tilt}°${r.autoTilt && r.autoTilt.check ? `, outlines ${r.autoTilt.check.before} -> ${r.autoTilt.check.after}` : ''})`);
  }
})();
