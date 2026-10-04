/* Assembled sections ("partial sets" of joined pieces).
 *
 * A section's outline is hard to cut into individual pieces, but its printed
 * picture is large and distinctive, so it is located on the box picture
 * directly: the section image is scaled so one piece ~ one grid cell and
 * template-matched against the box at a range of rotations. That gives the
 * box cells it covers and the open cells around it. Any catalogued loose
 * piece placed in one of those open cells attaches to the section, and the
 * cell direction says which of its edges touches the section. */
(function (G) {
  const PH = G.PH;

  // Half-resolution lightness of the box picture (computed once).
  PH.boxHalfL = function (box) {
    if (box.Lhalf) return box.Lhalf;
    const w = box.W >> 1, h = box.H >> 1, L = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) s += box.lab[((2 * y + dy) * box.W + 2 * x + dx) * 3];
      L[y * w + x] = s >> 2;
    }
    // light blur: tolerate a few degrees of rotation / sub-cell misregistration
    const cv = PH.cv, m = new cv.Mat(h, w, cv.CV_8UC1);
    m.data.set(L); cv.GaussianBlur(m, m, new cv.Size(5, 5), 1.2); L.set(m.data); m.delete();
    box.Lhalf = L; box.Lhw = w; box.Lhh = h;
    return L;
  };

  /**
   * Locate a section on the box.
   * @param crop {w,h,data:RGBA} image around the section (straightened source px)
   * @param maskPts flat outline of the section in crop coordinates
   * @param sidePx typical piece side length in the crop's pixels
   * @returns {score, rot, scale, cells:[cellIndex], open:[cellIndex], center:[col,row]} or null
   */
  PH.placeSection = function (box, crop, maskPts, sidePx, opts) {
    opts = opts || {};
    const cv = PH.cv;
    const BL = PH.boxHalfL(box), bw = box.Lhw, bh = box.Lhh;
    const S = PH.SQ / 2; // cell size at half resolution (12 px per piece)
    const base = S / sidePx; // crop px -> half-res box px
    // Section lightness + mask, downscaled to roughly box scale first.
    const lab = PH.rgbaToLab(crop.data, crop.w, crop.h);
    const Lm = new cv.Mat(crop.h, crop.w, cv.CV_8UC1);
    for (let p = 0; p < crop.w * crop.h; p++) Lm.data[p] = lab[3 * p];
    const Mk = cv.Mat.zeros(crop.h, crop.w, cv.CV_8UC1);
    const pm = cv.matFromArray(maskPts.length / 2, 1, cv.CV_32SC2, Array.from(maskPts, Math.round));
    const mv = new cv.MatVector(); mv.push_back(pm);
    cv.fillPoly(Mk, mv, new cv.Scalar(255));
    pm.delete(); mv.delete();
    const er = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.erode(Mk, Mk, er); er.delete();
    // Shrink to box scale with proper area averaging first (rotating and
    // shrinking in one step aliases thin lines and text), then blur like the box.
    const cw = Math.max(4, Math.round(crop.w * base)), chh = Math.max(4, Math.round(crop.h * base));
    const Ls = new cv.Mat(), Ms = new cv.Mat();
    cv.resize(Lm, Ls, new cv.Size(cw, chh), 0, 0, cv.INTER_AREA);
    cv.resize(Mk, Ms, new cv.Size(cw, chh), 0, 0, cv.INTER_NEAREST);
    cv.GaussianBlur(Ls, Ls, new cv.Size(5, 5), 1.2);
    Lm.delete(); Mk.delete();

    const boxRaw = new cv.Mat(bh, bw, cv.CV_8UC1); boxRaw.data.set(BL);
    const res = new cv.Mat();
    let best = null;
    const rots = opts.rotStep || 10, scales = opts.scales || [0.92, 1, 1.08];
    const diag = Math.ceil(Math.hypot(cw, chh) * Math.max(...scales)) + 4;
    // Pad the box so a section near its edge can still be centered on its true
    // spot (only the section's own pixels are compared, so the pad is ignored).
    const pad = Math.ceil(diag / 2);
    const boxMat = new cv.Mat();
    cv.copyMakeBorder(boxRaw, boxMat, pad, pad, pad, pad, cv.BORDER_REPLICATE);
    boxRaw.delete();
    const T = new cv.Mat(), TM = new cv.Mat();
    for (const sc of scales) for (let deg = 0; deg < 360; deg += rots) {
      const a = (deg * Math.PI) / 180, c = Math.cos(a) * sc, s = Math.sin(a) * sc;
      // rotate+scale about the crop center into a diag x diag square
      const M = cv.matFromArray(2, 3, cv.CV_64F, [c, -s, diag / 2 - (c * cw / 2 - s * chh / 2), s, c, diag / 2 - (s * cw / 2 + c * chh / 2)]);
      cv.warpAffine(Ls, T, M, new cv.Size(diag, diag), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
      cv.warpAffine(Ms, TM, M, new cv.Size(diag, diag), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
      M.delete();
      // Outside the section: fill with its mean so it doesn't affect the correlation.
      let sum = 0, n = 0;
      for (let p = 0; p < diag * diag; p++) if (TM.data[p]) { sum += T.data[p]; n++; }
      if (n < 50) continue;
      const mean = sum / n;
      for (let p = 0; p < diag * diag; p++) if (!TM.data[p]) T.data[p] = mean;
      // Masked: only the section's own pixels count (the box around it doesn't).
      cv.matchTemplate(boxMat, T, res, cv.TM_CCOEFF_NORMED, TM);
      const mm = cv.minMaxLoc(res);
      if (!best || mm.maxVal > best.score) best = { score: mm.maxVal, x: mm.maxLoc.x - pad, y: mm.maxLoc.y - pad, deg, sc, mask: new Uint8Array(TM.data) };
    }
    [Ls, Ms, boxMat, res, T, TM].forEach((m) => m.delete());
    if (!best || best.score < (opts.minScore || 0.45)) return best ? { score: best.score, failed: true } : null;

    // Cells covered by the section at the best placement.
    const cover = new Map();
    for (let y = 0; y < diag; y++) for (let x = 0; x < diag; x++) {
      if (!best.mask[y * diag + x]) continue;
      const col = Math.floor((best.x + x) / S), row = Math.floor((best.y + y) / S);
      if (col < 0 || row < 0 || col >= box.cols || row >= box.rows) continue;
      const id = row * box.cols + col;
      cover.set(id, (cover.get(id) || 0) + 1);
    }
    const cells = [...cover].filter(([, c]) => c > S * S * 0.5).map(([id]) => id);
    const occ = new Set(cells);
    const open = new Set();
    for (const id of cells) {
      const col = id % box.cols, row = (id / box.cols) | 0;
      for (const [dc, dr] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const c = col + dc, r = row + dr;
        if (c < 0 || r < 0 || c >= box.cols || r >= box.rows) continue;
        const n = r * box.cols + c;
        if (!occ.has(n)) open.add(n);
      }
    }
    let sc0 = 0, sr0 = 0;
    for (const id of cells) { sc0 += id % box.cols; sr0 += (id / box.cols) | 0; }
    return {
      score: best.score, rot: best.deg, scale: best.sc, cells, open: [...open],
      center: cells.length ? [sc0 / cells.length, sr0 / cells.length] : null,
    };
  };

  /**
   * How loose piece P attaches to a placed section: P's box cell must be one
   * of the section's open cells; returns the edges of P that touch it.
   */
  PH.sectionAttach = function (box, sec, P) {
    if (!sec || !sec.cells || !P.t2 || !P.t2.cands.length) return null;
    const A = P.t2.cands[0];
    const id = A.row * box.cols + A.col;
    if (!sec.open.includes(id)) return null;
    const occ = new Set(sec.cells);
    const edges = [];
    [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(([dc, dr], side) => {
      const c = A.col + dc, r = A.row + dr;
      if (c < 0 || r < 0 || c >= box.cols || r >= box.rows) return;
      if (occ.has(r * box.cols + c)) edges.push((side - A.rot + 4) % 4); // P's edge index on that side
    });
    return edges.length ? { edges, conf: P.t2.conf, cell: [A.col, A.row] } : null;
  };

  /* ---------- open spots of an assembled section ----------
   * Late in a puzzle most of it is one big joined block, too big to locate as
   * a whole and often bigger than the view. Its open spots are found in the
   * camera frame itself: the block is laid on its own grid of piece-sized
   * cells (angle from its straight sides, pitch and offset from where those
   * sides lie), each cell is read as filled or empty, and every empty cell
   * next to filled ones is a spot - a hole inside the block, a pocket, or a
   * place along its edge. The neighbours' sides say what the missing piece
   * needs there (their tab = a blank on it, their blank = a tab); a straight
   * side means the puzzle's own border, so the cell beyond it is no spot.
   * With a box picture the visible cells are then matched to the box picture
   * cell by cell (4 turns x every offset), which names each spot's box cell.
   * Grid sides: 0 up, 1 right, 2 down, 3 left (same as box cells). */
  const D4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  // Dominant direction (radians, 0..pi/2) of an outline's straight runs.
  function gridAngle(pts, step, cut) {
    const n = pts.length / 2, hist = new Float64Array(90);
    for (let i = 0; i < n; i++) {
      const j = (i + step) % n;
      if (cut(i) || cut(j)) continue;
      const dx = pts[2 * j] - pts[2 * i], dy = pts[2 * j + 1] - pts[2 * i + 1];
      const len = Math.hypot(dx, dy);
      if (len < step * 0.8) continue; // a curve (tab, blank): not a straight run
      let a = (Math.atan2(dy, dx) * 180) / Math.PI;
      a = ((a % 90) + 90) % 90;
      hist[Math.floor(a) % 90] += len;
    }
    let best = 0, bv = -1;
    for (let b = 0; b < 90; b++) {
      let v = 0;
      for (let k = -2; k <= 2; k++) v += hist[(b + k + 90) % 90] * (3 - Math.abs(k));
      if (v > bv) { bv = v; best = b; }
    }
    let sx = 0, sw = 0;
    for (let k = -4; k <= 4; k++) { const v = hist[(best + k + 90) % 90]; sx += (best + k + 0.5) * v; sw += v; }
    const a = sw ? sx / sw : best + 0.5;
    return ((((a % 90) + 90) % 90) * Math.PI) / 180;
  }
  // Signed comb: sum of w * e^(2 pi i x / P).
  function comb(xs, ws, P) {
    let c = 0, s = 0;
    for (let i = 0; i < xs.length; i++) { const ph = (2 * Math.PI * xs[i]) / P; c += ws[i] * Math.cos(ph); s += ws[i] * Math.sin(ph); }
    return { c, s };
  }

  /**
   * Open spots of one big blob in the processing frame.
   * @param det {pts, holes?} outline (+ holes) in processing px
   * @param side typical piece pitch in processing px (sqrt of one piece's area)
   * @param fw,fh processing frame size (cells must be fully in view to count)
   * @returns null, or {angle, pitch, u0, v0, occ:[[i,j]], spots:[{i,j,n,hole,need,poly}], crisp, toXY}
   */
  PH.sectionSpots = function (det, side, fw, fh) {
    const cv = PH.cv;
    const pts = det.pts, n = pts.length / 2;
    if (n < 40) return null;
    // Where the block runs off the view its outline follows the frame's edge:
    // long straight runs that are no part of the puzzle. Left out.
    const offEdge = (P) => (i) => { const x = P[2 * i], y = P[2 * i + 1]; return x <= 2 || y <= 2 || x >= fw - 3 || y >= fh - 3; };
    const ang = gridAngle(pts, Math.max(3, Math.round((side || 40) / 5)), offEdge(pts));
    const c = Math.cos(ang), s = Math.sin(ang);
    const toUV = (x, y) => [x * c + y * s, -x * s + y * c];
    const toXY = (u, v) => [u * c - v * s, u * s + v * c];
    // Outline points on straight runs, split by direction: runs along v (|du|
    // small) sit on vertical grid lines (constant u), runs along u on horizontal ones.
    // Grid pitch and line positions from the outline. Along each side of the
    // block the outline is straight near the piece corners (= on the grid
    // lines) and bulges or bites in halfway between (tabs, blanks). Points
    // on sides running along u count +1 where straight and -1 where curved,
    // at their u position: lines every P reinforce, while every 2P, 3P or
    // P/2 cancel out. Same for sides along v. One pitch for both (pieces are
    // square). Runs lying ON a line (the block's own sides) then fine-tune
    // where the lines are. `side` (a piece size from loose pieces; often
    // missing or wrong in a view of only the assembled block) breaks ties.
    const all = [pts].concat(det.holes || []);
    const xu = [], wu = [], xv = [], wv = [], uOn = [], vOn = [];
    const st = 3, lw = 12;
    for (const P of all) {
      const m = P.length / 2;
      if (m < 2 * lw + 2) continue;
      const cut = offEdge(P);
      for (let i = 0; i < m; i++) {
        if (cut(i) || cut((i - lw + m) % m) || cut((i + lw) % m)) continue;
        const [u, v] = toUV(P[2 * i], P[2 * i + 1]);
        const a = (i - st + m) % m, b = (i + st) % m, A2 = (i - lw + m) % m, B2 = (i + lw) % m;
        const [ua, va] = toUV(P[2 * a], P[2 * a + 1]), [ub, vb] = toUV(P[2 * b], P[2 * b + 1]);
        const [uA, vA] = toUV(P[2 * A2], P[2 * A2 + 1]), [uB, vB] = toUV(P[2 * B2], P[2 * B2 + 1]);
        const du = ub - ua, dv = vb - va, Ls = Math.hypot(du, dv) || 1;
        const DU = uB - uA, DV = vB - vA, Ll = Math.hypot(DU, DV) || 1;
        const straight = Ls >= st * 1.6;
        if (Math.abs(DV) / Ll < 0.4) { // on a side running along u
          const flat = straight && Math.abs(dv) / Ls < 0.2;
          xu.push(u); wu.push(flat ? 1 : -1);
          if (flat) vOn.push(v);
        } else if (Math.abs(DU) / Ll < 0.4) { // along v
          const flat = straight && Math.abs(du) / Ls < 0.2;
          xv.push(v); wv.push(flat ? 1 : -1);
          if (flat) uOn.push(u);
        }
      }
    }
    if (xu.length + xv.length < 40) return null;
    const pMin = 10, pMax = Math.max(pMin * 2, Math.min(fw, fh) / 2.5), wsum = xu.length + xv.length;
    let gb = null;
    for (let P = pMin; P <= pMax; P *= 1.01) {
      const cu = comb(xu, wu, P), cv2 = comb(xv, wv, P);
      const m = (Math.hypot(cu.c, cu.s) + Math.hypot(cv2.c, cv2.s)) / wsum;
      const key = m * (side && Math.abs(Math.log(P / side)) < 0.2 ? 1.1 : 1);
      if (!gb || key > gb.key) gb = { key, m, P, cu, cv: cv2 };
    }
    if (!gb || gb.m < 0.12) return null;
    const off = (c, P) => ((Math.atan2(c.s, c.c) / (2 * Math.PI)) * P + P) % P;
    const gu = { P: gb.P, off: off(gb.cu, gb.P) }, gv = { P: gb.P, off: off(gb.cv, gb.P) };
    const pitch = (gu.P + gv.P) / 2;
    // Fine-tune each set of lines on the straight runs lying along them (the
    // block's own sides): their median offset from the nearest line.
    const tune = (g, on) => {
      if (on.length < 8) return;
      const r = on.map((u) => ((((u - g.off) % pitch) + 1.5 * pitch) % pitch) - pitch / 2).filter((x) => Math.abs(x) < pitch * 0.3).sort((a, b) => a - b);
      if (r.length >= 8) g.off = (g.off + r[r.length >> 1] + pitch) % pitch;
    };
    tune(gu, uOn); tune(gv, vOn);
    // Rasterise blob (minus holes) and the frame's own area in grid coordinates.
    let umin = Infinity, vmin = Infinity, umax = -Infinity, vmax = -Infinity;
    for (let i = 0; i < n; i++) { const [u, v] = toUV(pts[2 * i], pts[2 * i + 1]); if (u < umin) umin = u; if (u > umax) umax = u; if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
    // first grid line at or before the blob, one spare cell around it
    const u0 = gu.off + Math.floor((umin - gu.off) / pitch - 1) * pitch, v0 = gv.off + Math.floor((vmin - gv.off) / pitch - 1) * pitch;
    const nc = Math.ceil((umax - u0) / pitch) + 2, nr = Math.ceil((vmax - v0) / pitch) + 2;
    if (nc * nr > 6000 || nc < 3 || nr < 3) return null;
    const R = 16; // samples per cell side
    const W = nc * R, H = nr * R, k = R / pitch;
    const poly = (P) => { const out = []; for (let i = 0; i < P.length; i += 2) { const [u, v] = toUV(P[i], P[i + 1]); out.push(Math.round((u - u0) * k), Math.round((v - v0) * k)); } return out; };
    const fill = (mat, list, val) => {
      const mv = new cv.MatVector();
      for (const P of list) { const m = cv.matFromArray(P.length / 2, 1, cv.CV_32SC2, P); mv.push_back(m); m.delete(); }
      cv.fillPoly(mat, mv, new cv.Scalar(val)); mv.delete();
    };
    const M = cv.Mat.zeros(H, W, cv.CV_8UC1), V = cv.Mat.zeros(H, W, cv.CV_8UC1);
    fill(M, [poly(pts)], 1);
    if (det.holes && det.holes.length) fill(M, det.holes.map(poly), 0);
    const mg = 2; // frame margin, processing px
    fill(V, [poly([mg, mg, fw - mg, mg, fw - mg, fh - mg, mg, fh - mg])], 1);
    const mask = new Uint8Array(M.data), valid = new Uint8Array(V.data);
    M.delete(); V.delete();
    // integral images
    const ii = (a) => { const I = new Int32Array((W + 1) * (H + 1)); for (let y = 0; y < H; y++) { let r = 0; for (let x = 0; x < W; x++) { r += a[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + r; } } return I; };
    const IM = ii(mask), IV = ii(valid);
    const box = (I, x0, y0, x1, y1) => {
      x0 = Math.max(0, Math.min(W, Math.round(x0))); x1 = Math.max(0, Math.min(W, Math.round(x1)));
      y0 = Math.max(0, Math.min(H, Math.round(y0))); y1 = Math.max(0, Math.min(H, Math.round(y1)));
      const a = (x1 - x0) * (y1 - y0);
      return a > 0 ? (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / a : 0;
    };
    // Each cell's centre (the middle 40%: tabs and blanks never reach it).
    const inner = new Float32Array(nc * nr), inView = new Uint8Array(nc * nr);
    let amb = 0, decided = 0;
    for (let j = 0; j < nr; j++) for (let i = 0; i < nc; i++) {
      const id = j * nc + i;
      inner[id] = box(IM, i * R + 0.3 * R, j * R + 0.3 * R, i * R + 0.7 * R, j * R + 0.7 * R);
      inView[id] = box(IV, i * R, j * R, i * R + R, j * R + R) > 0.98 ? 1 : 0;
      if (!inView[id]) continue;
      if (inner[id] > 0.75 || inner[id] < 0.15) decided++; else if (inner[id] > 0.02) amb++;
    }
    const occ = (i, j) => i >= 0 && j >= 0 && i < nc && j < nr && inner[j * nc + i] > 0.75;
    const occN = [];
    for (let j = 0; j < nr; j++) for (let i = 0; i < nc; i++) if (occ(i, j)) occN.push([i, j]);
    const crisp = decided / Math.max(1, decided + amb);
    // A grid that doesn't fit (a towel fold, the table read as a piece) leaves
    // many half-filled cell centres.
    if (occN.length < 3 || crisp < 0.8) return { failed: true, crisp, angle: ang, pitch };
    // Side between filled cell (i,j) and its neighbour on side d: where the
    // outline crosses the band around the side, middle of the side vs its
    // ends (near the corners the outline sits on the true grid line, so a
    // slightly misplaced grid doesn't matter): the middle further out = the
    // filled cell's tab, further in = its blank, level = a straight (border)
    // side. Distances in samples (R per cell).
    const depth = (i, j, d, t0, t1) => {
      // mean outward position of the outline along the side, over [t0,t1] of its length
      const x0 = i * R, y0 = j * R, B = 0.4 * R;
      t0 *= R; t1 *= R;
      let out, inn;
      if (d === 0) { out = box(IM, x0 + t0, y0 - B, x0 + t1, y0); inn = box(IM, x0 + t0, y0, x0 + t1, y0 + B); }
      else if (d === 2) { out = box(IM, x0 + t0, y0 + R, x0 + t1, y0 + R + B); inn = box(IM, x0 + t0, y0 + R - B, x0 + t1, y0 + R); }
      else if (d === 1) { out = box(IM, x0 + R, y0 + t0, x0 + R + B, y0 + t1); inn = box(IM, x0 + R - B, y0 + t0, x0 + R, y0 + t1); }
      else { out = box(IM, x0 - B, y0 + t0, x0, y0 + t1); inn = box(IM, x0, y0 + t0, x0 + B, y0 + t1); }
      return (out - (1 - inn)) * B;
    };
    const sideType = (i, j, d) => {
      const mid = depth(i, j, d, 0.38, 0.62), ends = (depth(i, j, d, 0.04, 0.2) + depth(i, j, d, 0.8, 0.96)) / 2;
      const t = (mid - ends) / R; // in piece sides; a tab or blank reaches ~0.2-0.3
      return t > 0.08 ? 'T' : t < -0.08 ? 'B' : 'F';
    };
    const flatsOf = new Map(); // filled cell -> its straight sides (puzzle border) facing empty cells in view
    const sides = new Map(); // filled cell "i,j" -> side types toward empty cells in view (null = not seen)
    const empty = [];
    const spots = [];
    const holeOf = (i, j) => {
      if (!det.holes) return false;
      const [x, y] = toXY(u0 + (i + 0.5) * pitch, v0 + (j + 0.5) * pitch);
      return det.holes.some((P) => PH.pointInPoly(x, y, P));
    };
    for (let j = 0; j < nr; j++) for (let i = 0; i < nc; i++) {
      const id = j * nc + i;
      if (!inView[id] || inner[id] > 0.15) continue;
      empty.push([i, j]);
      const need = ['?', '?', '?', '?'];
      let nb = 0;
      for (let d = 0; d < 4; d++) {
        const a = i + D4[d][0], b = j + D4[d][1];
        if (!occ(a, b)) continue;
        nb++;
        const t = sideType(a, b, (d + 2) % 4); // the neighbour's side facing this cell
        const sk = a + ',' + b; (sides.get(sk) || sides.set(sk, [null, null, null, null]).get(sk))[(d + 2) % 4] = t;
        // A straight side is the puzzle's border - or a tab too small to see
        // at this distance - so it's no reason to drop the spot; once the
        // block is on the box, cells beyond the box edge are dropped anyway.
        if (t === 'F') { const key = a + ',' + b; (flatsOf.get(key) || flatsOf.set(key, []).get(key)).push((d + 2) % 4); }
        need[d] = t === 'T' ? 'B' : t === 'B' ? 'T' : '?';
      }
      if (!nb) continue;
      const q = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => toXY(u0 + a * pitch, v0 + b * pitch));
      const ctr = toXY(u0 + (i + 0.5) * pitch, v0 + (j + 0.5) * pitch);
      spots.push({ i, j, n: nb, hole: holeOf(i, j), need, poly: [].concat(...q), cx: ctr[0], cy: ctr[1] });
    }
    return { angle: ang, pitch, u0, v0, nc, nr, occ: occN, empty, sides, flats: flatsOf, spots, crisp, toXY, toUV };
  };

  // Box picture as 6x6 lightness patches per cell (from the half-res box, 12 px per cell).
  const PS = 6;
  function boxPatches(box) {
    if (box.patches) return box.patches;
    const L = PH.boxHalfL(box), bw = box.Lhw, S = PH.SQ / 2, f = S / PS;
    const out = new Float32Array(box.cols * box.rows * PS * PS);
    for (let r = 0; r < box.rows; r++) for (let c = 0; c < box.cols; c++) for (let b = 0; b < PS; b++) for (let a = 0; a < PS; a++) {
      let sum = 0, cnt = 0;
      for (let y = 0; y < f; y++) for (let x = 0; x < f; x++) { sum += L[(r * S + b * f + y) * bw + c * S + a * f + x]; cnt++; }
      out[((r * box.cols + c) * PS + b) * PS + a] = sum / cnt;
    }
    return (box.patches = out);
  }

  /** 6x6 lightness patches of a frame grid's cells (PH.sectionSpots result
   *  `g`), from the processing frame's lightly blurred lightness L (w x h).
   *  One Float32Array of cells.length x 36, in grid orientation. */
  PH.PATCH = PS;
  PH.gridPatches = function (g, cells, L, w, h) {
    const samp = (x, y) => {
      const xi = Math.max(0, Math.min(w - 2, Math.floor(x))), yi = Math.max(0, Math.min(h - 2, Math.floor(y)));
      const fx = Math.max(0, Math.min(1, x - xi)), fy = Math.max(0, Math.min(1, y - yi)), p = yi * w + xi;
      return (L[p] * (1 - fx) + L[p + 1] * fx) * (1 - fy) + (L[p + w] * (1 - fx) + L[p + w + 1] * fx) * fy;
    };
    const X = new Float32Array(cells.length * PS * PS);
    cells.forEach(([i, j], n) => {
      for (let b = 0; b < PS; b++) for (let a = 0; a < PS; a++) {
        const [x, y] = g.toXY(g.u0 + (i + (a + 0.5) / PS) * g.pitch, g.v0 + (j + (b + 0.5) / PS) * g.pitch);
        X[(n * PS + b) * PS + a] = samp(x, y);
      }
    });
    return X;
  };
  // Turn k (90° clockwise each, y down): (x, y) -> (-y, x).
  PH.rotCell = (k, x, y) => { for (let t = 0; t < k; t++) { const nx = -y; y = x; x = nx; } return [x, y]; };
  // Patch sample index map for turn k: index in the turned patch -> index in the original.
  PH.patchTurn = function (k) {
    const sIdx = new Int32Array(PS * PS);
    for (let b = 0; b < PS; b++) for (let a = 0; a < PS; a++) {
      const [x, y] = PH.rotCell((4 - k) % 4, a - (PS - 1) / 2, b - (PS - 1) / 2);
      sIdx[b * PS + a] = Math.round(y + (PS - 1) / 2) * PS + Math.round(x + (PS - 1) / 2);
    }
    return sIdx;
  };
  /** One frame's section on the box (see PH.placeOnBox). */
  PH.gridOnBox = function (box, g, L, w, h) {
    const flats = [];
    for (const [key, ds] of g.flats) { const [i, j] = key.split(',').map(Number); for (const d of ds) flats.push([i, j, d]); }
    return PH.placeOnBox(box, g.occ, PH.gridPatches(g, g.occ, L, w, h), flats);
  };
  /**
   * Put filled grid cells on the box picture: each cell's 6x6 lightness patch
   * against every box cell, for the 4 turns and every offset that keeps all
   * cells on the box; Pearson correlation over all samples. Cells with a
   * straight (border) side should sit on the box's matching edge.
   * @param cells [[i,j]], X their patches (PH.gridPatches), flats [[i,j,side]]
   * @returns {k, oc, or, score, margin, cellOf(i,j)->[col,row], sideOf(d)} or null
   */
  PH.placeOnBox = function (box, cells, X, flats) {
    if (cells.length < 6) return null;
    const BP = boxPatches(box), cols = box.cols, rows = box.rows;
    const N = cells.length;
    let sx = 0, sxx = 0;
    for (const v of X) { sx += v; sxx += v * v; }
    const M = X.length, vx = sxx - (sx * sx) / M;
    if (vx < M * 4) return null; // featureless (plain white): can't be placed by print
    const rot = PH.rotCell;
    const results = [];
    for (let k = 0; k < 4; k++) {
      const rc = cells.map(([i, j]) => rot(k, i, j));
      let mi = Infinity, mj = Infinity, xi = -Infinity, xj = -Infinity;
      for (const [a, b] of rc) { mi = Math.min(mi, a); mj = Math.min(mj, b); xi = Math.max(xi, a); xj = Math.max(xj, b); }
      const span = [xi - mi, xj - mj];
      // A stray cell or two (misread at the block's edge) may fall off the
      // box: allowed, left out of the comparison, at a small cost each.
      const spare = Math.max(1, Math.round(N * 0.04));
      if (span[0] >= cols + spare || span[1] >= rows + spare) continue;
      const sIdx = PH.patchTurn(k);
      const rf = flats.map(([i, j, d]) => { const [a, b] = rot(k, i, j); return [a - mi, b - mj, (d + k) % 4]; });
      for (let orow = -spare; orow + span[1] < rows + spare; orow++) for (let ocol = -spare; ocol + span[0] < cols + spare; ocol++) {
        // border sides should face out of the box (a penalty, not a rule: one
        // misread side must not rule out the right placement)
        let bad = 0;
        for (const [a, b, d] of rf) { const c2 = ocol + a + D4[d][0], r2 = orow + b + D4[d][1]; if (c2 >= 0 && r2 >= 0 && c2 < cols && r2 < rows) bad++; }
        let sy = 0, syy = 0, sxy = 0, sx2 = 0, sxx2 = 0, m2 = 0, off = 0;
        for (let n = 0; n < N; n++) {
          const col = ocol + rc[n][0] - mi, row = orow + rc[n][1] - mj;
          if (col < 0 || row < 0 || col >= cols || row >= rows) { off++; continue; }
          const base = (row * cols + col) * PS * PS, xb = n * PS * PS;
          for (let q = 0; q < PS * PS; q++) { const y = BP[base + q], x = X[xb + sIdx[q]]; sy += y; syy += y * y; sxy += x * y; sx2 += x; sxx2 += x * x; }
          m2 += PS * PS;
        }
        if (off > spare || !m2) continue;
        const vy = syy - (sy * sy) / m2, vx2 = sxx2 - (sx2 * sx2) / m2;
        if (vy <= 0 || vx2 <= 0) continue;
        results.push({ k, oc: ocol - mi, or: orow - mj, score: (sxy - (sx2 * sy) / m2) / Math.sqrt(vx2 * vy) - Math.min(0.06, 0.01 * bad) - 0.03 * off, bad, off });
      }
    }
    if (!results.length) return null;
    results.sort((a, b) => b.score - a.score);
    const best = results[0], second = results[1];
    const margin = second ? best.score - second.score : best.score;
    const cellOf = (i, j) => { const [a, b] = rot(best.k, i, j); return [a + best.oc, b + best.or]; };
    return Object.assign(best, { margin, cellOf, sideOf: (d) => (d + best.k) % 4, n: N });
  };
})(typeof self !== 'undefined' ? self : globalThis);
