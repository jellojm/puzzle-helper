/* Box image: warp the photographed lid flat, split it into the puzzle grid,
 * and place pieces on it (T2).
 *
 * Placement is fast because the T1 corners fix the piece's rotation to one of
 * 4 options and the grid fixes its scale, so there is no rotation/scale search.
 * A cheap color pre-filter over every cell picks ~20 candidates, which are then
 * compared pixel-by-pixel over a small window of offsets. */
(function (G) {
  const PH = G.PH;

  PH.chooseGrid = function (pieces, aspect) {
    let best = null;
    for (let cols = 2; cols <= 200; cols++) {
      const rows = Math.max(2, Math.round(pieces / cols));
      const score = Math.abs(Math.log(cols / rows / aspect)) + (2 * Math.abs(cols * rows - pieces)) / pieces;
      if (!best || score < best.score) best = { cols, rows, score };
    }
    return { cols: best.cols, rows: best.rows };
  };

  /**
   * @param img {w,h,data:RGBA} photo of the lid
   * @param corners [[x,y] x4] TL, TR, BR, BL in image pixels
   * @param opts {pieces, cols, rows}
   */
  PH.createBox = function (img, corners, opts) {
    const cv = PH.cv;
    const S = PH.SQ;
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const aspect = (d(corners[0], corners[1]) + d(corners[3], corners[2])) / (d(corners[0], corners[3]) + d(corners[1], corners[2]));
    let cols = opts.cols, rows = opts.rows;
    if (!cols || !rows) ({ cols, rows } = PH.chooseGrid(opts.pieces || 1000, aspect));
    const W = cols * S, H = rows * S;

    const src = new cv.Mat(img.h, img.w, cv.CV_8UC4);
    src.data.set(img.data);
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat(...corners));
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
    const M = cv.getPerspectiveTransform(from, to);
    const warped = new cv.Mat();
    cv.warpPerspective(src, warped, M, new cv.Size(W, H), cv.INTER_AREA, cv.BORDER_REPLICATE);
    const lab = PH.rgbaToLab(warped.data, W, H);

    // Preview image for the on-screen mini-map (max 720 px wide).
    const ps = Math.min(1, 720 / W);
    const prev = new cv.Mat();
    cv.resize(warped, prev, new cv.Size(Math.round(W * ps), Math.round(H * ps)), 0, 0, cv.INTER_AREA);
    const preview = { w: prev.cols, h: prev.rows, data: new Uint8ClampedArray(prev.data) };
    [src, from, to, M, warped, prev].forEach((m) => m.delete());

    // Box-photo pixels per piece side: below ~48 placement gets unreliable
    // (Piece Finder's threshold); the page warns.
    const srcPx = Math.min((d(corners[0], corners[1]) + d(corners[3], corners[2])) / 2 / cols, (d(corners[0], corners[3]) + d(corners[1], corners[2])) / 2 / rows);
    const box = { cols, rows, S, W, H, lab, preview, srcPx: Math.round(srcPx) };
    PH.computeCells(box);
    return box;
  };

  /** Sorting zones (tray sorting, PuzAI's main feature): the box picture in
   *  6 areas - 3 x 2, or 2 x 3 for a tall box - lettered A-F in reading
   *  order. A piece's zone is the area of its box spot. */
  PH.zoneGrid = (box) => (box.cols >= box.rows ? [3, 2] : [2, 3]);
  PH.zoneOf = function (box, col, row) {
    const [zc, zr] = PH.zoneGrid(box);
    return Math.min(zc - 1, Math.floor((col * zc) / box.cols)) + Math.min(zr - 1, Math.floor((row * zr) / box.rows)) * zc;
  };

  /**
   * One piece per cell: assign pieces to box cells so the total placement
   * score is (near) lowest, each cell holding at most one piece. Each piece
   * only bids for its own candidate cells plus a private "not placed" option
   * costing `none[i]`. Forward auction (Bertsekas), within n*eps of optimal: sparse,
   * so it stays fast for 1000 pieces x 6 candidates.
   * @param arcs  per piece: [{key, score}] (key = 'col,row'; lower score = better)
   * @param none  per piece: cost of leaving it unassigned
   * @returns per piece: the assigned key or null
   * On synthetic puzzles the optimal assignment lifted top-1 placement from
   * 84.2% to 87.3% (greedy, most confident first: no gain).
   */
  PH.assignCells = function (arcs, none) {
    const n = arcs.length, keys = new Map();
    // one arc per cell per piece (its best score there): a cell listed twice
    // (two rotations) would make the "second best" the same cell, and the
    // bid increment - the gap between them - meaningless
    const A = arcs.map((list) => {
      const best = new Map();
      for (const a of list) {
        let j = keys.get(a.key);
        if (j === undefined) { j = keys.size; keys.set(a.key, j); }
        if (!best.has(j) || -a.score > best.get(j)) best.set(j, -a.score);
      }
      return [...best].map(([j, b]) => ({ j, b }));
    });
    const M = keys.size;
    A.forEach((list, i) => list.push({ j: M + i, b: -none[i] })); // private "not placed"
    // One round at a fine step from zero prices. (eps-scaling keeps prices
    // between rounds, which is only right when every object must be taken;
    // with private "not placed" options it pushed ~60 of 96 pieces there.)
    const price = new Float64Array(M + n), owner = new Int32Array(M + n).fill(-1), asg = new Int32Array(n).fill(-1);
    const eps = 0.003, queue = [];
    for (let i = n - 1; i >= 0; i--) queue.push(i);
    let guard = 0;
    while (queue.length && guard++ < 5000000) {
      const i = queue.pop();
      let b1 = -Infinity, b2 = -Infinity, j1 = -1;
      for (const a of A[i]) {
        const v = a.b - price[a.j];
        if (v > b1) { b2 = b1; b1 = v; j1 = a.j; } else if (v > b2) b2 = v;
      }
      if (b2 === -Infinity) b2 = b1 - 1;
      price[j1] += b1 - b2 + eps;
      const prev = owner[j1];
      owner[j1] = i; asg[i] = j1;
      if (prev >= 0) { asg[prev] = -1; queue.push(prev); }
    }
    const back = [...keys.keys()];
    return Array.from(asg, (j) => (j >= 0 && j < M ? back[j] : null));
  };

  /** Guess the 4 corners (TL, TR, BR, BL) of the picture in a lid photo:
   *  the largest convex quadrilateral among the image's edge contours.
   *  Returns null when nothing plausible is found. */
  PH.detectBoxCorners = function (img) {
    const cv = PH.cv;
    const sc = Math.min(1, 640 / Math.max(img.w, img.h));
    const src = new cv.Mat(img.h, img.w, cv.CV_8UC4);
    src.data.set(img.data);
    const small = new cv.Mat();
    cv.resize(src, small, new cv.Size(Math.round(img.w * sc), Math.round(img.h * sc)), 0, 0, cv.INTER_AREA);
    src.delete();
    const w = small.cols, h = small.rows;
    const minArea = w * h * 0.15;

    // Fit a quadrilateral to the biggest contour of a binary mask.
    const quadFrom = (mask) => {
      const contours = new cv.MatVector(), hier = new cv.Mat();
      cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      let best = null;
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const a = cv.contourArea(c);
        if (a > minArea && (!best || a > best.a)) { if (best) best.c.delete(); best = { a, c }; } else c.delete();
      }
      let quad = null;
      if (best) {
        const hull = new cv.Mat();
        cv.convexHull(best.c, hull);
        const peri = cv.arcLength(hull, true);
        for (let eps = 0.01; eps <= 0.1 && !quad; eps += 0.01) {
          const ap = new cv.Mat();
          cv.approxPolyDP(hull, ap, eps * peri, true);
          if (ap.rows === 4) quad = Array.from({ length: 4 }, (_, j) => [ap.data32S[2 * j] / sc, ap.data32S[2 * j + 1] / sc]);
          ap.delete();
        }
        hull.delete(); best.c.delete();
      }
      contours.delete(); hier.delete();
      return quad;
    };

    // 1) The lid differs from whatever surrounds it: compare to the border color.
    const lab = PH.rgbaToLab(small.data, w, h);
    const ring = [];
    const bw = Math.max(2, Math.round(Math.min(w, h) * 0.02));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x >= bw && y >= bw && x < w - bw && y < h - bw) continue;
      const i = (y * w + x) * 3;
      ring.push([lab[i], lab[i + 1], lab[i + 2]]);
    }
    const med = [0, 1, 2].map((k) => PH.median(ring.map((r) => r[k])));
    const mask = new cv.Mat(h, w, cv.CV_8UC1);
    for (let p = 0, i = 0; p < w * h; p++, i += 3) mask.data[p] = PH.dE(lab[i], lab[i + 1], lab[i + 2], med[0], med[1], med[2], 0.7) > 18 ? 255 : 0;
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k);
    let quad = quadFrom(mask);

    // 2) Fallback: strong edges (works when the lid sits on a similar color).
    if (!quad) {
      const gray = new cv.Mat();
      cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      cv.Canny(gray, mask, 40, 120);
      cv.dilate(mask, mask, k);
      quad = quadFrom(mask);
      gray.delete();
    }
    [small, mask, k].forEach((m) => m.delete());
    if (!quad) return null;
    const by = (f) => quad.slice().sort((p, q) => f(p) - f(q));
    const sum = by((p) => p[0] + p[1]), diff = by((p) => p[1] - p[0]);
    return [sum[0], diff[0], sum[3], diff[3]];
  };

  PH.computeCells = function (box) {
    const { cols, rows, S, W, lab } = box;
    const n = cols * rows;
    const mean = new Float32Array(n * 3), hist = new Float32Array(n * 64), quad = new Float32Array(n * 12);
    let sL = 0, sLL = 0, cnt = 0;
    const h = S / 2;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const id = r * cols + c;
      const q = new Float64Array(12), qn = [0, 0, 0, 0];
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = ((r * S + y) * W + c * S + x) * 3;
        const L = lab[i], a = lab[i + 1], b = lab[i + 2];
        hist[id * 64 + PH.histBin(L, a, b)]++;
        const qi = (y < h ? 0 : 2) + (x < h ? 0 : 1);
        q[qi * 3] += L; q[qi * 3 + 1] += a; q[qi * 3 + 2] += b; qn[qi]++;
        sL += L; sLL += L * L; cnt++;
      }
      for (let k = 0; k < 64; k++) hist[id * 64 + k] /= S * S;
      for (let qi = 0; qi < 4; qi++) for (let ch = 0; ch < 3; ch++) quad[id * 12 + qi * 3 + ch] = q[qi * 3 + ch] / qn[qi];
      for (let ch = 0; ch < 3; ch++) mean[id * 3 + ch] = (quad[id * 12 + ch] + quad[id * 12 + 3 + ch] + quad[id * 12 + 6 + ch] + quad[id * 12 + 9 + ch]) / 4;
    }
    box.cells = { mean, hist, quad };
    // Puzzle color palette in coarse Lab bins, lightly blurred to tolerate
    // lighting differences; used to tell pieces from a mixed background.
    const raw = new Float32Array(8192);
    for (let i = 0; i < lab.length; i += 3) raw[PH.coarseBin(lab[i], lab[i + 1], lab[i + 2])]++;
    const palette = new Float32Array(8192);
    const total = lab.length / 3;
    for (let L = 0; L < 8; L++) for (let a = 0; a < 32; a++) for (let b = 0; b < 32; b++) {
      let s = 0, ws = 0;
      for (let dL = -1; dL <= 1; dL++) for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) {
        const L2 = L + dL, a2 = a + da, b2 = b + db;
        const wgt = (dL ? 0.5 : 1) * (da ? 0.6 : 1) * (db ? 0.6 : 1);
        ws += wgt;
        if (L2 < 0 || L2 > 7 || a2 < 0 || a2 > 31 || b2 < 0 || b2 > 31) continue;
        s += raw[(L2 << 10) | (a2 << 5) | b2] * wgt;
      }
      palette[(L << 10) | (a << 5) | b] = s / ws / total;
    }
    box.palette = palette;
    box.white = PH.whitePoint(lab, total);
    box.Lmu = sL / cnt;
    box.Lsd = Math.sqrt(Math.max(1, sLL / cnt - box.Lmu * box.Lmu));
  };

  // Rotate an SxS image (ch channels) 90° clockwise.
  function rot90(src, S, ch) {
    const out = new src.constructor(src.length);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      // out(x', y') with x' = S-1-y, y' = x  <-  in(x, y)
      const o = (x * S + (S - 1 - y)) * ch, i = (y * S + x) * ch;
      for (let k = 0; k < ch; k++) out[o + k] = src[i + k];
    }
    return out;
  }

  // Outside sides of a cell: bit0 top, bit1 right, bit2 bottom, bit3 left.
  function cellSides(box, c, r) {
    return (r === 0 ? 1 : 0) | (c === box.cols - 1 ? 2 : 0) | (r === box.rows - 1 ? 4 : 0) | (c === 0 ? 8 : 0);
  }
  // Sides the piece's flat edges occupy after rotating clockwise by rot quarter turns.
  function flatSides(flats, rot) {
    let m = 0;
    for (let k = 0; k < 4; k++) if (flats[k]) m |= 1 << ((k + rot) % 4);
    return m;
  }

  /**
   * Place a piece (needs t1.square) on the box.
   * @param calib {Lmu, Lsd} lightness stats of catalogued pieces (null = none yet)
   * @returns {cands:[{col,row,rot,score,dx,dy}], conf}
   */
  PH.placePiece = function (box, t1, calib) {
    const S = PH.SQ, n = S * S;
    const { cols, rows, W, H, lab: blab, cells } = box;

    // Calibrated piece square (lightness mapped to the box's distribution).
    const pl = new Float32Array(n * 3);
    const mask = t1.square.mask;
    const useCal = calib && calib.n >= 12;
    for (let p = 0; p < n; p++) {
      let L = t1.square.lab[3 * p];
      if (useCal) L = PH.clamp(((L - calib.Lmu) / calib.Lsd) * box.Lsd + box.Lmu, 0, 255);
      pl[3 * p] = L; pl[3 * p + 1] = t1.square.lab[3 * p + 1]; pl[3 * p + 2] = t1.square.lab[3 * p + 2];
    }
    let mcount = 0;
    for (let p = 0; p < n; p++) if (mask[p]) mcount++;
    if (mcount < n * 0.3) return null;

    // Rotations, histogram, quadrant means, texture.
    const rots = [{ lab: pl, mask }];
    for (let r = 1; r < 4; r++) rots.push({ lab: rot90(rots[r - 1].lab, S, 3), mask: rot90(rots[r - 1].mask, S, 1) });
    const hist = new Float32Array(64);
    let sL = 0, sLL = 0;
    for (let p = 0; p < n; p++) if (mask[p]) {
      hist[PH.histBin(pl[3 * p], pl[3 * p + 1], pl[3 * p + 2])] += 1 / mcount;
      sL += pl[3 * p]; sLL += pl[3 * p] * pl[3 * p];
    }
    const sdL = Math.sqrt(Math.max(0, sLL / mcount - (sL / mcount) ** 2)) * PH.L_SCALE;
    const tex = PH.clamp(sdL / 8, 0, 1);
    const h = S / 2;
    for (const R of rots) {
      const q = new Float64Array(12), qn = [0, 0, 0, 0];
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const p = y * S + x;
        if (!R.mask[p]) continue;
        const qi = (y < h ? 0 : 2) + (x < h ? 0 : 1);
        for (let ch = 0; ch < 3; ch++) q[qi * 3 + ch] += R.lab[3 * p + ch];
        qn[qi]++;
      }
      R.quad = Array.from(q, (v, i) => (qn[(i / 3) | 0] ? v / qn[(i / 3) | 0] : NaN));
    }

    const flats = t1.flats;
    const nFlat = flats.filter(Boolean).length;
    const adjacentFlats = nFlat === 2 && !(flats[0] && flats[2]) && !(flats[1] && flats[3]);
    const constrain = nFlat === 0 || nFlat === 1 || adjacentFlats;

    // 1) cheap pre-filter over every cell.
    const pre = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const id = r * cols + c;
      const sides = cellSides(box, c, r);
      let hi = 0;
      for (let k = 0; k < 64; k++) { const a = hist[k], b = cells.hist[id * 64 + k]; hi += a < b ? a : b; }
      for (let rot = 0; rot < 4; rot++) {
        if (constrain && flatSides(flats, rot) !== sides) continue;
        const Q = rots[rot].quad;
        let qd = 0, qc = 0;
        for (let qi = 0; qi < 4; qi++) {
          if (Number.isNaN(Q[qi * 3])) continue;
          const o = id * 12 + qi * 3;
          qd += PH.dE(Q[qi * 3], Q[qi * 3 + 1], Q[qi * 3 + 2], cells.quad[o], cells.quad[o + 1], cells.quad[o + 2], 0.7);
          qc++;
        }
        pre.push({ c, r, rot, s: 1 - hi + (qc ? qd / qc : 50) / 30 });
      }
    }
    if (!pre.length) return null;
    pre.sort((x, y) => x.s - y.s);
    const top = pre.slice(0, 20);

    // 2) fine compare over a window of offsets.
    const ls = PH.L_SCALE * 0.7;
    function fine(rot, x0, y0) {
      const R = rots[rot];
      let d = 0, m = 0, sp = 0, sb = 0, spp = 0, sbb = 0, spb = 0;
      for (let y = 0; y < S; y++) {
        const by = y0 + y;
        for (let x = 0; x < S; x++) {
          const p = y * S + x;
          if (!R.mask[p]) continue;
          const bi = (by * W + x0 + x) * 3, pi = 3 * p;
          const L1 = R.lab[pi], L2 = blab[bi];
          const dL = (L1 - L2) * ls, da = R.lab[pi + 1] - blab[bi + 1], db = R.lab[pi + 2] - blab[bi + 2];
          d += Math.sqrt(dL * dL + da * da + db * db);
          sp += L1; sb += L2; spp += L1 * L1; sbb += L2 * L2; spb += L1 * L2; m++;
        }
      }
      d /= m;
      const cov = spb / m - (sp / m) * (sb / m);
      const vp = spp / m - (sp / m) ** 2, vb = sbb / m - (sb / m) ** 2;
      const z = vp > 1 && vb > 1 ? cov / Math.sqrt(vp * vb) : 0;
      return d / 15 - tex * z;
    }
    const step = Math.max(1, Math.round(S / 8)), span = Math.round(S * 0.375);
    const scored = [];
    for (const t of top) {
      let best = null;
      for (let dy = -span; dy <= span; dy += step) for (let dx = -span; dx <= span; dx += step) {
        const x0 = t.c * S + dx, y0 = t.r * S + dy;
        if (x0 < 0 || y0 < 0 || x0 + S > W || y0 + S > H) continue;
        const s = fine(t.rot, x0, y0);
        if (!best || s < best.score) best = { col: t.c, row: t.r, rot: t.rot, score: s, dx, dy };
      }
      if (best) scored.push(best);
    }
    scored.sort((x, y) => x.score - y.score);
    if (!scored.length) return null;
    const s1 = scored[0].score;
    const other = scored.find((s) => Math.abs(s.col - scored[0].col) + Math.abs(s.row - scored[0].row) > 1);
    const conf = other ? PH.clamp((other.score - s1) / 0.25, 0, 1) : 0.5;
    return { cands: scored.slice(0, 6), conf, tex };
  };
})(typeof self !== 'undefined' ? self : globalThis);
