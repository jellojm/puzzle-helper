/* T1 piece model, computed once per piece from a sharp full-resolution crop:
 *   - outline (uniformly resampled, clockwise on screen)
 *   - 4 corners (sharp convex points forming the most rectangle-like quad)
 *   - 4 edges: type (T=tab, B=blank, F=flat), shape signature, color strip
 *   - a rotation-normalized "core square" image used to place the piece on the box
 * Edge i runs from corner i to corner i+1. With corners clockwise, edge 0 is
 * the piece's "top" in its own square frame, 1 = right, 2 = bottom, 3 = left. */
(function (G) {
  const PH = G.PH;
  const N = 320;          // outline samples
  // Two separate point systems per edge (owner, 2026-10-05: geometry and
  // colour "could be different systems of points"):
  //  - GEOM_PTS: where the outline is sampled for the shape signature;
  //  - COLOUR_PTS: where colour is read just inside the cut, for matching
  //    the print across a seam.
  // Each is tuned on its own (tools/points-bench.js).
  // GEOM_PTS (tools/points-bench.js geom): the point count makes no difference
  // (16-64: same ranks - read noise, not sampling, limits shape); leaving
  // the corners off removes corner-finding jitter: two reads of one edge on
  // the owner's video stay as close (median 0.164 -> 0.172) while look-alikes
  // move away (near-ties 32% -> 21%, synthetic joins AUC .884 -> .900).
  PH.GEOM_PTS = { n: 32, trim: 0.14 };   // points per edge; fraction of the arc left off at each corner
  PH.COLOUR_PTS = { n: 32, ends: 0, depth: 0.03, depth2: 0, patch: 1 }; // ends: fraction skipped at each corner; depth(s): inset, fraction of the edge length; patch: sample radius (px)
  // 8-bit Lab lightness: a colour point this bright has lost its colour (glare,
  // overexposure). Dark print is not counted: deep black in good light is
  // real colour (the reef's dark water flagged 13% of edges); a dark frame is
  // caught by the light correction it needed instead.
  PH.COL_CLIP_HI = 245;
  // The colour points get their own, wider light correction: a dark frame
  // needs ~x2 (points-bench why: dark pieces' true joins passed the colour
  // rule 27% at the x1.7 clamp, 67% at x2.5).
  PH.COL_LIGHT_K = [0.4, 2.5];
  // When an edge's colour can't be trusted (owner, 2026-10-05: "indicate
  // color is a bad match when conditions are not favorable"): 2+ of its 32
  // colour points washed out (glare, overexposed), or the
  // light needed more than x2.2 / less than x0.5 correction. points-bench
  // why: true joins with such an edge passed the colour rule only 55% of the
  // time (vs 93% for the rest) - there the colour test would throw out real
  // fits, so it is skipped and the reason shown instead.
  PH.COL_TRUST = { clip: 0.05, kHi: 2.2, kLo: 0.5 };
  PH.colourDoubt = function (e, lf) {
    const T = PH.COL_TRUST, why = [], k = lf && lf.kRaw;
    if (e.cc && e.cc.clip >= T.clip) why.push('glare');
    if (k > T.kHi) why.push('dark');
    else if (k && k < T.kLo) why.push('bright');
    return why.length ? why.join('+') : null;
  };
  const STRIP = 16;       // color samples per edge
  PH.SQ = 24;             // core-square size (matches box cell size)

  /**
   * Add a piece's outline to its colour mask (in place). The outline is where
   * lightness changes sharply — the cut edge and its thin shadow — which holds
   * even where the print matches the board. Edges are closed into rings,
   * enclosed regions filled, and only the region overlapping the middle of
   * the crop (the piece) is kept, so shadows and neighbours can't attach.
   * The edge threshold comes from the crop's own border (board texture), since
   * photo crops are far higher resolution than live frames.
   */
  function addOutline(lab, w, h, mask) {
    const cv = PH.cv;
    const lab3 = new cv.Mat(h, w, cv.CV_8UC3); lab3.data.set(lab);
    const planes = new cv.MatVector(); cv.split(lab3, planes);
    const L = planes.get(0);
    const gx = new cv.Mat(), gy = new cv.Mat(), ax = new cv.Mat(), ay = new cv.Mat(), mag = new cv.Mat();
    cv.Scharr(L, gx, cv.CV_16S, 1, 0); cv.Scharr(L, gy, cv.CV_16S, 0, 1);
    cv.convertScaleAbs(gx, ax, 1 / 16); cv.convertScaleAbs(gy, ay, 1 / 16);
    cv.addWeighted(ax, 0.5, ay, 0.5, 0, mag);
    // board texture: gradient along a 3 px frame of the crop
    const md = mag.data, v = [];
    for (let x = 0; x < w; x += 2) for (const y of [0, 1, 2, h - 3, h - 2, h - 1]) if (y >= 0 && y < h) v.push(md[y * w + x]);
    for (let y = 3; y < h - 3; y += 2) for (const x of [0, 1, 2, w - 3, w - 2, w - 1]) if (x >= 0 && x < w) v.push(md[y * w + x]);
    v.sort((a, b) => a - b);
    const noise = v.length ? v[Math.floor(v.length * 0.75)] : 4;
    const T = Math.max(6, Math.min(40, noise * 2.5 + 3));
    cv.threshold(mag, mag, T, 255, cv.THRESH_BINARY);
    const bk = Math.max(3, 2 * Math.round(Math.max(w, h) * 0.012) + 1);
    const kb = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(bk, bk));
    cv.morphologyEx(mag, mag, cv.MORPH_CLOSE, kb);
    // enclosed = not reachable from the crop border through non-edge pixels
    const inv = new cv.Mat();
    cv.bitwise_not(mag, inv);
    cv.rectangle(inv, new cv.Point(0, 0), new cv.Point(w - 1, h - 1), new cv.Scalar(255), 1);
    const ff = cv.Mat.zeros(h + 2, w + 2, cv.CV_8UC1);
    cv.floodFill(inv, ff, new cv.Point(0, 0), new cv.Scalar(0), new cv.Rect(), new cv.Scalar(0), new cv.Scalar(0), 4);
    const shape = new cv.Mat();
    cv.bitwise_or(inv, mag, shape);
    cv.bitwise_or(shape, mask, shape);
    // keep only the connected region at the middle of the crop (the piece)
    const labels = new cv.Mat();
    cv.connectedComponents(shape, labels, 8, cv.CV_32S);
    const ld = labels.data32S, cx = w >> 1, cy = h >> 1;
    const counts = new Map();
    const r = Math.max(2, Math.round(Math.min(w, h) * 0.08));
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      const k = ld[y * w + x]; if (k > 0) counts.set(k, (counts.get(k) || 0) + 1);
    }
    let keep = 0, kc = 0;
    for (const [k, c] of counts) if (c > kc) { kc = c; keep = k; }
    if (keep > 0) {
      const sel = new cv.Mat(), kmat = new cv.Mat(h, w, cv.CV_32S, new cv.Scalar(keep));
      cv.compare(labels, kmat, sel, cv.CMP_EQ);
      cv.bitwise_or(mask, sel, mask);
      // the ring sits ~1 px outside the true edge after closing: trim it back
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kb);
      sel.delete(); kmat.delete();
    }
    [lab3, planes, L, gx, gy, ax, ay, mag, kb, inv, ff, shape, labels].forEach((m) => m.delete());
  }

  // Cast shadows (owner, 2026-10-06: light from a shallow angle; "the shadow
  // on one side of the pieces may deteriorate the quality of that edge"):
  // a shadow is the board, darker, with the board's colour (its a/b shrink
  // with its lightness); the colour-distance threshold takes it for piece,
  // so on the shadow side the outline runs out into it and keyholes fill
  // (IMG_3599 on a cream counter: 14% of shadow-side outline points >2% of a
  // side outside the real cut; IMG_3598: two pieces joined by the shadow
  // between them). Peel: grow the bare board into the mask through
  // shadow-like pixels, by small steps only - the cut itself is a sharp
  // change, so the growth stops there and print inside the piece is never
  // reached. Skipped when the piece itself looks like darkened board (a
  // grey piece on a white board), where shadow and print can't be told apart.
  // (measured on IMG_3598: the lamp's shadow keeps the counter's colour -
  // b +12..+15 against +15 lit - and only loses lightness, L 88-120 vs 176)
  // Only on a board with a colour of its own (cream, wood, felt): on a
  // neutral white or grey board a shadow is grey, like dark print, and the
  // peel ate the ship's hull off two pieces (IMG_3602) - there shadows are
  // mild anyway (IMG_3603/3604: 1-3% of outline points off).
  PH.SHADOW_PEEL = { kMin: 0.3, kMax: 0.95, chroma: 5, chromaK: 0.1, stepL: 14, stepC: 6, maxLike: 0.25, minBoardChroma: 10 };
  function peelShadow(lab, w, h, mask, bg) {
    const S = PH.SHADOW_PEEL, md = mask.data, n = w * h;
    if (Math.hypot(bg.a - 128, bg.b - 128) < S.minBoardChroma) return 0;
    const tol = S.chroma + S.chromaK * Math.hypot(bg.a - 128, bg.b - 128);
    const like = (p) => {
      const i = 3 * p, k = lab[i] / bg.L;
      return k >= S.kMin && k <= S.kMax && Math.abs(lab[i + 1] - bg.a) < tol && Math.abs(lab[i + 2] - bg.b) < tol;
    };
    // the piece mostly looks like darkened board: no telling shadow from print
    let inside = 0, likeIn = 0;
    for (let p = 0; p < n; p += 3) if (md[p]) { inside++; if (like(p)) likeIn++; }
    if (!inside || likeIn > inside * S.maxLike) return 0;
    const seen = new Uint8Array(n), queue = new Int32Array(n);
    let qh = 0, qt = 0, peeled = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (!md[p] && (md[p - 1] || md[p + 1] || md[p - w] || md[p + w])) { seen[p] = 1; queue[qt++] = p; }
    }
    while (qh < qt) {
      const q = queue[qh++], x = q % w, iq = 3 * q;
      for (const p of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, q - w, q + w]) {
        if (p < 0 || p >= n || seen[p] || !md[p]) continue;
        const ip = 3 * p;
        if (Math.abs(lab[ip] - lab[iq]) > S.stepL || Math.abs(lab[ip + 1] - lab[iq + 1]) > S.stepC || Math.abs(lab[ip + 2] - lab[iq + 2]) > S.stepC || !like(p)) continue;
        seen[p] = 1; md[p] = 0; peeled++; queue[qt++] = p;
      }
    }
    if (PH.DEBUG_PEEL) { const ks = []; for (let p = 0; p < n; p++) if (seen[p] && !md[p] && lab[3 * p] < bg.L) ks.push(lab[3 * p] / bg.L); ks.sort((x, y) => x - y); PH.DEBUG_PEEL({ inside, likeIn: +(likeIn / inside).toFixed(3), peeled: +(peeled / (inside * 3)).toFixed(3), kP10: ks.length ? +ks[Math.floor(ks.length * 0.1)].toFixed(2) : null, kP50: ks.length ? +ks[ks.length >> 1].toFixed(2) : null, bg: [Math.round(bg.L), Math.round(bg.a - 128), Math.round(bg.b - 128)] }); }
    return peeled;
  }

  function segmentCrop(lab, w, h, bg, threshDE, lightW, lut, hint, boundary, peel) {
    const cv = PH.cv;
    const dist = new cv.Mat(h, w, cv.CV_8UC1);
    const dd = dist.data;
    const ls = PH.L_SCALE * lightW;
    if (lut) {
      for (let p = 0, i = 0; p < w * h; p++, i += 3) dd[p] = lut[PH.correctedBin(lab[i], lab[i + 1], lab[i + 2], lut.corr)] ? 0 : 255;
      threshDE = 64;
    } else {
      // The board under this crop may be in shadow while `bg` is the (lit,
      // shadow-evened) board colour. Lighting is ~constant over one crop, so
      // take the board's lightness here from the crop's border pixels that
      // have the board's colour.
      const Ls = [];
      const take = (x, y) => { const i = (y * w + x) * 3; if (Math.abs(lab[i + 1] - bg.a) < 10 && Math.abs(lab[i + 2] - bg.b) < 10) Ls.push(lab[i]); };
      for (let x = 0; x < w; x += 2) { take(x, 0); take(x, h - 1); }
      for (let y = 0; y < h; y += 2) { take(0, y); take(w - 1, y); }
      if (Ls.length > (w + h) * 0.3) { Ls.sort((a, b) => a - b); bg = Object.assign({}, bg, { L: Ls[Ls.length >> 1] }); }
    }
    if (!lut) for (let p = 0, i = 0; p < w * h; p++, i += 3) {
      const dL = (lab[i] - bg.L) * ls, da = lab[i + 1] - bg.a, db = lab[i + 2] - bg.b;
      const d = 2 * Math.sqrt(dL * dL + da * da + db * db);
      dd[p] = d > 255 ? 255 : d;
    }
    const mask = new cv.Mat();
    cv.threshold(dist, mask, 2 * threshDE, 255, cv.THRESH_BINARY);
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
    if (peel && !lut && peelShadow(lab, w, h, mask, bg)) cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k);
    if (boundary) addOutline(lab, w, h, mask);
    if (hint) {
      // Limit to this piece's (slightly grown) outline from the split.
      const hm = cv.Mat.zeros(h, w, cv.CV_8UC1);
      const pm = cv.matFromArray(hint.length / 2, 1, cv.CV_32SC2, Array.from(hint, Math.round));
      const mv = new cv.MatVector(); mv.push_back(pm);
      cv.fillPoly(hm, mv, new cv.Scalar(255));
      const g = Math.max(3, Math.round(Math.max(w, h) * 0.03));
      const gk = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * g + 1, 2 * g + 1));
      cv.dilate(hm, hm, gk);
      cv.bitwise_and(mask, hm, mask);
      [hm, pm, mv, gk].forEach((m) => m.delete());
    }
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    let best = -1, bestScore = 0;
    const cx = w / 2, cy = h / 2;
    for (let c = 0; c < contours.size(); c++) {
      const cnt = contours.get(c);
      const a = cv.contourArea(cnt);
      const inside = cv.pointPolygonTest(cnt, new cv.Point(cx, cy), false) >= 0;
      const s = a * (inside ? 4 : 1);
      if (s > bestScore) { bestScore = s; best = c; }
      cnt.delete();
    }
    let pts = null, area = 0;
    const filled = cv.Mat.zeros(h, w, cv.CV_8UC1);
    if (best >= 0) {
      const cnt = contours.get(best);
      pts = new Int32Array(cnt.data32S);
      area = cv.contourArea(cnt);
      cv.drawContours(filled, contours, best, new cv.Scalar(255), -1);
      cnt.delete();
    }
    k.delete(); contours.delete(); hier.delete(); dist.delete(); mask.delete();
    return { pts, area, filled };
  }

  function findCorners(P, area) {
    const k = Math.round(N / 40);
    const ang = new Float32Array(N);
    const convex = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i - k + N) % N, b = (i + k) % N;
      const v1x = P[2 * a] - P[2 * i], v1y = P[2 * a + 1] - P[2 * i + 1];
      const v2x = P[2 * b] - P[2 * i], v2y = P[2 * b + 1] - P[2 * i + 1];
      const c = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-9);
      ang[i] = (Math.acos(PH.clamp(c, -1, 1)) * 180) / Math.PI;
      // d1 = p - prev = -v1, d2 = next - p = v2; convex on a clockwise outline when cross(d1,d2) > 0
      convex[i] = -v1x * v2y + v1y * v2x > 0 ? 1 : 0;
    }
    let cands = [];
    for (let i = 0; i < N; i++) {
      if (!convex[i] || ang[i] > 140) continue;
      let isMin = true;
      for (let j = 1; j <= k && isMin; j++) {
        if (ang[(i + j) % N] < ang[i] || ang[(i - j + N) % N] <= ang[i]) isMin = false;
      }
      if (isMin) cands.push(i);
    }
    if (cands.length < 4) return null;
    cands.sort((x, y) => ang[x] - ang[y]);
    cands = cands.slice(0, 16).sort((x, y) => x - y);
    // "Shoulders": from a true corner the outline runs straight along both
    // sides for a while (toward the neighbor corners) before any tab starts.
    // A tab neck curves off into the tab instead, so its shoulders point the
    // wrong way. Directions measured over ~1/30 of the outline each side.
    const sh = Math.round(N / 30);
    const outDir = new Map(), inDir = new Map();
    for (const i of cands) {
      const f = (i + sh) % N, b = (i - sh + N) % N;
      let ox = P[2 * f] - P[2 * i], oy = P[2 * f + 1] - P[2 * i + 1], ol = Math.hypot(ox, oy) || 1;
      let ix = P[2 * i] - P[2 * b], iy = P[2 * i + 1] - P[2 * b + 1], il = Math.hypot(ix, iy) || 1;
      outDir.set(i, [ox / ol, oy / ol]); inDir.set(i, [ix / il, iy / il]);
    }

    const n = cands.length;
    let best = null;
    const q = new Float64Array(8);
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
      const idx = [cands[a], cands[b], cands[c], cands[d]];
      // each edge must cover a reasonable share of the outline
      let ok = true;
      for (let e = 0; e < 4; e++) {
        const span = (idx[(e + 1) % 4] - idx[e] + N) % N;
        if (span < N * 0.1 || span > N * 0.45) { ok = false; break; }
      }
      if (!ok) continue;
      for (let e = 0; e < 4; e++) { q[2 * e] = P[2 * idx[e]]; q[2 * e + 1] = P[2 * idx[e] + 1]; }
      const s = [], angs = [];
      for (let e = 0; e < 4; e++) {
        const nx = q[2 * ((e + 1) % 4)] - q[2 * e], ny = q[2 * ((e + 1) % 4) + 1] - q[2 * e + 1];
        s.push(Math.hypot(nx, ny));
      }
      for (let e = 0; e < 4; e++) {
        const p = (e + 3) % 4, nn = (e + 1) % 4;
        const ux = q[2 * p] - q[2 * e], uy = q[2 * p + 1] - q[2 * e + 1];
        const vx = q[2 * nn] - q[2 * e], vy = q[2 * nn + 1] - q[2 * e + 1];
        const cc = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) + 1e-9);
        angs.push((Math.acos(PH.clamp(cc, -1, 1)) * 180) / Math.PI);
      }
      const angleErr = angs.reduce((t, x) => t + Math.abs(x - 90), 0) / 360;
      const sideErr = Math.abs(s[0] - s[2]) / (s[0] + s[2]) + Math.abs(s[1] - s[3]) / (s[1] + s[3]);
      const aspectErr = Math.abs(Math.log((s[0] + s[2]) / (s[1] + s[3])));
      const quadArea = Math.abs(PH.polyArea(q));
      const areaFrac = quadArea / area;
      const sharp = idx.reduce((t, i) => t + (1 - ang[i] / 180), 0) / 4;
      let shoulderErr = 0;
      for (let e = 0; e < 4; e++) {
        const nx = q[2 * ((e + 1) % 4)] - q[2 * e], ny = q[2 * ((e + 1) % 4) + 1] - q[2 * e + 1], nl = Math.hypot(nx, ny) || 1;
        const px = q[2 * e] - q[2 * ((e + 3) % 4)], py = q[2 * e + 1] - q[2 * ((e + 3) % 4) + 1], pl = Math.hypot(px, py) || 1;
        const o = outDir.get(idx[e]), n2 = inDir.get(idx[e]);
        shoulderErr += (1 - (o[0] * nx + o[1] * ny) / nl) + (1 - (n2[0] * px + n2[1] * py) / pl);
      }
      shoulderErr /= 8;
      const score = sharp * Math.exp(-4 * angleErr) * Math.exp(-3 * sideErr) * Math.exp(-1.5 * aspectErr) * Math.exp(-6 * shoulderErr) * Math.min(1, areaFrac / 0.6);
      if (!best || score > best.score) best = { score, idx };
    }
    return best;
  }

  function sampleLab(lab, w, h, x, y, rad) {
    let sL = 0, sa = 0, sb = 0, n = 0;
    const xi = Math.round(x), yi = Math.round(y), R = rad === undefined ? 1 : rad;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const xx = xi + dx, yy = yi + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const i = (yy * w + xx) * 3;
      sL += lab[i]; sa += lab[i + 1]; sb += lab[i + 2]; n++;
    }
    return n ? [sL / n, sa / n, sb / n] : [0, 128, 128];
  }

  /** How much an outline looks like a jigsaw piece (best 4-corner score;
   *  ~0.1-0.45 for real pieces, < 0.05 for fragments and merged groups). */
  PH.pieceScore = function (pts, area) {
    if (pts.length < 40) return 0;
    let P = PH.resampleClosed(pts, N).pts;
    if (PH.polyArea(P) < 0) {
      const R = new Float32Array(P.length);
      for (let i = 0; i < N; i++) { R[2 * i] = P[2 * (N - 1 - i)]; R[2 * i + 1] = P[2 * (N - 1 - i) + 1]; }
      P = R;
    }
    const c = findCorners(P, area);
    return c ? c.score : 0;
  };

  /**
   * Analyze one piece.
   * @param crop {w,h,data:RGBA} full-resolution crop around the piece
   * @param ctx {bg:{L,a,b}, threshDE, lightW, ox, oy (crop origin in source px)}
   */
  PH._segmentCrop = (...a) => segmentCrop(...a); // diagnostics only (test/shape-real.js --sheet)
  /** A crop scaled by k (< 1: smaller), for reading a big piece at less
   *  cost (PH.READ_SIDE). */
  PH.scaleCrop = function (crop, k) {
    const cv = PH.cv;
    const src = new cv.Mat(crop.h, crop.w, cv.CV_8UC4); src.data.set(crop.data);
    const w = Math.max(8, Math.round(crop.w * k)), h = Math.max(8, Math.round(crop.h * k));
    const dst = new cv.Mat();
    cv.resize(src, dst, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    const out = { w, h, data: new Uint8ClampedArray(dst.data) };
    src.delete(); dst.delete();
    return out;
  };
  /** A read made from a crop scaled by k, back in source pixels (crop origin
   *  ox, oy). Everything else in a read is scale-free (edge shapes, relative
   *  lengths, colours, the print square). */
  PH.unscaleRead = function (t1, k, ox, oy) {
    t1.corners = t1.corners.map((c) => [c[0] / k + ox, c[1] / k + oy]);
    t1.meanSide /= k;
    for (const e of t1.edges) e.len /= k;
    if (t1.thumb) { t1.thumb.ox = ox; t1.thumb.oy = oy; t1.thumb.s *= k; }
    t1.readScale = k;
    return t1;
  };
  PH.analyzePiece = function (crop, ctx) {
    const cv = PH.cv;
    const w = crop.w, h = crop.h;
    const lab = PH.rgbaToLab(crop.data, w, h);
    const lightW = ctx.lightW === undefined ? 0.5 : ctx.lightW;
    const touchesCrop = (pts) => {
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i], y = pts[i + 1];
        if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) return true;
      }
      return false;
    };
    // Colour distance alone loses pale print on a pale board: the outline
    // then follows only the colourful part of the piece, tabs read as flat
    // edges, or the read fails (owner's kitchen photo IMG_3573: 66% read, 33%
    // "edge" pieces vs 22% possible). So the piece's own outline (a lightness
    // edge ring, closed and filled) is added first; if that leaks to the crop
    // border or balloons past the colour blob, fall back to colour only.
    const useOutline = ctx.boundary !== false;
    // A piece-sized outline only. A partial one (pale part lost, cut along a
    // print boundary inside the piece) is what produces FALSE FLAT edges; a
    // much bigger one has swallowed a neighbour. Both are rejected rather
    // than trusted. ctx.unitArea = one piece's area in crop pixels.
    const U = ctx.unitArea || 0;
    const fits = (r) => r.pts && r.pts.length >= 40 && !touchesCrop(r.pts) && (!U || (r.area >= U * (ctx.minUnit || 0.6) && r.area <= U * (ctx.maxUnit || 1.9)));
    // Colour first: where it yields a whole piece it is the most faithful
    // (the outline channel also picks up the lamp shadow beside a piece, which
    // fills the blanks on that side). Only when colour gives a partial piece
    // (pale part lost) is the outline added to rescue it.
    let seg = null;
    if (PH.SHADOW_PEEL && ctx.peel !== false) { // shadows peeled off first; kept only if a whole piece remains
      seg = segmentCrop(lab, w, h, ctx.bg, ctx.threshDE, lightW, ctx.lut, ctx.hint, false, true);
      if (!fits(seg)) { seg.filled.delete(); seg = null; }
    }
    if (!seg) seg = segmentCrop(lab, w, h, ctx.bg, ctx.threshDE, lightW, ctx.lut, ctx.hint, false);
    if (useOutline && !fits(seg)) {
      const withOutline = segmentCrop(lab, w, h, ctx.bg, ctx.threshDE, lightW, ctx.lut, ctx.hint, true);
      seg.filled.delete(); seg = withOutline;
    }
    if (!fits(seg)) { seg.filled.delete(); return null; }

    let P = PH.resampleClosed(seg.pts, N).pts;
    if (PH.polyArea(P) < 0) { // make clockwise on screen
      const R = new Float32Array(P.length);
      for (let i = 0; i < N; i++) { R[2 * i] = P[2 * (N - 1 - i)]; R[2 * i + 1] = P[2 * (N - 1 - i) + 1]; }
      P = R;
    }
    const cr = findCorners(P, seg.area);
    if (!cr) { seg.filled.delete(); return null; }
    const ci = cr.idx;
    const corners = ci.map((i) => [P[2 * i], P[2 * i + 1]]);

    // The board's colour around the piece in this crop (its local "white"):
    // median of the crop's outer frame where it isn't piece. Colours compared
    // between reads (print, edge colours) are taken relative to it, so the
    // phone's shadow and exposure changes cancel out.
    let white = null;
    {
      const fd = seg.filled.data, Ls = [], As = [], Bs = [], fr = Math.max(2, Math.round(Math.min(w, h) * 0.04));
      for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
        if (x >= fr && y >= fr && x < w - fr && y < h - fr) { x = w - fr - 1; continue; }
        const p = y * w + x;
        if (fd[p]) continue;
        Ls.push(lab[3 * p]); As.push(lab[3 * p + 1]); Bs.push(lab[3 * p + 2]);
      }
      if (Ls.length >= 12) white = [PH.median(Ls), PH.median(As), PH.median(Bs)];
    }

    // Colours with the light taken out (PH.lightFix against this session's
    // usual board, ctx.boardRef).
    const lf = PH.lightFix(white, ctx.boardRef || null), wk = lf.k, wa = lf.da, wb = lf.db;
    const edges = [];
    for (let e = 0; e < 4; e++) {
      const i0 = ci[e], i1 = ci[(e + 1) % 4];
      const span = (i1 - i0 + N) % N;
      const pts = [];
      for (let s = 0; s <= span; s++) { const i = (i0 + s) % N; pts.push([P[2 * i], P[2 * i + 1]]); }
      const A = pts[0], B = pts[pts.length - 1];
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const dx = (B[0] - A[0]) / L, dy = (B[1] - A[1]) / L;
      const nx = dy, ny = -dx; // outward normal for a clockwise outline (y down)
      const G = PH.GEOM_PTS, SIG = G.n;
      const rs = PH.arcPoints(pts, SIG, G.trim, 1 - G.trim).map((q) => [q.x, q.y]);
      const sig = new Float32Array(SIG * 2);
      let maxY = -1e9, minY = 1e9;
      for (let s = 0; s < SIG; s++) {
        const px = rs[s][0] - A[0], py = rs[s][1] - A[1];
        const x = (px * dx + py * dy) / L, y = (px * nx + py * ny) / L;
        sig[2 * s] = x; sig[2 * s + 1] = y;
        if (y > maxY) maxY = y;
        if (y < minY) minY = y;
      }
      const amp = Math.max(maxY, -minY);
      const type = amp < 0.12 ? 'F' : maxY > -minY ? 'T' : 'B';
      // Near the flat/tab threshold the call is a coin toss (a shallow tab, a
      // blurred or foreshortened view): mark the edge uncertain and keep the
      // other reading. Uncertain flats don't count as border, still get match
      // candidates as their other type, and a later clear view settles them.
      const unc = Math.abs(amp - 0.12) < 0.035;
      const alt = type === 'F' ? (maxY > -minY ? 'T' : 'B') : 'F';

      // Color strip just inside the outline, using the local tangent for the inward normal.
      const strip = new Float32Array(STRIP * 3);
      for (let s = 0; s < STRIP; s++) {
        const i = (i0 + Math.round(((s + 0.5) / STRIP) * span)) % N;
        const ia = (i - 2 + N) % N, ib = (i + 2) % N;
        let tx = P[2 * ib] - P[2 * ia], ty = P[2 * ib + 1] - P[2 * ia + 1];
        const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const off = Math.max(3, 0.05 * L);
        const c = sampleLab(lab, w, h, P[2 * i] - ty * off, P[2 * i + 1] + tx * off);
        strip[3 * s] = c[0]; strip[3 * s + 1] = c[1]; strip[3 * s + 2] = c[2];
      }
      // Colour at every outline point (owner, 2026-10-05: "the puzzle points
      // should also capture color"): at each of the SIG shape points, ~3% of
      // the edge length inside the cut (box-picture seams: 98% of true
      // neighbours agree there, vs 69% at 5%), relative to the board; and
      // how busy the print is there (change to ~6% in) - a busy spot gets
      // more tolerance when two edges are compared (matcher.js).
      // (its own point system: PH.COLOUR_PTS)
      const C = PH.COLOUR_PTS, NC = C.n;
      const cp = PH.arcPoints(pts, NC, C.ends, 1 - C.ends);
      const pcol = new Float32Array(NC * 3), pspread = new Float32Array(NC), pxy = new Float32Array(NC * 2);
      const d1 = Math.max(2, C.depth * L), d2 = Math.max(3, 2 * C.depth * L), dB = C.depth2 ? Math.max(2, C.depth2 * L) : 0;
      let clip = 0; // points washed out (glare, overexposure): their colour is lost
      const wkC = lf.kRaw ? PH.clamp(lf.kRaw, PH.COL_LIGHT_K[0], PH.COL_LIGHT_K[1]) : wk;
      for (let s = 0; s < NC; s++) {
        const q = cp[s];
        // where it sits in the edge's own frame (x along the corner-to-corner
        // line, y outward, in edge lengths): colour points of two edges are
        // paired by position, not by index (their corners jitter apart)
        const ux = q.x - A[0], uy = q.y - A[1];
        pxy[2 * s] = (ux * dx + uy * dy) / L; pxy[2 * s + 1] = (ux * nx + uy * ny) / L;
        let c1 = sampleLab(lab, w, h, q.x - q.ty * d1, q.y + q.tx * d1, C.patch);
        if (dB) { const cb = sampleLab(lab, w, h, q.x - q.ty * dB, q.y + q.tx * dB, C.patch); c1 = [(c1[0] + cb[0]) / 2, (c1[1] + cb[1]) / 2, (c1[2] + cb[2]) / 2]; }
        const c2 = sampleLab(lab, w, h, q.x - q.ty * d2, q.y + q.tx * d2, C.patch);
        pcol[3 * s] = Math.min(255, c1[0] * wkC); pcol[3 * s + 1] = c1[1] - wa; pcol[3 * s + 2] = c1[2] - wb;
        pspread[s] = PH.dE(c1[0] * wkC, c1[1], c1[2], c2[0] * wkC, c2[1], c2[2], 0.7);
        if (c1[0] >= PH.COL_CLIP_HI) clip++;
      }
      const cc = { clip: clip / NC, busy: PH.median(Array.from(pspread)) };
      const e1 = { type, sig, gtrim: G.trim, strip, len: L, amp, unc, alt, pcol, pspread, pxy, cc };
      e1.cdoubt = PH.colourDoubt(e1, lf); // null: colour trusted
      edges.push(e1);
    }
    const meanSide = edges.reduce((t, e) => t + e.len, 0) / 4;
    for (const e of edges) e.lenRel = e.len / meanSide;
    const code = edges.map((e) => e.type).join('');
    const flats = edges.map((e) => e.type === 'F');
    // A "piece" with a straight side cut out of an assembled section carries
    // the seam between two real pieces across its middle (owner 2026-10-04:
    // false edge pieces "tracing hard color edges across pieces already
    // placed together"). Real pieces have no seam inside.
    if (flats.some(Boolean) && ctx.seamCheck !== false && PH.innerSeam(lab, w, h, seg.filled, meanSide)) {
      seg.filled.delete();
      if (ctx.why) ctx.why.seam = true;
      return null;
    }

    // Rotation-normalized core square (Lab + mask) for box placement.
    const S = PH.SQ;
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat(...corners));
    const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, S, 0, S, S, 0, S]);
    const M = cv.getPerspectiveTransform(src, dst);
    const labMat = new cv.Mat(h, w, cv.CV_8UC3);
    labMat.data.set(lab);
    const sq = new cv.Mat(), sqm = new cv.Mat();
    cv.warpPerspective(labMat, sq, M, new cv.Size(S, S), cv.INTER_AREA, cv.BORDER_REPLICATE);
    const ek = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.erode(seg.filled, seg.filled, ek);
    cv.warpPerspective(seg.filled, sqm, M, new cv.Size(S, S), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
    const square = { lab: new Uint8Array(sq.data), mask: new Uint8Array(sqm.data) };

    // Sharpness (variance of Laplacian on lightness).
    const Lm = new cv.Mat(h, w, cv.CV_8UC1);
    for (let p = 0; p < w * h; p++) Lm.data[p] = lab[3 * p];
    const lap = new cv.Mat();
    cv.Laplacian(Lm, lap, cv.CV_32F);
    const mean = new cv.Mat(), sd = new cv.Mat();
    cv.meanStdDev(lap, mean, sd);
    const sharp = sd.doubleAt(0, 0) ** 2;

    // Small thumbnail for the UI.
    const rgba = new cv.Mat(h, w, cv.CV_8UC4);
    rgba.data.set(crop.data);
    const ts = 72 / Math.max(w, h);
    const tw = Math.max(1, Math.round(w * ts)), th = Math.max(1, Math.round(h * ts));
    const tm = new cv.Mat();
    cv.resize(rgba, tm, new cv.Size(tw, th), 0, 0, cv.INTER_AREA);
    const thumb = { w: tw, h: th, data: new Uint8ClampedArray(tm.data), ox: ctx.ox || 0, oy: ctx.oy || 0, s: ts };

    // Read quality: how crisp the piece's own outline is (Laplacian spread in
    // a thin band around its mask - blur flattens it, print inside doesn't
    // count), times resolution and corner clarity. Used to keep the best of
    // several reads of a piece and to rank shapes.
    let edgeSharp = 0;
    try {
      const band = new cv.Mat(), bk = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
      cv.morphologyEx(seg.filled, band, cv.MORPH_GRADIENT, bk);
      const g = new cv.Mat(), lp = new cv.Mat(), mu = new cv.Mat(), sg = new cv.Mat();
      cv.cvtColor(rgba, g, cv.COLOR_RGBA2GRAY);
      cv.Laplacian(g, lp, cv.CV_16S, 3);
      cv.meanStdDev(lp, mu, sg, band);
      edgeSharp = sg.data64F[0];
      [band, bk, g, lp, mu, sg].forEach((m) => m.delete());
    } catch (e) { edgeSharp = 0; }
    const quality = { sharp: +edgeSharp.toFixed(1), q: +((edgeSharp / (edgeSharp + 25)) * Math.min(1, meanSide / 90) * Math.min(1, cr.score / 0.15)).toFixed(3) };

    [src, dst, M, labMat, sq, sqm, ek, Lm, lap, mean, sd, rgba, tm, seg.filled].forEach((m) => m.delete());

    const ox = ctx.ox || 0, oy = ctx.oy || 0;
    return {
      corners: corners.map((c) => [c[0] + ox, c[1] + oy]),
      edges, code, flats, meanSide, square, sharp, thumb, quality,
      cornerScore: cr.score, white, lf,
    };
  };

  /** Same physical piece? Best mean signature distance over the 4 rotations
   *  whose edge-type codes agree (Infinity if none agree). ~0.01-0.03 for the
   *  same piece seen twice; different pieces are usually > 0.06. */
  PH.sameShape = function (a, b) { return PH.shapeAlign(a, b).d; };

  /** Best rotation aligning a to b: a.edges[k] corresponds to b.edges[(k+r)%4]. */
  PH.LEN_GATE = +(typeof process !== 'undefined' && process.env && process.env.LEN_GATE) || 0.08; // two reads of one piece: each edge's relative length within this
  // stretch: compare edge lengths after taking out each read's stretch (the
  // ratio of its two pairs of opposite sides, within PH.STRETCH_MAX of the
  // other's) - a view from another angle, or a tilt corrected a little
  // differently, makes one direction longer and the other shorter.
  const axisNorm = (t) => { const L = t.edges.map((e) => e.lenRel), p = (L[0] + L[2]) / 2 || 1, q = (L[1] + L[3]) / 2 || 1; return { n: [L[0] / p, L[1] / q, L[2] / p, L[3] / q], asp: Math.log(q / p) }; };
  PH.shapeAlign = function (a, b, stretch) {
    let best = Infinity, bestR = -1;
    const na = stretch ? axisNorm(a) : null, nb = stretch ? axisNorm(b) : null;
    for (let r = 0; r < 4; r++) {
      let ok = true, d = 0;
      // (a quarter turn swaps b's two directions: its stretch flips sign)
      if (stretch && Math.abs(na.asp - (r % 2 ? -nb.asp : nb.asp)) > PH.STRETCH_MAX) continue;
      for (let k = 0; k < 4 && ok; k++) {
        const ea = a.edges[k], eb = b.edges[(k + r) % 4];
        const dl = stretch ? Math.abs(na.n[k] - nb.n[(k + r) % 4]) : Math.abs(ea.lenRel - eb.lenRel);
        if ((ea.type !== eb.type && !ea.unc && !eb.unc) || dl > PH.LEN_GATE) { ok = false; break; }
        const n = ea.sig.length / 2, sb = PH.sigAs(eb.sig, n, eb.gtrim, ea.gtrim || 0);
        let s = 0;
        for (let i = 0; i < n; i++) s += Math.hypot(ea.sig[2 * i] - sb[2 * i], ea.sig[2 * i + 1] - sb[2 * i + 1]);
        d += s / n / 4;
      }
      if (ok && d < best) { best = d; bestR = r; }
    }
    return { d: best, r: bestR };
  };

  // Rotate an SxS image (ch channels) 90° clockwise.
  function rot90cw(src, S, ch) {
    const out = new src.constructor(src.length);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const o = (x * S + (S - 1 - y)) * ch, i = (y * S + x) * ch;
      for (let k = 0; k < ch; k++) out[o + k] = src[i + k];
    }
    return out;
  }

  /**
   * Do two views show the same printed picture? With a.edges[k] matching
   * b.edges[(k+r)%4], b's core square is turned into a's orientation and the
   * two are compared: correlation of lightness (text, lines, texture) and
   * mean color difference. Returns {ncc, dE, tex}.
   */
  PH.appearance = function (a, b, r) {
    const S = PH.SQ;
    let bl = b.square.lab, bm = b.square.mask;
    for (let t = 0; t < (4 - r) % 4; t++) { bl = rot90cw(bl, S, 3); bm = rot90cw(bm, S, 1); }
    const al = a.square.lab, am = a.square.mask;
    // Colours relative to each read's own board (t1.white): the same piece in
    // the phone's shadow and in full light compares as the same colour.
    // (each read's own correction, PH.lightFix, stored with it as t1.lf)
    const both = a.lf && b.lf;
    const fa = both ? a.lf : { k: 1, da: 0, db: 0 }, fb = both ? b.lf : { k: 1, da: 0, db: 0 };
    const ka = fa.k, kb = fb.k, daA = fa.da, dbA = fa.db, daB = fb.da, dbB = fb.db;
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, de = 0;
    for (let p = 0; p < S * S; p++) {
      if (!am[p] || !bm[p]) continue;
      const La = Math.min(255, al[3 * p] * ka), Lb = Math.min(255, bl[3 * p] * kb);
      sa += La; sb += Lb; saa += La * La; sbb += Lb * Lb; sab += La * Lb; n++;
      de += PH.dE(La, al[3 * p + 1] - daA, al[3 * p + 2] - dbA, Lb, bl[3 * p + 1] - daB, bl[3 * p + 2] - dbB, 0.5);
    }
    if (n < S * S * 0.25) return { ncc: 0, dE: 99, tex: 0 };
    const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
    const ncc = va > 4 && vb > 4 ? (sab / n - (sa / n) * (sb / n)) / Math.sqrt(va * vb) : 0;
    return { ncc, dE: de / n, tex: Math.sqrt(Math.min(va, vb)) * PH.L_SCALE };
  };

  /**
   * Same physical piece? Outline must match (shapeAlign) AND the print must
   * agree: textured views must correlate; plain views must match in color.
   * Many pieces share near-identical cuts, so shape alone is not identity.
   */
  PH.samePiece = function (a, b, shapeTol) {
    const al = PH.shapeAlign(a, b);
    if (!(al.d < (shapeTol || PH.ANCHOR_SHAPE))) return { ok: false, d: al.d };
    const ap = PH.appearance(a, b, al.r);
    // Near-identical outline (well under the ~0.05 look-alike floor): the print
    // only has to be consistent. Merely close outline: the print must agree.
    // (v0.20: a near-identical outline passes on either rule - it used to be
    // held to a stricter print test than a merely close one, which kept 9 of
    // 48 copies apart in test/dedupe.js: d ~0.01, print dE 15-20, ncc 0.8)
    const tight = al.d < 0.025;
    const normal = ap.tex > 8 ? ap.ncc > 0.5 && ap.dE < 25 : ap.dE < 10 && ap.ncc > 0.2;
    const ok = normal || (tight && ap.dE < 15 && ap.ncc > -0.1);
    // combined distance for ranking: shape plus appearance disagreement
    return { ok, d: al.d + (1 - Math.max(0, ap.ncc)) * 0.05 + ap.dE / 400, r: al.r, ap };
  };

  /**
   * Fold another view of the same piece into its stored model: edge outlines
   * and lengths become running averages (noise from any single photo cancels
   * out). Corners, core square and color strips stay from the stored view.
   */
  PH.fuseShapes = function (base, obs, r) {
    const n = base.nObs || 1;
    let retyped = false;
    for (let j = 0; j < 4; j++) {
      const eb = base.edges[j], eo = obs.edges[(j - r + 4) % 4];
      // An uncertain edge is settled by a view that reads it clearly.
      if (eb.unc && !eo.unc && eb.type !== eo.type) {
        eb.type = eo.type; eb.unc = false; eb.alt = eo.alt; eb.sig = Float32Array.from(eo.sig); eb.gtrim = eo.gtrim; eb.amp = eo.amp; retyped = true;
        continue;
      }
      if (eb.type !== eo.type) continue;
      if (eb.unc && !eo.unc) eb.unc = false;
      const os = PH.sigAs(eo.sig, eb.sig.length / 2, eo.gtrim, eb.gtrim || 0);
      for (let i = 0; i < eb.sig.length; i++) eb.sig[i] = (eb.sig[i] * n + os[i]) / (n + 1);
      eb.lenRel = (eb.lenRel * n + eo.lenRel) / (n + 1);
      eb.amp = (eb.amp * n + eo.amp) / (n + 1);
    }
    // Colour: a read in good conditions replaces colour read in bad ones
    // (glare, too dark) - scanning again in better light fixes it.
    for (let j = 0; j < 4; j++) {
      const eb = base.edges[j], eo = obs.edges[(j - r + 4) % 4];
      if (eb.cdoubt && eo.cdoubt === null && eo.pcol && eb.type === eo.type) {
        eb.pcol = eo.pcol; eb.pspread = eo.pspread; eb.pxy = eo.pxy; eb.cc = eo.cc; eb.cdoubt = null;
      }
    }
    base.nObs = n + 1;
    if (retyped) { base.code = base.edges.map((e) => e.type).join(''); base.flats = base.edges.map((e) => e.type === 'F'); }
    // keep the best read's quality
    if (obs.quality && (!base.quality || obs.quality.q > base.quality.q)) base.quality = obs.quality;
  };

  /**
   * Is there a seam (the thin dark gap between two joined pieces) across
   * this outline? Thin dark lines (black-hat) inside the eroded outline; a
   * seam is continuous and cuts the inside into two big parts, while print
   * (text, drawn lines with gaps) leaves it in one piece.
   * @param lab crop Lab (Uint8, 3 per pixel), filled = outline mask (Mat), side = mean side (px)
   */
  PH.innerSeam = function (lab, w, h, filled, side) {
    const cv = PH.cv;
    const odd = (v) => Math.max(3, (Math.round(v) | 1));
    const L = new cv.Mat(h, w, cv.CV_8UC1), Ld = L.data;
    for (let p = 0; p < w * h; p++) Ld[p] = lab[3 * p];
    const kb = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(odd(Math.min(9, side * 0.06)), odd(Math.min(9, side * 0.06))));
    const bh = new cv.Mat();
    cv.morphologyEx(L, bh, cv.MORPH_BLACKHAT, kb);
    const ke = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(odd(side * 0.12), odd(side * 0.12)));
    const inner = new cv.Mat();
    cv.erode(filled, inner, ke);
    const line = new cv.Mat();
    cv.threshold(bh, line, 18, 255, cv.THRESH_BINARY);
    cv.bitwise_and(line, inner, line);
    const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(line, line, k3);
    const rest = new cv.Mat();
    cv.bitwise_not(line, rest);
    cv.bitwise_and(rest, inner, rest);
    const A = cv.countNonZero(inner);
    const lab2 = new cv.Mat(), stats = new cv.Mat(), cent = new cv.Mat();
    const n = cv.connectedComponentsWithStats(rest, lab2, stats, cent, 4, cv.CV_32S);
    let big = 0;
    for (let i = 1; i < n; i++) if (stats.intAt(i, cv.CC_STAT_AREA) >= A * 0.15) big++;
    [L, kb, bh, ke, inner, line, k3, rest, lab2, stats, cent].forEach((m) => m.delete());
    return A > 50 && big >= 2;
  };
  PH.MIN_CORNER_SCORE = 0.03; // real pieces ~0.05-0.3, fragments ~0.01-0.02 // below this an outline isn't a jigsaw piece
  PH.SAME_SHAPE = 0.05;
  /** A close read: the piece at least this many camera pixels across (corner
   *  to corner) and sharp enough. Measured on the owner's 50-piece video:
   *  close reads (~260 px) agree on edge types 41/42 times and two reads of
   *  one edge differ 3.5x less than overview reads (~80 px: 8/49 misread). */
  // (tuned on the owner's video: the sweep passed some pieces only at
  // ~120-155 px; the pale piece's correct reads scored q 0.27-0.29, its
  // misreads 0.15-0.23; two close reads must still agree to check a piece)
  PH.CLOSE_SIDE = 120; // (overview reads in the owner's video: 70-80 px)
  PH.CLOSE_Q = 0.25;
  PH.READ_SIDE = Infinity; // read pieces bigger than this (side, source px) from a scaled-down crop (Engine.detT1)
  /** Fewest edges whose types differ between two reads, over the 4 turns. */
  PH.codeDistance = function (a, b) {
    let best = 4;
    for (let r = 0; r < 4; r++) { let d = 0; for (let k = 0; k < 4; k++) if (a[k] !== b[(k + r) % 4]) d++; if (d < best) best = d; }
    return best;
  };
  /** Two reads that are clearly of different pieces: 2+ edges of another type
   *  in every turn, or outlines far apart. One misread tab (a close read gets
   *  ~1 in 40 wrong) is not enough - it never splits one piece in two or
   *  calls a piece "swapped". */
  PH.clearlyDifferent = function (a, b) {
    if (PH.codeDistance(a.code, b.code) >= 2) return true;
    const al = PH.shapeAlign(a, b);
    if (al.r >= 0) return al.d > PH.ANCHOR_SHAPE * 2 || (al.d > PH.ANCHOR_SHAPE && !PH.samePiece(a, b, PH.ANCHOR_SHAPE * 2).ok);
    return false;
  };
  /** Two reads of the piece already linked to this spot agree on its shape:
   *  the same edge types and a close outline (print is not compared - it
   *  differs between a 155 px and a 129 px view of one piece). */
  // Two re-reads of one spot whose sides differ only by a stretch (owner's
  // videos: every same-code pair that failed to agree failed on the length
  // gate alone, with a 13-24% median stretch; all such pairs in IMG_3593 were
  // the right piece per its key) agree when the outline is close (PH.STRETCH_D).
  PH.shapeAgree = function (a, b) {
    const al = PH.shapeAlign(a, b);
    if (al.r >= 0 && al.d < PH.ANCHOR_SHAPE) return al;
    const st = PH.shapeAlign(a, b, true);
    return st.r >= 0 && st.d < PH.STRETCH_D ? Object.assign(st, { stretched: true }) : null;
  };
  PH.STRETCH_MAX = 0.3; // log ratio: up to ~35% difference in a read's long/short side ratio
  PH.STRETCH_D = 0.08;  // outline distance for a stretched agreement (tighter than ANCHOR_SHAPE)
  /** A shape signature (x,y pairs, evenly spaced along the edge) at n points:
   *  reads saved with another PH.GEOM_PTS.n compare with today's. */
  // A signature resampled to n points; from/to: the fraction of the arc left
  // off at each corner by the source / wanted signature (edge.gtrim), so
  // reads saved with another corner trim still compare point for point
  // (the points are evenly spaced along the arc).
  PH.sigAs = function (sig, n, from, to) {
    const m = sig.length / 2, f0 = from || 0, t0 = to === undefined ? f0 : to || 0;
    if (m === n && f0 === t0) return sig;
    const out = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      const frac = t0 + (1 - 2 * t0) * (n === 1 ? 0 : k / (n - 1));
      const t = PH.clamp(((frac - f0) / (1 - 2 * f0)) * (m - 1), 0, m - 1), i = Math.min(m - 2, Math.floor(t)), f = t - i;
      out[2 * k] = sig[2 * i] * (1 - f) + sig[2 * i + 2] * f; out[2 * k + 1] = sig[2 * i + 1] * (1 - f) + sig[2 * i + 3] * f;
    }
    return out;
  };
  PH.isCloseRead = (t1) => !!t1 && t1.meanSide >= PH.CLOSE_SIDE && (!t1.quality || t1.quality.q >= PH.CLOSE_Q);
  PH.ANCHOR_SHAPE = 0.13; // candidate threshold when matching photos to the map // sameShape() below this = same physical piece

  // Rotation-invariant code, e.g. "BTFT" -> lexicographically smallest rotation.
  PH.canonicalCode = function (code) {
    let best = code;
    for (let r = 1; r < 4; r++) { const c = code.slice(r) + code.slice(0, r); if (c < best) best = c; }
    return best;
  };
})(typeof self !== 'undefined' ? self : globalThis);
