/* Box-placement check on a real puzzle picture.
 * Usage: node test/real-box.js [photo=test/fixtures/chickens-box.jpg] [pieces=1000]
 * 1. auto-detects the picture corners in the photo (saves test/out/real-corners.jpg)
 * 2. builds the box grid
 * 3. cuts jigsaw pieces from the rectified picture, scatters a sample on a
 *    table (with color shift + blur), and measures placement + matching. */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
const { readImage, writeJpg } = require('./imageio');
globalThis.self = globalThis;
for (const f of ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'engine']) require(path.join(__dirname, '..', 'js', 'vision', f + '.js'));
const PH = globalThis.PH;
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const file = process.argv[2] || path.join(__dirname, 'fixtures', 'chickens-box.jpg');
  const pieces = parseInt(process.argv[3] || '1000', 10);
  const img = readImage(file);
  console.log(`photo ${img.w}x${img.h}`);

  let t = Date.now();
  const corners = PH.detectBoxCorners(img);
  console.log(`corners (${Date.now() - t} ms):`, corners && JSON.stringify(corners.map((c) => c.map(Math.round))));
  {
    const m = new cv.Mat(img.h, img.w, cv.CV_8UC4); m.data.set(img.data);
    if (corners) for (let i = 0; i < 4; i++) cv.line(m, new cv.Point(...corners[i]), new cv.Point(...corners[(i + 1) % 4]), new cv.Scalar(0, 255, 255, 255), 8);
    const s = new cv.Mat(); cv.resize(m, s, new cv.Size(Math.round(img.w / 3), Math.round(img.h / 3)));
    writeJpg(path.join(OUT, 'real-corners.jpg'), s.cols, s.rows, s.data); m.delete(); s.delete();
  }
  if (!corners) { console.log('No corners found'); return; }
  t = Date.now();
  const box = PH.createBox(img, corners, { pieces });
  console.log(`box grid ${box.cols}x${box.rows} = ${box.cols * box.rows} cells (${Date.now() - t} ms)`);
  writeJpg(path.join(OUT, 'real-rectified.jpg'), box.preview.w, box.preview.h, box.preview.data);

  // Cut the rectified picture into a jigsaw with the same grid.
  const warped = new cv.Mat(box.preview.h, box.preview.w, cv.CV_8UC4); warped.data.set(box.preview.data);
  const P = S.makePuzzle(cv, { cols: box.cols, rows: box.rows, cs: 48, seed: 9, image: warped });
  // Sample: a 10x10 block (to test matching) + 60 random pieces elsewhere.
  const rnd = S.makeRng(4);
  const r0 = Math.floor(box.rows * 0.55), c0 = Math.floor(box.cols * 0.3);
  const subset = [];
  for (let r = r0; r < r0 + 10; r++) for (let c = c0; c < c0 + 10; c++) subset.push(r * box.cols + c);
  while (subset.length < 160) { const k = (rnd() * P.pieces.length) | 0; if (!subset.includes(k)) subset.push(k); }
  const sc = S.scatter(cv, P, { scale: 2.2, seed: 6, subset, felt: [30, 30, 34], gain: 0.9, offset: 6 });
  writeJpg(path.join(OUT, 'real-table.jpg'), sc.TW, sc.TH, sc.table.data);

  const eng = new PH.Engine();
  eng.setBox(box);
  const snap = eng.processSnap(S.matSource(cv, sc.table));
  console.log(`snap of ${subset.length} pieces: found ${snap.found}, shapes ${snap.shaped}, ${snap.ms.toFixed(0)} ms`);

  // Ground truth by position; placement accuracy split by texture.
  const gtOf = new Map();
  for (const p of eng.pieces.values()) {
    if (!p.t1) continue;
    const cx = p.t1.corners.reduce((s, c) => s + c[0], 0) / 4, cy = p.t1.corners.reduce((s, c) => s + c[1], 0) / 4;
    let best = null;
    for (const g of sc.gt) { const d = Math.hypot(g.x - cx, g.y - cy); if (!best || d < best.d) best = { d, g }; }
    if (best.d < sc.core * 0.3) gtOf.set(p.id, best.g);
  }
  const buckets = { plain: [0, 0, 0, 0], textured: [0, 0, 0, 0] }; // n, top1, top5, top-1 within 1 cell
  let codeOk = 0;
  for (const [id, g] of gtOf) {
    const p = eng.pieces.get(id);
    if (PH.canonicalCode(p.t1.code) === PH.canonicalCode(g.code)) codeOk++;
    if (!p.t2 || !p.t2.cands.length) continue;
    const b = buckets[p.t2.tex < 0.35 ? 'plain' : 'textured'];
    const k = p.t2.cands.findIndex((c) => c.col === g.c && c.row === g.r);
    const c = p.t2.cands[0];
    b[0]++; if (k === 0) b[1]++; if (k >= 0 && k < 5) b[2]++; if (Math.abs(c.col - g.c) <= 1 && Math.abs(c.row - g.r) <= 1) b[3]++;
  }
  const pc = (a, n) => (n ? ((100 * a) / n).toFixed(0) + '%' : 'n/a');
  console.log(`shape read for ${gtOf.size}/${subset.length}, edge codes right ${pc(codeOk, gtOf.size)}`);
  for (const [k, b] of Object.entries(buckets)) console.log(`placement, ${k} pieces (${b[0]}): top-1 ${pc(b[1], b[0])}, top-5 ${pc(b[2], b[0])}, top-1 within 1 cell ${pc(b[3], b[0])}`);

  // Matching inside the 10x10 block (catalog = all 160 sampled pieces).
  const byCell = new Map(); for (const [id, g] of gtOf) byCell.set(g.r * box.cols + g.c, id);
  let tot = 0, top1 = 0, top3 = 0;
  for (const [id, g] of gtOf) {
    if (g.r <= r0 || g.r >= r0 + 9 || g.c <= c0 || g.c >= c0 + 9) continue; // interior of the block: all 4 neighbors present
    const p = eng.pieces.get(id);
    const nb = [[0, -1], [1, 0], [0, 1], [-1, 0]].map(([dc, dr]) => byCell.get((g.r + dr) * box.cols + g.c + dc)).filter(Boolean);
    for (const r of PH.findMatches(p, eng.pieces.values(), { topN: 10 })) {
      if (r.type === 'F') continue;
      tot++;
      if (r.matches[0] && nb.includes(r.matches[0].id)) top1++;
      if (r.matches.slice(0, 3).some((m) => nb.includes(m.id))) top3++;
    }
  }
  // 2x2 loop confirmation: how often is a loop-confirmed top match right?
  {
    let edges = 0, conf = 0, confOk = 0, ms = 0, n = 0;
    for (const [id, g] of gtOf) {
      if (g.r <= r0 || g.r >= r0 + 9 || g.c <= c0 || g.c >= c0 + 9) continue;
      const p = eng.pieces.get(id);
      const nb = [[0, -1], [1, 0], [0, 1], [-1, 0]].map(([dc, dr]) => byCell.get((g.r + dr) * box.cols + g.c + dc)).filter(Boolean);
      const t0 = Date.now();
      const res = PH.findMatches(p, eng.pieces.values(), { topN: 10 });
      PH.confirmWithLoops(res, PH.findLoops(p, eng.pieces.values(), { K: 6 }));
      ms += Date.now() - t0; n++;
      for (const r of res) {
        if (r.type === 'F') continue;
        edges++;
        if (r.matches[0] && r.matches[0].loopOk) { conf++; if (nb.includes(r.matches[0].id)) confOk++; }
      }
    }
    console.log(`2x2 loop confirms ${pc(conf, edges)} of top matches; confirmed ones are right ${pc(confOk, conf)} (${(ms / Math.max(1, n)).toFixed(0)} ms/piece)`);
  }
  console.log(`matching inside the block (${tot} edges): best match is a true neighbor ${pc(top1, tot)}, one in top-3 ${pc(top3, tot)}`);
})();
