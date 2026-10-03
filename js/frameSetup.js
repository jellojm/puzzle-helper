// Mark the finished border: a still of the camera view, 4 numbered dots to
// drag onto the border's outer corners (1 = the box picture's top-left, then
// clockwise), and the box picture with the same numbers for reference.

const $ = (id) => document.getElementById(id);
const DOT = ['#ff4fd8', '#ffcc00', '#35e0d8', '#4f9dff'];

export class FrameSetup {
  constructor(worker, toast, onToggle) {
    this.worker = worker;
    this.toast = toast;
    this.onToggle = onToggle || (() => {});
    this.bitmap = null;
    this.corners = null; // camera-frame px, clockwise from the box's top-left
    this.drag = -1;
    this.box = null; // {cols, rows, preview:{w,h,data}}
    this.canvas = $('frameCanvas');
    $('frameCancel').onclick = () => this.close();
    $('frameUse').onclick = () => this.submit();
    $('frameTurn').onclick = () => { this.corners.push(this.corners.shift()); this.draw(); };
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', () => this.up());
    this.canvas.addEventListener('pointercancel', () => this.up());
    window.addEventListener('resize', () => !$('frameModal').hidden && this.bitmap && this.draw());
  }

  setBox(box) { this.box = box; }

  /** `bitmap` = the camera frame, `tilt` = the phone tilt when it was taken. */
  open(bitmap, tilt) {
    if (this.bitmap) this.bitmap.close();
    this.bitmap = bitmap;
    this.tilt = tilt;
    const w = bitmap.width, h = bitmap.height;
    // Start as an inset rectangle in the box picture's shape, its long side
    // along the view's long side (the usual way a puzzle fills the view).
    const a = this.box ? this.box.cols / this.box.rows : 0.75;
    const ar = (w > h) === (a > 1) ? a : 1 / a;
    let bw = w * 0.8, bh = bw / ar;
    if (bh > h * 0.8) { bh = h * 0.8; bw = bh * ar; }
    const x0 = (w - bw) / 2, y0 = (h - bh) / 2;
    this.corners = [[x0, y0], [x0 + bw, y0], [x0 + bw, y0 + bh], [x0, y0 + bh]];
    $('frameModal').hidden = false;
    this.onToggle();
    this.draw();
    this.drawBox();
  }
  close() {
    $('frameModal').hidden = true;
    if (this.bitmap) { this.bitmap.close(); this.bitmap = null; }
    this.onToggle();
  }

  layout() {
    const c = this.canvas, b = this.bitmap;
    const parent = c.parentElement;
    const maxW = parent.clientWidth - 20, maxH = parent.clientHeight - 20;
    const s = Math.min(maxW / b.width, maxH / b.height);
    const cw = Math.round(b.width * s), ch = Math.round(b.height * s);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.style.width = cw + 'px'; c.style.height = ch + 'px';
    c.width = cw * dpr; c.height = ch * dpr;
    this.s = s; this.dpr = dpr;
  }

  draw() {
    this.layout();
    const ctx = this.canvas.getContext('2d');
    const { s, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(this.bitmap, 0, 0, this.bitmap.width * s, this.bitmap.height * s);
    const P = this.corners.map(([x, y]) => [x * s, y * s]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); P.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    P.forEach((p, i) => dot(ctx, p[0], p[1], i, i === this.drag));
    if (this.drag >= 0) this.loupe(ctx, P[this.drag]);
  }

  // The box picture with the corner numbers: dot 1 = its top-left.
  drawBox() {
    const c = $('frameBox');
    const pv = this.box && this.box.preview;
    c.hidden = !pv;
    if (!pv) return;
    const S = 90 / Math.max(pv.w, pv.h);
    const w = Math.round(pv.w * S), h = Math.round(pv.h * S), pad = 12;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.style.width = w + 2 * pad + 'px'; c.style.height = h + 2 * pad + 'px';
    c.width = (w + 2 * pad) * dpr; c.height = (h + 2 * pad) * dpr;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const tmp = new OffscreenCanvas(pv.w, pv.h);
    tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pv.data), pv.w, pv.h), 0, 0);
    ctx.drawImage(tmp, pad, pad, w, h);
    [[pad, pad], [pad + w, pad], [pad + w, pad + h], [pad, pad + h]].forEach(([x, y], i) => dot(ctx, x, y, i, false, 9));
  }

  // Magnified view of the area under the finger, drawn away from it.
  loupe(ctx, p) {
    const R = 52, zoom = 3;
    const cw = this.bitmap.width * this.s;
    const lx = p[0] < cw / 2 ? cw - R - 8 : R + 8, ly = R + 8;
    const ix = p[0] / this.s, iy = p[1] / this.s, half = R / zoom / this.s;
    ctx.save();
    ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(this.bitmap, ix - half, iy - half, 2 * half, 2 * half, lx - R, ly - R, 2 * R, 2 * R);
    ctx.restore();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(lx - 8, ly); ctx.lineTo(lx + 8, ly); ctx.moveTo(lx, ly - 8); ctx.lineTo(lx, ly + 8); ctx.stroke();
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / this.s, (e.clientY - r.top) / this.s];
  }
  down(e) {
    const [x, y] = this.pos(e);
    let best = -1, bd = 44 / this.s;
    this.corners.forEach((c, i) => { const d = Math.hypot(c[0] - x, c[1] - y); if (d < bd) { bd = d; best = i; } });
    this.drag = best;
    if (best >= 0) { this.canvas.setPointerCapture(e.pointerId); this.grab = [this.corners[best][0] - x, this.corners[best][1] - y]; this.draw(); }
  }
  move(e) {
    if (this.drag < 0) return;
    const [x, y] = this.pos(e);
    const w = this.bitmap.width, h = this.bitmap.height;
    this.corners[this.drag] = [Math.max(0, Math.min(w, x + this.grab[0])), Math.max(0, Math.min(h, y + this.grab[1]))];
    this.draw();
  }
  up() {
    if (this.drag < 0) return;
    this.drag = -1;
    this.draw();
  }

  async submit() {
    if (!this.bitmap) return;
    const bmp = await createImageBitmap(this.bitmap);
    this.worker.post({ type: 'frameMark', bitmap: bmp, corners: this.corners.map((p) => p.slice()), tilt: this.tilt }, [bmp]);
    this.toast('Learning the table around the border…');
    this.close();
  }
}

function dot(ctx, x, y, i, active, r) {
  r = r || 14;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = active ? DOT[i] : 'rgba(0,0,0,0.6)';
  ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = DOT[i]; ctx.stroke();
  ctx.fillStyle = active ? '#000' : '#fff';
  ctx.font = `bold ${Math.round(r * 1.1)}px -apple-system, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(i + 1), x, y + 1);
}
