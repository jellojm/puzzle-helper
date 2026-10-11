/* Test mode on the PC: the same variants as Settings -> Test mode on the
 * phone (js/vision/testmode.js), on photos.
 *   node tools/testmode.js photo1.jpg [photo2.jpg ...] [--box box.jpg --grid 24x31] [--div 2] [--json out.json]
 * Prints, per photo, each variant's pieces found / read / read attempts,
 * piece size, how square the reads are and the time. */
'use strict';
const path = require('path');
const fs = require('fs');
const PH = require('../test/lib/vision')();
const S = require('../test/synth');
const { readImage } = require('../test/imageio');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const files = process.argv.slice(2).filter((a, i, A) => !a.startsWith('--') && !(i > 0 && A[i - 1].startsWith('--')));
(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const base = new PH.Engine({ checkedOnly: false });
  if (arg('--box')) { const bi = readImage(arg('--box')); const [c, r] = (arg('--grid') || '').split('x').map(Number); base.setBox(PH.createBox(bi, [[0, 0], [bi.w, 0], [bi.w, bi.h], [0, bi.h]], c && r ? { cols: c, rows: r } : { pieces: 1000 })); }
  const div = +(arg('--div') || 2), all = [];
  for (const f of files) {
    const im = readImage(f), full = new cv.Mat(im.h, im.w, cv.CV_8UC4); full.data.set(im.data);
    const mat = new cv.Mat(); cv.resize(full, mat, new cv.Size(Math.round(im.w / div), Math.round(im.h / div)), 0, 0, cv.INTER_AREA); full.delete();
    const out = { label: path.basename(f), variants: [] };
    console.log(`\n${out.label} (${mat.cols}x${mat.rows})`);
    console.log('  variant'.padEnd(40), 'dets clumps edge', 'found', 'read', 'reads ok/tried', 'unit px', 'model'.padEnd(12), 'q', 'off90', 'ms');
    for (const v of PH.TEST_VARIANTS) {
      const r = PH.runTestVariant(v, S.matSource(cv, mat), base, {});
      out.variants.push(r);
      if (r.error) { console.log('  ' + v.name.padEnd(38), 'ERROR', r.error); continue; }
      console.log('  ' + v.name.padEnd(38), `${r.dets}`.padStart(4), `${r.clumps}`.padStart(6), `${r.cutByEdge}`.padStart(4), String(r.found).padStart(5), String(r.shaped).padStart(4), `${r.readsOk}/${r.reads}`.padStart(14), String(r.unitPx).padStart(7), (r.model ? r.model.kind + (r.model.edgeT ? r.model.edgeT[0] : '') : '-').padEnd(12), r.readQ, r.cornerOffMed, r.ms);
    }
    mat.delete();
    all.push(out);
  }
  if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(all, null, 1));
})();
