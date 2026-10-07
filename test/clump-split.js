/* Splitting touching pieces: synthetic clumps of 2-4 real-shaped pieces
 * (test/synth.js outlines) pushed together at random angles, with the true
 * piece masks. Each splitter is scored by clumps split exactly right (one
 * part per piece, each part overlapping its piece >= 85%).
 *   node test/clump-split.js [n=200] [--draw]
 * Splitters: watershed (PH.splitBlob), notches (PH.splitConcave), corners
 * (PH.splitCorners: tabs and blanks smoothed off, cuts from inward ~90 deg
 * corners along the neighbouring sides). */
'use strict';
const path = require('path');
const S = require('./synth');
const { writeJpg } = require('./imageio');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const N = +(process.argv[2] || 200), DRAW = process.argv.includes('--draw');
  const P = S.makePuzzle(cv, { cols: 10, rows: 8, cs: 100, seed: 3 });
  const rnd = S.makeRng(5);
  const SIDE = +(process.env.SIDE || 40);
  if (process.env.KNOB) PH.CORNER_KNOB = +process.env.KNOB;
  if (process.env.MINP) PH.CORNER_MIN_PART = +process.env.MINP;
  if (process.env.MAXCUT) PH.CORNER_MAX_CUT = +process.env.MAXCUT;
  if (process.env.EPS) PH.CORNER_EPS = +process.env.EPS; // piece side in px (the live view: ~33-60)
  const k = SIDE / P.cs;
  const W = Math.ceil(SIDE * 7), H = W;
  // one piece's outline, rotated by a and placed with its core centre at (x, y)
  const place = (p, a, x, y) => {
    const c = Math.cos(a) * k, s = Math.sin(a) * k, cx = p.c * P.cs + P.cs / 2, cy = p.r * P.cs + P.cs / 2;
    return p.poly.map(([u, v]) => [x + c * (u - cx) - s * (v - cy), y + s * (u - cx) + c * (v - cy)]);
  };
  const fill = (poly) => {
    const m = cv.Mat.zeros(H, W, cv.CV_8UC1), pm = cv.matFromArray(poly.length, 1, cv.CV_32SC2, [].concat(...poly.map(([x, y]) => [Math.round(x), Math.round(y)]))), mv = new cv.MatVector();
    mv.push_back(pm); cv.fillPoly(m, mv, new cv.Scalar(255)); pm.delete(); mv.delete();
    return m;
  };
  const overlap = (a, b) => { const t = new cv.Mat(); cv.bitwise_and(a, b, t); const n = cv.countNonZero(t); t.delete(); return n; };
  const names = ['watershed', 'notches', 'corners', 'both'];
  const score = Object.fromEntries(names.map((n) => [n, { ok: 0, n: 0, parts: 0, ms: 0 }]));
  const byN = {};
  let drawn = 0;
  for (let t = 0; t < N; t++) {
    const n = 2 + Math.floor(rnd() * 3);
    // pieces one by one: each new one comes in from a random direction
    // towards the clump until it just touches (1-2 px overlap)
    const masks = [];
    let clump = cv.Mat.zeros(H, W, cv.CV_8UC1);
    for (let i = 0; i < n; i++) {
      const p = P.pieces[Math.floor(rnd() * P.pieces.length)], a = rnd() * Math.PI * 2;
      let m;
      if (!i) m = fill(place(p, a, W / 2, H / 2));
      else {
        const d = rnd() * Math.PI * 2;
        let r = SIDE * 4, last = null;
        for (; r > 0; r -= 1) {
          const q = fill(place(p, a, W / 2 + Math.cos(d) * r, H / 2 + Math.sin(d) * r));
          const ov = overlap(q, clump);
          if (ov > SIDE * 0.5) { q.delete(); break; }
          if (last) last.delete();
          last = q;
        }
        m = last;
      }
      // pieces don't overlap: what a later piece would cover stays the earlier one's
      const free = new cv.Mat(); cv.bitwise_not(clump, free); cv.bitwise_and(m, free, m); free.delete();
      masks.push(m);
      cv.bitwise_or(clump, m, clump);
    }
    const cs = new cv.MatVector(), hh = new cv.Mat();
    cv.findContours(clump, cs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    let ci = 0, ca = 0; for (let i = 0; i < cs.size(); i++) { const a = cv.contourArea(cs.get(i)); if (a > ca) { ca = a; ci = i; } }
    const cnt = cs.get(ci);
    const unitA = PH.median(masks.map((m) => cv.countNonZero(m)));
    const lab = new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(128, 128, 128)); // flat: watershed sees only the shape
    if (!byN[n]) byN[n] = Object.fromEntries(names.map((x) => [x, 0]));
    byN[n].n = (byN[n].n || 0) + 1;
    for (const name of names) {
      const t0 = Date.now();
      const out = name === 'watershed' ? PH.splitBlob(cnt, lab, unitA, W, H) : name === 'notches' ? PH.splitConcave(cnt, unitA) : name === 'corners' ? PH.splitCorners(cnt, unitA, W, H) : PH.splitTouching(cnt, unitA, W, H);
      score[name].ms += Date.now() - t0;
      const parts = out ? out.map((c) => { const pm = cv.Mat.zeros(H, W, cv.CV_8UC1), mv = new cv.MatVector(); mv.push_back(c); cv.drawContours(pm, mv, 0, new cv.Scalar(255), -1); mv.delete(); return pm; }) : [clump.clone()];
      // each true piece: its best part must cover >= 85% of it and be >= 85% it
      let good = parts.length === n;
      if (good) for (const m of masks) {
        const am = cv.countNonZero(m);
        if (!parts.some((q) => { const o = overlap(q, m); return o >= 0.85 * am && o >= 0.85 * cv.countNonZero(q); })) { good = false; break; }
      }
      score[name].n++; score[name].parts += parts.length;
      if (good) { score[name].ok++; byN[n][name]++; }
      if (DRAW && name === 'both' && !good && drawn < 12) {
        const o = new Uint8Array(W * H * 4);
        for (let p = 0; p < W * H; p++) { const v = clump.data[p] ? 90 : 0; o[4 * p] = o[4 * p + 1] = o[4 * p + 2] = v; o[4 * p + 3] = 255; }
        parts.forEach((q, j) => { const col = [[255, 80, 80], [80, 255, 80], [80, 140, 255], [255, 220, 0], [255, 0, 255]][j % 5]; const e = new cv.Mat(); cv.Canny(q, e, 50, 100); for (let p = 0; p < W * H; p++) if (e.data[p]) { o[4 * p] = col[0]; o[4 * p + 1] = col[1]; o[4 * p + 2] = col[2]; } e.delete(); });
        writeJpg(path.join(__dirname, 'out', `clump-${drawn++}.jpg`), W, H, o);
      }
      parts.forEach((q) => q.delete());
      if (out) out.forEach((c) => c.delete());
    }
    masks.forEach((m) => m.delete()); clump.delete(); cs.delete(); hh.delete(); lab.delete();
  }
  const pct = (x) => score[x].ok / score[x].n;
  const ok = pct('both') >= 0.74 && pct('both') >= pct('notches') + 0.03;
  for (const name of names) {
    const s = score[name];
    console.log(`${name.padEnd(10)} exactly right ${s.ok}/${s.n} (${(100 * s.ok / s.n).toFixed(0)}%)  by pieces ${Object.keys(byN).map((n) => n + ':' + byN[n][name] + '/' + byN[n].n).join(' ')}  ${(s.ms / s.n).toFixed(1)} ms`);
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  notches + corners split >= 74% of clumps exactly right, and beat notches alone by 3+ points`);
  process.exitCode = ok ? 0 : 1;
})();
