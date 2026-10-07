/* Puzzle Helper vision core: shared namespace, color + geometry helpers.
 * Classic script (no modules) so it can be loaded by importScripts() in the
 * worker and by vm in Node tests. Everything hangs off self.PH. */
(function (G) {
  const PH = (G.PH = G.PH || {});

  // ---------- color ----------
  // OpenCV 8-bit Lab: L in 0..255 (=L*·255/100), a,b offset by 128.
  PH.L_SCALE = 100 / 255;

  // Convert RGBA pixels to 8-bit Lab (3 bytes/pixel) using OpenCV.
  PH.rgbaToLab = function (rgba, w, h) {
    const cv = PH.cv;
    const src = new cv.Mat(h, w, cv.CV_8UC4);
    src.data.set(rgba);
    const rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const lab = new cv.Mat();
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    const out = new Uint8Array(lab.data);
    src.delete(); rgb.delete(); lab.delete();
    return out;
  };

  // Delta-E (CIE76) between two 8-bit Lab triples, with optional L weight.
  PH.dE = function (L1, a1, b1, L2, a2, b2, wL) {
    const dL = (L1 - L2) * PH.L_SCALE * (wL === undefined ? 1 : wL);
    const da = a1 - a2, db = b1 - b2;
    return Math.sqrt(dL * dL + da * da + db * db);
  };

  // 4x4x4 Lab histogram bins. a/b are concentrated near 128 for real-world
  // colors, so their bins cover 88..168 rather than the full byte range.
  PH.HIST_BINS = 64;
  PH.histBin = function (L, a, b) {
    const li = L >> 6;
    let ai = ((a - 88) / 20) | 0; ai = ai < 0 ? 0 : ai > 3 ? 3 : ai;
    let bi = ((b - 88) / 20) | 0; bi = bi < 0 ? 0 : bi > 3 ? 3 : bi;
    return (li << 4) | (ai << 2) | bi;
  };
  PH.histIntersect = function (h1, h2) {
    let s = 0;
    for (let i = 0; i < h1.length; i++) s += h1[i] < h2[i] ? h1[i] : h2[i];
    return s;
  };

  // ---------- geometry ----------
  PH.polyArea = function (pts) { // pts: flat [x0,y0,x1,y1,...]; >0 = clockwise on screen (y down)
    let s = 0;
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      s += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
    }
    return s / 2;
  };

  PH.pointInPoly = function (x, y, pts) {
    let inside = false;
    const n = pts.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = pts[2 * i], yi = pts[2 * i + 1], xj = pts[2 * j], yj = pts[2 * j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  // Resample a closed polyline (flat array) to n points evenly spaced by arc length.
  PH.resampleClosed = function (pts, n) {
    const m = pts.length / 2;
    const cum = new Float64Array(m + 1);
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      cum[i + 1] = cum[i] + Math.hypot(pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]);
    }
    const total = cum[m];
    const out = new Float32Array(2 * n);
    let seg = 0;
    for (let k = 0; k < n; k++) {
      const d = (k * total) / n;
      while (seg < m - 1 && cum[seg + 1] < d) seg++;
      const j = (seg + 1) % m;
      const t = cum[seg + 1] > cum[seg] ? (d - cum[seg]) / (cum[seg + 1] - cum[seg]) : 0;
      out[2 * k] = pts[2 * seg] + t * (pts[2 * j] - pts[2 * seg]);
      out[2 * k + 1] = pts[2 * seg + 1] + t * (pts[2 * j + 1] - pts[2 * seg + 1]);
    }
    return { pts: out, length: total };
  };

  // Resample an open polyline given as array of [x,y] to n points.
  PH.resampleOpen = function (P, n) {
    const m = P.length;
    const cum = new Float64Array(m);
    for (let i = 1; i < m; i++) cum[i] = cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    const total = cum[m - 1];
    const out = [];
    let seg = 0;
    for (let k = 0; k < n; k++) {
      const d = (k * total) / (n - 1);
      while (seg < m - 2 && cum[seg + 1] < d) seg++;
      const span = cum[seg + 1] - cum[seg];
      const t = span > 0 ? Math.min(1, (d - cum[seg]) / span) : 0;
      out.push([P[seg][0] + t * (P[seg + 1][0] - P[seg][0]), P[seg][1] + t * (P[seg + 1][1] - P[seg][1])]);
    }
    return out;
  };

  /** n points evenly spaced by arc length between fractions t0 and t1 of an
   *  open polyline P ([[x,y],...]), plus the unit tangent at each (taken
   *  over +-`dt` of the length, so it doesn't depend on n). */
  PH.arcPoints = function (P, n, t0, t1, dt) {
    const m = P.length, cum = new Float64Array(m);
    for (let i = 1; i < m; i++) cum[i] = cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    const total = cum[m - 1] || 1;
    let seg = 0;
    const at = (d) => {
      d = Math.max(0, Math.min(total, d));
      if (cum[seg] > d) seg = 0;
      while (seg < m - 2 && cum[seg + 1] < d) seg++;
      const span = cum[seg + 1] - cum[seg], t = span > 0 ? Math.min(1, (d - cum[seg]) / span) : 0;
      return [P[seg][0] + t * (P[seg + 1][0] - P[seg][0]), P[seg][1] + t * (P[seg + 1][1] - P[seg][1])];
    };
    const out = [], h = (dt || 0.01) * total;
    for (let k = 0; k < n; k++) {
      const d = total * (n === 1 ? (t0 + t1) / 2 : t0 + ((t1 - t0) * k) / (n - 1));
      const p = at(d), a = at(d - h), b = at(d + h);
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1;
      out.push({ x: p[0], y: p[1], tx: tx / tl, ty: ty / tl });
    }
    return out;
  };

  // ---------- similarity transform (x,y) -> (a x - b y + tx, b x + a y + ty) ----------
  PH.simApply = function (T, x, y) {
    return [T.a * x - T.b * y + T.tx, T.b * x + T.a * y + T.ty];
  };
  PH.simInvert = function (T) {
    const d = T.a * T.a + T.b * T.b;
    const a = T.a / d, b = -T.b / d;
    return { a, b, tx: -(a * T.tx - b * T.ty), ty: -(b * T.tx + a * T.ty) };
  };
  PH.simScale = function (T) { return Math.hypot(T.a, T.b); };

  // Least-squares similarity from point pairs src[i] -> dst[i] ([x,y] arrays).
  PH.simFit = function (src, dst) {
    const n = src.length;
    if (n < 2) return null;
    let sx = 0, sy = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]; }
    sx /= n; sy /= n; dx /= n; dy /= n;
    let num1 = 0, num2 = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const px = src[i][0] - sx, py = src[i][1] - sy, qx = dst[i][0] - dx, qy = dst[i][1] - dy;
      num1 += px * qx + py * qy;
      num2 += px * qy - py * qx;
      den += px * px + py * py;
    }
    if (den < 1e-9) return null;
    const a = num1 / den, b = num2 / den;
    return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
  };

  // Weighted similarity fit (least squares, weights w[i] >= 0).
  PH.simFitW = function (src, dst, w) {
    const n = src.length;
    let W = 0, sx = 0, sy = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { W += w[i]; sx += src[i][0] * w[i]; sy += src[i][1] * w[i]; dx += dst[i][0] * w[i]; dy += dst[i][1] * w[i]; }
    if (W <= 0) return null;
    sx /= W; sy /= W; dx /= W; dy /= W;
    let num1 = 0, num2 = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const px = src[i][0] - sx, py = src[i][1] - sy, qx = dst[i][0] - dx, qy = dst[i][1] - dy;
      num1 += (px * qx + py * qy) * w[i]; num2 += (px * qy - py * qx) * w[i]; den += (px * px + py * py) * w[i];
    }
    if (den < 1e-9) return null;
    const a = num1 / den, b = num2 / den;
    return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
  };

  // RANSAC similarity. pairs: [{src:[x,y], dst:[x,y]}]. Returns {T, inliers:[idx]} or null.
  PH.simRansac = function (pairs, tol, iters, rnd) {
    const n = pairs.length;
    if (n < 2) return null;
    rnd = rnd || Math.random;
    let best = null;
    const tol2 = tol * tol;
    const tryT = (T) => {
      const inl = [];
      for (let i = 0; i < n; i++) {
        const p = PH.simApply(T, pairs[i].src[0], pairs[i].src[1]);
        const ex = p[0] - pairs[i].dst[0], ey = p[1] - pairs[i].dst[1];
        if (ex * ex + ey * ey < tol2) inl.push(i);
      }
      return inl;
    };
    const total = n <= 8 ? (n * (n - 1)) / 2 : iters;
    for (let it = 0, i = 0, j = 1; it < total; it++) {
      let a, b;
      if (n <= 8) { a = i; b = j; if (++j >= n) { i++; j = i + 1; } }
      else { a = (rnd() * n) | 0; b = (rnd() * n) | 0; if (a === b) continue; }
      const T = PH.simFit([pairs[a].src, pairs[b].src], [pairs[a].dst, pairs[b].dst]);
      if (!T) continue;
      const inl = tryT(T);
      if (!best || inl.length > best.inliers.length) best = { T, inliers: inl };
    }
    if (!best || best.inliers.length < 2) return null;
    const T = PH.simFit(best.inliers.map((k) => pairs[k].src), best.inliers.map((k) => pairs[k].dst)) || best.T;
    return { T, inliers: tryT(T) };
  };

  PH.median = function (arr) {
    if (!arr.length) return 0;
    const s = Array.from(arr).sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  PH.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // Deterministic PRNG for tests / RANSAC reproducibility.
  PH.mulberry32 = function (seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
})(typeof self !== 'undefined' ? self : globalThis);
