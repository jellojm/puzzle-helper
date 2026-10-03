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
  const SIG = 32;         // shape-signature samples per edge
  const STRIP = 16;       // color samples per edge
  PH.SQ = 24;             // core-square size (matches box cell size)

  function segmentCrop(lab, w, h, bg, threshDE, lightW, lut, hint) {
    const cv = PH.cv;
    const dist = new cv.Mat(h, w, cv.CV_8UC1);
    const dd = dist.data;
    const ls = PH.L_SCALE * lightW;
    if (lut) {
      for (let p = 0, i = 0; p < w * h; p++, i += 3) dd[p] = lut[PH.correctedBin(lab[i], lab[i + 1], lab[i + 2], lut.corr)] ? 0 : 255;
      threshDE = 64;
    } else for (let p = 0, i = 0; p < w * h; p++, i += 3) {
      const dL = (lab[i] - bg.L) * ls, da = lab[i + 1] - bg.a, db = lab[i + 2] - bg.b;
      const d = 2 * Math.sqrt(dL * dL + da * da + db * db);
      dd[p] = d > 255 ? 255 : d;
    }
    const mask = new cv.Mat();
    cv.threshold(dist, mask, 2 * threshDE, 255, cv.THRESH_BINARY);
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
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

  function sampleLab(lab, w, h, x, y) {
    let sL = 0, sa = 0, sb = 0, n = 0;
    const xi = Math.round(x), yi = Math.round(y);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
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
  PH.analyzePiece = function (crop, ctx) {
    const cv = PH.cv;
    const w = crop.w, h = crop.h;
    const lab = PH.rgbaToLab(crop.data, w, h);
    const seg = segmentCrop(lab, w, h, ctx.bg, ctx.threshDE, ctx.lightW === undefined ? 0.5 : ctx.lightW, ctx.lut, ctx.hint);
    if (!seg.pts || seg.pts.length < 40) { seg.filled.delete(); return null; }
    const touches = (() => {
      for (let i = 0; i < seg.pts.length; i += 2) {
        const x = seg.pts[i], y = seg.pts[i + 1];
        if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) return true;
      }
      return false;
    })();
    if (touches) { seg.filled.delete(); return null; }

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
      const rs = PH.resampleOpen(pts, SIG);
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
      edges.push({ type, sig, strip, len: L, amp });
    }
    const meanSide = edges.reduce((t, e) => t + e.len, 0) / 4;
    for (const e of edges) e.lenRel = e.len / meanSide;
    const code = edges.map((e) => e.type).join('');
    const flats = edges.map((e) => e.type === 'F');

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

    [src, dst, M, labMat, sq, sqm, ek, Lm, lap, mean, sd, rgba, tm, seg.filled].forEach((m) => m.delete());

    const ox = ctx.ox || 0, oy = ctx.oy || 0;
    return {
      corners: corners.map((c) => [c[0] + ox, c[1] + oy]),
      edges, code, flats, meanSide, square, sharp, thumb,
      cornerScore: cr.score,
    };
  };

  /** Same physical piece? Best mean signature distance over the 4 rotations
   *  whose edge-type codes agree (Infinity if none agree). ~0.01-0.03 for the
   *  same piece seen twice; different pieces are usually > 0.06. */
  PH.sameShape = function (a, b) { return PH.shapeAlign(a, b).d; };

  /** Best rotation aligning a to b: a.edges[k] corresponds to b.edges[(k+r)%4]. */
  PH.shapeAlign = function (a, b) {
    let best = Infinity, bestR = -1;
    for (let r = 0; r < 4; r++) {
      let ok = true, d = 0;
      for (let k = 0; k < 4 && ok; k++) {
        const ea = a.edges[k], eb = b.edges[(k + r) % 4];
        if (ea.type !== eb.type || Math.abs(ea.lenRel - eb.lenRel) > 0.08) { ok = false; break; }
        const n = ea.sig.length / 2;
        let s = 0;
        for (let i = 0; i < n; i++) s += Math.hypot(ea.sig[2 * i] - eb.sig[2 * i], ea.sig[2 * i + 1] - eb.sig[2 * i + 1]);
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
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, de = 0;
    for (let p = 0; p < S * S; p++) {
      if (!am[p] || !bm[p]) continue;
      const La = al[3 * p], Lb = bl[3 * p];
      sa += La; sb += Lb; saa += La * La; sbb += Lb * Lb; sab += La * Lb; n++;
      de += PH.dE(La, al[3 * p + 1], al[3 * p + 2], Lb, bl[3 * p + 1], bl[3 * p + 2], 0.5);
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
    const tight = al.d < 0.025;
    const ok = tight ? ap.dE < 15 && ap.ncc > -0.1
      : ap.tex > 8 ? ap.ncc > 0.5 && ap.dE < 25 : ap.dE < 10 && ap.ncc > 0.2;
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
    for (let j = 0; j < 4; j++) {
      const eb = base.edges[j], eo = obs.edges[(j - r + 4) % 4];
      if (eb.type !== eo.type) continue;
      for (let i = 0; i < eb.sig.length; i++) eb.sig[i] = (eb.sig[i] * n + eo.sig[i]) / (n + 1);
      eb.lenRel = (eb.lenRel * n + eo.lenRel) / (n + 1);
      eb.amp = (eb.amp * n + eo.amp) / (n + 1);
    }
    base.nObs = n + 1;
  };

  PH.MIN_CORNER_SCORE = 0.03; // real pieces ~0.05-0.3, fragments ~0.01-0.02 // below this an outline isn't a jigsaw piece
  PH.SAME_SHAPE = 0.05;
  PH.ANCHOR_SHAPE = 0.13; // candidate threshold when matching photos to the map // sameShape() below this = same physical piece

  // Rotation-invariant code, e.g. "BTFT" -> lexicographically smallest rotation.
  PH.canonicalCode = function (code) {
    let best = code;
    for (let r = 1; r < 4; r++) { const c = code.slice(r) + code.slice(0, r); if (c < best) best = c; }
    return best;
  };
})(typeof self !== 'undefined' ? self : globalThis);
