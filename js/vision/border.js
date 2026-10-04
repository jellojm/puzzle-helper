/* The finished border, found automatically, and the puzzle read cell by cell.
 *
 * Late in a puzzle the border is complete. Seen whole, the puzzle is a big
 * four-sided patch printed with the box picture's colours; the table isn't.
 * PH.findBorderQuad finds that patch's four outer corners (and which one is
 * the box picture's top-left), which gives every box cell's place in the view
 * (the marked-border machinery in frame.js then follows it into later views).
 * PH.readCells then looks at each cell: does it show the box picture there
 * (a piece is in place) or the table (an open spot)? That works where an
 * outline can't: seen whole, the big white puzzle can look like the "table"
 * to the piece finder, and dark print looks like dark glass - but a cell of
 * dark hen still matches the box's dark hen.
 * Corner order everywhere: the box picture's TL, TR, BR, BL. */
(function (G) {
  const PH = G.PH;
  const bin = (L, a, b) => ((L >> 5) << 8) | ((a >> 4) << 4) | (b >> 4); // 8 x 16 x 16 Lab bins
  const NB = 2048;
  const odd = (v) => Math.max(3, Math.round(v) | 1);

  // Colour histogram of the box picture (normalised), computed once.
  function boxHist(box) {
    if (box.hist2k) return box.hist2k;
    const h = new Float32Array(NB), L = box.lab, n = L.length / 3;
    for (let i = 0; i < L.length; i += 3) h[bin(L[i], L[i + 1], L[i + 2])]++;
    for (let k = 0; k < NB; k++) h[k] /= n;
    return (box.hist2k = h);
  }
  const lineOf = (pts) => { // total least squares line through points: {x0,y0,dx,dy}
    let mx = 0, my = 0;
    for (const [x, y] of pts) { mx += x; my += y; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { x0: mx, y0: my, dx: Math.cos(a), dy: Math.sin(a) };
  };
  const meet = (p, q) => { // intersection of two lines
    const det = p.dx * q.dy - p.dy * q.dx;
    if (Math.abs(det) < 1e-6) return null;
    const t = ((q.x0 - p.x0) * q.dy - (q.y0 - p.y0) * q.dx) / det;
    return [p.x0 + p.dx * t, p.y0 + p.dy * t];
  };

  /**
   * Find the finished puzzle in an image.
   * @param img {w,h,data:RGBA} (the analysed view)
   * @returns {corners:[[x,y]x4] (box TL,TR,BR,BL), score, margin, area} or null (with .why when debugging)
   */
  PH.findBorderQuad = function (img, box, dbg) {
    const cv = PH.cv, w = img.w, h = img.h;
    const lab = PH.rgbaToLab(img.data, w, h);
    const hb = boxHist(box), hf = new Float32Array(NB);
    for (let i = 0; i < lab.length; i += 3) hf[bin(lab[i], lab[i + 1], lab[i + 2])]++;
    for (let k = 0; k < NB; k++) hf[k] /= w * h;
    // Puzzle pixels: bright (a finished border is a ring of light pieces, and
    // the owner's table is darker glass: Otsu on lightness), or a colour more
    // common in the box picture than in this view (colourful print).
    const Lm = new cv.Mat(h, w, cv.CV_8UC1);
    for (let p = 0; p < w * h; p++) Lm.data[p] = lab[3 * p];
    const m = new cv.Mat();
    cv.threshold(Lm, m, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    Lm.delete();
    const md = m.data;
    for (let p = 0, i = 0; p < w * h; p++, i += 3) { if (md[p]) continue; const k = bin(lab[i], lab[i + 1], lab[i + 2]); if (hb[k] > hf[k] && hb[k] > 2e-4) md[p] = 255; }
    const s = Math.min(w, h);
    // light clean-up: specks off, the seams between pieces closed
    const ko = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(odd(s * 0.006), odd(s * 0.006)));
    cv.morphologyEx(m, m, cv.MORPH_OPEN, ko);
    const kc = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(odd(s * 0.008), odd(s * 0.008)));
    cv.morphologyEx(m, m, cv.MORPH_CLOSE, kc);
    // The rough shape after a strong opening (~2 pieces wide): thin links to
    // the box lid or to loose pieces lying close by are cut, the puzzle stays.
    // (holes - open spots and dark print - filled first: the opening
    // should only cut thin links, not the puzzle's own ribbons)
    const big = cv.Mat.zeros(h, w, cv.CV_8UC1);
    { const cs = new cv.MatVector(), hh = new cv.Mat();
      cv.findContours(m, cs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      cv.drawContours(big, cs, -1, new cv.Scalar(255), -1);
      cs.delete(); hh.delete(); }
    const filled = big.clone(); // for the sides: the detailed outline, holes filled
    if (dbg) dbg.filled = new Uint8Array(filled.data);
    const kb = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(odd(s * 0.05), odd(s * 0.05)));
    cv.morphologyEx(big, big, cv.MORPH_OPEN, kb);
    if (dbg) dbg.opened = new Uint8Array(big.data);
    const largest = (mat) => {
      const cs = new cv.MatVector(), hh = new cv.Mat();
      cv.findContours(mat, cs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      let b = null, a0 = 0;
      for (let i = 0; i < cs.size(); i++) { const c = cs.get(i), a = cv.contourArea(c); if (a > a0) { if (b) b.delete(); b = c; a0 = a; } else c.delete(); }
      cs.delete(); hh.delete();
      return { c: b, a: a0 };
    };
    if (dbg) dbg.mask = new Uint8Array(m.data);
    const rough = largest(big);
    const fine = largest(filled);
    [m, big, filled, ko, kc, kb].forEach((x) => x.delete());
    let best = rough.c;
    const ba = rough.a;
    const fail = (why) => { if (best) best.delete(); if (fine.c) fine.c.delete(); if (dbg) dbg.why = why; return null; };
    if (!best || ba < w * h * 0.08) return fail('no big box-coloured patch');
    // four corners: the rough hull simplified to 4 points, then each side
    // refitted as a line through the detailed outline's points along it
    // (pieces lying against the border make bumps; the long straight runs win)
    const hull = new cv.Mat(); cv.convexHull(best, hull);
    let quad = null;
    for (let eps = 0.01; eps < 0.2 && !quad; eps += 0.01) {
      const ap = new cv.Mat(); cv.approxPolyDP(hull, ap, eps * cv.arcLength(hull, true), true);
      if (ap.rows === 4) quad = Array.from({ length: 4 }, (_, k) => [ap.data32S[2 * k], ap.data32S[2 * k + 1]]);
      ap.delete();
    }
    hull.delete();
    if (dbg) { dbg.rough = quad; const t = new cv.Mat(h, w, cv.CV_8UC1); dbg.big = null; t.delete(); }
    best.delete(); best = fine.c; fine.c = null;
    const P = best.data32S, n = P.length / 2;
    best.delete(); best = null;
    if (!quad) return fail('not four-sided');
    // clockwise on screen (y down)
    const area2 = quad.reduce((acc, p, k) => { const q = quad[(k + 1) % 4]; return acc + p[0] * q[1] - q[0] * p[1]; }, 0);
    if (area2 < 0) quad.reverse();
    const lines = [];
    for (let k = 0; k < 4; k++) {
      const A = quad[k], B = quad[(k + 1) % 4], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const ux = (B[0] - A[0]) / L, uy = (B[1] - A[1]) / L, near = [];
      for (let i = 0; i < n; i++) {
        const x = P[2 * i] - A[0], y = P[2 * i + 1] - A[1], t = x * ux + y * uy, d = Math.abs(-x * uy + y * ux);
        if (t > L * 0.1 && t < L * 0.9 && d < s * 0.015) near.push([P[2 * i], P[2 * i + 1]]);
      }
      if (near.length < 20) return fail('a side is not straight');
      lines.push(lineOf(near));
    }
    const corners = [];
    for (let k = 0; k < 4; k++) { const c = meet(lines[(k + 3) % 4], lines[k]); if (!c) return fail('sides do not meet'); corners.push(c); }
    for (const [x, y] of corners) if (x < -w * 0.02 || y < -h * 0.02 || x > w * 1.02 || y > h * 1.02) return fail('runs off the view');
    if (dbg) dbg.corners = corners;
    // proportions: the long sides should be the box's long sides
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const sA = (d(corners[0], corners[1]) + d(corners[2], corners[3])) / 2, sB = (d(corners[1], corners[2]) + d(corners[3], corners[0])) / 2;
    const boxAsp = box.cols / box.rows;
    // which corner is the box picture's top-left: the turns whose shape fits
    // the box, compared with the picture itself
    const cands = [];
    for (let k = 0; k < 4; k++) {
      const c = [0, 1, 2, 3].map((j) => corners[(j + k) % 4]);
      const asp = k % 2 ? sB / sA : sA / sB;
      if (Math.abs(Math.log(asp / boxAsp)) > 0.3) continue;
      cands.push({ k, c, asp, score: PH.gridCorrelation(img, lab, c, box) });
    }
    if (!cands.length) return fail(`proportions ${(sA / sB).toFixed(2)} don't match the box (${boxAsp.toFixed(2)})`);
    cands.sort((a, b) => b.score - a.score);
    const win = cands[0], margin = cands[1] ? win.score - cands[1].score : win.score;
    if (dbg) dbg.cands = cands.map((x) => ({ k: x.k, asp: +x.asp.toFixed(2), score: +x.score.toFixed(3) }));
    if (win.score < 0.25 || margin < 0.08) return fail(`picture doesn't match the box clearly (${win.score.toFixed(2)}, lead ${margin.toFixed(2)})`);
    return { corners: win.c, score: win.score, margin, area: ba / (w * h) };
  };

  // The view's lightness inside quad `c` (box TL,TR,BR,BL) warped onto the
  // box grid at 12 px per cell, as a Uint8Array (cols*12 x rows*12), blurred
  // like the box's half-resolution lightness.
  function warpL(img, lab, c, box) {
    const cv = PH.cv, S = PH.SQ / 2, W = box.cols * S, H = box.rows * S;
    const L = new cv.Mat(img.h, img.w, cv.CV_8UC1);
    for (let p = 0, n = img.w * img.h; p < n; p++) L.data[p] = lab[3 * p];
    const M = cv.matFromArray(3, 3, cv.CV_64F, PH.quadHomography([[0, 0], [W, 0], [W, H], [0, H]], c));
    const out = new cv.Mat();
    cv.warpPerspective(L, out, M, new cv.Size(W, H), cv.INTER_AREA | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE);
    cv.GaussianBlur(out, out, new cv.Size(5, 5), 1.2);
    const r = new Uint8Array(out.data);
    [L, M, out].forEach((x) => x.delete());
    return r;
  }
  // The box's lightness at 24 px per cell, blurred like readCells' view.
  function boxFullL(box) {
    if (box.Lfull) return box.Lfull;
    const cv = PH.cv, n = box.W * box.H, m = new cv.Mat(box.H, box.W, cv.CV_8UC1);
    for (let p = 0; p < n; p++) m.data[p] = box.lab[3 * p];
    cv.GaussianBlur(m, m, new cv.Size(5, 5), 1.2);
    box.Lfull = new Uint8Array(m.data); m.delete();
    return box.Lfull;
  }
  /** Pearson correlation of the view (inside quad c) with the box picture. */
  PH.gridCorrelation = function (img, lab, c, box) {
    const A = warpL(img, lab, c, box), B = PH.boxHalfL(box);
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    const n = A.length;
    for (let i = 0; i < n; i++) { const a = A[i], b = B[i]; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; }
    const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
    return va > 0 && vb > 0 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : 0;
  };

  /**
   * Read every box cell visible in an image: piece in place, or open?
   * @param img {w,h,data:RGBA}; H = box grid (cells) -> image homography
   * @returns {cells: Int8Array (1 filled, -1 open, 0 unsure / not in view, by row*cols+col), stats}
   */
  PH.readCells = function (img, H, box, dbg) {
    // 24 px per cell, and only each cell's middle is compared: a hole's
    // square still holds its neighbours' tabs (up to ~30% in from each side),
    // which carry the box picture's print and would make a hole look filled.
    const cv = PH.cv, S = PH.SQ, cols = box.cols, rows = box.rows, W = cols * S, Hh = rows * S;
    const lab = PH.rgbaToLab(img.data, img.w, img.h);
    // the puzzle warped onto the box grid (Lab, 24 px per cell)
    const src = new cv.Mat(img.h, img.w, cv.CV_8UC3); src.data.set(lab);
    const Hs = PH.homMul(H, [1 / S, 0, 0, 0, 1 / S, 0, 0, 0, 1]); // box px (24/cell) -> image
    const M = cv.matFromArray(3, 3, cv.CV_64F, Hs);
    const wl = new cv.Mat();
    cv.warpPerspective(src, wl, M, new cv.Size(W, Hh), cv.INTER_AREA | cv.WARP_INVERSE_MAP, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0));
    const WL = new Uint8Array(wl.data);
    [src, M, wl].forEach((x) => x.delete());
    const BL = boxFullL(box), BLab = box.lab, BW = box.W; // the box's lightness and Lab, 24 px/cell (BW = W)
    // which cells can be judged: their whole square inside the image
    const inImg = (x, y) => x >= 0 && y >= 0 && x < img.w && y < img.h;
    const cells = new Int8Array(cols * rows), feats = dbg ? [] : null;
    const Lw = new Uint8Array(W * Hh);
    for (let p = 0; p < W * Hh; p++) Lw[p] = WL[3 * p];
    // blurred like the box's lightness (boxFullL)
    const lm = new cv.Mat(Hh, W, cv.CV_8UC1); lm.data.set(Lw); cv.GaussianBlur(lm, lm, new cv.Size(5, 5), 1.2); Lw.set(lm.data); lm.delete();
    const vis = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
      if ([[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]].every(([x, y]) => { const q = PH.applyHom(H, x, y); return inImg(q[0], q[1]); })) vis.push(r * cols + c);
    // mean Lab of a cell's middle third
    const meanView = (c, r) => { let L = 0, a = 0, b = 0, n = 0; for (let y = 8; y < S - 8; y++) for (let x = 8; x < S - 8; x++) { const p = 3 * ((r * S + y) * W + c * S + x); L += WL[p]; a += WL[p + 1]; b += WL[p + 2]; n++; } return [L / n, a / n, b / n]; };
    const SB = PH.SQ, meanBox = (c, r) => { let L = 0, a = 0, b = 0, n = 0; for (let y = 8; y < SB - 8; y++) for (let x = 8; x < SB - 8; x++) { const p = 3 * ((r * SB + y) * BW + c * SB + x); L += BLab[p]; a += BLab[p + 1]; b += BLab[p + 2]; n++; } return [L / n, a / n, b / n]; };
    const mv = new Map(), mb = new Map();
    for (const id of vis) { const c = id % cols, r = (id / cols) | 0; mv.set(id, meanView(c, r)); mb.set(id, meanBox(c, r)); }
    // The room's light shifts every colour the same way (warm lamp vs the
    // printed box): the median view-minus-box difference, taken out.
    const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
    const off = [0, 1, 2].map((k) => med(vis.map((id) => mv.get(id)[k] - mb.get(id)[k])));
    // print: best correlation with the box cell's middle (10 x 10 of 24 x 24)
    // over shifts of up to 3 px (a small misregistration would sink it)
    // (also: how much fine detail the view has against the box cell, at no
    // shift - a hole shows smooth glass where the box has feathers)
    let detail = 1;
    const ncc = (c, r) => {
      let best = -1, plain = true;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
        for (let y = 7; y < S - 7; y++) for (let x = 7; x < S - 7; x++) {
          const yy = r * S + y + dy, xx = c * S + x + dx;
          if (yy < 0 || xx < 0 || yy >= Hh || xx >= W) continue;
          const a = Lw[yy * W + xx], b = BL[(r * S + y) * W + c * S + x];
          sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
        }
        const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
        if (vb < n * 6) continue; // the box cell is plain here: print can't tell
        plain = false;
        if (!dx && !dy) detail = va / vb;
        if (va > n * 2) best = Math.max(best, (sab - (sa * sb) / n) / Math.sqrt(va * vb));
        else best = Math.max(best, 0); // a plain view of a printed cell: no match
      }
      return plain ? null : best;
    };
    let nF = 0, nO = 0;
    for (const id of vis) {
      const c = id % cols, r = (id / cols) | 0;
      const v = mv.get(id), b = mb.get(id);
      const dE = PH.dE(v[0] - off[0], v[1] - off[1], v[2] - off[2], b[0], b[1], b[2], 0.6);
      detail = 1;
      const k = ncc(c, r);
      // filled: the print matches (and the view has some of the box cell's
      // detail - a nearly flat patch correlates by chance), or for a plain
      // cell the colour does. open: neither print nor colour matches, or the
      // box has fine print and the view is smooth (glass through a hole).
      // Kept strict on purpose: a spot shown as open that isn't is worse
      // than one found a few views later.
      let state = 0;
      const k2 = k !== null && detail >= 0.2 ? k : k === null ? null : 0;
      if ((k2 !== null && k2 > 0.5) || (k === null && dE < 10) || (k2 !== null && k2 > 0.35 && dE < 12)) state = 1;
      else if ((dE > 18 && (k2 === null || k2 < 0.3)) || (k !== null && k < 0.3 && detail < 0.35 && dE > 8)) state = -1;
      cells[id] = state;
      if (state > 0) nF++; else if (state < 0) nO++;
      if (feats) feats.push({ c, r, ncc: k === null ? null : +k.toFixed(2), dE: +dE.toFixed(1), detail: +detail.toFixed(2), state });
    }
    if (dbg) { dbg.feats = feats; dbg.warp = WL; dbg.W = W; dbg.H = Hh; dbg.off = off; }
    return { cells, stats: { filled: nF, open: nO } };
  };
})(typeof self !== 'undefined' ? self : globalThis);
