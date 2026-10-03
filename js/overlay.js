// Drawing on the camera overlay, plus small canvas helpers for thumbnails.

export const EDGE_COLORS = ['#ff6b6b', '#4dd0e1', '#ffd54f', '#b388ff'];
const STATUS = {
  unknown: { stroke: 'rgba(255,255,255,0.45)', dash: [4, 4] },
  seen: { stroke: '#aab2bb', dash: [] },
  shaped: { stroke: '#4f9dff', dash: [] },
  placed: { stroke: '#3ddc84', dash: [] },
  done: { stroke: 'rgba(160,170,180,0.35)', dash: [2, 4] }, // marked as in the puzzle
  merged: { stroke: '#ff9f43', dash: [6, 4] },
  section: { stroke: '#c084fc', dash: [] },
};
const ROLE = {
  sel: { color: '#ffffff', width: 5 },
  gold: { color: '#ffcc00', width: 5 },
  silver: { color: '#c9ced6', width: 3 },
  region: { color: '#ff4fd8', width: 4 },
  section: { color: '#c084fc', width: 5 },
  border: { color: '#35e0d8', width: 4 },  // edge pieces (one straight side)
  corner: { color: '#ff8c3a', width: 5 },  // corner pieces (two straight sides)
  find: { color: '#ff4fd8', width: 4 },    // whatever else the filter bar asked for
};

// Map processing-frame coordinates to CSS pixels of the overlay, matching the
// video's object-fit: cover crop.
function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w, w];
}
// Processing coordinates -> CSS pixels on screen (and back). With tilt
// correction the processing image is a straightened view, so points go
// through the homography back to the real camera frame first.
//
// `shift` = how far the camera image has moved (camera-frame pixels) since the
// frame `res` was analysed, as measured by the thumbnail tracker
// (js/vision/flow.js). It is a translation of the camera image, so it is
// applied exactly in screen space after the mapping — for the tilted path too.
// toVideo maps to the LIVE video and is deliberately not shifted.
export function frameMapping(video, canvas, res, shift) {
  const vw = res.frameW, vh = res.frameH;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const s = Math.max(cw / vw, ch / vh);
  const k = s / res.scale; // proc px -> css px (no tilt)
  const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
  const sx = shift ? shift.dx * s : 0, sy = shift ? shift.dy * s : 0;
  const R = res.rect;
  if (!R) {
    return {
      k, ox, oy, cw, ch, shiftX: sx, shiftY: sy,
      toVideo: (x, y) => [(x - ox) / s, (y - oy) / s], // screen -> camera frame pixel
      toScreen: (x, y) => [x * k + ox + sx, y * k + oy + sy],
      toFrame: (x, y) => [(x - sx - ox) / k, (y - sy - oy) / k],
    };
  }
  return {
    k, ox, oy, cw, ch, shiftX: sx, shiftY: sy,
    toVideo: (x, y) => [(x - ox) / s, (y - oy) / s],
    toScreen: (x, y) => {
      const p = applyH(R.Hinv, x / res.scale, y / res.scale);
      if (p[2] <= 0) return [NaN, NaN];
      return [p[0] * s + ox + sx, p[1] * s + oy + sy];
    },
    toFrame: (x, y) => {
      const p = applyH(R.H, (x - sx - ox) / s, (y - sy - oy) / s);
      return [p[0] * res.scale, p[1] * res.scale];
    },
  };
}

export function sizeCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function pathFor(ctx, pts, M) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    const [x, y] = M.toScreen(pts[i], pts[i + 1]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// Screen radius of a marker for a detection (proc px -> css px).
function markRadius(d, M) {
  return Math.max(4, Math.min(28, (d.r || 10) * M.k * 0.6));
}

export function drawOverlay(ctx, res, M, opts) {
  ctx.clearRect(0, 0, M.cw, M.ch);
  if (!res) return;
  const t = performance.now() / 1000;
  const byId = new Map();
  const marks = opts.marks !== false; // fast dots by default; outlines are opt-in
  ctx.lineJoin = 'round';
  // Marker mode costs one coordinate transform per piece instead of one per
  // outline point (and with tilt correction each of those is a homography),
  // which is most of what makes the overlay feel heavy on a phone.
  for (const d of res.dets) {
    if (d.id) byId.set(d.id, d);
    const st = STATUS[d.status] || STATUS.unknown;
    ctx.globalAlpha = d.border ? 0.5 : 0.9;
    if (marks) {
      const [x, y] = M.toScreen(d.cx, d.cy);
      if (!(x >= -40 && y >= -40 && x <= M.cw + 40 && y <= M.ch + 40)) continue;
      const r = markRadius(d, M);
      ctx.beginPath();
      ctx.arc(x, y, d.status === 'unknown' ? 3 : r * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = st.stroke;
      ctx.fill();
      continue;
    }
    pathFor(ctx, d.pts, M);
    ctx.setLineDash(st.dash);
    ctx.lineWidth = 2;
    ctx.strokeStyle = st.stroke;
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Auto-flagged pairs (mutual best matches) in scan mode.
  if (opts.mode === 'scan') {
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255, 204, 0, 0.85)';
    for (const l of res.links) {
      const [x1, y1] = M.toScreen(l.x1, l.y1), [x2, y2] = M.toScreen(l.x2, l.y2);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  if (res.pframe && res.pframe.visible) drawPuzzleFrame(ctx, res.pframe, M, t);

  // Highlights: on-screen ring, off-screen arrows at the edge.
  // No ctx.shadowBlur anywhere — it is re-rasterised per shape and is by far
  // the most expensive thing a 2D canvas can do on a phone. A translucent
  // wide ring under a bright thin one reads the same and costs nothing.
  const pulse = 0.6 + 0.4 * Math.sin(t * 5);
  for (const h of res.highlights) {
    const style = ROLE[h.role];
    const d = byId.get(h.id);
    if (h.visible && d) {
      if (marks) {
        const [x, y] = M.toScreen(d.cx, d.cy);
        const r = markRadius(d, M);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.globalAlpha = h.role === 'sel' ? 0.3 : 0.18 + 0.16 * pulse;
        ctx.fillStyle = style.color;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = style.width * 0.7;
        ctx.strokeStyle = style.color;
        ctx.stroke();
      } else {
        pathFor(ctx, d.pts, M);
        if (h.role === 'region' || h.role === 'find') { ctx.fillStyle = 'rgba(255, 79, 216, 0.22)'; ctx.fill(); }
        else if (h.role === 'border') { ctx.fillStyle = 'rgba(53, 224, 216, 0.20)'; ctx.fill(); }
        else if (h.role === 'corner') { ctx.fillStyle = 'rgba(255, 140, 58, 0.28)'; ctx.fill(); }
        ctx.globalAlpha = h.role === 'sel' ? 1 : 0.55 + 0.45 * pulse;
        ctx.lineWidth = style.width;
        ctx.strokeStyle = style.color;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (h.role === 'gold' || h.role === 'silver') {
        const [x, y] = M.toScreen(d.cx, d.cy);
        badge(ctx, x, y, h.role === 'gold' ? '★' : '·', style.color, EDGE_COLORS[h.edge]);
      }
      if (h.role === 'sel' && h.up) upArrow(ctx, M.toScreen(d.cx, d.cy), M.toScreen(h.up[0], h.up[1]));
    } else if (!h.visible) {
      arrow(ctx, M, h, style.color);
    }
  }
  ctx.globalAlpha = 1;
}

// The marked border (js/vision/frame.js) located in this view: its outline,
// and the selected piece's spot inside it (an arrow at the edge if off screen).
function drawPuzzleFrame(ctx, F, M, t) {
  const quadPath = (q) => {
    ctx.beginPath();
    q.forEach(([x, y], i) => { const [sx, sy] = M.toScreen(x, y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
    ctx.closePath();
  };
  ctx.setLineDash([10, 8]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  quadPath(F.quad);
  ctx.stroke();
  ctx.setLineDash([]);
  const T = F.target;
  if (!T) return;
  const quads = T.quads || [T.quad];
  const pulse = 0.6 + 0.4 * Math.sin(t * 5);
  let cx = 0, cy = 0, n = 0;
  for (const q of quads) {
    quadPath(q);
    ctx.globalAlpha = 0.25 + 0.25 * pulse;
    ctx.fillStyle = '#ff4fd8';
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ff4fd8';
    ctx.stroke();
    for (const [x, y] of q) { cx += x; cy += y; n++; }
  }
  cx /= n; cy /= n;
  const [sx, sy] = M.toScreen(cx, cy);
  if (!(sx >= 0 && sy >= 0 && sx <= M.cw && sy <= M.ch)) arrow(ctx, M, { x: cx, y: cy }, '#ff4fd8');
  else if (!T.quads) badge(ctx, sx, sy - 26, '⌂', '#ff4fd8');
}

function badge(ctx, x, y, text, color, ring) {
  if (!(x >= -20 && y >= -20 && x <= ctx.canvas.width && y <= ctx.canvas.height)) return;
  ctx.beginPath();
  ctx.arc(x, y, 12, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = ring || color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = 'bold 14px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 1);
}

function arrow(ctx, M, h, color) {
  const [tx, ty] = M.toScreen(h.x, h.y);
  const cx = M.cw / 2, cy = M.ch / 2;
  const dx = tx - cx, dy = ty - cy;
  const pad = 34;
  const sx = dx ? ((dx > 0 ? M.cw - pad : pad) - cx) / dx : Infinity;
  const sy = dy ? ((dy > 0 ? M.ch - pad - 70 : pad + 40) - cy) / dy : Infinity;
  const s = Math.min(sx, sy);
  const ax = cx + dx * s, ay = cy + dy * s;
  const ang = Math.atan2(dy, dx);
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(16, 0); ctx.lineTo(-10, -11); ctx.lineTo(-5, 0); ctx.lineTo(-10, 11);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 6;
  ctx.fill();
  ctx.restore();
}

// The selected piece's top edge (as it sits in the puzzle): a white arrow
// from its centre out past that edge.
function upArrow(ctx, from, to) {
  const [x0, y0] = from, [x1, y1] = to;
  if (!isFinite(x0 + y0 + x1 + y1)) return;
  const ang = Math.atan2(y1 - y0, x1 - x0), len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 6) return;
  ctx.save();
  ctx.translate(x0, y0); ctx.rotate(ang);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const [w, c] of [[7, 'rgba(0,0,0,0.7)'], [3.5, '#ffffff']]) {
    ctx.lineWidth = w; ctx.strokeStyle = c;
    ctx.beginPath(); ctx.moveTo(len * 0.25, 0); ctx.lineTo(len, 0); ctx.moveTo(len - 9, -7); ctx.lineTo(len, 0); ctx.lineTo(len - 9, 7); ctx.stroke();
  }
  ctx.restore();
}

/** The piece drawn upright as it sits in the finished puzzle: its edge k
 *  (the top edge from the box placement) turned to face up. */
export function drawUpright(canvas, piece, k) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!piece || !piece.thumb || !piece.thumb.data || !piece.corners || k == null) return;
  const th = piece.thumb;
  const tmp = new OffscreenCanvas(th.w, th.h);
  tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(th.data), th.w, th.h), 0, 0);
  const P = piece.corners.map(([x, y]) => [(x - th.ox) * th.s, (y - th.oy) * th.s]);
  const cx = (P[0][0] + P[1][0] + P[2][0] + P[3][0]) / 4, cy = (P[0][1] + P[1][1] + P[2][1] + P[3][1]) / 4;
  const mx = (P[k][0] + P[(k + 1) % 4][0]) / 2 - cx, my = (P[k][1] + P[(k + 1) % 4][1]) / 2 - cy;
  let side = 0;
  for (let i = 0; i < 4; i++) side += Math.hypot(P[(i + 1) % 4][0] - P[i][0], P[(i + 1) % 4][1] - P[i][1]) / 4;
  const s = (Math.min(W, H) * 0.6) / Math.max(1, side);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-Math.PI / 2 - Math.atan2(my, mx));
  ctx.scale(s, s);
  ctx.drawImage(tmp, -cx, -cy);
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.moveTo(W / 2, 3); ctx.lineTo(W / 2 - 8, 13); ctx.lineTo(W / 2 + 8, 13); ctx.closePath(); ctx.fill();
}

// Thumbnail with one edge highlighted (corners are in source pixels; the
// thumbnail records its crop origin and scale).
export function drawThumb(canvas, piece, edge, color) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!piece || !piece.thumb) { ctx.fillStyle = '#222'; ctx.fillRect(0, 0, W, H); return; }
  const th = piece.thumb;
  const img = new ImageData(new Uint8ClampedArray(th.data), th.w, th.h);
  const tmp = new OffscreenCanvas(th.w, th.h);
  tmp.getContext('2d').putImageData(img, 0, 0);
  const s = Math.min(W / th.w, H / th.h);
  const ox = (W - th.w * s) / 2, oy = (H - th.h * s) / 2;
  ctx.drawImage(tmp, ox, oy, th.w * s, th.h * s);
  if (edge != null && piece.corners && th.s) {
    const p = piece.corners.map(([x, y]) => [ox + (x - th.ox) * th.s * s, oy + (y - th.oy) * th.s * s]);
    const a = p[edge], b = p[(edge + 1) % 4];
    ctx.lineWidth = 4;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.beginPath();
    const sig = piece.sigs && piece.sigs[edge];
    if (sig) {
      // Rebuild the real edge curve from its signature (x along the chord, y outward).
      const dx = b[0] - a[0], dy = b[1] - a[1];
      for (let i = 0; i < sig.length; i += 2) {
        const x = a[0] + sig[i] * dx + sig[i + 1] * dy, y = a[1] + sig[i] * dy - sig[i + 1] * dx;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    } else { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    ctx.stroke();
  }
}
