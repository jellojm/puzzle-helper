/* Vision worker: owns OpenCV, the Engine (catalog + table map) and IndexedDB
 * persistence. The page sends camera frames as ImageBitmaps and gets back
 * outlines/highlights to draw. Classic worker (importScripts) because
 * OpenCV.js is a UMD script. */
/* global importScripts, PH, cv */
'use strict';

const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const VISION = ['core', 'segment', 'pieceModel', 'box', 'matcher', 'engine'];

let engine = null;
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
async function saveSettings() {
  if (db) await tx('meta', 'readwrite', (s) => s.put({ minDE: engine.opts.minDE, taught: engine.taught }, 'settings'));
}

const handlers = {
  init,
  frame(msg) {
    const src = bitmapSource(msg.bitmap);
    const out = engine.processFrame(src, { still: msg.still });
    msg.bitmap.close();
    out.type = 'frame';
    out.frameW = src.w; out.frameH = src.h;
    post(out);
    scheduleSave();
  },
  snap(msg) {
    post({ type: 'status', text: 'Cataloging photo…' });
    const src = bitmapSource(msg.bitmap);
    const res = engine.processSnap(src);
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
  region(msg) {
    const n = engine.selectRegion(msg.c0, msg.r0, msg.c1, msg.r1);
    post({ type: 'region', count: n, cells: [msg.c0, msg.r0, msg.c1, msg.r1] });
  },
  clearHighlights() { engine.selection = null; engine.region = null; },
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
    engine.clearBackground();
    await saveSettings();
    post({ type: 'taught', count: 0 });
  },
  async reset(msg) {
    const keepBox = msg.keepBox ? engine.box : null;
    engine.reset();
    if (keepBox) engine.box = keepBox;
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
