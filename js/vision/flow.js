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
   * @returns {dx, dy, conf} — conf in 0..1: how much better the best shift is than
   *          zero shift (0 = the image is featureless or the motion is beyond range).
   */
  PH.flowShift = function (prev, cur, w, h, opts) {
    opts = opts || {};
    const range = opts.range || Math.max(4, Math.round(w / 8));
    const step = opts.step || 2;
    // Coarse: every 2nd shift on a stride-2 grid, then fine around the best.
    let best = { dx: 0, dy: 0, c: sad(prev, cur, w, h, 0, 0, step) };
    const c0 = best.c;
    for (let dy = -range; dy <= range; dy += 2) for (let dx = -range; dx <= range; dx += 2) {
      const c = sad(prev, cur, w, h, dx, dy, step);
      if (c < best.c) best = { dx, dy, c };
    }
    for (let dy = best.dy - 1; dy <= best.dy + 1; dy++) for (let dx = best.dx - 1; dx <= best.dx + 1; dx++) {
      const c = sad(prev, cur, w, h, dx, dy, 1);
      if (c < best.c) best = { dx, dy, c };
    }
    // Sub-pixel: fit a parabola through the three costs along each axis.
    const cx = [sad(prev, cur, w, h, best.dx - 1, best.dy, 1), best.c, sad(prev, cur, w, h, best.dx + 1, best.dy, 1)];
    const cy = [sad(prev, cur, w, h, best.dx, best.dy - 1, 1), best.c, sad(prev, cur, w, h, best.dx, best.dy + 1, 1)];
    const sub = (c) => { const d = c[0] - 2 * c[1] + c[2]; return d > 1e-9 ? PH.clamp ? PH.clamp((c[0] - c[2]) / (2 * d), -0.5, 0.5) : Math.max(-0.5, Math.min(0.5, (c[0] - c[2]) / (2 * d))) : 0; };
    const conf = c0 > 1e-6 ? Math.max(0, Math.min(1, 1 - best.c / c0)) : 0;
    // The search found where prev's content came from relative to cur; report
    // it as where the content MOVED TO (prev -> cur), which is what the page
    // adds to the last analysis result's mark positions.
    return { dx: -(best.dx + sub(cx)), dy: -(best.dy + sub(cy)), conf };
  };
})(typeof self !== 'undefined' ? self : globalThis);
