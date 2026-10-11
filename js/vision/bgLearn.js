/* Learned background (PLAN-auto-background.md, step 1): the app learns what
 * THIS table looks like from what it is already sure of - the inside of
 * cut-outs that read as clean jigsaw pieces ("piece") and a ring of table
 * just outside them ("background") - and then tells piece from table pixel
 * by pixel. More than colour: wood grain runs one way (texture direction),
 * glass reflections are soft (sharpness), print has fine detail.
 *
 * Model: two lookup tables of log-odds (naive Bayes), colour (16^3 Lab bins)
 * and texture (energy 8 x direction 4 x sharpness 4); training is counting,
 * use is two lookups a pixel. {kind:'learned', lc, lt, bias} goes into
 * PH.segment as a background model (opts.bgModel), like the outline model.
 */
(function (G) {
  'use strict';
  const PH = (G.PH = G.PH || {});

  PH.BGL_SURE = 0.05; // pieceScore of a cut-out whose pixels teach (real pieces ~0.05-0.3)
  PH.BGL_MIN = 3000; // samples per class before a model is made
  PH.BGL_CAP = 60000; // counts per class kept (older ones fade by halving)
  PH.BGL_BIAS = 1; // log-odds above which a pixel is "piece"
  PH.BGL_ALPHA = 1; // add-alpha smoothing of the count tables
  PH.BGL_LSHIFT = 5; // lightness bin size (2^n of 256): coarser = less fooled by light and shadow
  PH.BGL_LIVE = true; // teach and offer the learned background while scanning (Engine.teachBg)
  PH.BGL_EVERY = 15; // ... from every n-th steady frame
  // A photo's own learned model is used when it scores this much better.
  // Off (Infinity): on the labelled lamp-lit photos it read 16 of 21 pieces
  // instead of 20 (one photo's lamp shadows taught as table), even at 1.3.
  PH.BGL_SNAP_WIN = Infinity;
  PH.BGL_CW = 1; // weight of the colour evidence against the texture evidence

  /** Per-pixel feature bins of a Lab image (8-bit, as PH.rgbaToLab):
   *  cbin 0..4095 (colour), tbin 0..127 (texture). Filtering in WebAssembly
   *  (OpenCV), binning in one JS pass. `planes` ({L,...} Mats) optional. */
  PH.bgFeatures = function (lab, w, h, planes) {
    const cv = PH.cv, n = w * h;
    const own = planes ? null : PH.labPlanes(lab, w, h), Lm = (planes || own).L;
    const Lf = new cv.Mat(), gx = new cv.Mat(), gy = new cv.Mat(), xx = new cv.Mat(), yy = new cv.Mat(), xy = new cv.Mat(), mu = new cv.Mat(), hp = new cv.Mat();
    Lm.convertTo(Lf, cv.CV_32F);
    cv.Sobel(Lf, gx, cv.CV_32F, 1, 0, 1); cv.Sobel(Lf, gy, cv.CV_32F, 0, 1, 1); // central differences
    cv.multiply(gx, gx, xx); cv.multiply(gy, gy, yy); cv.multiply(gx, gy, xy);
    const k7 = new cv.Size(7, 7), k5 = new cv.Size(5, 5);
    cv.blur(xx, xx, k7); cv.blur(yy, yy, k7); cv.blur(xy, xy, k7);
    cv.blur(Lf, mu, k5); cv.absdiff(Lf, mu, hp); cv.blur(hp, hp, k5);
    const sxx = xx.data32F, syy = yy.data32F, sxy = xy.data32F, sh = hp.data32F;
    const cbin = new Uint16Array(n), tbin = new Uint8Array(n), LS = PH.BGL_LSHIFT;
    for (let i = 0; i < n; i++) {
      cbin[i] = ((lab[3 * i] >> LS) << 8) | ((lab[3 * i + 1] >> 4) << 4) | (lab[3 * i + 2] >> 4);
      const a = sxx[i], b = syy[i], E = a + b;
      const e = Math.min(7, Math.floor(Math.log2(1 + E) * 0.5));
      const c = E > 4 ? Math.min(3, Math.floor((Math.sqrt((a - b) * (a - b) + 4 * sxy[i] * sxy[i]) / E) * 4)) : 0;
      const t = Math.min(3, Math.floor(Math.log2(1 + sh[i]) * 0.75));
      tbin[i] = (e << 4) | (c << 2) | t;
    }
    [Lf, gx, gy, xx, yy, xy, mu, hp].forEach((m) => m.delete());
    if (own) own.delete();
    return { w, h, cbin, tbin };
  };

  /** Teaching labels for one segmented image: 1 = piece (inside clean
   *  cut-outs, a little in from the outline), 2 = background (a ring of table
   *  around them, clear of every other cut-out), 0 = not used. */
  PH.bgLearnLabels = function (dets, w, h, unitArea) {
    const cv = PH.cv;
    const shaped = dets.filter((d) => !d.border && d.pts && d.pts.length >= 8);
    const scores = shaped.map((d) => PH.pieceScore(d.pts, d.area));
    const sure = shaped.filter((d, i) => scores[i] >= PH.BGL_SURE);
    const unit = unitArea || (sure.length ? PH.median(sure.map((d) => d.area)) : 0);
    const good = sure.filter((d) => unit && d.area > unit * 0.5 && d.area < unit * 2);
    if (!good.length) return null;
    const side = Math.sqrt(unit), odd = (v) => 2 * Math.max(1, Math.round(v)) + 1;
    const draw = (list) => {
      const m = cv.Mat.zeros(h, w, cv.CV_8UC1), mv = new cv.MatVector();
      for (const d of list) mv.push_back(cv.matFromArray(d.pts.length / 2, 1, cv.CV_32SC2, Array.from(d.pts)));
      cv.drawContours(m, mv, -1, new cv.Scalar(255), -1);
      for (let i = 0; i < mv.size(); i++) mv.get(i).delete();
      mv.delete();
      return m;
    };
    const gm = draw(good), am = draw(dets.filter((d) => d.pts));
    const k1 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(odd(side * 0.06), odd(side * 0.06)));
    const k2 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(odd(side * 0.1), odd(side * 0.1)));
    const k3 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(odd(side * 0.35), odd(side * 0.35)));
    const inner = new cv.Mat(), near = new cv.Mat(), outer = new cv.Mat();
    cv.erode(gm, inner, k1);
    cv.dilate(am, near, k2);
    cv.dilate(gm, outer, k3);
    const lab = new Uint8Array(w * h), I = inner.data, N = near.data, O = outer.data;
    let nf = 0, nb = 0;
    for (let i = 0; i < w * h; i++) {
      if (I[i]) { lab[i] = 1; nf++; } else if (O[i] && !N[i]) { lab[i] = 2; nb++; }
    }
    [gm, am, k1, k2, k3, inner, near, outer].forEach((m) => m.delete());
    return { labels: lab, nf, nb, pieces: good.length, unit };
  };

  /** Counts piece/background examples over time; makes the model. */
  class BgLearner {
    constructor() { this.reset(); }
    reset() {
      this.cf = new Float32Array(4096); this.cb = new Float32Array(4096);
      this.tf = new Float32Array(128); this.tb = new Float32Array(128);
      this.nf = 0; this.nb = 0; this.batches = 0; this.version = 0;
    }
    /** Add one image's labelled pixels (every `step`-th pixel). */
    add(feat, labels, step) {
      step = step || 2;
      const { cbin, tbin } = feat;
      for (let i = 0; i < labels.length; i += step) {
        const l = labels[i];
        if (l === 1) { this.cf[cbin[i]]++; this.tf[tbin[i]]++; this.nf++; } else if (l === 2) { this.cb[cbin[i]]++; this.tb[tbin[i]]++; this.nb++; }
      }
      // old light fades: halve a class's counts once it passes the cap
      if (this.nf > PH.BGL_CAP) { for (let i = 0; i < 4096; i++) this.cf[i] /= 2; for (let i = 0; i < 128; i++) this.tf[i] /= 2; this.nf /= 2; }
      if (this.nb > PH.BGL_CAP) { for (let i = 0; i < 4096; i++) this.cb[i] /= 2; for (let i = 0; i < 128; i++) this.tb[i] /= 2; this.nb /= 2; }
      this.batches++;
    }
    ready() { return this.nf >= PH.BGL_MIN && this.nb >= PH.BGL_MIN; }
    /** {kind:'learned', lc, lt, bias} or null before enough examples. */
    model() {
      if (!this.ready()) return null;
      const lc = logOdds(smooth3(this.cf), smooth3(this.cb), 4096), lt = logOdds(this.tf, this.tb, 128);
      return { kind: 'learned', lc, lt, bias: PH.BGL_BIAS, n: [Math.round(this.nf), Math.round(this.nb)], v: ++this.version };
    }
    toJSON() { return { cf: Array.from(this.cf, (v) => Math.round(v)), cb: Array.from(this.cb, (v) => Math.round(v)), tf: Array.from(this.tf), tb: Array.from(this.tb), nf: this.nf, nb: this.nb }; }
    static fromJSON(o) {
      const L = new BgLearner();
      if (o && o.cf && o.cf.length === 4096) { L.cf.set(o.cf); L.cb.set(o.cb); L.tf.set(o.tf); L.tb.set(o.tb); L.nf = o.nf; L.nb = o.nb; }
      return L;
    }
  }
  PH.BgLearner = BgLearner;

  // [1,2,1] smoothing along each axis of the 16^3 colour table (neighbouring
  // shades share evidence: few samples per bin otherwise)
  function smooth3(c) {
    let a = c;
    for (const st of [1, 16, 256]) {
      const o = new Float32Array(4096);
      for (let i = 0; i < 4096; i++) {
        const k = Math.floor(i / st) % 16;
        o[i] = 2 * a[i] + (k > 0 ? a[i - st] : a[i]) + (k < 15 ? a[i + st] : a[i]);
      }
      a = o;
    }
    for (let i = 0; i < 4096; i++) a[i] /= 64;
    return a;
  }
  function logOdds(f, b, n) {
    let sf = 0, sb = 0;
    for (let i = 0; i < n; i++) { sf += f[i]; sb += b[i]; }
    const A = PH.BGL_ALPHA, out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.log((f[i] + A) / (sf + A * n)) - Math.log((b[i] + A) / (sb + A * n));
    return out;
  }

  /** Foreground mask (0/255) of a Lab image under a learned model: summed
   *  log-odds, averaged over 3x3 (fewer specks), above the model's bias. */
  PH.learnedMask = function (lab, w, h, model, feat, planes) {
    const cv = PH.cv;
    feat = feat || PH.bgFeatures(lab, w, h, planes);
    const n = w * h, { cbin, tbin } = feat, lc = model.lc, lt = model.lt, cw = PH.BGL_CW;
    const sm = new cv.Mat(h, w, cv.CV_32F), s = sm.data32F;
    for (let i = 0; i < n; i++) s[i] = cw * lc[cbin[i]] + lt[tbin[i]];
    cv.blur(sm, sm, new cv.Size(3, 3));
    const m = sm.data32F, out = new Uint8Array(n), bias = model.bias || 0;
    for (let i = 0; i < n; i++) out[i] = m[i] > bias ? 255 : 0;
    sm.delete();
    return out;
  };
})(typeof self !== 'undefined' ? self : globalThis);
