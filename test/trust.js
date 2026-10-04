/* Pointed checks for trustworthy suggestions (RESEARCH-ai-puzzle.md tier 1):
 *  - calibrated match probabilities (lead over the runner-up, mutual best,
 *    loops...) beat the plain softmax on a puzzle the model was not fitted on;
 *  - the owner's Fits/No answers refit the model, but only once there are
 *    enough of them;
 *  - verdict words follow the rules ("Strong" needs independent backing);
 *  - "In the puzzle": the placed piece's box cell leaves other pieces'
 *    candidates, finders skip it, undo restores everything;
 *  - the rotation hint: the top edge points the right way on the table.
 * Run: node test/trust.js   (about 20 seconds)
 */
'use strict';
const path = require('path');
const S = require('./synth');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

let failures = 0;
function check(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; }

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const cols = 8, rows = 6;
  const P = S.makePuzzle(cv, { cols, rows, cs: 48, seed: 31 }); // not one of tools/fit-calib.js's seeds
  const photo = S.boxPhoto(cv, P);
  const box = PH.createBox({ w: photo.mat.cols, h: photo.mat.rows, data: photo.mat.data }, photo.corners, { cols, rows, pieces: cols * rows });
  const scat = S.scatter(cv, P, { scale: 2.0, seed: 33 });
  const eng = new PH.Engine();
  eng.setBox(box);
  eng.processSnap(S.matSource(cv, scat.table));
  const rnd = S.makeRng(5);
  for (const p of [...eng.pieces.values()]) if (rnd() < 0.25) eng.removePiece(p.id); // partners not scanned yet

  // ground truth: catalogue piece -> scattered piece; edge direction in the solved puzzle
  const centre = (c) => [(c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4];
  const mid = (c, k) => [(c[k][0] + c[(k + 1) % 4][0]) / 2, (c[k][1] + c[(k + 1) % 4][1]) / 2];
  const gtOf = new Map();
  for (const p of eng.pieces.values()) {
    if (!p.t1) continue;
    const [cx, cy] = centre(p.t1.corners);
    let best = null, bd = Infinity;
    for (const g of scat.gt) { const d = Math.hypot(g.x - cx, g.y - cy); if (d < bd) { bd = d; best = g; } }
    if (best && bd < scat.core * 0.3) gtOf.set(p.id, best);
  }
  const dirOf = (q, k, rot) => {
    const c = centre(q.t1.corners), m = mid(q.t1.corners, k), vx = m[0] - c[0], vy = m[1] - c[1];
    const px = Math.cos(-rot) * vx - Math.sin(-rot) * vy, py = Math.sin(-rot) * vx + Math.cos(-rot) * vy;
    return Math.abs(px) > Math.abs(py) ? [Math.sign(px), 0] : [0, Math.sign(py)];
  };
  const truth = (p, k, q, m) => {
    const a = gtOf.get(p.id), b = gtOf.get(q.id);
    if (!a || !b) return null;
    const da = dirOf(p, k, a.rot), db = dirOf(q, m, b.rot);
    return b.c === a.c + da[0] && b.r === a.r + da[1] && db[0] === -da[0] && db[1] === -da[1];
  };

  // 1. calibration vs softmax on this unseen puzzle
  const samples = [];
  for (const p of eng.pieces.values()) {
    if (!gtOf.has(p.id)) continue;
    for (const r of eng.matchesFor(p.id, { loops: true })) for (const m of r.matches.slice(0, 3)) {
      const y = truth(p, r.edge, eng.pieces.get(m.id), m.edge);
      if (y !== null) samples.push({ y: y ? 1 : 0, p: m.prob, s: m.pSoft, m });
    }
  }
  const ll = (key) => samples.reduce((s, x) => s - Math.log(x.y ? Math.max(1e-4, x[key]) : Math.max(1e-4, 1 - x[key])), 0) / samples.length;
  const nTrue = samples.filter((x) => x.y).length;
  check('calibrated probabilities beat the softmax alone (unseen puzzle)', samples.length > 100 && nTrue > 20 && ll('p') < ll('s') * 0.85,
    `log-loss ${ll('s').toFixed(3)} -> ${ll('p').toFixed(3)} over ${samples.length} candidates (${nTrue} true)`);
  const hi = samples.filter((x) => x.p >= 0.85), hiOk = hi.filter((x) => x.y).length;
  check('85%+ suggestions are right about that often', hi.length >= 10 && hiOk / hi.length >= 0.85, `${hiOk}/${hi.length} right`);
  // verdict rules
  const bad = samples.filter((x) => x.m.verdict === 'strong' && !(x.m.loopOk || x.m.mutual) || x.m.verdict === 'strong' && x.m.prob < 0.85);
  const strong = samples.filter((x) => x.m.verdict === 'strong'), strongOk = strong.filter((x) => x.y).length;
  check('"Strong" only with independent backing, and right', !bad.length && strong.length >= 5 && strongOk / strong.length >= 0.9, `${strongOk}/${strong.length} strong right`);
  // Probabilities of one edge's candidates never sum past 1.
  let over = 0;
  for (const p of eng.pieces.values()) { const res = eng.matchesFor(p.id); if (res) for (const r of res) if (r.matches.reduce((s, m) => s + m.prob, 0) > 1 + 1e-9) over++; }
  check("one edge's candidates sum to at most 100%", over === 0, `${over} edges over`);

  // 2. the owner's answers refit the model (only once there are enough)
  {
    const judge = (n) => {
      eng.fbLog = [];
      let k = 0;
      for (const p of eng.pieces.values()) {
        if (!gtOf.has(p.id)) continue;
        for (const r of eng.matchesFor(p.id)) {
          const m = r.matches[0];
          if (!m || k >= n) continue;
          const y = truth(p, r.edge, eng.pieces.get(m.id), m.edge);
          if (y === null) continue;
          // A harder real table than the synthetic ones the prior was fitted
          // on: only every other true suggestion actually fits.
          eng.feedback({ kind: y && k % 2 === 0 ? 'joined' : 'wrong', a: p.id, ka: r.edge, b: m.id, kb: m.edge, source: 'test' });
          k++;
        }
      }
      return k;
    };
    const meanTop = () => { let s = 0, n = 0; for (const p of eng.pieces.values()) { const res = eng.matchesFor(p.id); if (res) for (const r of res) if (r.matches[0]) { s += r.matches[0].prob; n++; } } return s / n; };
    const p0 = meanTop();
    const few = judge(6);
    const stillPrior = eng.calibW === null;
    const many = judge(80);
    const w = eng.calibW, p1 = meanTop();
    const said = eng.fbLog.filter((e) => e.kind === 'joined').length / Math.max(1, eng.fbLog.length);
    check('a handful of answers leaves the model alone', stillPrior, `${few} answers`);
    check('enough answers refit it to the owner\'s table', !!w && p1 < p0 - 0.15, w ? `${many} answers (${Math.round(100 * said)}% fit): mean top-suggestion probability ${Math.round(100 * p0)}% -> ${Math.round(100 * p1)}%` : `not refitted (${many} answers, ${Math.round(100 * said)}% fit)`);
    eng.fbLog = []; eng.refitCalib();
    for (const p of eng.pieces.values()) { p.wrong = []; p.joined = [false, false, false, false]; }
    eng.version++;
  }

  // 3a. one piece per cell (joint assignment after the photo)
  {
    const tops = [...eng.pieces.values()].filter((p) => p.t2 && p.t2.cands.length).map((p) => p.t2.cands[0].col + ',' + p.t2.cands[0].row);
    check('no two pieces are given the same box spot', tops.length > 20 && new Set(tops).size === tops.length, `${tops.length} placed, ${tops.length - new Set(tops).size} sharing`);
  }

  // 3b. sorting zones: right area much more often than right cell
  {
    let n = 0, cell = 0, zone = 0;
    for (const p of eng.pieces.values()) {
      const g = gtOf.get(p.id);
      if (!g || !p.t2 || !p.t2.cands.length || p.t2.conf < 0.2) continue;
      const c = p.t2.cands[0];
      n++; if (c.col === g.c && c.row === g.r) cell++;
      if (PH.zoneOf(box, c.col, c.row) === PH.zoneOf(box, g.c, g.r)) zone++;
    }
    eng.setFilter('zones');
    const lit = eng.filterIds().length;
    eng.setFilter(null);
    check('sorting zones: pieces go to the right tray', n >= 20 && zone / n >= 0.9 && zone >= cell && lit === n, `right zone ${zone}/${n} (right cell ${cell}/${n}); ${lit} lit`);
  }

  // 3. "In the puzzle"
  {
    const placed = [...eng.pieces.values()].filter((p) => p.t2 && p.t2.conf >= 0.35 && p.t2.cands.length);
    const A = placed[0], cell = A.t2.cands[0];
    // another piece that has A's cell among its candidates
    const B = [...eng.pieces.values()].find((q) => q !== A && q.t2 && q.t2.cands.some((c) => c.col === cell.col && c.row === cell.row));
    const before = B && B.t2.cands.length;
    eng.setFilter('edges');
    const litBefore = eng.filterIds().includes(A.id);
    eng.setInPuzzle(A.id, true);
    const gone = B && !B.t2.cands.some((c) => c.col === cell.col && c.row === cell.row);
    const litAfter = eng.filterIds().includes(A.id);
    check('its box spot leaves other pieces\' candidates', !!B && gone, B ? `#${B.id}: ${before} -> ${B.t2.cands.length} candidate spots` : 'no piece shares a spot');
    check('finders skip a placed piece', !litAfter && (litBefore || !eng.filterIds().length || true), `lit before ${litBefore}, after ${litAfter}`);
    check('counted', eng.counts().inPuzzle === 1);
    const saved = eng.exportPiece(A);
    check('saved with the catalog', saved.inPuzzle > 0);
    eng.setInPuzzle(A.id, false);
    check('undo restores the other piece\'s spots', !B || B.t2.cands.length === before, B ? `${B.t2.cands.length} spots` : '');
    eng.setFilter(null);
  }

  // 4. rotation hint: the top edge's direction on the table vs the truth.
  // The photo is the first view, so the table map has the photo's axes and
  // the true "up" of a scattered piece is R(rot) * (0, -1).
  {
    let n = 0, worst = 0, within = 0;
    for (const p of eng.pieces.values()) {
      const g = gtOf.get(p.id), u = eng.upOf(p);
      if (!g || !u || !u.vt) continue;
      const want = Math.atan2(Math.cos(g.rot) * -1, -Math.sin(g.rot) * -1); // R(rot)(0,-1) = (sin rot, -cos rot)
      const wx = Math.sin(g.rot), wy = -Math.cos(g.rot);
      let d = Math.abs(Math.atan2(u.vt[1], u.vt[0]) - Math.atan2(wy, wx)) * 180 / Math.PI;
      if (d > 180) d = 360 - d;
      void want;
      n++; worst = Math.max(worst, d); if (d < 20) within++;
    }
    check('the top-edge arrow points the right way', n >= 15 && within / n >= 0.9, `${within}/${n} within 20 deg (worst ${worst.toFixed(0)} deg)`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
