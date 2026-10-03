/* Vision worker: owns OpenCV, the Engine (catalog + table map) and IndexedDB
 * persistence. The page sends camera frames as ImageBitmaps and gets back
 * outlines/highlights to draw. Classic worker (importScripts) because
 * OpenCV.js is a UMD script. */
/* global importScripts, PH, cv */
'use strict';

const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const VISION = ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'engine'];

let engine = null;
const recent = []; // recent frame timings
let db = null;
let saveTimer = null;

// ---------- image sources ----------
const canvasCache = new Map();
function canvas2d(w, h, key) {
  let c = canvasCache.get(key);
  if (!c || c.width !== w || c.height !== h) {
    c = new OffscreenCanvas(w, h);
    c.ctx = c.getContext('2d', { willReadFrequently: true });
    canvasCache.set(key, c);
  }
  return c;
}
function bitmapSource(bmp) {
  const w = bmp.width, h = bmp.height;
  return {
    w, h,
    getProc(maxW) {
      const scale = Math.min(1, maxW / Math.max(w, h)); // long side, so portrait works too
      const pw = Math.round(w * scale), ph = Math.round(h * scale);
      const c = canvas2d(pw, ph, 'proc');
      c.ctx.drawImage(bmp, 0, 0, pw, ph);
      return { w: pw, h: ph, data: c.ctx.getImageData(0, 0, pw, ph).data, scale };
    },
    getCrop(x, y, cw, ch) {
      const c = canvas2d(cw, ch, 'crop');
      c.ctx.clearRect(0, 0, cw, ch);
      c.ctx.drawImage(bmp, x, y, cw, ch, 0, 0, cw, ch);
      return { w: cw, h: ch, data: c.ctx.getImageData(0, 0, cw, ch).data };
    },
    rgba() {
      const c = canvas2d(w, h, 'full');
      c.ctx.drawImage(bmp, 0, 0);
      return { w, h, data: c.ctx.getImageData(0, 0, w, h).data };
    },
  };
}

// ---------- IndexedDB ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('puzzle-helper', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('pieces')) d.createObjectStore('pieces', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
async function loadState() {
  if (!db) return { pieces: [] };
  const pieces = await tx('pieces', 'readonly', (s) => s.getAll());
  const box = await tx('meta', 'readonly', (s) => s.get('box'));
  const settings = await tx('meta', 'readonly', (s) => s.get('settings'));
  return { pieces: pieces || [], box: box || null, settings: settings || null };
}
function scheduleSave() {
  if (saveTimer || !db) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const { put, del } = engine.takeDirty();
    if (!put.length && !del.length) return;
    try {
      await tx('pieces', 'readwrite', (s) => { for (const p of put) s.put(p); for (const id of del) s.delete(id); });
    } catch (e) {
      post({ type: 'error', message: 'Saving failed: ' + e.message });
    }
  }, 2500);
}

// ---------- messaging ----------
function post(msg, transfer) { self.postMessage(msg, transfer || []); }
function boxInfo() {
  const b = engine.box;
  if (!b) return null;
  return { cols: b.cols, rows: b.rows, preview: b.preview };
}

async function init(msg) {
  post({ type: 'status', text: 'Loading vision library (first time ~10 MB)…' });
  importScripts(OPENCV_URL);
  for (const f of VISION) importScripts('vision/' + f + '.js');
  // The Emscripten module is a thenable; never `await` it directly.
  const m = self.cv;
  if (m instanceof Promise) PH.cv = await m;
  else { if (!m.Mat) await new Promise((r) => (m.onRuntimeInitialized = r)); PH.cv = m; }
  engine = new PH.Engine(msg.opts || {});
  try {
    db = await openDb();
    const st = await loadState();
    engine.importState(st);
    if (st.settings) {
      if (st.settings.minDE) engine.opts.minDE = st.settings.minDE;
      engine.taught = st.settings.taught || [];
    }
  } catch (e) {
    post({ type: 'error', message: 'Storage unavailable; the catalog will not be saved (' + e.message + ')' });
  }
  post({ type: 'ready', counts: engine.counts(), box: boxInfo(), settings: settingsInfo() });
}
function settingsInfo() { return { minDE: engine.opts.minDE, taught: engine.taught.length }; }
// Drop the taught table colours AND the background model chosen with them, so
// the engine re-picks its background on the next frames instead of carrying a
// "taught" model whose colours are gone.
function forgetTable() {
  engine.clearBackground();
  engine.bgModel = null; engine.bgEval = null; engine.bgModelAt = 0; engine.poorStreak = 0;
}
async function saveSettings() {
  if (db) await tx('meta', 'readwrite', (s) => s.put({ minDE: engine.opts.minDE, taught: engine.taught }, 'settings'));
}

const handlers = {
  init,
  frame(msg) {
    const src = bitmapSource(msg.bitmap);
    const g0 = performance.now();
    const out = engine.processFrame(src, { still: msg.still, tilt: msg.tilt });
    out.timings.workerTotal = performance.now() - g0;
    msg.bitmap.close();
    out.type = 'frame';
    out.frameW = src.w; out.frameH = src.h;
    post(out);
    scheduleSave();
  },
  snap(msg) {
    post({ type: 'status', text: 'Cataloging photo…' });
    const src = bitmapSource(msg.bitmap);
    const res = engine.processSnap(src, { tilt: msg.tilt });
    msg.bitmap.close();
    post({ type: 'snap', result: res });
    scheduleSave();
  },
  async box(msg) {
    post({ type: 'status', text: 'Preparing box image…' });
    const src = bitmapSource(msg.bitmap);
    const box = PH.createBox(src.rgba(), msg.corners, { pieces: msg.pieces, cols: msg.cols, rows: msg.rows });
    msg.bitmap.close();
    engine.setBox(box);
    if (db) await tx('meta', 'readwrite', (s) => s.put(box, 'box'));
    post({ type: 'box', box: boxInfo() });
    scheduleSave();
  },
  boxCorners(msg) {
    const src = bitmapSource(msg.bitmap);
    const corners = PH.detectBoxCorners(src.rgba());
    msg.bitmap.close();
    post({ type: 'boxCorners', corners });
  },
  boxGrid(msg) {
    const aspect = msg.aspect;
    post({ type: 'boxGrid', grid: PH.chooseGrid(msg.pieces, aspect) });
  },
  select(msg) {
    post({ type: 'selected', desc: msg.id ? engine.select(msg.id) : (engine.select(null), null) });
  },
  // Select a catalogued piece of a given kind without needing it on screen
  // (the off-screen arrows then point the way to it).
  selectKind(msg) {
    let pick = null;
    for (const p of engine.pieces.values()) {
      if (msg.kind === 'section' ? (p.kind === 'section' && p.sec && p.sec.cells) : p.kind !== 'section' && p.t1) { pick = p; break; }
    }
    post({ type: 'selected', desc: pick ? engine.select(pick.id) : null });
  },
  region(msg) {
    const n = engine.selectRegion(msg.c0, msg.r0, msg.c1, msg.r1);
    post({ type: 'region', count: n, cells: [msg.c0, msg.r0, msg.c1, msg.r1] });
  },
  clearHighlights() { engine.selection = null; engine.region = null; engine.filter = null; engine.pairSel = null; },
  // Highlight a whole class of pieces (border / corner / unplaced / unread).
  filter(msg) {
    const n = engine.setFilter(msg.kind);
    post({ type: 'filter', kind: msg.kind || null, count: n });
  },
  // "Any matches?" — scan the whole catalog for confident pairs. Resumable:
  // the page calls again with `from` until `done`.
  pairs(msg) {
    const r = engine.scanPairs({ from: msg.from || 0, budgetMs: msg.budgetMs || 1200, minProb: msg.minProb });
    const brief = (id) => {
      const Q = engine.pieces.get(id);
      return { id, code: Q.t1 ? Q.t1.code : null, thumb: Q.t1 ? Q.t1.thumb : null, corners: Q.t1 ? Q.t1.corners : null,
        sigs: Q.t1 ? Q.t1.edges.map((e) => e.sig) : null, located: !!Q.pos };
    };
    post({ type: 'pairs', from: r.from, total: r.total, done: r.done,
      pairs: r.pairs.slice(0, 60).map((p) => Object.assign({}, p, { A: brief(p.a), B: brief(p.b) })) });
  },
  showPair(msg) { engine.selectPair(msg.a, msg.b); },
  // Fold duplicate scan groups together and drop entries that never read as pieces.
  async tidy() {
    const r = engine.tidy();
    const { put, del } = engine.takeDirty();
    if (db) await tx('pieces', 'readwrite', (s) => { for (const p of put) s.put(p); for (const id of del) s.delete(id); });
    post({ type: 'tidied', removed: r.removed, counts: engine.counts() });
  },
  // Diagnostic snapshot for "Send report".
  async report() {
    // The (straightened) image the vision code analyzed last, as a JPEG.
    let analyzed = null;
    if (engine.lastProc && typeof OffscreenCanvas !== 'undefined') {
      try {
        const p = engine.lastProc, c = new OffscreenCanvas(p.w, p.h);
        c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h), 0, 0);
        analyzed = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      } catch (e) { analyzed = null; }
    }
    // The rectified box picture as the engine actually holds it: placement
    // problems are usually visible in it (wrong corners, skew, bad grid).
    let boxImg = null;
    if (engine.box && engine.box.preview && typeof OffscreenCanvas !== 'undefined') {
      try {
        const b = engine.box.preview, c = new OffscreenCanvas(b.w, b.h);
        const g = c.getContext('2d');
        g.putImageData(new ImageData(new Uint8ClampedArray(b.data), b.w, b.h), 0, 0);
        // Draw the piece grid over it, so a mis-sized grid is obvious at a glance.
        g.strokeStyle = 'rgba(255,0,128,0.55)';
        g.lineWidth = 1;
        for (let i = 1; i < engine.box.cols; i++) { const x = (i * b.w) / engine.box.cols; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, b.h); g.stroke(); }
        for (let j = 1; j < engine.box.rows; j++) { const y = (j * b.h) / engine.box.rows; g.beginPath(); g.moveTo(0, y); g.lineTo(b.w, y); g.stroke(); }
        boxImg = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      } catch (e) { boxImg = null; }
    }
    const pieces = [...engine.pieces.values()].map((p) => ({
      id: p.id, kind: p.kind || 'piece', island: p.island, pos: p.pos && p.pos.map(Math.round), area: Math.round(p.area || 0),
      sec: p.sec ? (p.sec.failed ? 'failed' : (p.sec.cells || []).length + ' cells') : null,
      code: p.t1 ? p.t1.code : null, cornerScore: p.t1 ? +p.t1.cornerScore.toFixed(3) : null, nObs: p.t1 ? p.t1.nObs || 1 : 0,
      meanSide: p.t1 ? Math.round(p.t1.meanSide) : null, t1Fail: p.t1Fail || 0,
      box: p.t2 && p.t2.cands.length ? { col: p.t2.cands[0].col, row: p.t2.cands[0].row, conf: +p.t2.conf.toFixed(2) } : null,
      wrong: p.wrong, joined: p.joined,
    }));
    post({ type: 'report', analyzed, boxImg, data: {
      opts: engine.opts, taught: engine.taught, counts: engine.counts(), bg: engine.bg, thresh: engine.thresh,
      box: engine.box ? { cols: engine.box.cols, rows: engine.box.rows, white: engine.box.white } : null,
      island: engine.island, tracking: !!engine.pose, pieces,
      cvInfo: PH.cv && PH.cv.getBuildInformation ? String(PH.cv.getBuildInformation()).slice(0, 3000) : null,
    } });
  },
  feedback(msg) {
    engine.feedback(msg);
    scheduleSave();
    if (engine.selection) post({ type: 'selected', desc: engine.describe(engine.selection.id) });
  },
  async settings(msg) {
    Object.assign(engine.opts, msg.settings);
    await saveSettings();
  },
  // A tap on bare table: remember its color as background.
  async teachBg(msg) {
    const L = PH.rgbaToLab(new Uint8ClampedArray([msg.rgb[0], msg.rgb[1], msg.rgb[2], 255]), 1, 1);
    engine.teachBackground({ L: L[0], a: L[1], b: L[2] });
    await saveSettings();
    post({ type: 'taught', count: engine.taught.length });
  },
  async undoBg() {
    engine.taught.pop();
    await saveSettings();
    post({ type: 'taught', count: engine.taught.length });
  },
  async clearBg() {
    forgetTable();
    await saveSettings();
    post({ type: 'taught', count: 0 });
  },
  async reset(msg) {
    const keepBox = msg.keepBox ? engine.box : null;
    engine.reset();
    if (keepBox) engine.box = keepBox;
    // A new puzzle is often a new table (or new light): taught colours from the
    // old one make the board look like a piece. The page asks; this forgets.
    if (msg.forgetTable) { forgetTable(); await saveSettings(); }
    if (db) {
      await tx('pieces', 'readwrite', (s) => s.clear());
      if (!keepBox) await tx('meta', 'readwrite', (s) => s.delete('box'));
    }
    post({ type: 'ready', counts: engine.counts(), box: boxInfo(), settings: settingsInfo() });
  },
};

// Process messages one at a time; frames that arrive while busy are dropped
// by the page (it waits for each result before sending the next frame).
let chain = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      if (!engine && msg.type !== 'init') { if (msg.bitmap) msg.bitmap.close(); return; }
      await handlers[msg.type](msg);
    } catch (err) {
      if (msg.bitmap) try { msg.bitmap.close(); } catch (_) { /* already closed */ }
      post({ type: 'error', message: (err && err.message) || String(err), where: msg.type });
    }
  });
};
