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

  // Estimate background Lab as the mean of the most populated coarse bin.
  PH.estimateBackground = function (lab, w, h, valid) {
    if (!valid) valid = PH.onesMask(w * h);
    const counts = new Uint32Array(8 * 32 * 32);
    const step = 3;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (!valid[y * w + x]) continue;
        const i = (y * w + x) * 3;
        counts[((lab[i] >> 5) << 10) | ((lab[i + 1] >> 3) << 5) | (lab[i + 2] >> 3)]++;
      }
    }
    let best = 0;
    for (let k = 1; k < counts.length; k++) if (counts[k] > counts[best]) best = k;
    let sL = 0, sa = 0, sb = 0, n = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (!valid[y * w + x]) continue;
        const i = (y * w + x) * 3;
        if ((((lab[i] >> 5) << 10) | ((lab[i + 1] >> 3) << 5) | (lab[i + 2] >> 3)) === best) {
          sL += lab[i]; sa += lab[i + 1]; sb += lab[i + 2]; n++;
        }
      }
    }
    let nValid = 0; for (let p = 0; p < w * h; p++) nValid += valid[p];
    return { L: sL / n, a: sa / n, b: sb / n, frac: (n * step * step) / Math.max(1, nValid) };
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
   */
  PH.flattenLight = function (lab, w, h, valid, unitArea, boardL) {
    if (!valid) valid = PH.onesMask(w * h);
    const cv = PH.cv;
    const n = w * h;
    const L = new cv.Mat(h, w, cv.CV_8UC1), Ld = L.data;
    let darker = 0, brighter = 0, cnt = 0;
    for (let p = 0, i = 0; p < n; p++, i += 3) {
      Ld[p] = lab[i];
      if (!valid[p]) continue;
      cnt++;
      if (lab[i] < boardL - 12) darker++; else if (lab[i] > boardL + 12) brighter++;
    }
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
    // How uneven is the light? 10th..90th percentile of the surface.
    const sv = Array.from(sm.data).sort((a, b) => a - b);
    const lo = sv[Math.floor(sv.length * 0.1)], hi = sv[Math.floor(sv.length * 0.9)];
    if (hi - lo < hi * 0.08) { [L, sm].forEach((m) => m.delete()); return null; }
    const big = new cv.Mat();
    cv.resize(sm, big, new cv.Size(w, h), 0, 0, cv.INTER_LINEAR);
    const ref = hi, bd = big.data;
    const out = new Uint8Array(lab);
    for (let p = 0, i = 0; p < n; p++, i += 3) {
      const v = (lab[i] * ref) / Math.max(16, bd[p]);
      out[i] = v > 255 ? 255 : v;
    }
    [L, sm, big].forEach((m) => m.delete());
    return { lab: out, ref, spread: (hi - lo) / hi };
  };

  /** The k most common colours in the frame (coarse Lab bins, neighbours of
   *  an already-picked bin are skipped), as {L,a,b,frac}. Background
   *  candidates: on a dense pile the most common colour can be the pieces. */
  PH.colorModes = function (lab, w, h, valid, k) {
    if (!valid) valid = PH.onesMask(w * h);
    const counts = new Uint32Array(8 * 32 * 32), sums = new Float64Array(8 * 32 * 32 * 3);
    let n = 0;
    for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
      if (!valid[y * w + x]) continue;
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

  // Shared all-ones mask per size ("every pixel valid"), so callers never pass null.
  const onesCache = new Map();
  PH.onesMask = function (n) {
    let m = onesCache.get(n);
    if (!m) { m = new Uint8Array(n).fill(1); onesCache.set(n, m); if (onesCache.size > 4) onesCache.delete(onesCache.keys().next().value); }
    return m;
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
    mark('lab');
    // Pixels outside the real camera image (tilt correction): alpha 0.
    // Always a Uint8Array (all ones when nothing is invalid): the hot loops
    // below then see one type. A null-or-array mask makes JavaScriptCore
    // (iOS) drop them to a slow tier - tilt-corrected frames were 15-40x
    // slower on the phone only.
    let valid;
    if (img.invalid) { valid = new Uint8Array(w * h); for (let p = 0; p < w * h; p++) valid[p] = img.data[4 * p + 3] ? 1 : 0; }
    else valid = PH.onesMask(w * h);
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
    let labS = lab, flat = null;
    if (opts.flatten !== false && !(model && model.kind !== 'color')) {
      flat = PH.flattenLight(lab, w, h, valid, opts.unitArea, est.L);
      if (flat) {
        labS = flat.lab;
        if (model) {
          // the chosen board colour, re-measured in the shadow-evened image
          let sL = 0, sa = 0, sb = 0, m = 0;
          for (let p = 0, i = 0; p < w * h; p += 5, i += 15) {
            if (!valid[p]) continue;
            if (Math.abs(lab[i + 1] - est.a) < 8 && Math.abs(lab[i + 2] - est.b) < 8 && Math.abs(lab[i] - est.L) < 40) { sL += labS[i]; sa += labS[i + 1]; sb += labS[i + 2]; m++; }
          }
          if (m > 50) est = { L: sL / m, a: sa / m, b: sb / m, frac: 1 };
        } else est = PH.estimateBackground(labS, w, h, valid);
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
      for (let p = 0, i = 0; p < w * h; p += 7, i += 21) { if (!valid[p]) continue; m++; if (lut[PH.correctedBin(lab[i], lab[i + 1], lab[i + 2], lut.corr)]) bgc++; }
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

    // Distance-from-background image, 2 units per ΔE.
    const dist = new cv.Mat(h, w, cv.CV_8UC1);
    const dd = dist.data;
    const ls = PH.L_SCALE * lightW;
    for (let p = 0, i = 0; p < w * h; p++, i += 3) {
      const dL = (labS[i] - bg.L) * ls, da = labS[i + 1] - bg.a, db = labS[i + 2] - bg.b;
      const d = 2 * Math.sqrt(dL * dL + da * da + db * db);
      dd[p] = !valid[p] ? 0 : d > 255 ? 255 : d;
    }
    mark('dist');
    // Threshold from the cloth's own noise: the background is the large peak
    // near zero distance, so its median distance measures the cloth texture.
    // (Otsu would split halfway to the average piece color and cut away any
    // print that is merely close to the cloth.)
    const mask = new cv.Mat();
    let thresh;
    if (lut) {
      // Mixed background: classify each pixel by its color bin.
      for (let p = 0, i = 0; p < w * h; p++, i += 3) dd[p] = lut[PH.correctedBin(lab[i], lab[i + 1], lab[i + 2], lut.corr)] || !valid[p] ? 0 : 255;
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
    mark('thresh');

    // Experimental: a piece has a crisp outline against any plain table even
    // where its print matches the table's colour. Lightness gradient above
    // `boundaryT` is added to the mask, so a pale piece becomes a closed ring
    // and RETR_EXTERNAL returns its outline.
    if (opts.boundary) {
      // L plane via cv.split (WASM) rather than a JS strided copy.
      const lab3 = new cv.Mat(h, w, cv.CV_8UC3); lab3.data.set(lab);
      const planes = new cv.MatVector(); cv.split(lab3, planes);
      const Lm = planes.get(0);
      lab3.delete(); planes.delete();
      const gx = new cv.Mat(), gy = new cv.Mat(), ax = new cv.Mat(), ay = new cv.Mat(), mag = new cv.Mat();
      cv.Scharr(Lm, gx, cv.CV_16S, 1, 0); cv.Scharr(Lm, gy, cv.CV_16S, 0, 1);
      cv.convertScaleAbs(gx, ax, 1 / 16); cv.convertScaleAbs(gy, ay, 1 / 16);
      cv.addWeighted(ax, 0.5, ay, 0.5, 0, mag);
      cv.threshold(mag, mag, opts.boundaryT || 10, 255, cv.THRESH_BINARY);
      if (img.invalid) for (let p = 0; p < w * h; p++) if (!valid[p]) mag.data[p] = 0; // no edges in the filled-in corners
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
      [Lm, gx, gy, ax, ay, mag].forEach((m) => m.delete());
      mark('boundary');
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
      blobs.push({ cnt, area, solidity: area / Math.max(1, cv.contourArea(hull)) });
    }
    hull.delete();
    // This frame's own "one piece" area: mass-weighted mode of log2(area) over
    // blobs that look like a jigsaw piece (4 good corners). Fragments are many
    // but small, so they carry little mass and can't drag it down. Needs at
    // least 3 such blobs; otherwise there is no estimate (null), never a
    // median of everything (that once picked up a 578k px background blob).
    // (one piece is never more than ~12% of the view; bigger "piece-shaped"
    // blobs are piles or assembled sections and must not set the size)
    const like = blobs.filter((b) => b.solidity > 0.6 && b.area < Math.min(maxArea, w * h * 0.12) && PH.pieceScore(b.cnt.data32S, b.area) > PH.MIN_CORNER_SCORE).map((b) => b.area);
    const unitOwn = like.length >= 3 ? PH.massMode(like) : null;
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
    for (const b of blobs) {
      // Clusters of a few pieces always; whole piles too unless the caller
      // turned that off (time-limited on live frames by splitBudgetMs).
      const pile = b.area >= splitMax;
      if (opts.split !== false && unitA && b.area > 1.8 * unitA && (!pile || opts.splitPiles !== false) && now() < splitEnd) {
        if (!labMat) { labMat = new cv.Mat(h, w, cv.CV_8UC3); labMat.data.set(lab); }
        const pieces = PH.splitBlob(b.cnt, labMat, unitA, w, h);
        if (pieces) { b.cnt.delete(); for (const p of pieces) parts.push({ cnt: p, split: true }); continue; }
      }
      parts.push({ cnt: b.cnt, split: false });
    }
    if (labMat) labMat.delete();
    mark('split');

    const dets = [];
    const noHier = new cv.Mat();
    for (const part of parts) {
      const cnt = part.cnt;
      const area = cv.contourArea(cnt);
      if (area < minArea || area > maxArea) { cnt.delete(); continue; }
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
        perim: cv.arcLength(cnt, true),
      };
      // Filled mask for this contour within its bbox -> fingerprint.
      const pm = cv.Mat.zeros(r.height, r.width, cv.CV_8UC1);
      const one = new cv.MatVector();
      one.push_back(cnt);
      cv.drawContours(pm, one, 0, new cv.Scalar(255), -1, cv.LINE_8, noHier, 0, new cv.Point(-r.x, -r.y));
      det.fp = PH.fingerprint(lab, w, r, pm.data, dd, thresh);
      det.rect = cv.minAreaRect(cnt);
      one.delete(); pm.delete(); cnt.delete();
      dets.push(det);
    }
    noHier.delete();
    contours.delete(); hier.delete(); dist.delete(); mask.delete(); k3.delete(); k5.delete();
    mark('dets');
    return { lab, w, h, bg, thresh: thresh / 2, dets, lut, unitArea: unitA, unitOwn, unitN: like.length, flat: flat && { ref: flat.ref, spread: flat.spread } };
  };

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
    const seeds = new cv.Mat(R.height, R.width, cv.CV_8UC1);
    const n = R.width * R.height;
    for (let p = 0; p < n; p++) seeds.data[p] = dist.data32F[p] > t ? 255 : 0;
    const labels = new cv.Mat();
    const nl = cv.connectedComponents(seeds, labels, 8, cv.CV_32S);
    let out = null;
    if (nl - 1 >= 2) {
      const L = labels.data32S, bd = blob.data;
      for (let p = 0; p < n; p++) if (!bd[p]) L[p] = nl; // outside the blob = its own basin
      const img = labMat.roi(R).clone();
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

  /** T0 fingerprint: mean Lab, L spread, 64-bin Lab histogram, size/shape scalars. */
  PH.fingerprint = function (lab, w, r, maskData, distData, thresh) {
    const hist = new Float32Array(PH.HIST_BINS);
    let n = 0, sL = 0, sa = 0, sb = 0, sLL = 0;
    const strict = thresh * 1.15;
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        if (!maskData[y * r.width + x]) continue;
        const p = (r.y + y) * w + (r.x + x);
        if (distData[p] < strict) continue; // skip anti-aliased rim pixels
        const i = p * 3;
        const L = lab[i], a = lab[i + 1], b = lab[i + 2];
        hist[PH.histBin(L, a, b)]++;
        sL += L; sa += a; sb += b; sLL += L * L; n++;
      }
    }
    if (n) for (let k = 0; k < hist.length; k++) hist[k] /= n;
    const mL = n ? sL / n : 0;
    return {
      hist,
      L: mL, a: n ? sa / n : 128, b: n ? sb / n : 128,
      sdL: n ? Math.sqrt(Math.max(0, sLL / n - mL * mL)) : 0,
    };
  };

  /** Similarity between two T0 fingerprints in 0..1 (1 = identical). */
  PH.fpSimilarity = function (f1, f2) {
    const hi = PH.histIntersect(f1.hist, f2.hist);
    const de = PH.dE(f1.L, f1.a, f1.b, f2.L, f2.a, f2.b, 0.6);
    return hi * Math.exp(-de / 25);
  };
})(typeof self !== 'undefined' ? self : globalThis);
