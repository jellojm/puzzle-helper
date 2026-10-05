/* Pointed check of the match answer key: Fits/No taps are logged with what
 * the app claimed (probability, rank, 2x2 loop, confirmed shapes), and
 * Engine.feedbackStats() turns them into accuracy figures.
 *
 * A synthetic puzzle is catalogued from a photo; then the "owner" judges the
 * top suggestion for every edge of every piece using the true layout. The
 * logged accuracy must equal the true precision of what was judged, and the
 * app's own probabilities should be roughly calibrated against it.
 * Run: node test/answer-key.js   (a few seconds)
 */
'use strict';
const path = require('path');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;
PH.CLOSE_SIDE = 40; // synthetic pieces are small (the phone's close reads: 150+ px); this test is about other things

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const cols = 8, rows = 6;
  const P = S.makePuzzle(cv, { cols, rows, cs: 48, seed: 3 });
  const photo = S.boxPhoto(cv, P);
  const box = PH.createBox({ w: photo.mat.cols, h: photo.mat.rows, data: photo.mat.data }, photo.corners, { cols, rows, pieces: cols * rows });
  const scat = S.scatter(cv, P, { scale: 2.2, seed: 5 });
  const eng = new PH.Engine();
  eng.setBox(box);
  eng.processSnap(S.matSource(cv, scat.table));

  // catalogue piece -> true grid cell (nearest ground-truth centre)
  const gtOf = new Map();
  for (const p of eng.pieces.values()) {
    if (!p.t1) continue;
    const cx = p.t1.corners.reduce((s, c) => s + c[0], 0) / 4, cy = p.t1.corners.reduce((s, c) => s + c[1], 0) / 4;
    let best = null, bd = Infinity;
    for (const g of scat.gt) { const d = Math.hypot(g.x - cx, g.y - cy); if (d < bd) { bd = d; best = g; } }
    if (best && bd < scat.core * 0.3) gtOf.set(p.id, best);
  }
  // The owner judges each piece's top suggestion per edge, once per pair.
  let judged = 0, trueFits = 0;
  const seen = new Set();
  for (const p of [...eng.pieces.values()]) {
    if (!p.t1 || !gtOf.has(p.id)) continue;
    const d = eng.describe(p.id);
    for (const e of d.edges) {
      const m = e.matches[0];
      if (!m || !gtOf.has(m.id)) continue;
      const key = Math.min(p.id, m.id) + ':' + Math.max(p.id, m.id);
      if (seen.has(key)) continue;
      seen.add(key);
      const a = gtOf.get(p.id), b = gtOf.get(m.id);
      const fit = Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
      eng.feedback({ kind: fit ? 'joined' : 'wrong', a: p.id, ka: e.edge, b: m.id, kb: m.edgeB, source: 'test' });
      judged++; if (fit) trueFits++;
    }
  }
  const st = eng.feedbackStats();
  console.log(`judged ${judged} suggestions: ${trueFits} true pairs; stats ${JSON.stringify({ accuracy: st.accuracy, byProb: st.byProb, byRank: st.byRank })}`);
  check('every Fits/No is logged with what was claimed', eng.fbLog.length === judged && eng.fbLog.every((x) => x.rank === 1 && x.prob !== null), `${eng.fbLog.length} logged, all rank 1 with a probability`);
  check('logged accuracy equals the true precision', judged > 20 && st.accuracy === +(trueFits / judged).toFixed(3), `${st.accuracy} vs ${(trueFits / judged).toFixed(3)} over ${judged}`);
  // Calibration: the high-confidence bucket should be right more often than the low one.
  const hi = st.byProb['>=0.95'] || st.byProb['0.8-0.95'], lo = st.byProb['<0.5'];
  check('high-probability suggestions fit more often than low ones', !hi || !lo || hi.fits / hi.n >= lo.fits / lo.n, `${hi ? `${hi.fits}/${hi.n}` : '-'} vs ${lo ? `${lo.fits}/${lo.n}` : '-'}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
