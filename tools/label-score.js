/* Score a report's pieces against labels made with tools/label.html.
 *   node tools/label-score.js <…-pieces.json> <…-labels.json> [other-pieces.json]
 * With a second pieces.json (the same report re-read by another build, same
 * piece ids) the two are compared on the same answer key.
 * Prints: outline verdicts, edge codes right (of the edges checked), corner
 * error (true corners, in piece sides), outline overlap with the traced true
 * outline (IoU), and the true joins / not-joins labelled.
 */
'use strict';
const fs = require('fs');
const [geoFile, labFile, geo2File] = process.argv.slice(2);
if (!geoFile || !labFile) { console.log('usage: node tools/label-score.js <pieces.json> <labels.json> [other pieces.json]'); process.exit(1); }
const L = JSON.parse(fs.readFileSync(labFile, 'utf8'));

// area of a polygon and the IoU of two polygons by rasterising both on a grid
function iou(a, b) { // a, b: flat [x,y,...]
  const xs = [...a.filter((_, i) => i % 2 === 0), ...b.filter((_, i) => i % 2 === 0)], ys = [...a.filter((_, i) => i % 2), ...b.filter((_, i) => i % 2)];
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), N = 200, sx = (x1 - x0) / N || 1, sy = (y1 - y0) / N || 1;
  const inside = (P, x, y) => { let c = false; for (let i = 0, j = P.length - 2; i < P.length; j = i, i += 2) { const xi = P[i], yi = P[i + 1], xj = P[j], yj = P[j + 1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  let I = 0, U = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { const x = x0 + (c + 0.5) * sx, y = y0 + (r + 0.5) * sy, A = inside(a, x, y), B = inside(b, x, y); if (A && B) I++; if (A || B) U++; }
  return U ? I / U : 0;
}
const med = (v) => { if (!v.length) return null; const s = [...v].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
const f2 = (v) => (v === null ? '-' : v.toFixed(2));

function score(file) {
  const geo = JSON.parse(fs.readFileSync(file, 'utf8')), by = new Map(geo.pieces.map((p) => [p.id, p]));
  const out = { file, outline: { ok: 0, wrong: 0, notPiece: 0 }, edges: 0, edgesRight: 0, cornerErr: [], iou: [], missing: 0 };
  for (const [ids, lb] of Object.entries(L.pieces)) {
    const p = by.get(+ids); if (!p) { out.missing++; continue; }
    if (lb.outline) out.outline[lb.outline]++;
    if (lb.codeOk && p.code) for (let k = 0; k < 4; k++) { out.edges++; if (p.code[k] === lb.code[k]) out.edgesRight++; }
    const d = p.detail, side = p.meanSide || 1;
    // labels are in the pixels of the read shown (the detail's read when there is one)
    const corners = d && d.corners ? d.corners : p.corners, outline = d && d.outline ? d.outline : null;
    if (lb.corners && lb.corners.length === 4 && corners) {
      // best cyclic alignment (true corners were started near corner 0, but be safe)
      let best = Infinity;
      for (let r = 0; r < 4; r++) best = Math.min(best, med(lb.corners.map((q, i) => Math.hypot(q[0] - corners[(i + r) % 4][0], q[1] - corners[(i + r) % 4][1]))));
      out.cornerErr.push(best / side);
    }
    if (lb.trace && lb.trace.length >= 6 && outline) out.iou.push(iou(lb.trace, outline));
  }
  return out;
}
function show(s) {
  console.log(`\n${s.file}`);
  console.log(`  outline (by eye): right ${s.outline.ok}, wrong ${s.outline.wrong}, not a piece ${s.outline.notPiece}${s.missing ? `; ${s.missing} labelled pieces missing here` : ''}`);
  console.log(`  edge codes right: ${s.edgesRight}/${s.edges}${s.edges ? ` (${Math.round((100 * s.edgesRight) / s.edges)}%)` : ''}`);
  console.log(`  corner error (median over pieces, piece sides): ${f2(med(s.cornerErr))} over ${s.cornerErr.length} pieces; worst ${f2(s.cornerErr.length ? Math.max(...s.cornerErr) : null)}`);
  console.log(`  outline vs trace IoU: median ${f2(med(s.iou))} over ${s.iou.length} pieces; worst ${f2(s.iou.length ? Math.min(...s.iou) : null)}`);
}
console.log(`labels ${L.report}: ${Object.keys(L.pieces).length} pieces labelled, ${L.joins.length} true joins, ${L.notJoins.length} not joins`);
show(score(geoFile));
if (geo2File) { show(score(geo2File)); console.log('\n  (outline verdicts are the labels\' own: they judge the first file\'s outlines)'); }
