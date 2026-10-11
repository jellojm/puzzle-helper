/* Learned background vs the fixed models (PLAN-auto-background.md step 1).
 *   node tools/bg-learn-eval.js [pictures...]   (default: every report frame)
 * For each picture: the fixed models are scored as the app does
 * (Engine.chooseBackground), the learned model is taught from the winner's
 * clean cut-outs, then re-taught from its own (ROUNDS), and scored the same
 * way. Prints both; writes test/out/bgl/<name>.jpg: fixed (left) and learned
 * (right), piece-shaped cut-outs outlined.
 * HOLD=1: teach on the picture's left half only, score on the whole (does it
 * carry over to table it hasn't seen?).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../test/synth');
const { readImage, writeJpg } = require('../test/imageio');
const PH = require('../test/lib/vision')();
const ROOT = path.join(__dirname, '..');
const ROUNDS = +(process.env.ROUNDS || 2);
const OUT = path.join(ROOT, 'test', 'out', 'bgl');

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  if (process.env.PHSET) Object.assign(PH, JSON.parse(process.env.PHSET)); // e.g. PHSET='{"BGL_LSHIFT":5}'
  fs.mkdirSync(OUT, { recursive: true });
  let files = process.argv.slice(2);
  if (!files.length) files = fs.readdirSync(path.join(ROOT, 'reports')).filter((f) => /-frame\.jpg$/.test(f)).sort().map((f) => path.join(ROOT, 'reports', f));
  const rows = [];
  for (const file of files) {
    const im = readImage(file, 1920);
    const mat = new cv.Mat(im.h, im.w, cv.CV_8UC4); mat.data.set(im.data);
    const src = S.matSource(cv, mat), eng = new PH.Engine({});
    eng.curSource = src;
    const proc = src.getProc(eng.opts.procW);
    const tried = eng.bgCandidates(proc).map((c) => eng.scoreBg(proc, c, { splitBudgetMs: undefined }));
    const best = eng.pickBg(tried) || tried.reduce((m, t) => (!m || t.score > m.score ? t : m), null);
    const segOf = (model) => PH.segment(proc, eng.segOpts({ bgModel: model, unitArea: null }));
    const lab = PH.rgbaToLab(proc.data, proc.w, proc.h), feat = PH.bgFeatures(lab, proc.w, proc.h);
    const L = new PH.BgLearner();
    let seg = best ? segOf(best.c) : null, fixedSeg = seg, learned = null, sc = null, taught = null, bestLearned = null;
    const scores = [];
    for (let r = 0; r <= ROUNDS && seg; r++) {
      const lb = PH.bgLearnLabels(seg.dets, proc.w, proc.h, seg.unitArea);
      if (!lb) break;
      if (process.env.HOLD) for (let y = 0; y < proc.h; y++) for (let x = (proc.w >> 1); x < proc.w; x++) lb.labels[y * proc.w + x] = 0;
      if (!taught) taught = lb;
      L.add(feat, lb.labels, 1);
      const m = L.model();
      if (!m) break;
      learned = m;
      const s1 = eng.scoreBg(proc, m, { splitBudgetMs: undefined });
      scores.push(s1);
      if (!sc || s1.score > sc.score) { sc = s1; bestLearned = m; }
      seg = segOf(m);
    }
    const t0 = Date.now(); if (learned) PH.learnedMask(lab, proc.w, proc.h, learned); const mskMs = Date.now() - t0;
    const t1 = Date.now(); PH.bgFeatures(lab, proc.w, proc.h); const featMs = Date.now() - t1;
    const name = path.basename(file).replace(/^puzzle-report-/, '').replace(/\.(jpe?g|png)$/i, '');
    const fmt = (t) => (t ? `${t.good} good, fg ${t.fg}, tex ${t.tex}` : '-');
    rows.push({ name, fixed: best && best.c.kind, fixedGood: best ? best.good : 0, learnedGood: sc ? sc.good : 0 });
    console.log(`${name.padEnd(28)} fixed ${(best ? best.c.kind : 'none').padEnd(7)} ${fmt(best).padEnd(32)} | learned ${scores.map((s) => s.good).join(' -> ') || '-'} (${fmt(sc)}) | taught from ${taught ? taught.pieces : 0} pieces, ${taught ? taught.nf + '/' + taught.nb : '-'} px | ${featMs}+${mskMs} ms`);
    // picture: fixed | learned, piece-shaped cut-outs outlined
    const draw = (sg) => {
      const m = new cv.Mat(proc.h, proc.w, cv.CV_8UC4); m.data.set(proc.data);
      if (sg) for (const d of sg.dets) {
        if (!d.pts) continue;
        const ok = !d.border && PH.pieceScore(d.pts, d.area) > PH.MIN_CORNER_SCORE;
        const mv = new cv.MatVector(); mv.push_back(cv.matFromArray(d.pts.length / 2, 1, cv.CV_32SC2, Array.from(d.pts)));
        cv.drawContours(m, mv, -1, ok ? new cv.Scalar(0, 255, 0, 255) : new cv.Scalar(255, 0, 0, 255), 2);
        mv.get(0).delete(); mv.delete();
      }
      return m;
    };
    const a = draw(fixedSeg), b = draw(bestLearned ? segOf(bestLearned) : null), both = new cv.Mat(), mv = new cv.MatVector();
    mv.push_back(a); mv.push_back(b); cv.hconcat(mv, both);
    writeJpg(path.join(OUT, name + '.jpg'), both.cols, both.rows, both.data);
    [a, b, both, mat].forEach((m) => m.delete()); mv.delete();
  }
  const win = rows.filter((r) => r.learnedGood > r.fixedGood).length, lose = rows.filter((r) => r.learnedGood < r.fixedGood).length;
  console.log(`\n${rows.length} pictures: learned more piece-shaped cut-outs in ${win}, fewer in ${lose}; total ${rows.reduce((s, r) => s + r.fixedGood, 0)} fixed vs ${rows.reduce((s, r) => s + r.learnedGood, 0)} learned; as one more candidate (the better of the two) ${rows.reduce((s, r) => s + Math.max(r.fixedGood, r.learnedGood), 0)}`);
})();
