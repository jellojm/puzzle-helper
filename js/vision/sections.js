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
})(typeof self !== 'undefined' ? self : globalThis);
