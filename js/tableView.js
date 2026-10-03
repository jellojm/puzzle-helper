// Table view: a camera-off, top-down map of the catalogued pieces, drawn as
// their own pictures at their scanned position and angle. One shared screen
// (a phone or iPad lying on the table); rotatable so it faces whoever uses
// it; updated by rescanning. The same finders and matches as the camera view.
//
// Coordinates: "table" = the engine's table map (per scan group / island);
// islands are laid out side by side ("laid-out table"); the view maps that to
// screen pixels with a centre, zoom and rotation. The geometry helpers are
// plain functions so they can be tested without a browser (test/table-view.js).

/** Side-by-side layout of the scan groups: {island -> [dx, dy]} offsets.
 *  Biggest group first, wrapped into rows about as wide as the whole is tall. */
export function layoutIslands(pieces, unit) {
  const groups = new Map();
  for (const p of pieces) {
    let g = groups.get(p.island);
    if (!g) groups.set(p.island, (g = { island: p.island, n: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }));
    g.n++;
    g.x0 = Math.min(g.x0, p.pos[0] - unit); g.y0 = Math.min(g.y0, p.pos[1] - unit);
    g.x1 = Math.max(g.x1, p.pos[0] + unit); g.y1 = Math.max(g.y1, p.pos[1] + unit);
  }
  const list = [...groups.values()].sort((a, b) => b.n - a.n);
  const area = list.reduce((s, g) => s + (g.x1 - g.x0) * (g.y1 - g.y0), 0);
  const rowW = Math.max(list.length ? list[0].x1 - list[0].x0 : 0, Math.sqrt(area) * 1.3);
  const gap = unit * 2;
  const off = new Map();
  let x = 0, y = 0, rowH = 0;
  for (const g of list) {
    const w = g.x1 - g.x0, h = g.y1 - g.y0;
    if (x > 0 && x + w > rowW) { x = 0; y += rowH + gap; rowH = 0; }
    off.set(g.island, [x - g.x0, y - g.y0]);
    x += w + gap; rowH = Math.max(rowH, h);
  }
  return off;
}

/** View transform: screen = R(rot) * zoom * (t - c) + (w/2, h/2). */
export function makeView(v, w, h) {
  const c = Math.cos(v.rot), s = Math.sin(v.rot);
  return {
    toScreen: (x, y) => { const dx = (x - v.cx) * v.zoom, dy = (y - v.cy) * v.zoom; return [c * dx - s * dy + w / 2, s * dx + c * dy + h / 2]; },
    toTable: (sx, sy) => { const dx = sx - w / 2, dy = sy - h / 2; return [(c * dx + s * dy) / v.zoom + v.cx, (-s * dx + c * dy) / v.zoom + v.cy]; },
  };
}

/** Centre and zoom that fit `pts` (laid-out table coords) on a w x h screen at rotation rot. */
export function fitView(pts, w, h, rot, pad) {
  if (!pts.length) return { cx: 0, cy: 0, zoom: 1, rot };
  const c = Math.cos(rot), s = Math.sin(rot);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { const rx = c * x - s * y, ry = s * x + c * y; x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y0 = Math.min(y0, ry); y1 = Math.max(y1, ry); }
  const zoom = Math.min((w - 2 * pad) / Math.max(1, x1 - x0), (h - 2 * pad) / Math.max(1, y1 - y0));
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2; // rotated-frame centre -> back to table coords
  return { cx: c * mx + s * my, cy: -s * mx + c * my, zoom, rot };
}

/** Nearest item whose screen circle contains (x, y), or null. */
export function hitTest(items, x, y) {
  let best = null, bd = Infinity;
  for (const it of items) { const d = Math.hypot(it.sx - x, it.sy - y); if (d < it.r * 1.15 && d < bd) { bd = d; best = it.id; } }
  return best;
}

/** A piece's outline in thumbnail pixels: its four corners joined by its edge
 *  curves (signatures run along each corner-to-corner chord). */
export function outlinePoints(p) {
  const th = p.thumb, out = [];
  if (!th || !p.corners) return out;
  const T = (q) => [(q[0] - th.ox) * th.s, (q[1] - th.oy) * th.s];
  for (let k = 0; k < 4; k++) {
    const a = T(p.corners[k]), b = T(p.corners[(k + 1) % 4]);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const sig = p.sigs && p.sigs[k];
    if (!sig) { out.push(a); continue; }
    for (let i = 0; i < sig.length; i += 2) out.push([a[0] + sig[i] * dx + sig[i + 1] * dy, a[1] + sig[i] * dy - sig[i + 1] * dx]);
  }
  return out;
}

const ROLE = { sel: '#ffffff', gold: '#ffcc00', silver: '#c9ced6', corner: '#ff8c3a', border: '#35e0d8', find: '#ff4fd8', pairA: '#ffffff', pairB: '#ffcc00' };
const STATUS = { seen: '#aab2bb', shaped: '#4f9dff', placed: '#3ddc84', section: '#c084fc' };

export class TableView {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.onTap = (opts && opts.onTap) || (() => {});
    this.pieces = [];
    this.byId = new Map();
    this.unit = 30;
    this.off = new Map();
    this.view = { cx: 0, cy: 0, zoom: 1, rot: 0 };
    this.hl = { roles: new Map(), lines: [] };
    this.fitted = false;
    this.pointers = new Map();
    this.dirty = false;
    this.bindGestures();
    window.addEventListener('resize', () => this.request());
  }

  // ---- data ----
  setData(data) {
    this.unit = data.unit || 30;
    this.pieces = data.pieces;
    this.byId = new Map(this.pieces.map((p) => [p.id, p]));
    this.off = layoutIslands(this.pieces, this.unit);
    for (const p of this.pieces) p.sprite = p.thumb && p.rd ? this.makeSprite(p) : null;
    if (!this.fitted) { this.fit(); this.fitted = true; }
    this.request();
  }
  // The piece's thumbnail cut out along its own outline (no board around it).
  makeSprite(p) {
    const th = p.thumb;
    const src = document.createElement('canvas');
    src.width = th.w; src.height = th.h;
    src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(th.data), th.w, th.h), 0, 0);
    const pts = outlinePoints(p);
    if (pts.length < 8) return src;
    const c = document.createElement('canvas');
    c.width = th.w; c.height = th.h;
    const g = c.getContext('2d');
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.save(); g.clip(); g.drawImage(src, 0, 0); g.restore();
    g.lineWidth = 1; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.stroke();
    return c;
  }
  laid(p) { const o = this.off.get(p.island) || [0, 0]; return [p.pos[0] + o[0], p.pos[1] + o[1]]; }

  // ---- highlights ----
  /** roles: Map id -> 'sel'|'gold'|'silver'|'corner'|'border'|'find'; lines: [[idA, idB, colour]] */
  setHighlights(h) { this.hl = { roles: h.roles || new Map(), lines: h.lines || [] }; this.request(); }
  /** Finder chips / Border button on the map; returns how many pieces lit up. */
  filterRoles(kind) {
    const roles = new Map();
    for (const p of this.pieces) {
      if (p.kind === 'section') continue;
      const r = kind === 'corner' ? (p.corner ? 'corner' : null)
        : kind === 'border' ? (p.border ? 'border' : null)
          : kind === 'edges' ? (p.corner ? 'corner' : p.border ? 'border' : null)
            : kind === 'unplaced' ? (p.shaped && !p.placed ? 'find' : null)
              : kind === 'unread' ? (!p.shaped ? 'find' : null) : null;
      if (r) roles.set(p.id, r);
    }
    return roles;
  }

  // ---- view ----
  size() { return [this.canvas.clientWidth || 1, this.canvas.clientHeight || 1]; }
  fit() {
    const [w, h] = this.size();
    const u = this.unit, pts = [];
    for (const p of this.pieces) { const [x, y] = this.laid(p); pts.push([x - u, y - u], [x + u, y + u]); }
    this.view = fitView(pts, w, h, this.view.rot, 24);
    this.request();
  }
  rotate90() { this.view.rot += Math.PI / 2; this.fit(); }
  /** Bring these pieces into view (pair stepping). */
  zoomTo(ids) {
    const [w, h] = this.size();
    const u = this.unit, pts = [];
    for (const id of ids) { const p = this.byId.get(id); if (p) { const [x, y] = this.laid(p); pts.push([x - 3 * u, y - 3 * u], [x + 3 * u, y + 3 * u]); } }
    if (pts.length) { this.view = fitView(pts, w, h, this.view.rot, 40); this.request(); }
  }

  // ---- drawing ----
  request() { if (this.dirty) return; this.dirty = true; requestAnimationFrame(() => { this.dirty = false; this.render(); }); }
  render() {
    const cv = this.canvas;
    if (cv.hidden) return;
    const [w, h] = this.size();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1a1f26'; ctx.fillRect(0, 0, w, h);
    const V = makeView(this.view, w, h), u = this.unit, z = this.view.zoom;
    this.screen = [];
    for (const p of this.pieces) {
      const [lx, ly] = this.laid(p);
      const [sx, sy] = V.toScreen(lx, ly);
      const r = p.kind === 'section' ? Math.max(u, Math.sqrt(p.area || u * u) / 2) * z : u * 0.62 * z;
      this.screen.push({ id: p.id, sx, sy, r });
      if (sx < -r * 2 || sy < -r * 2 || sx > w + r * 2 || sy > h + r * 2) continue;
      ctx.globalAlpha = p.missing ? 0.35 : 1;
      if (p.sprite) {
        // view, then: island offset + drift since the read, the read's
        // source->table similarity, thumbnail pixels -> source pixels
        ctx.save();
        ctx.translate(w / 2, h / 2); ctx.rotate(this.view.rot); ctx.scale(z, z); ctx.translate(-this.view.cx, -this.view.cy);
        const o = this.off.get(p.island) || [0, 0], rd = p.rd, th = p.thumb;
        ctx.translate(o[0] + p.pos[0] - rd.pos0[0], o[1] + p.pos[1] - rd.pos0[1]);
        ctx.transform(rd.a, rd.b, -rd.b, rd.a, rd.tx, rd.ty);
        ctx.translate(th.ox, th.oy); ctx.scale(1 / th.s, 1 / th.s);
        ctx.drawImage(p.sprite, 0, 0);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(sx, sy, p.kind === 'section' ? r : r * 0.55, 0, Math.PI * 2);
        ctx.fillStyle = p.kind === 'section' ? 'rgba(192,132,252,0.35)' : (p.placed ? STATUS.placed : p.shaped ? STATUS.shaped : STATUS.seen);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // lines (selected piece -> its matches, or the pair being stepped through)
    const at = new Map(this.screen.map((s) => [s.id, s]));
    for (const [a, b, col] of this.hl.lines) {
      const A = at.get(a), B = at.get(b);
      if (!A || !B) continue;
      ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy);
      ctx.lineWidth = 2.5; ctx.strokeStyle = col || ROLE.gold; ctx.setLineDash([7, 5]); ctx.stroke(); ctx.setLineDash([]);
    }
    // rings
    for (const [id, role] of this.hl.roles) {
      const s = at.get(id);
      if (!s) continue;
      ctx.beginPath(); ctx.arc(s.sx, s.sy, Math.max(8, s.r), 0, Math.PI * 2);
      ctx.lineWidth = role === 'sel' ? 3.5 : 3; ctx.strokeStyle = ROLE[role] || ROLE.find; ctx.stroke();
    }
  }

  // ---- gestures: drag = pan, pinch = zoom, twist = rotate, tap = select ----
  bindGestures() {
    const cv = this.canvas;
    const pt = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    let tap = null, prev = null;
    const pair = () => { const v = [...this.pointers.values()]; return v.length >= 2 ? { m: [(v[0][0] + v[1][0]) / 2, (v[0][1] + v[1][1]) / 2], d: Math.hypot(v[1][0] - v[0][0], v[1][1] - v[0][1]), a: Math.atan2(v[1][1] - v[0][1], v[1][0] - v[0][0]) } : null; };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, pt(e));
      tap = this.pointers.size === 1 ? { p: pt(e), t: performance.now() } : null;
      prev = this.pointers.size >= 2 ? pair() : null;
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const old = this.pointers.get(e.pointerId), now = pt(e);
      this.pointers.set(e.pointerId, now);
      const [w, h] = this.size();
      if (this.pointers.size === 1) {
        if (tap && Math.hypot(now[0] - tap.p[0], now[1] - tap.p[1]) > 10) tap = null;
        const V = makeView(this.view, w, h), a = V.toTable(old[0], old[1]), b = V.toTable(now[0], now[1]);
        this.view.cx -= b[0] - a[0]; this.view.cy -= b[1] - a[1];
        this.request();
      } else if (this.pointers.size === 2) {
        const cur = pair();
        if (prev && cur) {
          // keep the table point under the fingers' midpoint under it
          const anchor = makeView(this.view, w, h).toTable(prev.m[0], prev.m[1]);
          this.view.zoom = Math.max(0.02, Math.min(50, this.view.zoom * (cur.d / Math.max(1, prev.d))));
          this.view.rot += cur.a - prev.a;
          const moved = makeView(this.view, w, h).toTable(cur.m[0], cur.m[1]);
          this.view.cx += anchor[0] - moved[0]; this.view.cy += anchor[1] - moved[1];
          this.request();
        }
        prev = cur;
      }
    });
    const end = (e) => {
      this.pointers.delete(e.pointerId);
      prev = this.pointers.size >= 2 ? pair() : null;
      if (tap && this.pointers.size === 0 && performance.now() - tap.t < 500 && this.screen) {
        const [x, y] = pt(e);
        this.onTap(hitTest(this.screen, x, y));
      }
      if (this.pointers.size === 0) tap = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', (e) => { this.pointers.delete(e.pointerId); tap = null; });
    cv.addEventListener('wheel', (e) => { // desktop: zoom about the cursor
      e.preventDefault();
      const [w, h] = this.size(), m = pt(e), a = makeView(this.view, w, h).toTable(m[0], m[1]);
      this.view.zoom *= Math.exp(-e.deltaY * 0.0015);
      const b = makeView(this.view, w, h).toTable(m[0], m[1]);
      this.view.cx += a[0] - b[0]; this.view.cy += a[1] - b[1];
      this.request();
    }, { passive: false });
  }
  /** Test hook: screen point of a piece. */
  screenOf(id) { const s = (this.screen || []).find((q) => q.id === id); return s ? [s.sx, s.sy] : null; }
}
