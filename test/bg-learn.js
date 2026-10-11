/* The learned background (js/vision/bgLearn.js, PLAN-auto-background.md):
 *  - on a plain table, taught from one frame's clean cut-outs, it calls
 *    piece and table as the colour model does (it learned the table);
 *  - on a wood-grain table it finds at least as many clean pieces as the
 *    best fixed model, and the live engine offers it as a candidate;
 *  - the learner fades old examples and survives a save/load round trip.
 * Run: node test/bg-learn.js   (a few seconds)
 */
'use strict';
const S = require('./synth');
const PH = require('./lib/vision')();

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 4 });
  const view = (scat) => S.cameraFrame(cv, scat.table, scat.TW / 2, scat.TH / 2, 0.2, 1.0, 960, 720);
  const learnOn = (frame) => {
    const src = S.matSource(cv, frame), eng = new PH.Engine({});
    eng.curSource = src;
    const proc = src.getProc(eng.opts.procW);
    const tried = eng.bgCandidates(proc).filter((c) => c.kind !== 'learned').map((c) => eng.scoreBg(proc, c, { splitBudgetMs: undefined }));
    const best = eng.pickBg(tried);
    const seg = PH.segment(proc, eng.segOpts({ bgModel: best.c }));
    const L = new PH.BgLearner();
    let m = eng.teachBg(seg, proc, L, seg.unitArea), sc = m && eng.scoreBg(proc, m, { splitBudgetMs: undefined });
    // one more round from its own cut-outs (as live scanning keeps teaching)
    if (m) { const m2 = eng.teachBg(PH.segment(proc, eng.segOpts({ bgModel: m })), proc, L, seg.unitArea); const s2 = m2 && eng.scoreBg(proc, m2, { splitBudgetMs: undefined }); if (s2 && s2.score > sc.score) { m = m2; sc = s2; } }
    return { eng, proc, best, seg, m, sc, L };
  };
  {
    const scat = S.scatter(cv, P, { scale: 2.2, seed: 9 });
    const r = learnOn(view(scat));
    check('plain table: a model is learned from one frame', !!r.m, r.m ? `${r.m.n[0]} piece / ${r.m.n[1]} table samples` : 'none');
    if (r.m) {
      const lab = PH.rgbaToLab(r.proc.data, r.proc.w, r.proc.h), lm = PH.learnedMask(lab, r.proc.w, r.proc.h, r.m), fm = r.seg.fg;
      let I = 0, U = 0;
      for (let i = 0; i < lm.length; i++) { const a = lm[i] > 0, b = fm ? fm[i] > 0 : false; if (a && b) I++; if (a || b) U++; }
      check('plain table: the learned cut agrees with the colour model', U && I / U > 0.75, `IoU ${(I / U).toFixed(2)}`);
      check('plain table: as many clean pieces', r.sc.good >= r.best.good - 1, `${r.sc.good} learned vs ${r.best.good} ${r.best.c.kind}`);
    }
  }
  {
    const scat = S.scatter(cv, P, { scale: 2.2, seed: 9, felt: [150, 98, 62], grain: 45 });
    const r = learnOn(view(scat));
    check('wood-grain table: at least as many clean pieces as the best fixed model', !!r.m && r.sc.good >= r.best.good, r.m ? `${r.sc.good} learned vs ${r.best.good} ${r.best.c.kind}` : 'no model');
    // live: steady frames teach it, and it is offered with the fixed models
    const eng = new PH.Engine({}), frame = view(scat);
    for (let i = 0; i < 30; i++) eng.processFrame(S.matSource(cv, frame), { still: true });
    const kinds = eng.bgCandidates(eng.lastProc).map((c) => c.kind);
    check('live: the table is learned while scanning and offered as a background', !!eng.learnedModel && kinds.includes('learned'), `lessons ${eng.bgLearner.batches}, in use: ${eng.bgModel && eng.bgModel.kind}`);
  }
  {
    const L = new PH.BgLearner(), n = 1000, feat = { cbin: new Uint16Array(n).fill(7), tbin: new Uint8Array(n).fill(3) }, lab = new Uint8Array(n).fill(1);
    for (let i = 0; i < 200; i++) L.add(feat, lab, 1);
    check('old examples fade (counts stay under the cap)', L.nf <= PH.BGL_CAP, `${Math.round(L.nf)}`);
    const L2 = PH.BgLearner.fromJSON(JSON.parse(JSON.stringify(L.toJSON())));
    check('save / load round trip', Math.round(L2.nf) === Math.round(L.nf) && L2.cf[7] === Math.round(L.cf[7]), `${Math.round(L2.nf)}`);
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
})();
