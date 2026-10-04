/* Segmentation lab: run PH.segment on real photos at the LIVE analysis width
 * under several option sets and report fragment / good-piece counts plus a
 * per-stage timing breakdown. For deciding what to change in segment.js, not
 * a pass/fail test.
 *
 * Usage: node test/seg-lab.js [--draw] img1.jpg img2.jpg ...
 *   (no images given -> the two report frames + three fixtures)
 *   --draw writes test/out/<name>-lab-<variant>.jpg for the baseline and the
 *   last variant, green = good single piece, red = fragment, orange = merged,
 *   grey = touches the frame edge, white = other.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
const { readImage, writeJpg } = require('./imageio');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

const args = process.argv.slice(2);
const DRAW = args.includes('--draw');
// --drawv=label1,label2 draws only those variants (default: first and last).
const DRAWV = (args.find((a) => a.startsWith('--drawv=')) || '').slice(8).split(',').filter(Boolean);
const files = args.filter((a) => !a.startsWith('--'));
const DEFAULT = [
  'reports/puzzle-report-2026-10-03T03-14-50-frame.jpg',
  'reports/puzzle-report-2026-10-03T03-08-58-frame.jpg',
  'test/fixtures/pieces-1.jpg',
  'test/fixtures/straight-1.jpg',
  'test/fixtures/close-1.jpg',
].map((f) => path.join(__dirname, '..', f));
const LIVE_W = 640;

// Option sets to compare. `label` is for the table; everything else goes to PH.segment.
// --variants='[{"label":"x","boundary":true,...}, ...]' replaces the list.
const VARIANTS = (() => { const a = args.find((x) => x.startsWith('--variants=')); return a ? JSON.parse(a.slice(11)) : null; })() || [
  { label: 'baseline' },
  { label: 'lightW .75', lightW: 0.75 },
  { label: 'lightW 1.0', lightW: 1.0 },
  { label: 'close 9', closeK: 9 },
  { label: 'no open', openK: 0 },
  { label: 'no split', split: false },
  { label: 'unit hint', unitHint: true },
  { label: 'boundary', boundary: true },
  { label: 'boundary+lw1', boundary: true, lightW: 1.0 },
  { label: 'bnd+lw1+unit', boundary: true, lightW: 1.0, unitHint: true },
];

const { robustUnit, classify } = require('./seg-metrics');

const COLORS = { good: [0, 230, 0, 255], frag: [255, 40, 40, 255], merged: [255, 140, 0, 255], border: [150, 150, 150, 255], other: [255, 255, 255, 255] };
function draw(cv, img, proc, dets, name) {
  const mat = new cv.Mat(img.h, img.w, cv.CV_8UC4); mat.data.set(img.data);
  const k = 1 / proc.scale;
  for (const d of dets) {
    const pts = []; for (let i = 0; i < d.pts.length; i++) pts.push(Math.round(d.pts[i] * k));
    const pm = cv.matFromArray(pts.length / 2, 1, cv.CV_32SC2, pts);
    const mv = new cv.MatVector(); mv.push_back(pm);
    cv.polylines(mat, mv, true, new cv.Scalar(...COLORS[d.cls]), 4);
    pm.delete(); mv.delete();
  }
  const s = new cv.Mat(); cv.resize(mat, s, new cv.Size(Math.round(img.w / 2), Math.round(img.h / 2)));
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  writeJpg(path.join(__dirname, 'out', name + '.jpg'), s.cols, s.rows, s.data);
  mat.delete(); s.delete();
}

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const list = files.length ? files : DEFAULT;
  const pad = (s, n) => String(s).padEnd(n);
  const num = (v, n) => String(v).padStart(n);
  for (const file of list) {
    if (!fs.existsSync(file)) { console.log('missing', file); continue; }
    const img = readImage(file);
    const mat = new cv.Mat(img.h, img.w, cv.CV_8UC4); mat.data.set(img.data);
    const src = S.matSource(cv, mat);
    const proc = src.getProc(LIVE_W);
    console.log(`\n=== ${path.basename(file)}  ${img.w}x${img.h} -> ${proc.w}x${proc.h} ===`);
    // Reference unit from the baseline run (same for every variant, so counts are comparable).
    const base = PH.segment(proc, { lightW: 0.5 });
    const unitRef = robustUnit(base.dets);
    console.log(`robust unit ≈ ${unitRef ? unitRef.toFixed(0) : '?'} px² (segment's own unitA on baseline: ${base.unitArea.toFixed(0)})`);
    console.log(pad('variant', 14) + num('blobs', 6) + num('good', 6) + num('frag', 6) + num('merged', 7) + num('border', 7) + num('unitA', 7) + num('ms', 6) + '   stage ms');
    let last = null;
    VARIANTS.forEach((v, vi) => {
      const o = Object.assign({ lightW: 0.5 }, v);
      delete o.label;
      if (o.unitHint) { o.unitArea = unitRef; delete o.unitHint; }
      // warm-up pass so timings aren't JIT noise, then a timed pass
      PH.segment(proc, Object.assign({}, o));
      const timings = {};
      const t0 = Date.now();
      const seg = PH.segment(proc, Object.assign({ timings }, o));
      const ms = Date.now() - t0;
      const c = classify(seg.dets, unitRef);
      const stages = Object.entries(timings).map(([k, t]) => `${k} ${t.toFixed(0)}`).join(' ');
      console.log(pad(v.label, 14) + num(c.blobs, 6) + num(c.good, 6) + num(c.frag, 6) + num(c.merged, 7) + num(c.border, 7) + num(seg.unitArea.toFixed(0), 7) + num(ms, 6) + '   ' + stages);
      const wantDraw = DRAWV.length ? DRAWV.includes(v.label) : (DRAW && (vi === 0 || vi === VARIANTS.length - 1));
      if (wantDraw) draw(cv, img, proc, seg.dets, path.basename(file, '.jpg') + '-lab-' + v.label.replace(/[^a-z0-9]+/gi, '_'));
      last = seg;
    });
    mat.delete();
  }
})();
