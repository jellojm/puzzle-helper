/* The finished border of the puzzle as its real location on the table.
 *
 * The owner marks the border once: a still camera view with its 4 outer
 * corners tapped, corner 1 being the box picture's top-left. That gives a
 * homography from box-grid coordinates (cells: x 0..cols, y 0..rows) to that
 * view. Matching the box ART against the table doesn't work (print vs. real
 * pieces under glass and glare: ORB found 6-21 consistent matches out of
 * thousands on the owner's video), but two camera views of the SAME table
 * match easily (hundreds of consistent ORB matches across 2 s of panning). So
 * the marked view's ORB features are kept, and every later view is matched
 * against them: box -> marked view -> this view. That puts every box cell on
 * the live camera image, so a piece's "where it goes" can be shown at its
 * real spot inside the frame.
 *
 * Works in whatever image the engine analyses (the straightened view with
 * tilt correction): any two views of the flat table are related by a
 * homography either way. */
(function (G) {
  const PH = G.PH;

  const MAX_FEATURES = 1200;
  const MIN_INLIERS = 25;

  function gray(cv, img) {
    const m = new cv.Mat(img.h, img.w, cv.CV_8UC4);
    m.data.set(img.data);
    const g = new cv.Mat();
    cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY);
    m.delete();
    return g;
  }

  // 3x3 homography helpers (row-major arrays of 9).
  function mul(A, B) {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[3 * r + c] = A[3 * r] * B[c] + A[3 * r + 1] * B[3 + c] + A[3 * r + 2] * B[6 + c];
    return C;
  }
  function apply(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }
  PH.homMul = mul;

  /** Homography taking the 4 points `src` to the 4 points `dst` ([[x,y]x4]). */
  PH.quadHomography = function (src, dst) {
    const cv = PH.cv;
    const a = cv.matFromArray(4, 1, cv.CV_32FC2, src.flat());
    const b = cv.matFromArray(4, 1, cv.CV_32FC2, dst.flat());
    const M = cv.getPerspectiveTransform(a, b);
    const H = Array.from(M.data64F);
    a.delete(); b.delete(); M.delete();
    return H;
  };

  /** ORB keypoints + descriptors of an RGBA image ({w,h,data}), optionally
   *  only inside polygon `poly` (a mask: features on the puzzle, not legs). */
  PH.orbFeatures = function (img, poly) {
    const cv = PH.cv;
    const g = gray(cv, img);
    let mask = new cv.Mat();
    if (poly) {
      mask = new cv.Mat(img.h, img.w, cv.CV_8U, new cv.Scalar(0));
      const pts = cv.matFromArray(poly.length, 1, cv.CV_32SC2, poly.flat().map(Math.round));
      const v = new cv.MatVector(); v.push_back(pts);
      cv.fillPoly(mask, v, new cv.Scalar(255));
      v.delete(); pts.delete();
    }
    const orb = new cv.ORB(MAX_FEATURES);
    const kp = new cv.KeyPointVector(), desc = new cv.Mat();
    orb.detectAndCompute(g, mask, kp, desc);
    const n = kp.size(), xy = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) { const p = kp.get(i).pt; xy[2 * i] = p.x; xy[2 * i + 1] = p.y; }
    const out = { n, xy, desc: new Uint8Array(desc.data), cols: desc.cols };
    g.delete(); mask.delete(); orb.delete(); kp.delete(); desc.delete();
    return out;
  };

  /** Homography taking feature set A's image to B's, or null. */
  PH.matchViews = function (A, B) {
    const cv = PH.cv;
    if (A.n < 8 || B.n < 8) return null;
    const da = cv.matFromArray(A.n, A.cols, cv.CV_8U, Array.from(A.desc));
    const db = cv.matFromArray(B.n, B.cols, cv.CV_8U, Array.from(B.desc));
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false), mm = new cv.DMatchVectorVector();
    bf.knnMatch(da, db, mm, 2);
    const s = [], d = [];
    for (let i = 0; i < mm.size(); i++) {
      const v = mm.get(i);
      if (v.size() < 2) continue;
      const a = v.get(0), b = v.get(1);
      if (a.distance < 0.75 * b.distance) {
        s.push(A.xy[2 * a.queryIdx], A.xy[2 * a.queryIdx + 1]);
        d.push(B.xy[2 * a.trainIdx], B.xy[2 * a.trainIdx + 1]);
      }
    }
    da.delete(); db.delete(); bf.delete(); mm.delete();
    const good = s.length / 2;
    if (good < MIN_INLIERS) return { H: null, good, inliers: 0 };
    const sm = cv.matFromArray(good, 1, cv.CV_32FC2, s), dm = cv.matFromArray(good, 1, cv.CV_32FC2, d);
    const mask = new cv.Mat();
    const Hm = cv.findHomography(sm, dm, cv.RANSAC, 4, mask);
    let inl = 0;
    for (let i = 0; i < mask.rows; i++) inl += mask.data[i] ? 1 : 0;
    const H = Hm.empty() ? null : Array.from(Hm.data64F);
    sm.delete(); dm.delete(); mask.delete(); Hm.delete();
    return { H: H && inl >= MIN_INLIERS ? H : null, good, inliers: inl };
  };

  /**
   * The marked border. `img` = the analysed view (RGBA {w,h,data}) the
   * corners were tapped on; `corners` = its 4 outer corners in that image,
   * clockwise from the box picture's top-left; cols/rows = the box grid.
   */
  PH.PuzzleFrame = class {
    constructor(img, corners, cols, rows) {
      this.cols = cols; this.rows = rows;
      this.w = img.w; this.h = img.h;
      this.corners = corners.map((p) => p.slice());
      this.Hbox = PH.quadHomography([[0, 0], [cols, 0], [cols, rows], [0, rows]], this.corners); // box cells -> marked view
      // features on the puzzle and a margin around it (the loose pieces right
      // next to it are as good as landmarks as the border itself)
      const c = this.corners, cx = c.reduce((s, p) => s + p[0], 0) / 4, cy = c.reduce((s, p) => s + p[1], 0) / 4;
      const poly = c.map(([x, y]) => [cx + (x - cx) * 1.15, cy + (y - cy) * 1.15]);
      this.feat = PH.orbFeatures(img, poly);
    }
    /** Locate the puzzle in view `img`: box cells -> img homography, or null. */
    locate(img) {
      const B = PH.orbFeatures(img);
      const m = PH.matchViews(this.feat, B);
      this.lastMatch = m && { good: m.good, inliers: m.inliers };
      if (!m || !m.H) return null;
      return { H: mul(m.H, this.Hbox), inliers: m.inliers };
    }
    /** Box cell (col,row) -> its 4 corners in an image with homography H. */
    static cellQuad(H, col, row, w, h) {
      w = w || 1; h = h || 1;
      return [[col, row], [col + w, row], [col + w, row + h], [col, row + h]].map(([x, y]) => apply(H, x, y));
    }
    toJSON() {
      return { cols: this.cols, rows: this.rows, w: this.w, h: this.h, corners: this.corners, Hbox: this.Hbox, feat: this.feat };
    }
    static fromJSON(o) {
      const f = Object.create(PH.PuzzleFrame.prototype);
      Object.assign(f, o);
      f.feat = Object.assign({}, o.feat, { xy: new Float32Array(o.feat.xy), desc: new Uint8Array(o.feat.desc) });
      return f;
    }
  };
  PH.applyHom = apply;
})(typeof self !== 'undefined' ? self : globalThis);
