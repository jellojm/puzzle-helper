// The Build view: groups of pieces the owner has confirmed as joined, each
// piece drawn from its own picture (cut out along its outline), turned and
// placed in its grid cell (Engine.buildGroups).
import { outlinePoints } from './tableView.js';

const DIRS = [-Math.PI / 2, 0, Math.PI / 2, Math.PI]; // up, right, down, left (canvas angles)

// The piece's picture cut out along its outline (thumbnail pixels).
function sprite(p) {
  const th = p.thumb;
  const src = document.createElement('canvas');
  src.width = th.w; src.height = th.h;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(th.data), th.w, th.h), 0, 0);
  const pts = outlinePoints(p);
  if (pts.length < 8) return src;
  const c = document.createElement('canvas');
  c.width = th.w; c.height = th.h;
  const g = c.getContext('2d');
  g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
  g.save(); g.clip(); g.drawImage(src, 0, 0); g.restore();
  g.lineWidth = 1.5; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.stroke();
  return c;
}

/** Draw one group into `canvas` (sized here: `cell` css px a piece). */
export function drawGroup(canvas, group, cell) {
  cell = cell || 84;
  const P = group.pieces;
  const c0 = Math.min(...P.map((p) => p.col)), c1 = Math.max(...P.map((p) => p.col));
  const r0 = Math.min(...P.map((p) => p.row)), r1 = Math.max(...P.map((p) => p.row));
  const pad = cell * 0.45, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = (c1 - c0 + 1) * cell + 2 * pad, H = (r1 - r0 + 1) * cell + 2 * pad;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#15191e'; g.fillRect(0, 0, W, H);
  const conflictIds = new Set((group.conflicts || []).flat());
  for (const p of P) {
    const cx = pad + (p.col - c0 + 0.5) * cell, cy = pad + (p.row - r0 + 0.5) * cell;
    if (!p.thumb || !p.corners || !p.thumb.s) {
      g.strokeStyle = '#888'; g.strokeRect(cx - cell / 2 + 4, cy - cell / 2 + 4, cell - 8, cell - 8);
    } else {
      const th = p.thumb, C = p.corners.map(([x, y]) => [(x - th.ox) * th.s, (y - th.oy) * th.s]);
      const mx = (C[0][0] + C[1][0] + C[2][0] + C[3][0]) / 4, my = (C[0][1] + C[1][1] + C[2][1] + C[3][1]) / 4;
      // turn: each edge k's outward direction onto the direction it faces in the group
      let sx = 0, sy = 0, side = 0;
      for (let k = 0; k < 4; k++) {
        const a = C[k], b = C[(k + 1) % 4];
        const ang = Math.atan2((a[1] + b[1]) / 2 - my, (a[0] + b[0]) / 2 - mx);
        const d = DIRS[(k + p.rot) % 4] - ang;
        sx += Math.cos(d); sy += Math.sin(d);
        side += Math.hypot(b[0] - a[0], b[1] - a[1]) / 4;
      }
      const phi = Math.atan2(sy, sx), s = cell / Math.max(1, side);
      g.save();
      g.translate(cx, cy); g.rotate(phi); g.scale(s, s);
      g.drawImage(sprite(p), -mx, -my);
      g.restore();
    }
    // number tag
    const txt = '#' + p.id;
    g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(txt).width + 8;
    g.fillStyle = conflictIds.has(p.id) ? 'rgba(200,40,40,0.85)' : 'rgba(0,0,0,0.65)';
    g.fillRect(cx - tw / 2, cy - 8, tw, 16);
    g.fillStyle = '#fff'; g.fillText(txt, cx, cy);
  }
}
