// Box picture setup: pick a photo, drag 4 corners onto the picture, choose grid.

const $ = (id) => document.getElementById(id);

export function chooseGrid(pieces, aspect) {
  let best = null;
  for (let cols = 2; cols <= 200; cols++) {
    const rows = Math.max(2, Math.round(pieces / cols));
    const score = Math.abs(Math.log(cols / rows / aspect)) + (2 * Math.abs(cols * rows - pieces)) / pieces;
    if (!best || score < best.score) best = { cols, rows, score };
  }
  return { cols: best.cols, rows: best.rows };
}

export class BoxSetup {
  constructor(worker, onDone, toast, onToggle) {
    this.worker = worker;
    this.onDone = onDone;
    this.toast = toast;
    this.onToggle = onToggle || (() => {}); // lets the page stop the camera while this is up
    this.file = null;
    this.bitmap = null;
    this.corners = null; // image px, TL TR BR BL
    this.drag = -1;
    this.gridTouched = false;
    this.canvas = $('boxCanvas');
    $('boxPick').onclick = () => $('boxInput').click();
    $('boxRetake').onclick = () => $('boxInput').click();
    $('boxInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.load(f); };
    $('boxCancel').onclick = () => this.close();
    $('boxUse').onclick = () => this.submit();
    $('boxPieces').oninput = () => { this.gridTouched = false; this.updateGrid(); };
    $('boxCols').oninput = $('boxRows').oninput = () => { this.gridTouched = true; };
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', () => this.up());
    this.canvas.addEventListener('pointercancel', () => this.up());
    window.addEventListener('resize', () => this.bitmap && this.draw());
  }

  open() {
    $('boxModal').hidden = false;
    if (!this.bitmap) { $('boxEmpty').hidden = false; this.canvas.hidden = true; }
    this.onToggle();
  }
  close() { $('boxModal').hidden = true; this.onToggle(); }

  async load(file) {
    this.file = file;
    try {
      this.bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      this.toast('Could not read that photo. Try a JPEG or PNG.');
      return;
    }
    const w = this.bitmap.width, h = this.bitmap.height;
    this.corners = [[w * 0.08, h * 0.08], [w * 0.92, h * 0.08], [w * 0.92, h * 0.92], [w * 0.08, h * 0.92]];
    $('boxEmpty').hidden = true;
    this.canvas.hidden = false;
    $('boxHelp').hidden = false;
    $('boxRetake').hidden = false;
    $('boxUse').disabled = false;
    this.draw();
    this.updateGrid();
    // Ask the worker for a better guess at the picture's corners.
    const copy = await createImageBitmap(file, { imageOrientation: 'from-image' });
    this.worker.post({ type: 'boxCorners', bitmap: copy }, [copy]);
  }

  setCorners(c) {
    if (!c || !this.bitmap) return;
    this.corners = c;
    this.draw();
    this.updateGrid();
  }

  aspect() {
    const c = this.corners, d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    return (d(c[0], c[1]) + d(c[3], c[2])) / (d(c[0], c[3]) + d(c[1], c[2]));
  }
  updateGrid() {
    if (!this.corners || this.gridTouched) return;
    const n = parseInt($('boxPieces').value, 10) || 1000;
    const g = chooseGrid(n, this.aspect());
    $('boxCols').value = g.cols;
    $('boxRows').value = g.rows;
  }

  layout() {
    const c = this.canvas, b = this.bitmap;
    const parent = c.parentElement;
    const maxW = parent.clientWidth - 20, maxH = parent.clientHeight - 50;
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
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, this.bitmap.width * s, this.bitmap.height * s);
    ctx.moveTo(P[0][0], P[0][1]); for (let i = 3; i >= 1; i--) ctx.lineTo(P[i][0], P[i][1]); ctx.closePath();
    ctx.fill('evenodd');
    ctx.strokeStyle = '#4f9dff';
    ctx.lineWidth = 2;
    ctx.beginPath(); P.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.stroke();
    P.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p[0], p[1], 13, 0, Math.PI * 2);
      ctx.fillStyle = i === this.drag ? 'rgba(79,157,255,0.5)' : 'rgba(79,157,255,0.25)';
      ctx.fill(); ctx.stroke();
    });
    if (this.drag >= 0) this.loupe(ctx, P[this.drag]);
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
    this.updateGrid();
  }

  async submit() {
    if (!this.file) return;
    const cols = parseInt($('boxCols').value, 10), rows = parseInt($('boxRows').value, 10);
    const pieces = parseInt($('boxPieces').value, 10) || 1000;
    if (!(cols >= 2 && rows >= 2)) { this.toast('Enter the grid size (columns × rows).'); return; }
    const bmp = await createImageBitmap(this.file, { imageOrientation: 'from-image' });
    this.worker.post({ type: 'box', bitmap: bmp, corners: this.corners, pieces, cols, rows }, [bmp]);
    this.close();
    this.onDone && this.onDone();
  }
}
