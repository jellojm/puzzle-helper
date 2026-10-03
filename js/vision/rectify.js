/* Tilt correction: turn a photo taken at an angle into a virtual top-down
 * view of the table.
 *
 * The pieces lie on one plane (the level table), so rotating a virtual camera
 * to look straight down undoes the perspective exactly: H = K R K^-1, where
 * K is the camera intrinsics (focal length from the field of view) and R is
 * the smallest rotation that turns "down" (from the gravity sensor) into the
 * optical axis. Everything downstream (segmentation, shapes, matching) then
 * works on the straightened image.
 *
 * Camera/image coordinates: X right, Y down, Z forward (out of the lens).
 * `down` is the unit gravity direction in those coordinates (Z > 0 when the
 * camera looks at the table). */
(function (G) {
  const PH = G.PH;

  function mul3(A, B) {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[3 * r + c] = A[3 * r] * B[c] + A[3 * r + 1] * B[3 + c] + A[3 * r + 2] * B[6 + c];
    return C;
  }
  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  PH.mul3 = mul3;
  PH.inv3 = inv3;
  PH.applyH = function (H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w, w];
  };

  // Focal length in pixels for an image whose long side spans fovDeg.
  PH.focalPx = (w, h, fovDeg) => Math.max(w, h) / 2 / Math.tan(((fovDeg || PH.DEFAULT_FOV) * Math.PI) / 360);
  // iPhone main (1x) camera: ~69° across the long side of the sensor; video
  // stabilization crops a little, so default slightly narrower.
  PH.DEFAULT_FOV = 66;

  // Tilt in degrees from straight down.
  PH.tiltDeg = (down) => (Math.acos(PH.clamp(down[2] / Math.hypot(down[0], down[1], down[2]), -1, 1)) * 180) / Math.PI;

  /**
   * Homography (original pixels -> virtual top-down pixels) for an image of
   * size w x h, focal f (px) and gravity direction `down`. The image center
   * keeps its scale; the output frame is the bounding box of the warped image,
   * limited to `maxArea` x the original area (the far, squashed part of a very
   * tilted view is dropped).
   */
  PH.tiltHomography = function (w, h, f, down, maxArea) {
    let [dx, dy, dz] = down;
    const n = Math.hypot(dx, dy, dz);
    dx /= n; dy /= n; dz /= n;
    // Rotation taking `down` to +Z (Rodrigues; axis = down x Z).
    let ax = dy, ay = -dx; // (dx,dy,dz) x (0,0,1) = (dy, -dx, 0)
    const s = Math.hypot(ax, ay), c = dz;
    let R;
    if (s < 1e-6) R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    else {
      ax /= s; ay /= s;
      const C = 1 - c;
      R = [c + ax * ax * C, ax * ay * C, ay * s,
        ax * ay * C, c + ay * ay * C, -ax * s,
        -ay * s, ax * s, c];
    }
    const cx = w / 2, cy = h / 2;
    const K = [f, 0, cx, 0, f, cy, 0, 0, 1], Ki = inv3(K);
    let H = mul3(K, mul3(R, Ki));
    // Keep the scale at the image center: virtual pixel size = original there.
    const c0 = PH.applyH(H, cx, cy), c1 = PH.applyH(H, cx + 1, cy), c2 = PH.applyH(H, cx, cy + 1);
    const sc = 1 / Math.sqrt(Math.abs((c1[0] - c0[0]) * (c2[1] - c0[1]) - (c1[1] - c0[1]) * (c2[0] - c0[0])));
    H = mul3([sc, 0, 0, 0, sc, 0, 0, 0, 1], H);
    // Output bounds.
    const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => PH.applyH(H, x, y));
    const mid = PH.applyH(H, cx, cy);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p[2] <= 0) continue; // corner beyond the horizon
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }
    if (!isFinite(x0)) return null;
    // Keep at most maxArea x the original area, centered on the image center.
    const k = Math.sqrt(maxArea || 3) / 2;
    x0 = Math.max(x0, mid[0] - k * w); x1 = Math.min(x1, mid[0] + k * w);
    y0 = Math.max(y0, mid[1] - k * h); y1 = Math.min(y1, mid[1] + k * h);
    H = mul3([1, 0, -x0, 0, 1, -y0, 0, 0, 1], H);
    return { H, Hinv: inv3(H), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
  };

  // Gravity direction for a camera pitched forward by p and rolled by r (degrees).
  PH.downFromAngles = function (pitchDeg, rollDeg) {
    const p = (pitchDeg * Math.PI) / 180, r = (rollDeg * Math.PI) / 180;
    // Rc = Rx(p) * Ry(r); down = third row of Rc
    return [-Math.sin(r), Math.sin(p) * Math.cos(r), Math.cos(p) * Math.cos(r)];
  };

  /**
   * Estimate tilt from the pieces themselves (for photos with no sensor data).
   * In a correctly straightened view (1) pieces near and far have the same
   * size and (2) randomly oriented pieces are, on average, not stretched in
   * any direction. Searches pitch/roll for the most uniform result.
   * @param blobs [{pts (flat, image px), area}] single-piece-sized outlines
   */
  PH.estimateTilt = function (blobs, w, h, fovDeg) {
    if (blobs.length < 6) return null;
    const f = PH.focalPx(w, h, fovDeg);
    const sample = blobs.slice(0, 80).map((b) => {
      const n = b.pts.length / 2, step = Math.max(1, Math.floor(n / 32)), P = [];
      for (let i = 0; i < n; i += step) P.push([b.pts[2 * i], b.pts[2 * i + 1]]);
      return P;
    });
    const score = (down) => {
      const rect = PH.tiltHomography(w, h, f, down, 1e9);
      if (!rect) return Infinity;
      let sxx = 0, syy = 0, sxy = 0;
      const logA = [];
      for (const P of sample) {
        const Q = P.map(([x, y]) => PH.applyH(rect.H, x, y));
        if (Q.some((q) => q[2] <= 0)) return Infinity;
        let mx = 0, my = 0;
        for (const q of Q) { mx += q[0]; my += q[1]; }
        mx /= Q.length; my /= Q.length;
        let cxx = 0, cyy = 0, cxy = 0;
        for (const q of Q) { const dx = q[0] - mx, dy = q[1] - my; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy; }
        const tr = cxx + cyy || 1;
        sxx += cxx / tr; syy += cyy / tr; sxy += cxy / tr;
        logA.push(Math.log(tr / Q.length));
      }
      const aniso = Math.hypot(sxx - syy, 2 * sxy) / (sxx + syy);
      const m = logA.reduce((a, b) => a + b, 0) / logA.length;
      const sd = Math.sqrt(logA.reduce((a, b) => a + (b - m) ** 2, 0) / logA.length);
      return aniso + sd;
    };
    let best = { s: score([0, 0, 1]), pitch: 0, roll: 0 };
    const flat = best.s;
    for (let pitch = 0; pitch <= 70; pitch += 5) for (let roll = -40; roll <= 40; roll += 5) {
      const s = score(PH.downFromAngles(pitch, roll));
      if (s < best.s) best = { s, pitch, roll };
    }
    // refine around the best
    const b0 = { ...best };
    for (let pitch = b0.pitch - 4; pitch <= b0.pitch + 4; pitch += 1) for (let roll = b0.roll - 4; roll <= b0.roll + 4; roll += 1) {
      if (pitch < 0) continue;
      const s = score(PH.downFromAngles(pitch, roll));
      if (s < best.s) best = { s, pitch, roll };
    }
    return { down: PH.downFromAngles(best.pitch, best.roll), pitch: best.pitch, roll: best.roll, gain: flat - best.s, tilt: PH.tiltDeg(PH.downFromAngles(best.pitch, best.roll)) };
  };

  /**
   * Wrap an image source (see Engine.processFrame) so it serves the virtual
   * top-down view instead. Only the processing-size image and the small
   * per-piece crops are ever warped, never the whole full-resolution frame.
   */
  PH.rectifiedSource = function (base, rect) {
    const cv = PH.cv;
    const { H, Hinv } = rect;
    const warp = (img, M, ow, oh) => {
      const src = new cv.Mat(img.h, img.w, cv.CV_8UC4); src.data.set(img.data);
      const m = cv.matFromArray(3, 3, cv.CV_64F, M);
      const dst = new cv.Mat();
      cv.warpPerspective(src, dst, m, new cv.Size(ow, oh), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      const out = { w: ow, h: oh, data: new Uint8ClampedArray(dst.data) };
      src.delete(); m.delete(); dst.delete();
      return out;
    };
    return {
      w: rect.w, h: rect.h, rect,
      getProc(maxW) {
        const scale = Math.min(1, maxW / Math.max(rect.w, rect.h));
        const ow = Math.round(rect.w * scale), oh = Math.round(rect.h * scale);
        // Source at a matching resolution (a bit more, for the stretched far side).
        const srcImg = base.getProc(Math.min(Math.max(base.w, base.h), maxW * 1.3));
        const si = srcImg.scale;
        // proc pixel <- virtual (x/scale) <- original <- source-proc (x/si)
        const M = mul3([scale, 0, 0, 0, scale, 0, 0, 0, 1], mul3(H, [1 / si, 0, 0, 0, 1 / si, 0, 0, 0, 1]));
        const out = warp(srcImg, M, ow, oh);
        out.scale = scale;
        // Corners outside the camera image are filled by stretching the edge
        // pixels (streaks). Mark them (alpha 0, plus a 2 px seam) so the
        // segmentation treats them as background instead of as objects.
        const ones = new cv.Mat(srcImg.h, srcImg.w, cv.CV_8UC1, new cv.Scalar(255));
        const m = cv.matFromArray(3, 3, cv.CV_64F, M), valid = new cv.Mat();
        cv.warpPerspective(ones, valid, m, new cv.Size(ow, oh), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
        const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
        cv.erode(valid, valid, k);
        let invalid = 0;
        for (let p = 0; p < ow * oh; p++) if (!valid.data[p]) { out.data[4 * p + 3] = 0; invalid++; }
        out.invalid = invalid > 0;
        [ones, m, valid, k].forEach((x) => x.delete());
        return out;
      },
      getCrop(x, y, cw, ch) {
        // Original-image region covering this virtual rectangle.
        const q = [[x, y], [x + cw, y], [x + cw, y + ch], [x, y + ch]].map(([u, v]) => PH.applyH(Hinv, u, v));
        const ox = Math.max(0, Math.floor(Math.min(...q.map((p) => p[0]))) - 2), oy = Math.max(0, Math.floor(Math.min(...q.map((p) => p[1]))) - 2);
        const ox1 = Math.min(base.w, Math.ceil(Math.max(...q.map((p) => p[0]))) + 2), oy1 = Math.min(base.h, Math.ceil(Math.max(...q.map((p) => p[1]))) + 2);
        if (ox1 - ox < 2 || oy1 - oy < 2) return { w: cw, h: ch, data: new Uint8ClampedArray(cw * ch * 4) };
        const orig = base.getCrop(ox, oy, ox1 - ox, oy1 - oy);
        const M = mul3([1, 0, -x, 0, 1, -y, 0, 0, 1], mul3(H, [1, 0, ox, 0, 1, oy, 0, 0, 1]));
        return warp(orig, M, cw, ch);
      },
    };
  };
})(typeof self !== 'undefined' ? self : globalThis);
