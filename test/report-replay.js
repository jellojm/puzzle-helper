/* Replay a phone report's camera frame through the engine with the SAME
 * settings the phone had (taught background colours, tilt, Scan detail),
 * comparing old (published) and current segmentation.
 * Usage: node test/report-replay.js reports/puzzle-report-XXXX.json [--draw] */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
const { readImage, writeJpg } = require('./imageio');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;
const { robustUnit, classify } = require('./seg-metrics');

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const jf = process.argv[2];
  const rep = JSON.parse(fs.readFileSync(jf, 'utf8'));
  const frameFile = jf.replace('.json', '-frame.jpg');
  const img = readImage(frameFile);
  // a black frame means the camera was already off when the report was made
  let sum = 0; for (let i = 0; i < img.data.length; i += 400) sum += img.data[i];
  if (sum / (img.data.length / 400) < 3) {
    // Camera was off when the report was made (fixed in 0.7.0). The analyzed
    // image (already straightened, at processing size) can still be replayed.
    const af = jf.replace('.json', '-analyzed.jpg');
    if (!fs.existsSync(af)) { console.log(path.basename(jf), ': camera frame is black and no analyzed image'); return; }
    const a = readImage(af);
    const w = rep.worker || {};
    console.log(`${path.basename(jf)}  camera frame black -> replaying the analyzed (straightened) image ${a.w}x${a.h}, taught ${(w.taught || []).length}`);
    const proc = { w: a.w, h: a.h, data: a.data, scale: 1 };
    for (const [label, opts] of [['published (0.6.0)', { boundary: false, stableUnit: false, flatten: false }], ['current', {}]]) {
      const eng = new PH.Engine(Object.assign({ minDE: (w.opts && w.opts.minDE) || 8 }, opts));
      eng.taught = (w.taught || []).slice();
      const so = eng.liveSegOpts({ still: true });
      if (opts.flatten === false) { so.flatten = false; }
      const seg = PH.segment(proc, so);
      const k = classify(seg.dets, robustUnit(seg.dets));
      console.log(`  ${label.padEnd(18)} good ${k.good} frag ${k.frag} merged ${k.merged} border ${k.border} other ${k.other}`);
      if (process.argv.includes('--draw')) {
        const m = new cv.Mat(a.h, a.w, cv.CV_8UC4); m.data.set(a.data);
        const COL = { good: [0, 230, 0, 255], frag: [255, 40, 40, 255], merged: [255, 140, 0, 255], border: [150, 150, 150, 255], other: [255, 255, 255, 255] };
        for (const d of seg.dets) { const pm = cv.matFromArray(d.pts.length / 2, 1, cv.CV_32SC2, Array.from(d.pts)); const mv = new cv.MatVector(); mv.push_back(pm); cv.polylines(m, mv, true, new cv.Scalar(...COL[d.cls]), 2); pm.delete(); mv.delete(); }
        writeJpg(path.join(__dirname, 'out', path.basename(jf, '.json') + '-replay-' + label.split(' ')[0] + '.jpg'), m.cols, m.rows, m.data);
        m.delete();
      }
    }
    return;
  }
  const mat = new cv.Mat(img.h, img.w, cv.CV_8UC4); mat.data.set(img.data);
  const w = rep.worker || {};
  const tilt = rep.tilt && rep.tiltOn ? rep.tilt : null;
  console.log(`${path.basename(jf)}  tilt ${tilt ? PH.tiltDeg(tilt.down).toFixed(1) + '°' : 'off'}  taught ${(w.taught || []).length}  procW ${w.opts && w.opts.procW}`);
  for (const [label, opts] of [['published (0.6.0)', { boundary: false, stableUnit: false, autoBg: false }], ['current', {}]]) {
    const eng = new PH.Engine(Object.assign({ procW: (w.opts && w.opts.procW) || 640, minDE: (w.opts && w.opts.minDE) || 8 }, opts));
    eng.taught = (w.taught || []).slice();
    let out;
    for (let i = 0; i < 3; i++) out = eng.processFrame(S.matSource(cv, mat), { still: true, tilt });
    const unit = robustUnit(out.dets.map((d) => ({ ...d, pts: Int32Array.from(d.pts) })));
    const proc = eng.lastProc;
    const seg = PH.segment(proc, eng.liveSegOpts({ still: true }));
    const k = classify(seg.dets, robustUnit(seg.dets));
    if (eng.bgTried) console.log('    background candidates:', JSON.stringify(eng.bgTried), '-> chose', JSON.stringify(eng.bgModel && { kind: eng.bgModel.kind, bg: eng.bgModel.bg && [eng.bgModel.bg.L, eng.bgModel.bg.a, eng.bgModel.bg.b].map(Math.round), list: eng.bgModel.list && eng.bgModel.list.map((c) => [c.L, c.a, c.b].map(Math.round)) }));
    console.log(`  ${label.padEnd(18)} dets ${String(out.dets.length).padStart(3)} | good ${k.good} frag ${k.frag} merged ${k.merged} border ${k.border} | tracking ${out.tracking} | ${out.timings.total.toFixed(0)} ms`);
    if (process.argv.includes('--draw')) {
      const m = new cv.Mat(proc.h, proc.w, cv.CV_8UC4); m.data.set(proc.data);
      const COL = { good: [0, 230, 0, 255], frag: [255, 40, 40, 255], merged: [255, 140, 0, 255], border: [150, 150, 150, 255], other: [255, 255, 255, 255] };
      for (const d of seg.dets) { const pm = cv.matFromArray(d.pts.length / 2, 1, cv.CV_32SC2, Array.from(d.pts)); const mv = new cv.MatVector(); mv.push_back(pm); cv.polylines(m, mv, true, new cv.Scalar(...COL[d.cls]), 2); pm.delete(); mv.delete(); }
      writeJpg(path.join(__dirname, 'out', path.basename(jf, '.json') + '-replay-' + label.split(' ')[0] + '.jpg'), m.cols, m.rows, m.data);
      m.delete();
    }
  }
  mat.delete();
})();
