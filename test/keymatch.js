/* Answer key <-> catalogue for the real-video tests. The key holds each
 * piece's centre in the opening overview frame (filmed at a slight angle);
 * entries sit on the engine's table map (straightened). A similarity fit
 * leaves the far edge off by more than half a piece, so: a similarity by
 * RANSAC to start, then a homography refitted on the nearest pairs.
 *   const M = fitKey(cv, PH, key, entries[, seed])  ->  M.map(x, y) = [mx, my], M.unit, M.inliers
 */
'use strict';

function fitKey(cv, PH, key, entries, seed) {
  const pts = entries.filter((p) => p.pos);
  const unit = Math.sqrt(PH.median(pts.map((p) => p.area || 1000)));
  const near = (q, tol) => { let b = null, bd = Infinity; for (const p of pts) { const d = Math.hypot(p.pos[0] - q[0], p.pos[1] - q[1]); if (d < bd) { bd = d; b = p; } } return bd < tol ? b : null; };
  // 1. similarity by RANSAC over random pairs - or, given key pieces whose
  // entries are known (`seed`: [[keyPiece, entry]], identity from the
  // overview), fitted to those: the key is a near-symmetric grid, and with a
  // few rows unknown a fit by position alone can turn it half round (a
  // 2026-10-07 replay: rows 1-2 scored "missing", ~11 pieces off)
  const rnd = PH.mulberry32(3);
  let best = null;
  const sd = (seed || []).filter(([, e]) => e && e.pos);
  if (sd.length >= 6) { const T = PH.simFit(sd.map(([k]) => [k.x, k.y]), sd.map(([, e]) => e.pos)); if (T) best = { T, inl: Infinity }; }
  const seeded = !!best;
  for (let it = 0; it < 5000 && pts.length > 1 && !seeded; it++) {
    const a = key[Math.floor(rnd() * key.length)], b = key[Math.floor(rnd() * key.length)];
    const A = pts[Math.floor(rnd() * pts.length)], B = pts[Math.floor(rnd() * pts.length)];
    if (a === b || A === B) continue;
    const T = PH.simFit([[a.x, a.y], [b.x, b.y]], [A.pos, B.pos]);
    if (!T) continue;
    const used = new Set();
    for (const k of key) { const e = near(PH.simApply(T, k.x, k.y), unit * 0.6); if (e) used.add(e); }
    const inl = used.size; // distinct entries: a fit that piles keys onto one entry scores 1
    if (!best || inl > best.inl) best = { T, inl };
  }
  let map = (x, y) => PH.simApply(best.T, x, y);
  function distinct(f, tol) { const used = new Set(); for (const k of key) { const e = near(f(k.x, k.y), unit * tol); if (e) used.add(e); } return used.size; }
  // 2. homography on the nearest pairs, twice
  for (let round = 0; round < 3; round++) {
    const src = [], dst = [];
    for (const k of key) { const e = near(map(k.x, k.y), unit * (round ? 0.5 : 0.7)); if (e) { src.push(k.x, k.y); dst.push(e.pos[0], e.pos[1]); } }
    if (src.length < 8) break;
    const s = cv.matFromArray(src.length / 2, 1, cv.CV_32FC2, src), d = cv.matFromArray(dst.length / 2, 1, cv.CV_32FC2, dst);
    const H = cv.findHomography(s, d, cv.RANSAC, unit * 0.3);
    s.delete(); d.delete();
    if (!H || H.rows !== 3) { if (H) H.delete(); break; }
    const h = Array.from(H.data64F); H.delete();
    const cand = (x, y) => { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
    // keep it only if it doesn't collapse the layout and matches more distinct entries
    const spread = (f) => { const P = key.map((k) => f(k.x, k.y)); const mx = P.reduce((t, p) => t + p[0], 0) / P.length, my = P.reduce((t, p) => t + p[1], 0) / P.length; return Math.sqrt(P.reduce((t, p) => t + (p[0] - mx) ** 2 + (p[1] - my) ** 2, 0) / P.length); };
    const ratio = spread(cand) / spread(map);
    if (!(ratio > 0.8 && ratio < 1.25) || distinct(cand, 0.5) < distinct(map, 0.5)) break;
    map = cand;
  }
  // 3. local refinement: the engine's map bends a little over a long sweep,
  // so each key piece is predicted from the global fit plus the offset of
  // its already-matched neighbours; matches are mutual nearest only.
  const kd = key.map((k) => Math.min(...key.filter((j) => j !== k).map((j) => Math.hypot(j.x - k.x, j.y - k.y))));
  const R = PH.median(kd) * 2.6;
  let assign = new Map();
  for (let round = 0; round < 4; round++) {
    const pred = new Map();
    for (const k of key) {
      const g = map(k.x, k.y), off = [];
      for (const j of key) { const e = assign.get(j.n); if (!e || j === k || Math.hypot(j.x - k.x, j.y - k.y) > R) continue; const gj = map(j.x, j.y); off.push([e.pos[0] - gj[0], e.pos[1] - gj[1]]); }
      pred.set(k.n, off.length >= 2 ? [g[0] + PH.median(off.map((o) => o[0])), g[1] + PH.median(off.map((o) => o[1]))] : g);
    }
    const tol = unit * (round ? 0.5 : 0.35), next = new Map();
    for (const k of key) {
      const q = pred.get(k.n), e = near(q, tol);
      if (!e) continue;
      // mutual: no other key predicts closer to this entry
      let mine = true;
      for (const j of key) { if (j === k) continue; const qj = pred.get(j.n); if (Math.hypot(qj[0] - e.pos[0], qj[1] - e.pos[1]) < Math.hypot(q[0] - e.pos[0], q[1] - e.pos[1])) { mine = false; break; } }
      if (mine) next.set(k.n, e);
    }
    assign = next;
  }
  const inliers = distinct(map, 0.5);
  return { map, unit, inliers, assign };
}

module.exports = { fitKey };
