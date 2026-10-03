/* Synthetic puzzle generator for testing the vision pipeline without a phone.
 * Builds a "box image", cuts it into real jigsaw shapes (tabs/blanks), scatters
 * the pieces on a felt-colored table with random rotations, and records ground
 * truth (grid cell, rotation, edge types, table position). */
'use strict';

function makeRng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxImage(cv, W, H, rnd) {
  const m = new cv.Mat(H, W, cv.CV_8UC4);
  const d = m.data;
  const cc = [0, 1, 2, 3].map(() => [rnd() * 255, rnd() * 255, rnd() * 255]);
  const f1 = 2 + rnd() * 4, f2 = 2 + rnd() * 4;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H, i = (y * W + x) * 4;
    for (let k = 0; k < 3; k++) {
      let c = cc[0][k] * (1 - u) * (1 - v) + cc[1][k] * u * (1 - v) + cc[2][k] * (1 - u) * v + cc[3][k] * u * v;
      c += 40 * Math.sin(u * f1 * 6.28 + k) * Math.cos(v * f2 * 6.28 - k);
      d[i + k] = c;
    }
    d[i + 3] = 255;
  }
  const col = () => new cv.Scalar(rnd() * 255, rnd() * 255, rnd() * 255, 255);
  for (let i = 0; i < 70; i++) cv.circle(m, new cv.Point(rnd() * W, rnd() * H), 5 + rnd() * W * 0.06, col(), -1, cv.LINE_AA);
  for (let i = 0; i < 40; i++) {
    const x = rnd() * W, y = rnd() * H;
    cv.rectangle(m, new cv.Point(x, y), new cv.Point(x + rnd() * W * 0.15, y + rnd() * H * 0.15), col(), -1);
  }
  for (let i = 0; i < 40; i++) cv.line(m, new cv.Point(rnd() * W, rnd() * H), new cv.Point(rnd() * W, rnd() * H), col(), 2 + rnd() * 6, cv.LINE_AA);
  const words = ['PUZZLE', 'HELPER', 'SKY', 'LAKE', 'FOX', 'MAP', 'TOWN'];
  for (let i = 0; i < 25; i++) cv.putText(m, words[(rnd() * words.length) | 0], new cv.Point(rnd() * W, rnd() * H), cv.FONT_HERSHEY_SIMPLEX, 0.6 + rnd() * 1.6, col(), 2 + rnd() * 3);
  // A low-detail "sky" band across the top to exercise the hard case.
  const skyH = Math.round(H * 0.18);
  for (let y = 0; y < skyH; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, t = y / skyH;
    d[i] = 120 + 60 * t; d[i + 1] = 170 + 40 * t; d[i + 2] = 235;
  }
  return m;
}

// Tab curve in edge-local coords: x along the edge (0..len), d perpendicular.
function tabCurve(len, sign, rnd) {
  const cx = 0.42 + rnd() * 0.16, r = 0.1 + rnd() * 0.03, c = r * (0.55 + rnd() * 0.25);
  const beta = Math.asin(c / r), nw = Math.sqrt(r * r - c * c);
  const pts = [];
  const n0 = 10;
  for (let i = 0; i <= n0; i++) pts.push([((cx - nw) * i) / n0, 0]);
  const steps = 40;
  for (let i = 1; i < steps; i++) {
    const th = Math.PI + beta - ((Math.PI + 2 * beta) * i) / steps;
    pts.push([cx + r * Math.cos(th), c + r * Math.sin(th)]);
  }
  for (let i = 0; i <= n0; i++) pts.push([cx + nw + ((1 - cx - nw) * i) / n0, 0]);
  return pts.map(([x, dd]) => [x * len, sign * dd * len]);
}
function straight(len) {
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push([(len * i) / 10, 0]);
  return pts;
}

function makePuzzle(cv, opts) {
  const rnd = makeRng(opts.seed || 7);
  const { cols, rows, cs } = opts;
  const margin = Math.round(cs * 0.5);
  const W = cols * cs, H = rows * cs;
  let big;
  if (opts.image) {
    // Real picture (RGBA Mat): resize to the grid and pad by edge replication.
    const r = new cv.Mat();
    cv.resize(opts.image, r, new cv.Size(W, H), 0, 0, cv.INTER_AREA);
    big = new cv.Mat();
    cv.copyMakeBorder(r, big, margin, margin, margin, margin, cv.BORDER_REPLICATE);
    r.delete();
  } else {
    big = boxImage(cv, W + 2 * margin, H + 2 * margin, rnd);
  }
  // H edges: (rows+1) x cols, V edges: rows x (cols+1). Each: points in box coords (no margin), sign.
  const Hs = [], Vs = [];
  for (let r = 0; r <= rows; r++) {
    Hs.push([]);
    for (let c = 0; c < cols; c++) {
      const sign = r === 0 || r === rows ? 0 : rnd() < 0.5 ? 1 : -1;
      const local = sign ? tabCurve(cs, sign, rnd) : straight(cs);
      Hs[r].push({ sign, pts: local.map(([x, d]) => [c * cs + x, r * cs + d]) });
    }
  }
  for (let r = 0; r < rows; r++) {
    Vs.push([]);
    for (let c = 0; c <= cols; c++) {
      const sign = c === 0 || c === cols ? 0 : rnd() < 0.5 ? 1 : -1;
      const local = sign ? tabCurve(cs, sign, rnd) : straight(cs);
      Vs[r].push({ sign, pts: local.map(([x, d]) => [c * cs + d, r * cs + x]) });
    }
  }
  const pieces = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const top = Hs[r][c], bottom = Hs[r + 1][c], left = Vs[r][c], right = Vs[r][c + 1];
    const poly = [].concat(top.pts, right.pts, bottom.pts.slice().reverse(), left.pts.slice().reverse());
    // d>0 on an H edge points down (into row r); on a V edge points right (into col c).
    const type = (sign, outIsPositive) => (sign === 0 ? 'F' : (sign > 0) === outIsPositive ? 'T' : 'B');
    const code = [type(top.sign, false), type(right.sign, true), type(bottom.sign, true), type(left.sign, false)].join('');
    pieces.push({ r, c, poly, code });
  }
  return { big, margin, W, H, cols, rows, cs, pieces, rnd };
}

// Inner box image (no margin) as RGBA Mat.
function innerBox(cv, P) {
  return P.big.roi(new cv.Rect(P.margin, P.margin, P.W, P.H)).clone();
}

// Phone photo of the box lid: perspective, color shift, blur, on a desk.
function boxPhoto(cv, P) {
  const inner = innerBox(cv, P);
  const PW = Math.round(P.W * 1.25), PH = Math.round(P.H * 1.3);
  const corners = [[PW * 0.08, PH * 0.1], [PW * 0.93, PH * 0.06], [PW * 0.95, PH * 0.92], [PW * 0.05, PH * 0.88]];
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, P.W, 0, P.W, P.H, 0, P.H]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat(...corners));
  const M = cv.getPerspectiveTransform(from, to);
  const photo = new cv.Mat();
  cv.warpPerspective(inner, photo, M, new cv.Size(PW, PH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(200, 190, 170, 255));
  const d = photo.data;
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = d[i + k] * 1.06 - 4;
  cv.GaussianBlur(photo, photo, new cv.Size(3, 3), 0);
  [inner, from, to, M].forEach((m) => m.delete());
  return { mat: photo, corners };
}

/**
 * Scatter pieces on a table. Returns RGBA Mat + ground truth per piece:
 * {x,y} table position of the piece's core center, rot (radians).
 */
function scatter(cv, P, opts) {
  const rnd = makeRng(opts.seed || 11);
  const k = opts.scale; // box px -> table px
  const core = P.cs * k;
  const spacing = core * (opts.spacing || 1.85);
  const order = (opts.subset || P.pieces.map((p, i) => i)).slice().sort(() => rnd() - 0.5);
  const perRow = opts.perRow || Math.ceil(Math.sqrt(order.length * 1.5));
  const TW = Math.ceil(perRow * spacing + spacing), TH = Math.ceil(Math.ceil(order.length / perRow) * spacing + spacing);
  const table = new cv.Mat(TH, TW, cv.CV_8UC4);
  const td = table.data;
  const felt = opts.felt || [38, 92, 60];
  for (let i = 0; i < td.length; i += 4) {
    const n = (rnd() - 0.5) * 10;
    td[i] = felt[0] + n; td[i + 1] = felt[1] + n; td[i + 2] = felt[2] + n; td[i + 3] = 255;
  }
  const gt = [];
  const ext = Math.ceil(P.cs * 0.35);
  order.forEach((pi, slot) => {
    const p = P.pieces[pi];
    const gx = (slot % perRow) + 1, gy = Math.floor(slot / perRow) + 1;
    const cx = gx * spacing + (rnd() - 0.5) * spacing * 0.2, cy = gy * spacing + (rnd() - 0.5) * spacing * 0.2;
    const rot = opts.noRotate ? 0 : rnd() * Math.PI * 2;
    // crop from the padded box image
    const bx = P.margin + p.c * P.cs - ext, by = P.margin + p.r * P.cs - ext, bs = P.cs + 2 * ext;
    const crop = P.big.roi(new cv.Rect(bx, by, bs, bs)).clone();
    const mask = cv.Mat.zeros(bs, bs, cv.CV_8UC1);
    const flat = [];
    for (const [x, y] of p.poly) flat.push(Math.round(x + P.margin - bx), Math.round(y + P.margin - by));
    const pm = cv.matFromArray(flat.length / 2, 1, cv.CV_32SC2, flat);
    const mv = new cv.MatVector(); mv.push_back(pm);
    cv.fillPoly(mask, mv, new cv.Scalar(255), cv.LINE_AA);
    // rotate+scale around the core center into a patch
    const PS = Math.ceil(bs * k * 1.5);
    const ccx = ext + P.cs / 2, ccy = ext + P.cs / 2;
    const cos = Math.cos(rot) * k, sin = Math.sin(rot) * k;
    const M = cv.matFromArray(2, 3, cv.CV_64F, [cos, -sin, PS / 2 - (cos * ccx - sin * ccy), sin, cos, PS / 2 - (sin * ccx + cos * ccy)]);
    const pc = new cv.Mat(), pmk = new cv.Mat();
    cv.warpAffine(crop, pc, M, new cv.Size(PS, PS), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
    cv.warpAffine(mask, pmk, M, new cv.Size(PS, PS), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
    const ox = Math.round(cx - PS / 2), oy = Math.round(cy - PS / 2);
    const gain = opts.gain || 0.93, off = opts.offset || 8;
    for (let y = 0; y < PS; y++) for (let x = 0; x < PS; x++) {
      const a = pmk.data[y * PS + x] / 255;
      if (!a) continue;
      const tx = ox + x, ty = oy + y;
      if (tx < 0 || ty < 0 || tx >= TW || ty >= TH) continue;
      const ti = (ty * TW + tx) * 4, si = (y * PS + x) * 4;
      // The user is told to pick a cloth unlike the puzzle; mimic that by keeping
      // piece colors at least `minSep` (RGB distance) away from the felt.
      let r = pc.data[si] * gain + off, g = pc.data[si + 1] * gain + off, b = pc.data[si + 2] * gain + off;
      const dr = r - felt[0], dg = g - felt[1], db = b - felt[2], dd = Math.hypot(dr, dg, db), minSep = opts.minSep === undefined ? 70 : opts.minSep;
      if (dd < minSep) {
        const k2 = dd > 1 ? minSep / dd : 0;
        if (k2) { r = felt[0] + dr * k2; g = felt[1] + dg * k2; b = felt[2] + db * k2; } else { r = felt[0] + minSep; g = felt[1]; b = felt[2]; }
      }
      td[ti] = td[ti] * (1 - a) + r * a; td[ti + 1] = td[ti + 1] * (1 - a) + g * a; td[ti + 2] = td[ti + 2] * (1 - a) + b * a;
    }
    gt.push({ r: p.r, c: p.c, code: p.code, x: cx, y: cy, rot });
    [crop, mask, pm, mv, M, pc, pmk].forEach((m) => m.delete());
  });
  cv.GaussianBlur(table, table, new cv.Size(3, 3), 0);
  return { table, gt, TW, TH, core };
}

// Camera view of the table: similarity warp to a W x H frame.
// Frame pixel (u,v) shows table point center + R(phi) * ((u,v) - frameCenter) / zoom.
function cameraFrame(cv, table, cx, cy, phi, zoom, W, H, feltRGB) {
  const c = Math.cos(phi) / zoom, s = Math.sin(phi) / zoom;
  // inverse map: table = A * frame + b
  const A = cv.matFromArray(2, 3, cv.CV_64F, [c, -s, cx - (c * W / 2 - s * H / 2), s, c, cy - (s * W / 2 + c * H / 2)]);
  const out = new cv.Mat();
  const f = feltRGB || [38, 92, 60];
  cv.warpAffine(table, out, A, new cv.Size(W, H), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_CONSTANT, new cv.Scalar(f[0], f[1], f[2], 255));
  A.delete();
  return out;
}

// View of the table from a TILTED phone. The camera sits above table point
// (cx, cy); `zoom` is the top-down scale (frame px per table px when looking
// straight down); pitch/roll (degrees) tilt it. Returns {mat, down} where
// `down` is gravity in camera coords (X right, Y down, Z forward), i.e. what
// the phone's sensor would report.
function tiltedFrame(cv, table, cx, cy, zoom, W, H, pitchDeg, rollDeg, fovDeg, feltRGB) {
  const f = Math.max(W, H) / 2 / Math.tan((fovDeg * Math.PI) / 360);
  const p = (pitchDeg * Math.PI) / 180, r = (rollDeg * Math.PI) / 180;
  const Rx = [1, 0, 0, 0, Math.cos(p), -Math.sin(p), 0, Math.sin(p), Math.cos(p)];
  const Ry = [Math.cos(r), 0, Math.sin(r), 0, 1, 0, -Math.sin(r), 0, Math.cos(r)];
  const mul = (A, B) => { const C = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C.push(A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j]); return C; };
  const Rc = mul(Rx, Ry); // tilted-camera ray -> straight-down-camera ray
  const Kti = [1 / f, 0, -W / 2 / f, 0, 1 / f, -H / 2 / f, 0, 0, 1];
  const Kd = [f, 0, 0, 0, f, 0, 0, 0, 1];
  // Aim like a person would: the optical axis hits the table at (cx, cy).
  const ax = Rc[2], ay = Rc[5], az = Rc[8];
  const A = [1 / zoom, 0, cx - (f * ax) / az / zoom, 0, 1 / zoom, cy - (f * ay) / az / zoom, 0, 0, 1]; // down-view px (centered) -> table px
  const M = mul(A, mul(Kd, mul(Rc, Kti)));
  const m = cv.matFromArray(3, 3, cv.CV_64F, M);
  const out = new cv.Mat();
  const fe = feltRGB || [38, 92, 60];
  cv.warpPerspective(table, out, m, new cv.Size(W, H), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_CONSTANT, new cv.Scalar(fe[0], fe[1], fe[2], 255));
  m.delete();
  // gravity (down-camera +Z) expressed in tilted-camera coords = Rc^T * (0,0,1)
  return { mat: out, down: [Rc[6], Rc[7], Rc[8]] };
}

// Engine "source" wrapping an RGBA Mat.
function matSource(cv, mat) {
  return {
    w: mat.cols, h: mat.rows,
    getProc(maxW) {
      const scale = Math.min(1, maxW / Math.max(mat.cols, mat.rows));
      const o = new cv.Mat();
      cv.resize(mat, o, new cv.Size(Math.round(mat.cols * scale), Math.round(mat.rows * scale)), 0, 0, cv.INTER_AREA);
      const r = { w: o.cols, h: o.rows, data: new Uint8ClampedArray(o.data), scale };
      o.delete();
      return r;
    },
    getCrop(x, y, w, h) {
      const r = mat.roi(new cv.Rect(x, y, w, h)).clone();
      const o = { w, h, data: new Uint8ClampedArray(r.data) };
      r.delete();
      return o;
    },
  };
}

module.exports = { makeRng, makePuzzle, innerBox, boxPhoto, scatter, cameraFrame, tiltedFrame, matSource };
