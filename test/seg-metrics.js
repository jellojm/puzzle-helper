/* Shared segmentation metrics for seg-lab.js and seg-regression.js.
 * good  = single piece: 4 good corners and area 0.6-1.6x the robust unit
 * frag  = area < 0.45x unit (a piece broken into colour islands)
 * merged = area > 1.9x unit */
'use strict';
const PH = globalThis.PH;

// Robust "one piece" area: mass-weighted mode of log2(area) over blobs that
// look like a piece. Fragments are many but small, so they carry little mass.
function robustUnit(dets) {
  const bins = new Map();
  for (const d of dets) {
    if (d.border || d.area < 40) continue;
    if (PH.pieceScore(d.pts, d.area) <= PH.MIN_CORNER_SCORE) continue;
    const k = Math.round(Math.log2(d.area) * 4);
    bins.set(k, (bins.get(k) || 0) + d.area);
  }
  let best = null;
  for (const [k, m] of bins) if (!best || m > best.m) best = { k, m };
  return best ? Math.pow(2, best.k / 4) : null;
}

function classify(dets, unit) {
  const out = { blobs: dets.length, good: 0, frag: 0, merged: 0, border: 0, other: 0 };
  for (const d of dets) {
    if (d.border) { out.border++; d.cls = 'border'; continue; }
    const r = unit ? d.area / unit : 1;
    const like = PH.pieceScore(d.pts, d.area) > PH.MIN_CORNER_SCORE;
    if (r < 0.45) { out.frag++; d.cls = 'frag'; }
    else if (r > 1.9) { out.merged++; d.cls = 'merged'; }
    else if (like && r >= 0.6 && r <= 1.6) { out.good++; d.cls = 'good'; }
    else { out.other++; d.cls = 'other'; }
  }
  return out;
}

module.exports = { robustUnit, classify };
