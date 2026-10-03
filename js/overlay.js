// Drawing on the camera overlay, plus small canvas helpers for thumbnails.

export const EDGE_COLORS = ['#ff6b6b', '#4dd0e1', '#ffd54f', '#b388ff'];
const STATUS = {
  unknown: { stroke: 'rgba(255,255,255,0.45)', dash: [4, 4] },
  seen: { stroke: '#aab2bb', dash: [] },
  shaped: { stroke: '#4f9dff', dash: [] },
  placed: { stroke: '#3ddc84', dash: [] },
  merged: { stroke: '#ff9f43', dash: [6, 4] },
  section: { stroke: '#c084fc', dash: [] },
};
const ROLE = {
  sel: { color: '#ffffff', width: 5 },
  gold: { color: '#ffcc00', width: 5 },
  silver: { color: '#c9ced6', width: 3 },
  region: { color: '#ff4fd8', width: 4 },
  section: { color: '#c084fc', width: 5 },
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
export function frameMapping(video, canvas, res) {
  const vw = res.frameW, vh = res.frameH;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const s = Math.max(cw / vw, ch / vh);
  const k = s / res.scale; // proc px -> css px (no tilt)
  const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
  const R = res.rect;
  if (!R) {
    return {
      k, ox, oy, cw, ch,
      toVideo: (x, y) => [(x - ox) / s, (y - oy) / s], // screen -> camera frame pixel
      toScreen: (x, y) => [x * k + ox, y * k + oy],
      toFrame: (x, y) => [(x - ox) / k, (y - oy) / k],
    };
  }
  return {
    k, ox, oy, cw, ch,
    toVideo: (x, y) => [(x - ox) / s, (y - oy) / s],
    toScreen: (x, y) => {
      const p = applyH(R.Hinv, x / res.scale, y / res.scale);
      if (p[2] <= 0) return [NaN, NaN];
      return [p[0] * s + ox, p[1] * s + oy];
    },
    toFrame: (x, y) => {
      const p = applyH(R.H, (x - ox) / s, (y - oy) / s);
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

export function drawOverlay(ctx, res, M, opts) {
  ctx.clearRect(0, 0, M.cw, M.ch);
  if (!res) return;
  const t = performance.now() / 1000;
  const byId = new Map();
  ctx.lineJoin = 'round';
  for (const d of res.dets) {
    if (d.id) byId.set(d.id, d);
    const st = STATUS[d.status] || STATUS.unknown;
    pathFor(ctx, d.pts, M);
    ctx.setLineDash(st.dash);
    ctx.lineWidth = 2;
    ctx.strokeStyle = st.stroke;
    ctx.globalAlpha = d.border ? 0.5 : 0.9;
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

  // Highlights: on-screen glow, off-screen arrows at the edge.
  const pulse = 0.6 + 0.4 * Math.sin(t * 5);
  for (const h of res.highlights) {
    const style = ROLE[h.role];
    const d = byId.get(h.id);
    if (h.visible && d) {
      pathFor(ctx, d.pts, M);
      if (h.role === 'region') { ctx.fillStyle = 'rgba(255, 79, 216, 0.22)'; ctx.fill(); }
      ctx.shadowColor = style.color;
      ctx.shadowBlur = h.role === 'sel' ? 0 : 14 * pulse;
      ctx.lineWidth = style.width;
      ctx.strokeStyle = style.color;
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (h.role === 'gold' || h.role === 'silver') {
        const [x, y] = M.toScreen(d.cx, d.cy);
        badge(ctx, x, y, h.role === 'gold' ? '★' : '·', style.color, EDGE_COLORS[h.edge]);
      }
    } else if (!h.visible) {
      arrow(ctx, M, h, style.color);
    }
  }
}

function badge(ctx, x, y, text, color, ring) {
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
