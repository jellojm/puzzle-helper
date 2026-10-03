/* Frame-to-frame camera motion from a tiny grayscale thumbnail.
 *
 * This is what lets the overlay run at display rate while the real analysis
 * runs at 2-5 frames/s: between analyses the last result's marks are moved by
 * the shift measured here, so they stay glued to the pieces. The whole thing
 * works on a ~64 px wide thumbnail (a few thousand pixels), so it costs well
 * under a millisecond and needs no motion sensor — which matters because on
 * iOS Chrome the motion permission is usually off.
 *
 * Model: pure translation (dx, dy) in thumbnail pixels, optionally with a
 * uniform scale. A hand sweep over a table at a roughly constant height is
 * dominated by translation; rotation and scale between two consecutive video
 * frames (16-100 ms apart) are tiny and are picked up again at the next
 * analysis. Pure logic, no DOM: the page downsamples the video into the
 * thumbnail with drawImage + getImageData and hands the bytes here.
 */
(function (G) {
  const PH = G.PH || (G.PH = {});

  /** RGBA -> grayscale Float32Array, mean-subtracted so lighting flicker cancels. */
  PH.flowGray = function (rgba, w, h) {
    const g = new Float32Array(w * h);
    let s = 0;
    for (let p = 0, i = 0; p < w * h; p++, i += 4) { const v = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]; g[p] = v; s += v; }
    const m = s / (w * h);
    for (let p = 0; p < w * h; p++) g[p] -= m;
    return g;
  };

  // Sum of absolute differences between `a` and `b` shifted by (dx, dy), over
  // the overlap, normalised per pixel so different overlaps compare fairly.
  function sad(a, b, w, h, dx, dy, step) {
    let s = 0, n = 0;
    const x0 = Math.max(0, dx), x1 = Math.min(w, w + dx), y0 = Math.max(0, dy), y1 = Math.min(h, h + dy);
    for (let y = y0; y < y1; y += step) {
      const ra = y * w, rb = (y - dy) * w - dx;
      for (let x = x0; x < x1; x += step) { s += Math.abs(a[ra + x] - b[rb + x]); n++; }
    }
    return n ? s / n : Infinity;
  }

  /**
   * Shift that best maps `prev` onto `cur` (both PH.flowGray outputs, w x h).
   * @param opts {range: max |shift| in px (default w/8), step: pixel stride for the
   *              coarse search (default 2)}
   * @returns {dx, dy, conf} — conf in 0..1: how distinctive the best match is
   *          against a typical wrong shift (0 = featureless image, or the
   *          motion ran into the edge of the search range).
   *
   * Confidence must NOT be "better than zero shift": at 30 Hz a hand sweep
   * moves ~1 thumbnail px per step, where zero shift is nearly as good as the
   * true one, and such a measure rejects exactly the steps that matter.
   */
  PH.flowShift = function (prev, cur, w, h, opts) {
    opts = opts || {};
    const range = opts.range || Math.max(4, Math.round(w / 8));
    const step = opts.step || 2;
    let best;
    if (opts.predict) {
      // Predicted motion (content moved TO, like the return value): search
      // only a small window around it, every shift, pixel stride 2. A hand
      // sweep is smooth, so this finds it ~3x cheaper than the full search;
      // the caller falls back to a full search when this one isn't sure.
      const rad = opts.radius || 4;
      const cx = Math.round(-opts.predict[0]), cy = Math.round(-opts.predict[1]);
      best = { dx: cx, dy: cy, c: Infinity };
      for (let dy = cy - rad; dy <= cy + rad; dy++) for (let dx = cx - rad; dx <= cx + rad; dx++) {
        if (Math.abs(dx) > range || Math.abs(dy) > range) continue;
        const c = sad(prev, cur, w, h, dx, dy, step);
        if (c < best.c) best = { dx, dy, c };
      }
      // Best on the window's rim: the motion may lie outside it.
      best.rim = Math.abs(best.dx - cx) >= rad || Math.abs(best.dy - cy) >= rad;
    } else {
      // Full search: every 2nd shift on a stride-2 pixel grid.
      best = { dx: 0, dy: 0, c: sad(prev, cur, w, h, 0, 0, step) };
      for (let dy = -range; dy <= range; dy += 2) for (let dx = -range; dx <= range; dx += 2) {
        const c = sad(prev, cur, w, h, dx, dy, step);
        if (c < best.c) best = { dx, dy, c };
      }
    }
    // "Typical wrong shift" cost: 8 shifts half the range away from the best.
    // A fixed probe set, so confidence means the same in both search modes.
    const off = Math.max(2, Math.round(range / 2));
    let sum = 0, cnt = 0;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const c = sad(prev, cur, w, h, best.dx + ox * off, best.dy + oy * off, step);
      if (Number.isFinite(c)) { sum += c; cnt++; }
    }
    const typical = cnt ? sum / cnt : 0;
    const rim = !!best.rim;
    for (let dy = best.dy - 1; dy <= best.dy + 1; dy++) for (let dx = best.dx - 1; dx <= best.dx + 1; dx++) {
      const c = sad(prev, cur, w, h, dx, dy, 1);
      if (c < best.c) best = { dx, dy, c };
    }
    // Sub-pixel: fit a parabola through the three costs along each axis.
    const cx = [sad(prev, cur, w, h, best.dx - 1, best.dy, 1), best.c, sad(prev, cur, w, h, best.dx + 1, best.dy, 1)];
    const cy = [sad(prev, cur, w, h, best.dx, best.dy - 1, 1), best.c, sad(prev, cur, w, h, best.dx, best.dy + 1, 1)];
    const sub = (c) => { const d = c[0] - 2 * c[1] + c[2]; return d > 1e-9 ? PH.clamp ? PH.clamp((c[0] - c[2]) / (2 * d), -0.5, 0.5) : Math.max(-0.5, Math.min(0.5, (c[0] - c[2]) / (2 * d))) : 0; };
    // Coarse costs were on a stride-2 pixel grid, the refined best on every
    // pixel; both are per-pixel means, so they compare. A best shift at the edge
    // of the range means the true motion was probably beyond it.
    const atEdge = rim || Math.abs(best.dx) >= range || Math.abs(best.dy) >= range;
    const conf = typical > 1e-6 && !atEdge ? Math.max(0, Math.min(1, 1 - best.c / typical)) : 0;
    // The search found where prev's content came from relative to cur; report
    // it as where the content MOVED TO (prev -> cur), which is what the page
    // adds to the last analysis result's mark positions.
    return { dx: -(best.dx + sub(cx)), dy: -(best.dy + sub(cy)), conf };
  };

  /**
   * Keyframe tracker: the running image shift (thumbnail px) since it started.
   *
   * Chaining small 30 Hz steps accumulates the sub-pixel bias of each step
   * (~0.1 px a step, i.e. ~10 screen px over a fifth of a second). Instead each
   * frame is matched against a keyframe — the frame the page last handed to the
   * analysis (`mark()`) — so the shift since that frame is ONE measurement.
   * Only when the keyframe is lost (low confidence, or the motion nears the
   * edge of the search range) does it fall back to a single chained step and
   * re-key on the current frame.
   *
   * push(gray) per thumbnail; mark() when a frame is grabbed for analysis;
   * total = [dx, dy] content motion in thumbnail px; speed = smoothed per-push
   * motion (for stillness); steps / lowConf / rekeys for diagnostics.
   */
  PH.FlowTracker = class {
    constructor(w, h, opts) {
      opts = opts || {};
      this.w = w; this.h = h;
      this.range = opts.range || Math.max(4, Math.round(Math.max(w, h) / 6));
      this.stepRange = opts.stepRange || Math.max(4, Math.round(Math.max(w, h) / 8));
      this.minConf = opts.minConf || 0.25;
      this.total = [0, 0];
      this.ref = null; this.refTotal = [0, 0];
      this.prev = null;
      this.speed = 0; this.steps = 0; this.lowConf = 0; this.rekeys = 0;
      this.lastStep = [0, 0]; this.predicted = 0; this.fullSearch = 0;
    }
    reset() { this.ref = this.prev = null; this.speed = 0; this.lastStep = [0, 0]; }
    mark() { if (this.prev) { this.ref = this.prev; this.refTotal = this.total.slice(); } }
    push(cur) {
      if (!this.ref) { this.ref = this.prev = cur; this.refTotal = this.total.slice(); return { moved: false, conf: 0 }; }
      this.steps++;
      const before = this.total.slice();
      // Predict keyframe -> cur from keyframe -> prev plus the last step's motion.
      const pred = [this.total[0] - this.refTotal[0] + this.lastStep[0], this.total[1] - this.refTotal[1] + this.lastStep[1]];
      let r = PH.flowShift(this.ref, cur, this.w, this.h, { range: this.range, predict: pred });
      if (r.conf >= this.minConf) this.predicted++;
      else { r = PH.flowShift(this.ref, cur, this.w, this.h, { range: this.range }); this.fullSearch++; }
      let ok = r.conf >= this.minConf;
      if (ok) {
        this.total = [this.refTotal[0] + r.dx, this.refTotal[1] + r.dy];
        // Re-key before the motion runs out of search range.
        if (Math.max(Math.abs(r.dx), Math.abs(r.dy)) > this.range * 0.6) { this.ref = cur; this.refTotal = this.total.slice(); this.rekeys++; }
      } else {
        r = PH.flowShift(this.prev, cur, this.w, this.h, { range: this.stepRange });
        ok = r.conf >= this.minConf;
        if (ok) { this.total = [this.total[0] + r.dx, this.total[1] + r.dy]; this.ref = cur; this.refTotal = this.total.slice(); this.rekeys++; }
        else this.lowConf++;
      }
      this.lastStep = [this.total[0] - before[0], this.total[1] - before[1]];
      const m = Math.hypot(this.lastStep[0], this.lastStep[1]);
      this.speed = this.speed * 0.6 + m * 0.4;
      this.prev = cur;
      return { moved: m > 0.05, conf: r.conf };
    }
  };
})(typeof self !== 'undefined' ? self : globalThis);
