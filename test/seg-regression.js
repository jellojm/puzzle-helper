/* Segmentation regression guard on REAL white-table frames (WP8).
 * The synthetic puzzle never reproduces the real failure (pale pieces lost,
 * colourful islands left as fragments), so this runs the engine's exact live
 * segmentation options on the owner's frames and checks good/fragment counts.
 *
 * Usage: node test/seg-regression.js [--draw]
 * Thresholds: raise them when a change improves the numbers; never lower one
 * without a before/after seg-lab table explaining why. */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
const { readImage, writeJpg } = require('./imageio');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;
const { robustUnit, classify } = require('./seg-metrics');

// Per fixture: minimum good single pieces, maximum fragments, maximum merged.
// History: baseline 2026-10-03 (colour-only): white-1 20/8/0, white-2 21/10/0,
// white-close-1 (video frame 2) 14/9/0, white-close-2 (frame 881) 9/4/0
// (see PLAN-hard-issues.md §1.1).
const CASES = [
  { file: 'white-1.jpg', minGood: 20, maxFrag: 8, maxMerged: 1 },
  { file: 'white-2.jpg', minGood: 21, maxFrag: 10, maxMerged: 3 },
  { file: 'white-close-1.jpg', minGood: 14, maxFrag: 9, maxMerged: 1 },
  { file: 'white-close-2.jpg', minGood: 9, maxFrag: 4, maxMerged: 1 },
];

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const DRAW = process.argv.includes('--draw');
  let failures = 0;
  console.log('fixture'.padEnd(20) + 'good'.padStart(6) + 'frag'.padStart(6) + 'merged'.padStart(8) + 'ms'.padStart(6));
  for (const c of CASES) {
    const file = path.join(__dirname, 'fixtures', c.file);
    if (!fs.existsSync(file)) { console.log('missing fixture', c.file); failures++; continue; }
    const img = readImage(file);
    const mat = new cv.Mat(img.h, img.w, cv.CV_8UC4); mat.data.set(img.data);
    const eng = new PH.Engine();
    const proc = S.matSource(cv, mat).getProc(eng.opts.procW);
    // The reference unit comes from the plain colour-only pass, so a change in
    // segmentation can't move its own goalposts.
    const unit = robustUnit(PH.segment(proc, { lightW: 0.5 }).dets);
    const t0 = Date.now();
    const seg = PH.segment(proc, eng.liveSegOpts({ still: true }));
    const ms = Date.now() - t0;
    const k = classify(seg.dets, unit);
    const ok = k.good >= c.minGood && k.frag <= c.maxFrag && k.merged <= c.maxMerged;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.file.padEnd(15)}${String(k.good).padStart(6)}${String(k.frag).padStart(6)}${String(k.merged).padStart(8)}${String(ms).padStart(6)}   (need good>=${c.minGood} frag<=${c.maxFrag} merged<=${c.maxMerged})`);
    if (DRAW) {
      const COL = { good: [0, 230, 0, 255], frag: [255, 40, 40, 255], merged: [255, 140, 0, 255], border: [150, 150, 150, 255], other: [255, 255, 255, 255] };
      const sc = 1 / proc.scale;
      for (const d of seg.dets) {
        const pm = cv.matFromArray(d.pts.length / 2, 1, cv.CV_32SC2, Array.from(d.pts, (v) => Math.round(v * sc)));
        const mv = new cv.MatVector(); mv.push_back(pm);
        cv.polylines(mat, mv, true, new cv.Scalar(...COL[d.cls]), 4);
        pm.delete(); mv.delete();
      }
      const s = new cv.Mat(); cv.resize(mat, s, new cv.Size(Math.round(img.w / 2), Math.round(img.h / 2)));
      fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
      writeJpg(path.join(__dirname, 'out', c.file.replace('.jpg', '-regr.jpg')), s.cols, s.rows, s.data);
      s.delete();
    }
    mat.delete();
  }
  console.log(failures ? `\n${failures} fixture(s) failed` : '\nAll fixtures passed');
  process.exitCode = failures ? 1 : 0;
})();
