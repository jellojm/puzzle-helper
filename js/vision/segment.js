/* Segmentation: separate pieces from a plain background, and compute the
 * cheap per-frame "T0" fingerprint for every blob.
 *
 * Background color is estimated as the mode of a coarse Lab histogram (the
 * cloth is the most common color in view), smoothed across frames. Pixels far
 * from it (in Lab, with lightness down-weighted to tolerate shadows) are
 * foreground. */
(function (G) {
  const PH = G.PH;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // Performance note (from the owner's iPhone reports, 2026-10-03): per-pixel
  // JavaScript loops over the whole frame are unpredictable on iOS — the same
  // loop measured 2 ms in one session and 57-81 ms in another (the WebAssembly
  // stages only slowed ~2x). Full-frame per-pixel work therefore runs in
  // OpenCV (WebAssembly) — see PH.labDistance and PH.flattenLight. Loops left in
  // JS only touch a sample of pixels. `valid` is a 0/1 Uint8Array for
  // tilt-corrected frames and null (= every pixel valid) otherwise.

  // Estimate background Lab as the mean of the most populated coarse bin.
  PH.estimateBackground = function (lab, w, h, valid) {
    const counts = new Uint32Array(8 * 32 * 32);
    const step = 3;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (valid && !valid[y * w + x]) continue;
        const i = (y * w + x) * 3;
        counts[((lab[i] >> 5) << 10) | ((lab[i + 1] >> 3) << 5) | (lab[i + 2] >> 3)]++;
      }
    }
    let best = 0;
    for (let k = 1; k < counts.length; k++) if (counts[k] > counts[best]) best = k;
    let sL = 0, sa = 0, sb = 0, n = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (valid && !valid[y * w + x]) continue;
        const i = (y * w + x) * 3;
        if ((((lab[i] >> 5) << 10) | ((lab[i + 1] >> 3) << 5) | (lab[i + 2] >> 3)) === best) {
          sL += lab[i]; sa += lab[i + 1]; sb += lab[i + 2]; n++;
        }
      }
    }
    const nValid = valid ? valid.nValid || countValid(valid) : w * h;
    return { L: sL / n, a: sa / n, b: sb / n, frac: (n * step * step) / Math.max(1, nValid) };
  };
  function countValid(valid) { let c = 0; for (let p = 0; p < valid.length; p++) c += valid[p]; valid.nValid = c; return c; }

  /** Which pixels of a tilt-corrected image are real camera pixels (alpha
   *  > 0): `valid`, a 0/1 Uint8Array (.nValid = count) for the sampled JS
   *  loops, and `validMat`, a 0/255 cv.Mat for the WebAssembly stages
   *  (caller deletes it). WebAssembly, no per-pixel JS. */
  PH.validFromAlpha = function (img) {
    const cv = PH.cv, w = img.w, h = img.h;
    const rgba = new cv.Mat(h, w, cv.CV_8UC4); rgba.data.set(img.data);
    const ch = new cv.MatVector(); cv.split(rgba, ch);
    // MatVector.get() returns a new Mat each call that must be deleted.
    const alpha = ch.get(3);
    const validMat = new cv.Mat(); cv.threshold(alpha, validMat, 0, 255, cv.THRESH_BINARY);
    const v01 = new cv.Mat(); cv.threshold(alpha, v01, 0, 1, cv.THRESH_BINARY);
    const valid = new Uint8Array(v01.data);
    valid.nValid = cv.countNonZero(validMat);
    [alpha, rgba, ch, v01].forEach((m) => m.delete());
    return { valid, validMat };
  };

  /** The L, a, b planes of an interleaved Lab image as three 8-bit cv.Mats
   *  (caller deletes them: P.delete()). segment() makes them once per frame
   *  and shares them; copying and splitting the frame used to happen up to
   *  three times (shadow flattening, distance, outlines). */
  PH.labPlanes = function (lab, w, h) {
    const cv = PH.cv;
    const lab3 = new cv.Mat(h, w, cv.CV_8UC3); lab3.data.set(lab);
    const mv = new cv.MatVector(); cv.split(lab3, mv);
    const P = { L: mv.get(0), A: mv.get(1), B: mv.get(2) };
    lab3.delete(); mv.delete();
    P.delete = () => { P.L.delete(); P.A.delete(); P.B.delete(); };
    return P;
  };

  /** Colour distance of every pixel from `bg`, 2 units per ΔE with lightness
   *  weighted by `ls`, as an 8-bit cv.Mat (saturating at 255). Pixels where
   *  `validMat` (0/255, optional) is 0 come out 0 (= background). WebAssembly
   *  throughout; replaces a JS loop that cost up to ~80 ms on the phone.
   *  `planes` ({L, A, B} Mats, optional) are used instead of splitting `lab`. */
  PH.labDistance = function (lab, w, h, bg, ls, validMat, planes) {
    const cv = PH.cv;
    const own = planes ? null : PH.labPlanes(lab, w, h);
    const { L, A, B } = planes || own;
    const fL = new cv.Mat(), fA = new cv.Mat(), fB = new cv.Mat(), m1 = new cv.Mat(), m2 = new cv.Mat();
    L.convertTo(fL, cv.CV_32F, ls, -bg.L * ls);
    A.convertTo(fA, cv.CV_32F, 1, -bg.a);
    B.convertTo(fB, cv.CV_32F, 1, -bg.b);
    cv.magnitude(fL, fA, m1);   // sqrt(dL² + da²)
    cv.magnitude(m1, fB, m2);   // sqrt(dL² + da² + db²)
    const dist = new cv.Mat();
    // ×2 per ΔE; the -0.5 makes the rounding match the old truncating store.
    m2.convertTo(dist, cv.CV_8U, 2, -0.5);
    if (validMat) cv.bitwise_and(dist, validMat, dist);
    [fL, fA, fB, m1, m2].forEach((m) => m.delete());
    if (own) own.delete();
    return dist;
  };

  /**
   * Foreground from sharp outlines (the 'edges' background model): for a
   * see-through table. On the owner's glass table (2026-10-07) the floor under
   * the glass (wood, dark carpet, light tile, lamp-lit gradients) showed
   * through in so many colours that no colour model found more than ~10 of
   * ~80 pieces. But the floor is ~70 cm further away than the pieces, so it
   * is out of focus: in the full camera image every piece has a crisp, closed
   * outline and the floor only sensor noise. Shrunk to the processing size
   * that difference is gone, so the outlines are found at `hp` (the same view
   * at ~2x the size).
   * The floor = the outline-free regions reaching the frame edge, plus big
   * enclosed regions (inside a ring of pieces, or an assembled border) whose
   * colour matches the floor around them. Everything else (pieces, their
   * outlines, small gaps between pieces) is foreground; touching pieces are
   * split later like any clump.
   * `edgeT` = Canny thresholds [lo, hi]. Returns a 0/255 Uint8Array, w x h.
   */
  PH.edgeForeground = function (hp, w, h, lab, edgeT) {
    const cv = PH.cv;
    const src = new cv.Mat(hp.h, hp.w, cv.CV_8UC4);
    src.data.set(hp.data);
    const g = new cv.Mat(), e = new cv.Mat();
    cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(g, g, new cv.Size(3, 3), 0);
    cv.Canny(g, e, edgeT[0], edgeT[1]);
    if (hp.invalid) {
      // no outline along the edge of the real camera image (tilt correction)
      const v = new cv.Mat(), ch = new cv.MatVector();
      cv.split(src, ch); ch.get(3).copyTo(v);
      cv.erode(v, v, cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7)));
      cv.bitwise_and(e, v, e);
      for (let i = 0; i < ch.size(); i++) ch.get(i).delete();
      ch.delete(); v.delete();
    }
    const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(e, e, k3);
    const es = new cv.Mat();
    cv.resize(e, es, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    cv.threshold(es, es, 40, 255, cv.THRESH_BINARY_INV); // outline-free = 255
    const lbl = new cv.Mat(), st = new cv.Mat(), ce = new cv.Mat();
    const n = cv.connectedComponentsWithStats(es, lbl, st, ce, 4, cv.CV_32S);
    const L = lbl.data32S.slice(), S = st.data32S.slice();
    [src, g, e, k3, es, lbl, st, ce].forEach((m) => m.delete());
    const A = w * h, bgR = new Uint8Array(n);
    for (let i = 1; i < n; i++) {
      const x = S[i * 5], y = S[i * 5 + 1], rw = S[i * 5 + 2], rh = S[i * 5 + 3], a = S[i * 5 + 4];
      if (a > A * 0.003 && (x <= 0 || y <= 0 || x + rw >= w || y + rh >= h)) bgR[i] = 1;
    }
    // The floor's colour around each spot (tiles of ~1/12 of the view, from
    // the floor regions found so far; tiles without floor take their
    // neighbours'), for judging the big enclosed regions.
    const TS = Math.max(24, Math.round(Math.max(w, h) / 12)), gx = Math.ceil(w / TS), gy = Math.ceil(h / TS);
    const acc = new Float64Array(gx * gy * 4);
    for (let p = 0; p < A; p += 2) {
      if (!bgR[L[p]]) continue;
      const t = (((p / w) | 0) / TS | 0) * gx + (((p % w) / TS) | 0);
      acc[4 * t] += lab[3 * p]; acc[4 * t + 1] += lab[3 * p + 1]; acc[4 * t + 2] += lab[3 * p + 2]; acc[4 * t + 3]++;
    }
    const G = new Float32Array(gx * gy * 3), ok = new Uint8Array(gx * gy);
    for (let t = 0; t < gx * gy; t++) if (acc[4 * t + 3] > 20) { for (let c = 0; c < 3; c++) G[3 * t + c] = acc[4 * t + c] / acc[4 * t + 3]; ok[t] = 1; }
    for (let it = 0; it < gx + gy; it++) {
      let any = false;
      for (let i = 0; i < gx * gy; i++) {
        if (ok[i]) continue;
        const x = i % gx, y = (i / gx) | 0, s = [0, 0, 0];
        let m = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= gx || Y >= gy || ok[Y * gx + X] !== 1) continue;
          const j = Y * gx + X; for (let c = 0; c < 3; c++) s[c] += G[3 * j + c]; m++;
        }
        if (m) { for (let c = 0; c < 3; c++) G[3 * i + c] = s[c] / m; ok[i] = 2; any = true; }
      }
      for (let i = 0; i < gx * gy; i++) if (ok[i] === 2) ok[i] = 1;
      if (!any) break;
    }
    // big enclosed regions (>= 1.5% of the view): floor if their colour is
    // the floor's there (lightness counts half, as in the colour models)
    const big = new Float64Array(n * 2);
    for (let p = 0; p < A; p += 2) {
      const r = L[p];
      if (!r || bgR[r] || S[r * 5 + 4] < A * PH.EDGE_POCKET) continue;
      const t = (((p / w) | 0) / TS | 0) * gx + (((p % w) / TS) | 0);
      const dL = (lab[3 * p] - G[3 * t]) * 0.5, da = lab[3 * p + 1] - G[3 * t + 1], db = lab[3 * p + 2] - G[3 * t + 2];
      big[2 * r] += Math.sqrt(dL * dL + da * da + db * db); big[2 * r + 1]++;
    }
    for (let i = 1; i < n; i++) if (big[2 * i + 1] && big[2 * i] / big[2 * i + 1] < PH.EDGE_POCKET_DE) bgR[i] = 1;
    const om = new cv.Mat(h, w, cv.CV_8UC1), out = om.data;
    for (let p = 0; p < A; p++) out[p] = bgR[L[p]] ? 0 : 255;
    // thin outline strokes on the floor (the glass's own edge, grout lines,
    // reflections) are not pieces
    const k5 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.morphologyEx(om, om, cv.MORPH_OPEN, k5);
    k5.delete();
    if (PH.EDGE_TRIM) { const kt = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * PH.EDGE_TRIM + 1, 2 * PH.EDGE_TRIM + 1)); cv.erode(om, om, kt); kt.delete(); }
    if (hp.invalid) {
      // (outside the real camera image: never foreground)
      const s = hp.w / w;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const q = (Math.min(hp.h - 1, Math.round(y * s)) * hp.w + Math.min(hp.w - 1, Math.round(x * s))) * 4 + 3;
        if (!hp.data[q]) out[y * w + x] = 0;
      }
    }
    const res = new Uint8Array(out);
    om.delete();
    return res;
  };

  /**
   * Even out lamp shadows / uneven light. Estimates how bright the bare board
   * is at every spot (a smooth surface with the pieces removed), then scales
   * lightness so the whole board reads like its lit part. Shadows scale
   * brightness, so the correction is a ratio. How the pieces are removed
   * depends on the board: brighter than the pieces (white board) -> remove
   * darker blobs (closing); darker (black felt) -> remove brighter blobs
   * (opening); in between -> median. Returns null when the light is already
   * even (nothing to fix).
   * With `planes` ({L, A, B} Mats of `lab`, shared by segment()) it returns
   * the corrected lightness plane as a Mat {Lmat, ref, spread} (caller
   * deletes Lmat; a and b are unchanged) instead of a merged Lab array.
   */
  PH.flattenLight = function (lab, w, h, valid, unitArea, boardL, validMat, planes) {
    const cv = PH.cv;
    const n = w * h;
    // Lightness plane and the darker/brighter-than-board counts, in WebAssembly.
    const own = planes ? null : PH.labPlanes(lab, w, h);
    const { L, A, B } = planes || own;
    let vm = validMat || null;
    if (valid && !vm) { vm = new cv.Mat(h, w, cv.CV_8UC1); vm.data.set(valid); cv.threshold(vm, vm, 0, 255, cv.THRESH_BINARY); }
    const tmp = new cv.Mat();
    const countWhere = (t, type) => { cv.threshold(L, tmp, t, 255, type); if (vm) cv.bitwise_and(tmp, vm, tmp); return cv.countNonZero(tmp); };
    const cnt = vm ? cv.countNonZero(vm) : n;
    // 8-bit thresholds are floored: BINARY_INV at t keeps L <= floor(t), BINARY keeps L > floor(t).
    const darker = countWhere(Math.ceil(boardL - 12) - 1, cv.THRESH_BINARY_INV); // L < boardL - 12
    const brighter = countWhere(boardL + 12, cv.THRESH_BINARY);                  // L > boardL + 12
    tmp.delete();
    if (vm && vm !== validMat) vm.delete();
    const s = Math.max(1, Math.round(Math.max(w, h) / 120));
    const sw = Math.max(8, Math.round(w / s)), sh = Math.max(8, Math.round(h / s));
    const sm = new cv.Mat();
    cv.resize(L, sm, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
    const side = unitArea ? Math.sqrt(unitArea) : Math.max(w, h) / 10;
    const kmax = 2 * Math.floor((Math.min(sw, sh) - 1) / 2) + 1;
    const k = Math.min(kmax, Math.max(5, Math.round((1.6 * side) / s) | 1));
    if (brighter < cnt * 0.1) {
      const ker = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
      cv.morphologyEx(sm, sm, cv.MORPH_CLOSE, ker); ker.delete();
    } else if (darker < cnt * 0.1) {
      const ker = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
      cv.morphologyEx(sm, sm, cv.MORPH_OPEN, ker); ker.delete();
    } else {
      cv.medianBlur(sm, sm, Math.min(k, 255));
    }
    cv.GaussianBlur(sm, sm, new cv.Size(0, 0), Math.max(1, k / 3));
    // How uneven is the light? 10th..90th percentile of the surface (from a
    // 256-bin histogram of the small surface image, not a comparator sort).
    const lo = percentile8(sm.data, 0.1), hi = percentile8(sm.data, 0.9);
    const done = (r) => { sm.delete(); if (own) own.delete(); return r; };
    if (hi - lo < hi * 0.08) return done(null);
    // Ratio correction L' = L * ref / max(16, surface), saturated, in WebAssembly.
    const big = new cv.Mat(), floor = new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(16)), Lf = new cv.Mat(), Lout = new cv.Mat();
    cv.resize(sm, big, new cv.Size(w, h), 0, 0, cv.INTER_LINEAR);
    cv.max(big, floor, big);
    const ref = hi;
    // Float divide, then truncate (-0.5 before rounding) like the old JS
    // store: rounding instead shifts lightness ~0.5 and can flip which
    // coarse colour bin wins the background estimate.
    cv.divide(L, big, Lf, ref, cv.CV_32F);
    Lf.convertTo(Lout, cv.CV_8U, 1, -0.5);
    [Lf, big, floor].forEach((m) => m.delete());
    if (planes) return done({ Lmat: Lout, ref, spread: (hi - lo) / hi });
    const out = mergeLab(Lout, A, B);
    Lout.delete();
    return done({ lab: out, ref, spread: (hi - lo) / hi });
  };
  // Interleaved Lab array from three planes.
  function mergeLab(L, A, B) {
    const cv = PH.cv;
    const merged = new cv.Mat(), mv = new cv.MatVector();
    mv.push_back(L); mv.push_back(A); mv.push_back(B);
    cv.merge(mv, merged);
    const out = new Uint8Array(merged.data);
    merged.delete(); mv.delete();
    return out;
  }
  // Mixed-table classification: 0 where the pixel's colour bin is background, else 255.
  // PH.edgeForeground for this view at about twice the processing size,
  // kept for the last view (the background re-check scores it repeatedly).
  let edgeCache = null;
  function edgeMask(source, w, h, lab, edgeT) {
    const T = edgeT || PH.EDGE_T[0], key = w + 'x' + h + ':' + T.join(',');
    if (edgeCache && edgeCache.source === source && edgeCache.key === key) return edgeCache.mask;
    const long = Math.max(source.w, source.h), want = Math.max(w, h) * PH.EDGE_SCALE;
    const hp = source.getProc(Math.min(long, want));
    // (another view's source: wrong shape -> no outline model this time)
    if (Math.abs(hp.w / hp.h - w / h) > 0.02) return null;
    const mask = PH.edgeForeground(hp, w, h, lab, T);
    edgeCache = { source, key, mask };
    return mask;
  }
  PH.EDGE_SCALE = 2;
  PH.EDGE_POCKET_DE = 12;
  PH.EDGE_TRIM = 1; // px: the widened outline and the piece's shadow side fatten it (rounded corners failed the piece-shape test)
  PH.EDGE_POCKET = 0.0005; // enclosed regions from this share of the view up are judged by colour (smaller: print inside a piece)
  // Canny thresholds the background re-check tries (each a candidate: the
  // one finding the most piece-shaped blobs wins - no setting for the owner)
  PH.EDGE_T = [[30, 80], [50, 120]];

  function lutClassify(lab, n, lut, out) {
    const corr = lut.corr;
    for (let p = 0, i = 0; p < n; p++, i += 3) out[p] = lut[PH.correctedBin(lab[i], lab[i + 1], lab[i + 2], corr)] ? 0 : 255;
  }
  // p-th fraction of an 8-bit array via a 256-bin histogram (small arrays only).
  function percentile8(data, p) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < data.length; i++) hist[data[i]]++;
    const target = Math.floor(data.length * p);
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > target) return v; }
    return 255;
  }

  /** The k most common colours in the frame (coarse Lab bins, neighbours of
   *  an already-picked bin are skipped), as {L,a,b,frac}. Background
   *  candidates: on a dense pile the most common colour can be the pieces. */
  PH.colorModes = function (lab, w, h, valid, k) {
    const counts = new Uint32Array(8 * 32 * 32), sums = new Float64Array(8 * 32 * 32 * 3);
    let n = 0;
    for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
      if (valid && !valid[y * w + x]) continue;
      const i = (y * w + x) * 3, b = ((lab[i] >> 5) << 10) | ((lab[i + 1] >> 3) << 5) | (lab[i + 2] >> 3);
      counts[b]++; sums[3 * b] += lab[i]; sums[3 * b + 1] += lab[i + 1]; sums[3 * b + 2] += lab[i + 2]; n++;
    }
    const order = [...counts.keys()].filter((b) => counts[b]).sort((x, y) => counts[y] - counts[x]);
    const picked = [];
    for (const b of order) {
      if (picked.length >= k) break;
      const L = b >> 10, A = (b >> 5) & 31, B = b & 31;
      if (picked.some((p) => Math.abs(p.Lb - L) <= 1 && Math.abs(p.Ab - A) <= 1 && Math.abs(p.Bb - B) <= 1)) continue;
      picked.push({ Lb: L, Ab: A, Bb: B, L: sums[3 * b] / counts[b], a: sums[3 * b + 1] / counts[b], b: sums[3 * b + 2] / counts[b], frac: counts[b] / n });
    }
    return picked.map((p) => ({ L: p.L, a: p.a, b: p.b, frac: p.frac }));
  };

  /** Piece area estimated from a pile's distance transform (85th percentile
   *  of its local maxima ~ 0.42 x side). null if there are too few peaks. */
  PH.pileUnit = function (mask) {
    const cv = PH.cv;
    const dt = new cv.Mat(), dil = new cv.Mat();
    cv.distanceTransform(mask, dt, cv.DIST_L2, 5);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    cv.dilate(dt, dil, k);
    const peaks = [], a = dt.data32F, b = dil.data32F;
    for (let p = 0; p < a.length; p++) if (a[p] >= 3 && a[p] >= b[p] - 1e-6) peaks.push(a[p]);
    [dt, dil, k].forEach((m) => m.delete());
    if (peaks.length < 10) return null;
    peaks.sort((x, y) => x - y);
    const side = peaks[Math.floor(peaks.length * 0.85)] / 0.42;
    return side * side * 1.1;
  };

  // Mass-weighted mode of log2(area), quarter-octave bins: the size that most
  // of the piece-like *area* belongs to.
  PH.massMode = function (areas) {
    const bins = new Map();
    for (const a of areas) { const k = Math.round(Math.log2(a) * 4); bins.set(k, (bins.get(k) || 0) + a); }
    let best = null;
    for (const [k, m] of bins) {
      // smooth with the neighbouring bins so a split peak isn't missed
      const sm = m + 0.5 * ((bins.get(k - 1) || 0) + (bins.get(k + 1) || 0));
      if (!best || sm > best.m) best = { k, m: sm };
    }
    // refine: area-weighted mean of the blobs within half an octave of the peak
    let s = 0, w = 0;
    for (const a of areas) if (Math.abs(Math.log2(a) * 4 - best.k) <= 2) { s += a * a; w += a; }
    return w ? s / w : Math.pow(2, best.k / 4);
  };


  // Coarse Lab bin (8 L x 32 a x 32 b) used by the background lookup table.
  PH.coarseBin = (L, a, b) => ((L >> 5) << 10) | ((a >> 3) << 5) | (b >> 3);

  // White point: mean Lab of the brightest ~4% of pixels (the paper of the
  // pieces / box print). Used to undo lighting color casts between photos.
  PH.whitePoint = function (lab, n) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n * 3; i += 9) hist[lab[i]]++;
    let tot = 0; for (let v = 0; v < 256; v++) tot += hist[v];
    let acc = 0, cut = 255;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= tot * 0.04) { cut = v; break; } }
    let sL = 0, sa = 0, sb = 0, m = 0;
    for (let i = 0; i < n * 3; i += 9) if (lab[i] >= cut) { sL += lab[i]; sa += lab[i + 1]; sb += lab[i + 2]; m++; }
    return m ? { L: sL / m, a: sa / m, b: sb / m } : { L: 255, a: 128, b: 128 };
  };
  // Map a frame color into the box picture's lighting: scale lightness so the
  // white points match, and remove the white point's color cast in proportion
  // to lightness. corr = null means no correction.
  PH.correctedBin = function (L, a, b, corr) {
    if (!corr) return PH.coarseBin(L, a, b);
    const t = L / corr.fL;
    const L2 = Math.min(255, L * corr.k), a2 = a - corr.da * t, b2 = b - corr.db * t;
    return PH.coarseBin(L2 | 0, PH.clamp(a2, 0, 255) | 0, PH.clamp(b2, 0, 255) | 0);
  };

  /**
   * Background lookup table for mixed backgrounds (glass, tile, wood...):
   * lut[bin] = 1 means "this color is background". Two sources:
   *  - taught: colors the user tapped on the table (most reliable)
   *  - palette: the box picture's colors. A color that is common in the frame
   *    but rare in the puzzle is background.
   * Returns null when neither is available (fall back to single-color cloth).
   */
  PH.buildBgLut = function (lab, n, opts) {
    const lut = new Uint8Array(8192);
    lut.corr = null;
    if (opts.taught && opts.taught.length) {
      const tol = opts.taughtTol || 12;
      for (let k = 0; k < 8192; k++) {
        const L = (k >> 10) * 32 + 16, a = ((k >> 5) & 31) * 8 + 4, b = (k & 31) * 8 + 4;
        for (const t of opts.taught) if (PH.dE(L, a, b, t.L, t.a, t.b, 0.8) < tol) { lut[k] = 1; break; }
      }
      return lut;
    }
    if (opts.palette) {
      let corr = null;
      if (opts.paletteWhite) {
        const wf = PH.whitePoint(lab, n), wb = opts.paletteWhite;
        // Only correct plausible casts (a dark frame with no paper in view has no real white).
        if (wf.L > 120) corr = { k: wb.L / wf.L, fL: wf.L, da: wf.a - wb.a, db: wf.b - wb.b };
      }
      lut.corr = corr;
      const fh = new Float32Array(8192);
      let m = 0;
      for (let i = 0; i < n * 3; i += 6) { fh[PH.correctedBin(lab[i], lab[i + 1], lab[i + 2], corr)]++; m++; }
      const ratio = opts.paletteRatio || 8;
      for (let k = 0; k < 8192; k++) { const f = fh[k] / m; if (f > 0.0005 && f > ratio * opts.palette[k]) lut[k] = 1; }
      return lut;
    }
    return null;
  };

  /**
   * Segment one image.
   * @param img {w,h,data:RGBA}
   * @param opts {minDE (foreground threshold in ΔE), lightW, bg (optional fixed/smoothed bg)}
   * @returns {lab, w, h, bg, thresh, dets:[{pts:Int32Array, area, cx, cy, bbox:[x,y,w,h], border, perim, fp}]}
   */
  PH.segment = function (img, opts) {
    const cv = PH.cv;
    opts = opts || {};
    const w = img.w, h = img.h;
    // Optional per-stage timings (opts.timings = {}) for profiling; and the
    // experimental knobs below (openK/closeK/boundary) default to the
    // long-standing behaviour so production output is unchanged.
    const T = opts.timings;
    let tm = now();
    const mark = (k) => { if (T) { const t = now(); T[k] = (T[k] || 0) + (t - tm); tm = t; } };
    const lab = PH.rgbaToLab(img.data, w, h);
    const P = PH.labPlanes(lab, w, h); // shared by the WebAssembly stages below
    mark('lab');
    // Pixels outside the real camera image (tilt correction): alpha 0.
    // `validMat` (0/255) masks the WebAssembly stages; `valid` (0/1 array) the
    // sampled JS loops. Both null when every pixel is real (untilted frames).
    // (74c030f made the mask always-present to keep loops monomorphic; the
    // next phone reports showed untilted frames getting as slow as tilted
    // ones, so that was reverted and the full-frame work moved to WebAssembly.)
    let valid = null, validMat = null;
    if (img.invalid) ({ valid, validMat } = PH.validFromAlpha(img));
    // opts.bgModel (chosen by the engine, see Engine.chooseBackground):
    //   {kind:'color', bg:{L,a,b}} plain board of that colour
    //   {kind:'taught'} / {kind:'palette'} colour tables; absent = automatic.
    const model = opts.bgModel || null;
    let est = model && model.kind === 'color' ? Object.assign({ frac: 1 }, model.bg) : PH.estimateBackground(lab, w, h, valid);
    mark('bgEst');
    // Taught colours that are all near-neutral and alike are just "the board"
    // (e.g. its lit and shadowed parts): handle it as a plain board, which
    // copes with lighting changes, instead of matching those exact colours.
    const taught = opts.taught || [];
    const taughtPlain = taught.length > 0 && taught.every((t) => Math.hypot(t.a - 128, t.b - 128) < 22) &&
      taught.every((t) => taught.every((u) => Math.hypot(t.a - u.a, t.b - u.b) < 12));
    // {kind:'colors', list:[...]}: a mixed table (glass + wood + tile ...) =
    // several background colours, handled like taught colours.
    if (model && model.kind === 'colors') opts = Object.assign({}, opts, { taught: model.list });
    const taughtActive = model ? model.kind === 'taught' || model.kind === 'colors' : taught.length > 0 && !taughtPlain;
    // Shadow-evened lightness for the plain-board model (colour fingerprints
    // and taught/palette tables keep using the real colours).
    // (Only the lightness plane changes, flatL; a and b stay those of `lab`.)
    let flat = null, flatL = null;
    if (opts.flatten !== false && !(model && model.kind !== 'color')) {
      flat = PH.flattenLight(lab, w, h, valid, opts.unitArea, est.L, validMat, P);
      if (flat) {
        flatL = flat.Lmat;
        if (model) {
          // the chosen board colour, re-measured in the shadow-evened image
          const Ls = flatL.data; // read right away: a view of WebAssembly memory
          let sL = 0, sa = 0, sb = 0, m = 0;
          for (let p = 0, i = 0; p < w * h; p += 5, i += 15) {
            if (valid && !valid[p]) continue;
            if (Math.abs(lab[i + 1] - est.a) < 8 && Math.abs(lab[i + 2] - est.b) < 8 && Math.abs(lab[i] - est.L) < 40) { sL += Ls[p]; sa += lab[i + 1]; sb += lab[i + 2]; m++; }
          }
          if (m > 50) est = { L: sL / m, a: sa / m, b: sb / m, frac: 1 };
        } else est = PH.estimateBackground(mergeLab(flatL, P.A, P.B), w, h, valid);
      }
    }
    mark('flatten');
    // A plain cloth (one dominant color that isn't a puzzle color) is handled
    // more precisely by the distance model; the palette table is for mixed
    // tables. (Non-plain) taught colours win.
    let plainCloth = model ? model.kind === 'color' : est.frac >= 0.2 && !taughtActive &&
      (!opts.palette || opts.palette[PH.coarseBin(est.L | 0, est.a | 0, est.b | 0)] * 8 < est.frac);
    let lut = plainCloth ? null : PH.buildBgLut(lab, w * h, taughtActive ? opts : Object.assign({}, opts, { taught: null }));
    // Stale taught colours (the light changed since they were tapped): if they
    // explain under a fifth of the frame, use the plain-board model this frame.
    if (lut && taughtActive && !model) {
      let bgc = 0, m = 0;
      for (let p = 0, i = 0; p < w * h; p += 7, i += 21) { if (valid && !valid[p]) continue; m++; if (lut[PH.correctedBin(lab[i], lab[i + 1], lab[i + 2], lut.corr)]) bgc++; }
      if (bgc < m * 0.2 && est.frac >= 0.2) { lut = null; plainCloth = true; }
    }
    mark('lut');
    let bg = est;
    if (opts.bg && opts.bgSmooth) {
      const prev = opts.bg, k = opts.bgSmooth;
      // Only blend when the new estimate is close; a big jump means the view changed.
      if (PH.dE(prev.L, prev.a, prev.b, est.L, est.a, est.b, 1) < 12) {
        bg = { L: prev.L * (1 - k) + est.L * k, a: prev.a * (1 - k) + est.a * k, b: prev.b * (1 - k) + est.b * k };
      }
    }
    const lightW = opts.lightW === undefined ? 0.5 : opts.lightW;

    // Distance-from-background image, 2 units per ΔE (WebAssembly).
    const ls = PH.L_SCALE * lightW;
    // Glare / blown-out highlights: share of (real) pixels at full lightness.
    // (Before `dd` below: a new Mat can grow WebAssembly memory, which would
    // leave an earlier view of it empty.)
    const blown = new cv.Mat();
    cv.threshold(P.L, blown, 249, 255, cv.THRESH_BINARY);
    if (validMat) cv.bitwise_and(blown, validMat, blown);
    const glare = cv.countNonZero(blown) / Math.max(1, valid ? valid.nValid : w * h);
    blown.delete();
    const dist = PH.labDistance(null, w, h, bg, ls, validMat, { L: flatL || P.L, A: P.A, B: P.B });
    const dd = dist.data;
    mark('dist');
    // Threshold from the cloth's own noise: the background is the large peak
    // near zero distance, so its median distance measures the cloth texture.
    // (Otsu would split halfway to the average piece color and cut away any
    // print that is merely close to the cloth.)
    const mask = new cv.Mat();
    let thresh;
    if (lut) {
      // Mixed background: classify each pixel by its color bin. (A small,
      // separate function, so the engine optimises it on its own.)
      lutClassify(lab, w * h, lut, dd);
      if (validMat) cv.bitwise_and(dist, validMat, dist);
      thresh = 128;
    } else {
      const otsu = cv.threshold(dist, mask, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      const dh = new Uint32Array(256);
      for (let p = 0; p < w * h; p += 2) dh[dd[p]]++;
      let below = 0, total = 0;
      for (let v = 0; v < otsu; v++) total += dh[v];
      let med = 0;
      for (let v = 0; v < otsu; v++) { below += dh[v]; if (below >= total / 2) { med = v; break; } }
      const minT = 2 * (opts.minDE || 8);
      thresh = PH.clamp(Math.max(minT, med * 3.5), minT, Math.max(minT, otsu));
    }
    cv.threshold(dist, mask, thresh, 255, cv.THRESH_BINARY);
    // See-through table: the floor is told apart by focus, not colour
    // (PH.edgeForeground). `opts.edgeSource()` = this view's image source.
    const edgeFg = model && model.kind === 'edges' && opts.edgeSource ? edgeMask(opts.edgeSource(), w, h, lab, model.edgeT) : null;
    if (edgeFg) mask.data.set(edgeFg);
    // Colour alone, before outlines are closed and filled: holes inside an
    // assembled section (missing pieces) survive only here.
    const colorFg = new Uint8Array(mask.data);
    mark('thresh');

    // Experimental: a piece has a crisp outline against any plain table even
    // where its print matches the table's colour. Lightness gradient above
    // `boundaryT` is added to the mask, so a pale piece becomes a closed ring
    // and RETR_EXTERNAL returns its outline.
    if (opts.boundary && !edgeFg) {
      const Lm = P.L; // the frame's own lightness (not shadow-evened)
      const gx = new cv.Mat(), gy = new cv.Mat(), ax = new cv.Mat(), ay = new cv.Mat(), mag = new cv.Mat();
      cv.Scharr(Lm, gx, cv.CV_16S, 1, 0); cv.Scharr(Lm, gy, cv.CV_16S, 0, 1);
      cv.convertScaleAbs(gx, ax, 1 / 16); cv.convertScaleAbs(gy, ay, 1 / 16);
      cv.addWeighted(ax, 0.5, ay, 0.5, 0, mag);
      cv.threshold(mag, mag, opts.boundaryT || 10, 255, cv.THRESH_BINARY);
      if (validMat) cv.bitwise_and(mag, validMat, mag); // no edges in the filled-in corners
      if (opts.boundary === 'fill') {
        // Close the edge rings and keep only what they enclose: a ring that
        // doesn't close adds nothing (no stray edge fragments), a closed one
        // yields a solid piece. Enclosed = not reachable from the frame edge.
        const bk = opts.boundaryClose || 5;
        const kb = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(bk, bk));
        cv.morphologyEx(mag, mag, cv.MORPH_CLOSE, kb);
        const inv = new cv.Mat();
        cv.bitwise_not(mag, inv); // free space = 255
        // Paint a 1 px free frame so every outside region touches (0,0), then
        // ONE flood fill from there empties all the outside; whatever is still
        // 255 is enclosed by a closed ring.
        cv.rectangle(inv, new cv.Point(0, 0), new cv.Point(w - 1, h - 1), new cv.Scalar(255), 1);
        const ff = cv.Mat.zeros(h + 2, w + 2, cv.CV_8UC1);
        cv.floodFill(inv, ff, new cv.Point(0, 0), new cv.Scalar(0), new cv.Rect(), new cv.Scalar(0), new cv.Scalar(0), 4);
        // Add interiors and the rings themselves - unless the scene is too
        // busy (dense piles, print, reflections): then the rings close up
        // everywhere and the "pieces" swallow the table. Guard: if filling
        // more than roughly doubles the foreground, keep the colour mask.
        const before = cv.countNonZero(mask);
        const filled = new cv.Mat();
        cv.bitwise_or(mask, inv, filled);
        cv.bitwise_or(filled, mag, filled);
        const after = cv.countNonZero(filled);
        // Judge by how much of the remaining table the fill claims: on a plain
        // board it adds the pale pieces (a small share); on a busy scene it
        // swallows a large share of the "table".
        const claimed = (after - before) / Math.max(1, w * h - before);
        if (T) T.boundaryClaim = claimed;
        if (claimed <= 0.3) filled.copyTo(mask);
        else if (T) T.boundaryRejected = 1;
        [kb, inv, ff, filled].forEach((m) => m.delete());
      } else {
        cv.bitwise_or(mask, mag, mask);
      }
      [gx, gy, ax, ay, mag].forEach((m) => m.delete());
      mark('boundary');
    }

    // Texture channel (opts.texture = {T, erode}): printed pieces have fine
    // detail even where their colour matches the board; a plain board has
    // none. Local spread of lightness (7x7) above T, closed, holes filled,
    // trimmed back by `erode` (the window spreads past the edge), added to
    // the mask. The engine turns it on only while pale pieces blend into the
    // board (capture coach): on the owner's frames it costs good pieces
    // elsewhere (98 -> 93-95), on pale-on-white tables it finds more.
    if (opts.texture && !edgeFg) {
      const tT = opts.texture.T || 5, er = opts.texture.erode || 0;
      const Lf = new cv.Mat(), m = new cv.Mat(), m2 = new cv.Mat(), sq = new cv.Mat(), tm = new cv.Mat(), t8 = new cv.Mat();
      P.L.convertTo(Lf, cv.CV_32F);
      cv.blur(Lf, m, new cv.Size(7, 7));
      cv.multiply(Lf, Lf, sq); cv.blur(sq, m2, new cv.Size(7, 7));
      cv.multiply(m, m, sq); cv.subtract(m2, sq, m2); // variance
      cv.threshold(m2, tm, tT * tT, 255, cv.THRESH_BINARY); tm.convertTo(t8, cv.CV_8U);
      if (validMat) cv.bitwise_and(t8, validMat, t8);
      const kc = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
      cv.morphologyEx(t8, t8, cv.MORPH_CLOSE, kc);
      const inv = new cv.Mat(); cv.bitwise_not(t8, inv);
      cv.rectangle(inv, new cv.Point(0, 0), new cv.Point(w - 1, h - 1), new cv.Scalar(255), 1);
      const ff = cv.Mat.zeros(h + 2, w + 2, cv.CV_8UC1);
      cv.floodFill(inv, ff, new cv.Point(0, 0), new cv.Scalar(0), new cv.Rect(), new cv.Scalar(0), new cv.Scalar(0), 4);
      cv.bitwise_or(t8, inv, t8);
      if (er) { const ke = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * er + 1, 2 * er + 1)); cv.erode(t8, t8, ke); ke.delete(); }
      const before = cv.countNonZero(mask), comb = new cv.Mat();
      cv.bitwise_or(mask, t8, comb);
      // same guard as the outline fill: a busy scene must not swallow the table
      const claimed = (cv.countNonZero(comb) - before) / Math.max(1, w * h - before);
      if (claimed <= 0.3) comb.copyTo(mask);
      if (opts.timings) opts.timings.texClaim = claimed;
      [Lf, m, m2, sq, tm, t8, kc, inv, ff, comb].forEach((x) => x.delete());
      mark('texture');
    }

    const openK = opts.openK === undefined ? 3 : opts.openK;
    const closeK = opts.closeK === undefined ? 5 : opts.closeK;
    const k3 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(Math.max(1, openK), Math.max(1, openK)));
    const k5 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(Math.max(1, closeK), Math.max(1, closeK)));
    if (openK > 1) cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k3);
    if (closeK > 1) cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k5);
    mark('morph');
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    mark('contours');

    const minArea = opts.minArea || 150;
    const maxArea = w * h * 0.2;

    // Blob stats; a typical single piece is a fairly solid (convex-ish) blob.
    const blobs = [];
    const hull = new cv.Mat();
    for (let c = 0; c < contours.size(); c++) {
      const cnt = contours.get(c);
      const area = cv.contourArea(cnt);
      if (area < minArea) { cnt.delete(); continue; }
      cv.convexHull(cnt, hull);
      const r = cv.boundingRect(cnt);
      const edge = r.x <= 1 || r.y <= 1 || r.x + r.width >= w - 1 || r.y + r.height >= h - 1;
      blobs.push({ cnt, area, edge, solidity: area / Math.max(1, cv.contourArea(hull)) });
    }
    hull.delete();
    // This frame's own "one piece" area: mass-weighted mode of log2(area) over
    // blobs that look like a jigsaw piece (4 good corners). Fragments are many
    // but small, so they carry little mass and can't drag it down. Needs at
    // least 3 such blobs; otherwise there is no estimate (null), never a
    // median of everything (that once picked up a 578k px background blob).
    // (one piece is never more than ~12% of the view; bigger "piece-shaped"
    // blobs are piles or assembled sections and must not set the size)
    // Blobs cut off by the frame edge are never whole pieces: the owner's
    // kitchen photo (IMG_3573) had a wall region touching the top edge pass as
    // "piece-shaped" (score 0.034) and, being 100x a piece's area, it won the
    // mass mode — the photo then catalogued nothing.
    const like = blobs.filter((b) => !b.edge && b.solidity > 0.6 && b.area < Math.min(maxArea, w * h * 0.12) && PH.pieceScore(b.cnt.data32S, b.area) > PH.MIN_CORNER_SCORE).map((b) => b.area);
    // Two clean pieces of about the same size also set it: a close-up of a
    // few pieces (owner's IMG_3598: 4 pieces, two of them joined by a shadow)
    // otherwise fell to the pile estimate, which put the size at a quarter
    // and called every piece a clump.
    const unitOwn = like.length >= 3 ? PH.massMode(like) : like.length === 2 && Math.max(...like) < 1.3 * Math.min(...like) ? (like[0] + like[1]) / 2 : null;
    if (PH.DEBUG_SEG) console.log('piece-like', like.map(Math.round).sort((a, b) => a - b).join(','), 'own', unitOwn);
    // A caller-supplied unit (live scanning keeps one across frames) wins.
    // null = unknown: nothing gets split (and the engine calls nothing merged).
    // Dense pile (pieces touching, no isolated ones to learn the size from):
    // read the size off the pile itself - its distance-transform peaks sit at
    // piece centres, ~0.42 x piece side from the nearest table pixel.
    const bigBlob = blobs.some((b) => b.area > w * h * 0.05);
    const unitPile = !opts.unitArea && !unitOwn && bigBlob ? PH.pileUnit(mask) : null;
    const unitA = opts.unitArea || unitOwn || unitPile;
    if (PH.DEBUG_SEG) console.log('blobs', blobs.length, 'solid', blobs.filter((b) => b.solidity > 0.75).map((b) => Math.round(b.area)).sort((a, b) => a - b).join(','), 'unitA', unitA);
    mark('blobStats');

    // Split clusters of touching pieces (watershed from piece centers).
    const parts = [];
    let labMat = null;
    // Only clusters of a few pieces are worth splitting (huge blobs are
    // background or whole piles), and live frames get a small time budget.
    const splitMax = (opts.splitMaxRatio || 8) * unitA;
    const splitEnd = opts.splitBudgetMs === undefined ? Infinity : now() + opts.splitBudgetMs;
    blobs.sort((a, b) => a.area - b.area);
    // The budget is only checked before each blob, and one whole-pile split
    // can cost several times a small clump's (phone reports: split 28-50 ms
    // against a 25 ms budget). On live frames, start a pile only with most of
    // the budget left, and at most one per frame; photos split everything.
    const live = opts.splitBudgetMs !== undefined;
    let pilesSplit = 0;
    for (const b of blobs) {
      // Clusters of a few pieces always; whole piles too unless the caller
      // turned that off (time-limited on live frames by splitBudgetMs).
      const pile = b.area >= splitMax;
      const pileOk = !pile || (opts.splitPiles !== false && (!live || (pilesSplit === 0 && splitEnd - now() > opts.splitBudgetMs * 0.6)));
      if (opts.split !== false && unitA && b.area > 1.8 * unitA && pileOk && now() < splitEnd) {
        if (pile) pilesSplit++;
        if (!labMat) { labMat = new cv.Mat(h, w, cv.CV_8UC3); labMat.data.set(lab); }
        // Straight cuts between notches: for a small clump (2-3 touching
        // pieces) or a ragged pile, never for a big compact blob. On an
        // assembled section they carved piece-sized chunks off its edge, each
        // with a straight cut that read as a border side: false "edge pieces"
        // with a seam inside (owner, 2026-10-04).
        const concaveOk = b.area <= 3 * unitA || b.solidity < 0.8;
        const pieces = PH.splitBlob(b.cnt, labMat, unitA, w, h) || (opts.concave !== false && concaveOk ? PH.splitConcave(b.cnt, unitA) : null);
        if (pieces) { b.cnt.delete(); for (const p of pieces) parts.push({ cnt: p, split: true, parent: { area: b.area / unitA, solidity: b.solidity } }); continue; }
      }
      parts.push({ cnt: b.cnt, split: false, solidity: b.solidity });
    }
    if (labMat) labMat.delete();
    mark('split');

    const dets = [];
    // The frame's foreground, kept for checking a piece's straight sides (bare
    // table beyond a real border side; more pieces beyond a cut).
    const fg = new Uint8Array(mask.data);
    const noHier = new cv.Mat();
    for (const part of parts) {
      const cnt = part.cnt;
      const area = cv.contourArea(cnt);
      // Bigger than a fifth of the view: the table read as a piece - or, late
      // in a puzzle, the assembled part of it held close. Kept as `big` (never
      // catalogued; only searched for open spots, which a wrong blob fails).
      const big = area > maxArea;
      if (area < minArea || area > w * h * 0.9) { cnt.delete(); continue; }
      const r = cv.boundingRect(cnt);
      const m = cv.moments(cnt);
      const border = r.x <= 1 || r.y <= 1 || r.x + r.width >= w - 1 || r.y + r.height >= h - 1;
      const det = {
        pts: new Int32Array(cnt.data32S),
        area,
        cx: m.m10 / m.m00,
        cy: m.m01 / m.m00,
        bbox: [r.x, r.y, r.width, r.height],
        border,
        split: part.split,
        parent: part.parent || null, // a split part: its blob's size (in pieces) and solidity
        solidity: part.solidity, // area / convex hull (an assembled block is compact; a clump of loose pieces isn't)
        perim: cv.arcLength(cnt, true),
      };
      if (big) det.big = true;
      // Filled mask for this contour within its bbox -> fingerprint.
      const pm = cv.Mat.zeros(r.height, r.width, cv.CV_8UC1);
      const one = new cv.MatVector();
      one.push_back(cnt);
      cv.drawContours(pm, one, 0, new cv.Scalar(255), -1, cv.LINE_8, noHier, 0, new cv.Point(-r.x, -r.y));
      det.fp = PH.fingerprint(lab, w, r, pm.data, dd, thresh, h, bg, opts.boardRef || null);
      det.rect = cv.minAreaRect(cnt);
      // Holes inside an assembled section (missing pieces): blob filled minus
      // the mask, piece-sized-ish ones only.
      if (big || area > w * h * 0.03 || (unitA && area > 2.5 * unitA)) det.holes = blobHoles(pm, colorFg, w, r, Math.min(unitA || Infinity, w * h * 0.002 * 4) / 4);
      one.delete(); pm.delete(); cnt.delete();
      dets.push(det);
    }
    noHier.delete();
    contours.delete(); hier.delete(); dist.delete(); mask.delete(); k3.delete(); k5.delete();
    if (validMat) validMat.delete();
    P.delete(); if (flatL) flatL.delete();
    mark('dets');
    return { lab, w, h, bg, thresh: thresh / 2, dets, lut, glare, unitArea: unitA, unitOwn, unitN: like.length, likeMed: like.length ? PH.median(like) : null, flat: flat && { ref: flat.ref, spread: flat.spread }, fg };
  };
  // Holes of one blob: pm = its filled outline (bbox r), colorFg = the
  // frame's colour-only foreground (w wide). Board-coloured patches inside
  // the outline of at least `minA` px.
  function blobHoles(pm, colorFg, w, r, minA) {
    const cv = PH.cv;
    const hole = new cv.Mat(r.height, r.width, cv.CV_8UC1), hd = hole.data, pd = pm.data;
    for (let y = 0; y < r.height; y++) {
      const o = (r.y + y) * w + r.x, q = y * r.width;
      for (let x = 0; x < r.width; x++) hd[q + x] = pd[q + x] && !colorFg[o + x] ? 255 : 0;
    }
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.morphologyEx(hole, hole, cv.MORPH_OPEN, k); k.delete();
    const cs = new cv.MatVector(), hh = new cv.Mat();
    cv.findContours(hole, cs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE, new cv.Point(r.x, r.y));
    const out = [];
    for (let i = 0; i < cs.size(); i++) {
      const c = cs.get(i);
      if (cv.contourArea(c) >= minA) out.push(new Int32Array(c.data32S));
      c.delete();
    }
    [hole, cs, hh].forEach((m) => m.delete());
    return out;
  }

  /**
   * Split a blob of touching pieces. Seeds are the piece centers (far from the
   * blob edge: tabs and the narrow contacts between pieces are not), then a
   * watershed on the image grows them out to the seams. Interlocked sections
   * have no narrow contacts, so they stay whole. Returns contour Mats in image
   * coordinates, or null if the blob looks like one piece.
   */
  PH.splitBlob = function (cnt, labMat, unitA, w, h) {
    const cv = PH.cv;
    const br = cv.boundingRect(cnt);
    const x0 = Math.max(0, br.x - 2), y0 = Math.max(0, br.y - 2);
    const R = new cv.Rect(x0, y0, Math.min(w, br.x + br.width + 2) - x0, Math.min(h, br.y + br.height + 2) - y0);
    const blob = cv.Mat.zeros(R.height, R.width, cv.CV_8UC1);
    const one = new cv.MatVector(); one.push_back(cnt);
    const noH = new cv.Mat();
    cv.drawContours(blob, one, 0, new cv.Scalar(255), -1, cv.LINE_8, noH, 0, new cv.Point(-R.x, -R.y));
    const dist = new cv.Mat();
    cv.distanceTransform(blob, dist, cv.DIST_L2, 5);
    const t = 0.3 * Math.sqrt(unitA / 1.1);
    // Seeds = piece centres (far from the blob edge); WebAssembly, not a JS loop.
    const seedsF = new cv.Mat(), seeds = new cv.Mat();
    cv.threshold(dist, seedsF, t, 255, cv.THRESH_BINARY);
    seedsF.convertTo(seeds, cv.CV_8U);
    seedsF.delete();
    const labels = new cv.Mat();
    const nl = cv.connectedComponents(seeds, labels, 8, cv.CV_32S);
    let out = null;
    if (nl - 1 >= 2) {
      const L = labels.data32S;
      const outside = new cv.Mat();
      cv.threshold(blob, outside, 0, 255, cv.THRESH_BINARY_INV);
      labels.setTo(new cv.Scalar(nl), outside); // outside the blob = its own basin
      outside.delete();
      // roi() is a view that pins labMat's whole buffer until it's deleted:
      // not deleting it leaked a full frame (~0.7 MB) per split.
      const roiView = labMat.roi(R), img = roiView.clone();
      roiView.delete();
      cv.watershed(img, labels);
      out = [];
      // One pass for each label's bounding box, then trace each label inside it.
      const bx0 = new Int32Array(nl).fill(1e9), by0 = new Int32Array(nl).fill(1e9), bx1 = new Int32Array(nl).fill(-1), by1 = new Int32Array(nl).fill(-1);
      for (let y = 0, p = 0; y < R.height; y++) for (let x = 0; x < R.width; x++, p++) {
        const k = L[p];
        if (k < 1 || k >= nl) continue;
        if (x < bx0[k]) bx0[k] = x; if (x > bx1[k]) bx1[k] = x; if (y < by0[k]) by0[k] = y; if (y > by1[k]) by1[k] = y;
      }
      const cs = new cv.MatVector(), hh = new cv.Mat();
      for (let k = 1; k < nl; k++) {
        if (bx1[k] < 0) continue;
        const rw = bx1[k] - bx0[k] + 3, rh = by1[k] - by0[k] + 3; // 1px empty frame around
        const region = cv.Mat.zeros(rh, rw, cv.CV_8UC1);
        for (let y = by0[k]; y <= by1[k]; y++) for (let x = bx0[k]; x <= bx1[k]; x++) if (L[y * R.width + x] === k) region.data[(y - by0[k] + 1) * rw + (x - bx0[k] + 1)] = 255;
        cv.findContours(region, cs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE, new cv.Point(R.x + bx0[k] - 1, R.y + by0[k] - 1));
        region.delete();
        let best = null, ba = 0;
        for (let i = 0; i < cs.size(); i++) { const c = cs.get(i); const a = cv.contourArea(c); if (a > ba) { if (best) best.delete(); best = c; ba = a; } else c.delete(); }
        if (best && ba >= 0.25 * unitA) out.push(best); else if (best) best.delete();
      }
      [img, cs, hh].forEach((m) => m.delete());
      if (out.length < 2) { out.forEach((m) => m.delete()); out = null; }
    }
    [blob, one, noH, dist, seeds, labels].forEach((m) => m.delete());
    return out;
  };

  /**
   * Split touching pieces the watershed couldn't (no narrow neck: pieces
   * pressed side by side): cut between a pair of deep inward notches on the
   * outline (concave points; splitting touching cells this way is >96%
   * reliable in the literature). A piece's own blanks are deep notches too,
   * so a cut is only taken when BOTH halves are piece-sized and look like a
   * jigsaw piece (PH.pieceScore); the best such cut wins, and halves still
   * the size of two pieces are cut again. Returns contour Mats or null.
   */
  PH.splitConcave = function (cnt, unitA, depth) {
    const cv = PH.cv;
    depth = depth || 0;
    const side = Math.sqrt(unitA / 1.1);
    const P = cnt.data32S, n = P.length / 2;
    if (n < 30) return null;
    const hull = new cv.Mat(), defects = new cv.Mat();
    let deep = [];
    try {
      cv.convexHull(cnt, hull, false, false);
      cv.convexityDefects(cnt, hull, defects);
      const D = defects.data32S;
      for (let i = 0; i < D.length; i += 4) if (D[i + 3] / 256 >= 0.12 * side) deep.push({ i: D[i + 2], d: D[i + 3] / 256 });
    } catch (e) { deep = []; }
    hull.delete(); defects.delete();
    if (deep.length < 2) return null;
    const poly = (a, b) => { // outline from index a to b (inclusive), along the contour
      const out = [];
      for (let k = a; ; k = (k + 1) % n) { out.push(P[2 * k], P[2 * k + 1]); if (k === b) break; }
      return Int32Array.from(out);
    };
    const area = (q) => Math.abs(PH.polyArea(Float32Array.from(q)));
    // candidate cuts: short, between deep notches; the most promising few
    const cuts = [];
    for (let x = 0; x < deep.length; x++) for (let y = x + 1; y < deep.length; y++) {
      const a = deep[x], b = deep[y];
      const d = Math.hypot(P[2 * a.i] - P[2 * b.i], P[2 * a.i + 1] - P[2 * b.i + 1]);
      if (d < 2 || d > 0.9 * side) continue;
      cuts.push({ a: Math.min(a.i, b.i), b: Math.max(a.i, b.i), rank: (a.d + b.d) / d });
    }
    cuts.sort((p, q) => q.rank - p.rank);
    let best = null;
    for (const c of cuts.slice(0, 8)) {
      const A = poly(c.a, c.b), B = poly(c.b, c.a), aA = area(A), aB = area(B);
      if (aA < 0.55 * unitA || aB < 0.55 * unitA) continue;
      const sA = aA <= 1.8 * unitA ? PH.pieceScore(A, aA) : 1, sB = aB <= 1.8 * unitA ? PH.pieceScore(B, aB) : 1;
      const sc = Math.min(sA, sB);
      if (sc > PH.MIN_CORNER_SCORE * 1.5 && (!best || sc > best.sc)) best = { A, B, aA, aB, sc };
    }
    if (!best) return null;
    const out = [];
    for (const [q, a] of [[best.A, best.aA], [best.B, best.aB]]) {
      const m = cv.matFromArray(q.length / 2, 1, cv.CV_32SC2, Array.from(q));
      const more = a > 1.8 * unitA && depth < 3 ? PH.splitConcave(m, unitA, depth + 1) : null;
      if (more) { m.delete(); out.push(...more); } else out.push(m);
    }
    return out;
  };

  /** The board's colour right around a piece (its local "white"): median Lab
   *  of background pixels in a band just outside the bbox. The phone's own
   *  shadow and the camera's exposure change how bright a piece looks by up
   *  to ~4x (owner's video: the same piece at L 68 and L 15), but they change
   *  the board next to it by the same factor. null when too little board
   *  shows (a pile, the frame edge). */
  PH.localWhite = function (lab, w, h, r, distData, thresh) {
    const pad = Math.max(3, Math.round(0.15 * Math.max(r.width, r.height)));
    const x0 = Math.max(0, r.x - pad), y0 = Math.max(0, r.y - pad);
    const x1 = Math.min(w - 1, r.x + r.width + pad), y1 = Math.min(h - 1, r.y + r.height + pad);
    const Ls = [], As = [], Bs = [];
    const lim = thresh * 0.7;
    for (let y = y0; y <= y1; y += 2) {
      const inY = y >= r.y && y < r.y + r.height;
      for (let x = x0; x <= x1; x += 2) {
        if (inY && x >= r.x && x < r.x + r.width) { x = r.x + r.width - 1; continue; } // skip the piece's own box
        const p = y * w + x;
        if (distData[p] >= lim) continue;
        Ls.push(lab[3 * p]); As.push(lab[3 * p + 1]); Bs.push(lab[3 * p + 2]);
      }
    }
    if (Ls.length < 16) return null;
    return { L: PH.median(Ls), a: PH.median(As), b: PH.median(Bs) };
  };
  /** How to take the light out of colours read next to board colour `w`
   *  ([L, a, b] or {L, a, b}), against `ref` - this session's usual board
   *  colour (Engine.boardRef, a slow running average): lightness scaled by
   *  ref/board (0.6-1.7x) and the change in colour cast removed. On any board
   *  the usual factor is ~1 (a dark cloth or the glass table's wood is never
   *  "brightened" until white pieces clip); a shadow or an exposure change
   *  that darkens or tints the board is undone. Identity without a ref. */
  PH.LIGHT_K = [0.6, 1.7]; // how far the light correction may scale lightness
  PH.lightFix = function (w, ref) {
    if (!w || !ref) return { k: 1, da: 0, db: 0 };
    const g = (v, i, key) => (Array.isArray(v) ? v[i] : v[key]);
    const L = g(w, 0, 'L'), rL = g(ref, 0, 'L');
    if (!(L > 15) || !(rL > 15)) return { k: 1, da: 0, db: 0 };
    return { k: PH.clamp(rL / L, PH.LIGHT_K[0], PH.LIGHT_K[1]), kRaw: rL / L, da: g(w, 1, 'a') - g(ref, 1, 'a'), db: g(w, 2, 'b') - g(ref, 2, 'b') };
  };
  /** Soft (trilinear) vote of one Lab colour into the 4x4x4 histogram, so a
   *  small shift moves weight gradually instead of jumping a whole bin. */
  function histVote(hist, L, a, b) {
    const fl = Math.min(3, Math.max(0, L / 64 - 0.5)), fa = Math.min(3, Math.max(0, (a - 88) / 20 - 0.5)), fb = Math.min(3, Math.max(0, (b - 88) / 20 - 0.5));
    const l0 = Math.floor(fl), a0 = Math.floor(fa), b0 = Math.floor(fb);
    const wl = fl - l0, wa = fa - a0, wb = fb - b0;
    for (let i = 0; i < 2; i++) {
      const li = Math.min(3, l0 + i), kl = i ? wl : 1 - wl;
      if (!kl) continue;
      for (let j = 0; j < 2; j++) {
        const ai = Math.min(3, a0 + j), ka = kl * (j ? wa : 1 - wa);
        if (!ka) continue;
        for (let k = 0; k < 2; k++) {
          const bi = Math.min(3, b0 + k), kb = ka * (k ? wb : 1 - wb);
          if (kb) hist[(li << 4) | (ai << 2) | bi] += kb;
        }
      }
    }
  }
  /** T0 fingerprint: mean Lab, L spread and a 64-bin Lab histogram, all
   *  with the light taken out (PH.lightFix: the board around the piece,
   *  PH.localWhite, against this session's usual board `ref`). `raw` keeps the
   *  plain mean colour (capture coach, reports). `h`/`bg` are optional
   *  (without them the colours are used as they are). */
  PH.fingerprint = function (lab, w, r, maskData, distData, thresh, h, bg, ref) {
    const hist = new Float32Array(PH.HIST_BINS);
    const white = h ? PH.localWhite(lab, w, h, r, distData, thresh) || bg || null : bg || null;
    const fx = PH.lightFix(white, ref), kL = fx.k, da = fx.da, db = fx.db;
    let n = 0, sL = 0, sa = 0, sb = 0, sLL = 0, rL = 0, ra = 0, rb = 0;
    const strict = thresh * 1.15;
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        if (!maskData[y * r.width + x]) continue;
        const p = (r.y + y) * w + (r.x + x);
        if (distData[p] < strict) continue; // skip anti-aliased rim pixels
        const i = p * 3;
        const L0 = lab[i], a0 = lab[i + 1], b0 = lab[i + 2];
        const L = Math.min(255, L0 * kL), a = a0 - da, b = b0 - db;
        histVote(hist, L, a, b);
        sL += L; sa += a; sb += b; sLL += L * L; n++;
        rL += L0; ra += a0; rb += b0;
      }
    }
    if (n) for (let k = 0; k < hist.length; k++) hist[k] /= n;
    const mL = n ? sL / n : 0;
    return {
      hist,
      L: mL, a: n ? sa / n : 128, b: n ? sb / n : 128,
      sdL: n ? Math.sqrt(Math.max(0, sLL / n - mL * mL)) : 0,
      raw: n ? [rL / n, ra / n, rb / n] : [0, 128, 128],
      white: white ? [Math.round(white.L), Math.round(white.a), Math.round(white.b)] : null,
    };
  };

  /** Running fingerprint: `old` moved toward `obs` by weight k. A fingerprint
   *  in plain colours (saved before v0.20) is replaced outright. */
  PH.blendFp = function (old, obs, k) {
    if (!old || !old.white || !obs.white) return obs.white || !old ? obs : old;
    const hist = new Float32Array(old.hist.length);
    for (let i = 0; i < hist.length; i++) hist[i] = old.hist[i] * (1 - k) + obs.hist[i] * k;
    const mix = (a, b) => a * (1 - k) + b * k;
    return { hist, L: mix(old.L, obs.L), a: mix(old.a, obs.a), b: mix(old.b, obs.b), sdL: mix(old.sdL, obs.sdL),
      raw: old.raw && obs.raw ? old.raw.map((v, i) => mix(v, obs.raw[i])) : obs.raw, white: obs.white };
  };
  /** Similarity between two T0 fingerprints in 0..1 (1 = identical). */
  PH.fpSimilarity = function (f1, f2) {
    // A fingerprint saved before v0.20 is in plain colours, not relative to
    // the board: compare those by colour alone (lightness depends on light).
    if (!f1.white !== !f2.white) return Math.exp(-Math.hypot(f1.a - f2.a, f1.b - f2.b) / 12);
    const hi = PH.histIntersect(f1.hist, f2.hist);
    const de = PH.dE(f1.L, f1.a, f1.b, f2.L, f2.a, f2.b, 0.6);
    return hi * Math.exp(-de / 25);
  };
})(typeof self !== 'undefined' ? self : globalThis);
