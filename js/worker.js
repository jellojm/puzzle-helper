/* Vision worker: owns OpenCV, the Engine (catalog + table map) and IndexedDB
 * persistence. The page sends camera frames as ImageBitmaps and gets back
 * outlines/highlights to draw. Classic worker (importScripts) because
 * OpenCV.js is a UMD script. */
/* global importScripts, PH, cv */
'use strict';

const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
// Our own OpenCV.js 4.10.0 build with WebAssembly SIMD (research item 9;
// build steps in PLAN-hard-issues.md): segmentation ~35% faster in node.
// Used when the browser has WebAssembly SIMD (iOS 16.4+); otherwise, or if
// it fails to load, the CDN build above.
const OPENCV_SIMD_URL = '../vendor/opencv-4.10.0-simd.js';
// A tiny module using one SIMD instruction: does this browser accept SIMD?
const simdOk = (() => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (_) { return false; } })();
const VISION = ['core', 'segment', 'pieceModel', 'box', 'matcher', 'rectify', 'sections', 'assembly', 'frame', 'border', 'engine'];

let engine = null;
const recent = []; // recent frame timings
const sentThumbs = new Map(); // Map view: piece id -> thumbnail object whose pixels the page already has
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

// Camera frames read here, in the worker (research item 8: iOS 18+ has
// MediaStreamTrackProcessor in workers): the page transfers a clone of its
// camera track, this keeps only the newest VideoFrame, and a 'frame' message
// without a bitmap analyses that one - no createImageBitmap + transfer on the
// page's main thread. The page falls back to bitmaps if this stalls.
let camReader = null, camLatest = null, camFrames = 0, camError = null, camBlank = 0;
async function camPump(track) {
  try {
    const proc = new MediaStreamTrackProcessor({ track });
    const reader = proc.readable.getReader();
    camReader = reader;
    for (;;) {
      const { value, done } = await reader.read();
      if (done || reader !== camReader) { if (value) value.close(); break; }
      if (camLatest) camLatest.close();
      camLatest = value; camFrames++;
    }
  } catch (e) { camError = String((e && e.message) || e); post({ type: 'camTrackFailed', why: camError }); }
}
function camStop() {
  if (camReader) { try { camReader.cancel(); } catch (_) { /* gone */ } camReader = null; }
  if (camLatest) { camLatest.close(); camLatest = null; }
}
// A VideoFrame as an image source (same interface as bitmapSource).
function videoFrameSource(vf) {
  const w = vf.displayWidth, h = vf.displayHeight;
  return {
    w, h,
    getProc(maxW) {
      const scale = Math.min(1, maxW / Math.max(w, h));
      const pw = Math.round(w * scale), ph = Math.round(h * scale);
      const c = canvas2d(pw, ph, 'proc');
      c.ctx.drawImage(vf, 0, 0, pw, ph);
      return { w: pw, h: ph, data: c.ctx.getImageData(0, 0, pw, ph).data, scale };
    },
    getCrop(x, y, cw, ch) {
      const c = canvas2d(cw, ch, 'crop');
      c.ctx.clearRect(0, 0, cw, ch);
      c.ctx.drawImage(vf, x, y, cw, ch, 0, 0, cw, ch);
      return { w: cw, h: ch, data: c.ctx.getImageData(0, 0, cw, ch).data };
    },
    rgba() {
      const c = canvas2d(w, h, 'full');
      c.ctx.drawImage(vf, 0, 0);
      return { w, h, data: c.ctx.getImageData(0, 0, w, h).data };
    },
  };
}

function frameFrom(src, msg, bitmap) {
  const g0 = performance.now();
  // How long the frame waited between the page sending it and this handler
  // starting (message transfer + anything queued ahead of it), on one clock.
  const waitMs = msg.sentAt ? Math.max(0, performance.timeOrigin + g0 - msg.sentAt) : null;
  const out = engine.processFrame(src, { still: msg.still, tilt: msg.tilt });
  out.timings.workerTotal = performance.now() - g0;
  if (waitMs !== null) out.timings.wait = waitMs;
  if (bitmap) bitmap.close();
  out.type = 'frame';
  out.frameW = src.w; out.frameH = src.h;
  out.fromTrack = !bitmap;
  noteTimings(out.timings);
  post(out);
  scheduleSave();
}

// ---------- IndexedDB ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('puzzle-helper', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('pieces')) d.createObjectStore('pieces', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      // v2: saved puzzles (a whole catalog each: pieces, box, answer key, border)
      if (!d.objectStoreNames.contains('library')) d.createObjectStore('library', { keyPath: 'key' });
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
  const feedback = await tx('meta', 'readonly', (s) => s.get('feedback'));
  const pframe = await tx('meta', 'readonly', (s) => s.get('pframe'));
  const asm = await tx('meta', 'readonly', (s) => s.get('asm'));
  const cellVotes = await tx('meta', 'readonly', (s) => s.get('cellVotes'));
  const boardRef = await tx('meta', 'readonly', (s) => s.get('boardRef'));
  return { pieces: pieces || [], box: box || null, settings: settings || null, feedback: feedback || [], pframe: pframe || null, asm: asm || [], cellVotes: cellVotes || null, boardRef: boardRef || null };
}
function scheduleSave() {
  if (saveTimer || !db) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (engine.asmDirty) { // the assembled part, built up from close views
      engine.asmDirty = false;
      try { await tx('meta', 'readwrite', (s) => s.put(engine.exportAsms(), 'asm')); } catch (e) { post({ type: 'error', message: 'Saving failed: ' + e.message }); }
    }
    if (engine.cellVotesDirty || engine.pframeDirty) { // the puzzle read cell by cell; a border found by itself
      const pf = engine.pframeDirty && engine.pframe ? engine.pframe.toJSON() : null;
      engine.cellVotesDirty = false; engine.pframeDirty = false;
      try { await tx('meta', 'readwrite', (s) => { s.put(engine.exportCellVotes(), 'cellVotes'); if (pf) s.put(pf, 'pframe'); }); } catch (e) { post({ type: 'error', message: 'Saving failed: ' + e.message }); }
    }
    if (engine.boardRefDirty) { // the scan's board colour (colours are corrected against it)
      engine.boardRefDirty = false;
      try { await tx('meta', 'readwrite', (s) => s.put(engine.boardRef, 'boardRef')); } catch (e) { post({ type: 'error', message: 'Saving failed: ' + e.message }); }
    }
    const { put, del } = engine.takeDirty();
    if (!put.length && !del.length) return;
    try {
      await tx('pieces', 'readwrite', (s) => { for (const p of put) s.put(p); for (const id of del) s.delete(id); });
    } catch (e) {
      post({ type: 'error', message: 'Saving failed: ' + e.message });
    }
  }, 2500);
}

// ---------- puzzle library ----------
async function currentName() {
  if (!db) return null;
  const c = await tx('meta', 'readonly', (s) => s.get('current'));
  return c ? c.name : null;
}
// Names the app made itself before v0.20 used the grid's count (a
// 1000-piece box's 27 x 37 grid = "999 pieces"); corrected in place. Names
// the owner typed are never touched.
function fixedName(e) {
  const m = e.box && /^(Puzzle .+ \()(\d+)( pieces\))$/.exec(e.name || '');
  if (!m || +m[2] !== e.box.cols * e.box.rows) return null;
  const n = PH.boxPieces(e.box);
  return n !== +m[2] ? m[1] + n + m[3] : null;
}
async function libEntries() {
  if (!db) return [];
  const all = await tx('library', 'readonly', (s) => s.getAll());
  const fix = (all || []).filter((e) => fixedName(e));
  if (fix.length) {
    const cur = await tx('meta', 'readonly', (s) => s.get('current'));
    for (const e of fix) { const nm = fixedName(e); if (cur && cur.key === e.key) cur.name = nm; e.name = nm; }
    await tx('library', 'readwrite', (s) => { for (const e of fix) s.put(e); });
    if (cur) await tx('meta', 'readwrite', (s) => s.put(cur, 'current'));
  }
  return (all || []).map((e) => ({ key: e.key, name: e.name, savedAt: e.savedAt, pieces: e.counts ? e.counts.pieces : (e.pieces || []).length,
    shaped: e.counts ? e.counts.shaped : null, grid: e.box ? `${e.box.cols} x ${e.box.rows}` : null })).sort((a, b) => b.savedAt - a.savedAt);
}
// The current catalog as a library entry (same entry as last time unless a new name is given).
async function saveCurrentToLibrary(name) {
  if (!db) return null;
  const cur = (await tx('meta', 'readonly', (s) => s.get('current'))) || null;
  const key = !name && cur ? cur.key : 'p' + Date.now();
  const nm = name || (cur && cur.name) || `Puzzle ${new Date().toLocaleDateString()}${engine.box ? ` (${PH.boxPieces(engine.box)} pieces)` : ''}`;
  const entry = { key, name: nm, savedAt: Date.now(), counts: engine.counts(),
    pieces: [...engine.pieces.values()].map((p) => engine.exportPiece(p)), box: engine.box || null,
    feedback: engine.fbLog || [], pframe: engine.pframe ? engine.pframe.toJSON() : null, asm: engine.exportAsms(), cellVotes: engine.exportCellVotes(), boardRef: engine.boardRef || null };
  await tx('library', 'readwrite', (s) => s.put(entry));
  await tx('meta', 'readwrite', (s) => s.put({ key, name: nm }, 'current'));
  return { key, name: nm, pieces: entry.pieces.length };
}

// ---------- messaging ----------
function post(msg, transfer) { self.postMessage(msg, transfer || []); }

// Whole-session timing totals for reports (the page keeps only the last few
// minutes of per-frame history): count / mean / max per stage, plus the
// recent `total`s for percentiles.
const session = { started: Date.now(), frames: 0, stats: {}, totals: [] };
function noteTimings(t) {
  session.frames++;
  for (const k in t) {
    const v = t[k];
    if (typeof v !== 'number' || !isFinite(v)) continue;
    const s = session.stats[k] || (session.stats[k] = { n: 0, sum: 0, max: 0 });
    s.n++; s.sum += v; if (v > s.max) s.max = v;
  }
  session.totals.push(t.total || 0);
  if (session.totals.length > 600) session.totals.shift();
}
function sessionSummary() {
  const q = (arr, p) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))]); };
  const stages = {};
  for (const k in session.stats) { const s = session.stats[k]; stages[k] = { n: s.n, mean: +(s.sum / s.n).toFixed(1), max: Math.round(s.max) }; }
  return { minutes: +((Date.now() - session.started) / 60000).toFixed(1), frames: session.frames,
    totalP50: q(session.totals, 0.5), totalP90: q(session.totals, 0.9), totalP99: q(session.totals, 0.99), stages };
}
function boxInfo() {
  const b = engine.box;
  if (!b) return null;
  return { cols: b.cols, rows: b.rows, preview: b.preview, srcPx: b.srcPx || null };
}

async function init(msg) {
  post({ type: 'status', text: 'Loading vision library (first time ~10 MB)…' });
  for (const f of VISION) importScripts('vision/' + f + '.js');
  // Tests only (?closeSide=N on the page URL): synthetic pieces are smaller
  // than a phone's close reads. The app never sets it.
  if (msg && msg.closeSide > 0) PH.CLOSE_SIDE = msg.closeSide;
  // The Emscripten module of the CDN build is a thenable: never `await` it,
  // and never RETURN it from an async function either (resolving a promise
  // with a thenable adopts it, and this one never settles - the app hung on
  // the CDN fallback). So start() assigns PH.cv instead of returning it.
  const start = async () => {
    const m = self.cv;
    if (m instanceof Promise) { PH.cv = await m; return; } // newer builds (ours): a real Promise
    if (!m.Mat) await new Promise((r, j) => { m.onRuntimeInitialized = r; m.onAbort = j; setTimeout(() => j(new Error('timeout')), 60000); });
    PH.cv = m;
  };
  PH.cvBuild = null;
  if (simdOk) {
    try { importScripts(OPENCV_SIMD_URL); await start(); PH.cvBuild = 'simd'; } catch (e) { self.cv = undefined; PH.cv = null; PH.cvError = String((e && e.message) || e); }
  }
  if (!PH.cvBuild) { importScripts(OPENCV_URL); await start(); PH.cvBuild = simdOk ? 'cdn (simd build failed)' : 'cdn (no simd)'; }
  engine = new PH.Engine(msg.opts || {});
  try {
    db = await openDb();
    const st = await loadState();
    engine.importState(st);
    engine.importAsms(st.asm);
    engine.importCellVotes(st.cellVotes);
    engine.fbLog = Array.isArray(st.feedback) ? st.feedback : [];
    engine.refitCalib(); // the match-probability model learns from saved Fits/No answers
    // the marked border, if it was marked on this box's grid
    if (st.pframe && engine.box && st.pframe.cols === engine.box.cols && st.pframe.rows === engine.box.rows) {
      try { engine.pframe = PH.PuzzleFrame.fromJSON(st.pframe); } catch (_) { /* old format: mark again */ }
    }
    if (st.settings) {
      if (st.settings.minDE) engine.opts.minDE = st.settings.minDE;
      engine.taught = st.settings.taught || [];
    }
  } catch (e) {
    post({ type: 'error', message: 'Storage unavailable; the catalog will not be saved (' + e.message + ')' });
  }
  post({ type: 'ready', counts: engine.counts(), box: boxInfo(), settings: settingsInfo(), border: !!engine.pframe,
    camWorker: typeof MediaStreamTrackProcessor !== 'undefined' });
  post({ type: 'feedbackStats', stats: engine.feedbackStats() }); // running match accuracy in More
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
  camTrack(msg) {
    camStop();
    if (typeof MediaStreamTrackProcessor === 'undefined') { post({ type: 'camTrackFailed', why: 'no MediaStreamTrackProcessor in the worker' }); return; }
    camPump(msg.track); // runs on its own, outside the message chain
  },
  camTrackOff() { camStop(); },
  // test hook (e2e): a WebAssembly trap like the one in the owner's screenshots
  __trap() { throw new WebAssembly.RuntimeError('Out of bounds memory access (test)'); },
  frame(msg) {
    if (msg.fromTrack) {
      // newest camera frame read in the worker (none yet: tell the page)
      const vf = camLatest; camLatest = null;
      if (!vf) { post({ type: 'frame', noFrame: true }); return; }
      try { frameFrom(videoFrameSource(vf), msg, null); } finally { vf.close(); }
      // Frames that arrive but are blank (all one value) would quietly
      // catalogue nothing: 10 in a row -> back to the page's bitmaps.
      const d = engine.lastProc && engine.lastProc.data;
      if (d) {
        let lo = 255, hi = 0;
        for (let i = 0; i < d.length; i += 4 * 97) { const v = d[i + 1]; if (v < lo) lo = v; if (v > hi) hi = v; }
        camBlank = hi - lo < 4 ? camBlank + 1 : 0;
        if (camBlank >= 10) { camStop(); post({ type: 'camTrackFailed', why: 'blank frames' }); }
      }
      return;
    }
    return frameFrom(bitmapSource(msg.bitmap), msg, msg.bitmap);
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
    // Real piece side (mm) from the finished size; else Engine.pieceMM() uses a typical one.
    if (msg.sizeCm) box.pieceMM = Math.sqrt((msg.sizeCm[0] * 10 * msg.sizeCm[1] * 10) / (box.cols * box.rows));
    msg.bitmap.close();
    engine.setBox(box); // also forgets the marked border (it was on the old grid)
    if (db) { await tx('meta', 'readwrite', (s) => s.put(box, 'box')); await tx('meta', 'readwrite', (s) => s.delete('pframe')); }
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
      if (p.t1) { pick = p; break; }
    }
    post({ type: 'selected', desc: pick ? engine.select(pick.id) : null });
  },
  region(msg) {
    const n = engine.selectRegion(msg.c0, msg.r0, msg.c1, msg.r1);
    // One cell: "fill this spot" - the loose pieces ranked for it.
    let fill = null;
    if (msg.c0 === msg.c1 && msg.r0 === msg.r1) {
      const f = engine.fillSpot(msg.c0, msg.r0, 8);
      fill = Object.assign(f, { cands: f.cands.map((c) => { const Q = engine.pieces.get(c.id); return Object.assign(c, { thumb: Q.t1.thumb, corners: Q.t1.corners, sigs: Q.t1.edges.map((e) => e.sig), located: !!Q.pos }); }) });
      engine.region = { c0: msg.c0, r0: msg.r0, c1: msg.c1, r1: msg.r1, ids: new Set(f.cands.slice(0, 5).map((c) => c.id)), best: f.cands.length ? f.cands[0].id : null };
    }
    post({ type: 'region', count: n, cells: [msg.c0, msg.r0, msg.c1, msg.r1], fill });
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
  // "In the puzzle": the owner placed this piece (or takes that back).
  inPuzzle(msg) {
    engine.setInPuzzle(msg.id, !!msg.on);
    scheduleSave();
    post({ type: 'inPuzzle', id: msg.id, on: !!msg.on, counts: engine.counts() });
    if (engine.selection) post({ type: 'selected', desc: engine.describe(engine.selection.id) });
  },
  // Table view: every catalogued piece with its position, read placement and
  // picture. A thumbnail's pixels go to the page once: later visits send
  // data: null for a thumbnail already sent (the page keeps it), so opening
  // Map on a big table doesn't copy every picture again.
  mapData() {
    const d = engine.mapData();
    for (const p of d.pieces) {
      if (!p.thumb) continue;
      if (sentThumbs.get(p.id) === p.thumb) p.thumb = Object.assign({}, p.thumb, { data: null });
      else sentThumbs.set(p.id, p.thumb);
    }
    post({ type: 'mapData', data: d });
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
      rot: p.t2 && p.t2.cands.length ? p.t2.cands[0].rot : undefined,
      seenSecAgo: p.lastSeen ? Math.round((Date.now() - p.lastSeen) / 1000) : null,
      color: p.fp ? (p.fp.raw || [p.fp.L, p.fp.a, p.fp.b]).map((v) => Math.round(v)) : null, colorRel: p.fp ? [p.fp.L, p.fp.a, p.fp.b].map((v) => Math.round(v)) : null,
      views: p.t1 ? p.t1.nObs || 1 : 0, q: p.t1 && p.t1.quality ? p.t1.quality.q : null, sharp: p.t1 && p.t1.quality ? p.t1.quality.sharp : null,
      unc: p.t1 ? p.t1.edges.map((e) => (e.unc ? 1 : 0)).join('') : null, conflicts: p.conflicts || 0, missing: !!p.missing,
      // v0.20: why it is (not) checked, and where it is (on the table / moved / in the puzzle)
      state: p.state || 'checking', closeRead: !!(p.t1 && PH.isCloseRead(p.t1)), closeAgree: p.closeAgree || 0, sightings: p.sightings || 0, moments: p.moments || 0,
      closeViews: p.closeViews || 0, photoRead: !!p.photoRead, seenWith: p.seenWith ? p.seenWith.size : 0, gone: !!p.gone, refound: p.refound || 0, notHere: p.notHere || 0,
    }));
    // Engine state that explains behaviour but isn't in any frame result.
    const bm = engine.bgModel;
    const doubt = engine.cornerDoubts ? engine.cornerDoubts() : new Set();
    const engineState = {
      frameNo: engine.fNo || 0, lostFrames: engine.lost, island: engine.island, nextIsland: engine.nextIsland,
      poseScale: engine.pose ? +Math.hypot(engine.pose.a, engine.pose.b).toFixed(3) : null,
      unitLive: engine.unitLive ? Math.round(engine.unitLive) : null, unitTable: engine.unitTable ? Math.round(engine.unitTable() || 0) : null,
      bgModel: bm ? { kind: bm.kind, bg: bm.bg ? [bm.bg.L, bm.bg.a, bm.bg.b].map((v) => Math.round(v)) : undefined, n: bm.list ? bm.list.length : undefined } : null,
      bgModelChosenAtFrame: engine.bgModelAt || null, bgEvaluating: !!engine.bgEval, poorStreak: engine.poorStreak || 0,
      catalogVersion: engine.version, matchCache: engine.matchCache ? engine.matchCache.size : null, unsaved: engine.dirty ? engine.dirty.size : null,
      // WebAssembly heap: grows without bound if OpenCV Mats leak.
      wasmHeapMB: PH.cv && PH.cv.HEAP8 ? +(PH.cv.HEAP8.buffer.byteLength / 1048576).toFixed(1) : null,
      cornerDoubts: [...doubt],
      border: engine.pframe ? { features: engine.pframe.feat.n, tries: engine.pfTries || 0, found: engine.pfFound || 0,
        lastMatch: engine.pframe.lastMatch || null, lastInliers: engine.pfLoc ? engine.pfLoc.inliers || 0 : 0,
        lastFoundSecAgo: engine.pfLoc && engine.pfLoc.H ? Math.round((performance.now() - engine.pfLoc.t) / 1000) : null } : null,
    };
    // Catalog shape at a glance (the full list is below).
    const all = [...engine.pieces.values()];
    const ages = all.filter((p) => p.lastSeen).map((p) => (Date.now() - p.lastSeen) / 1000).sort((a, b) => a - b);
    const catalog = {
      entries: all.length, withShape: all.filter((p) => p.t1).length, assembly: engine.assemblyInfo(), assemblies: (engine.asms || []).map((A) => ({ id: A.id, cells: A.cells.size, views: A.views, place: A.place, onMap: !!(A.tab && A.tab.T) })),
      neverShaped: all.filter((p) => !p.t1).length, shapeFailing: all.filter((p) => !p.t1 && (p.t1Fail || 0) >= 3).length,
      lastSeenSecMedian: ages.length ? Math.round(ages[ages.length >> 1]) : null,
      perIsland: all.reduce((m, p) => { m[p.island] = (m[p.island] || 0) + 1; return m; }, {}),
      placedConfHist: all.filter((p) => p.t2 && p.t2.cands.length).reduce((h, p) => { const b = Math.min(9, Math.floor(p.t2.conf * 10)); h[b] = (h[b] || 0) + 1; return h; }, {}),
    };
    post({ type: 'report', analyzed, boxImg, data: {
      opts: engine.opts, taught: engine.taught, counts: engine.counts(), bg: engine.bg, thresh: engine.thresh,
      box: engine.box ? { cols: engine.box.cols, rows: engine.box.rows, white: engine.box.white } : null,
      island: engine.island, tracking: !!engine.pose, engine: engineState, catalog, session: sessionSummary(), pieces,
      // Fits/No answers (ground truth) and what the app had claimed: match accuracy on the real puzzle.
      feedback: { stats: engine.feedbackStats(), log: (engine.fbLog || []).slice(-300) },
      // Why detections did not become pieces (shot-quality gate), and provisional pieces waiting.
      gate: { rejects: engine.rejects || {}, candidates: engine.cands ? engine.cands.size : 0, pieceMM: engine.pieceMM ? engine.pieceMM() : null },
      // v0.20: housekeeping (replaces Tidy up), why entries wait as rings, the colour rule's tolerance
      housekeeping: Object.assign({}, engine.hk || {}, { mergedInto: engine.mergedInto ? engine.mergedInto.size : 0 }),
      unchecked: engine.whyUnchecked ? engine.whyUnchecked() : null, colTol: PH.colTol, colourHealth: engine.colourHealth ? engine.colourHealth() : null, events: (engine.events || []).slice(-120), overCount: engine.box ? Math.max(0, engine.counts().pieces - PH.boxPieces(engine.box)) : 0,
      cvBuild: PH.cvBuild, cvError: PH.cvError || null, simd: simdOk,
      camWorker: { frames: camFrames, reading: !!camReader, error: camError },
      cvInfo: PH.cv && PH.cv.getBuildInformation ? String(PH.cv.getBuildInformation()).slice(0, 3000) : null,
    } });
  },
  async feedback(msg) {
    engine.feedback(msg);
    scheduleSave();
    // The answer key is small and precious: save it right away.
    if (db) await tx('meta', 'readwrite', (s) => s.put(engine.fbLog, 'feedback'));
    post({ type: 'feedbackStats', stats: engine.feedbackStats() });
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
  async frameMark(msg) {
    const src = bitmapSource(msg.bitmap);
    const r = engine.setPuzzleFrame(src, { tilt: msg.tilt }, msg.corners);
    msg.bitmap.close();
    if (r.ok && db) await tx('meta', 'readwrite', (s) => s.put(engine.pframe.toJSON(), 'pframe'));
    post({ type: 'frameMarked', ok: r.ok, why: r.why, features: r.features });
  },
  async frameClear() {
    engine.clearPuzzleFrame();
    if (db) await tx('meta', 'readwrite', (s) => s.delete('pframe'));
    post({ type: 'frameMarked', ok: false, cleared: true });
  },
  // ---------- puzzle library: several puzzles on the go ----------
  async libList() {
    // The menu is open (camera paused): a full housekeeping pass now, so what
    // is shown - and what Save keeps - is already cleaned up (plan T1).
    engine.housekeep(Infinity);
    scheduleSave();
    post({ type: 'library', list: await libEntries(), current: await currentName(), counts: engine.counts() });
  },
  // Save the current catalog into the library (under its own name; a new
  // name makes a new entry).
  async libSave(msg) {
    engine.housekeep(Infinity); // (what is saved is cleaned up, as a reopened scan would be)
    const r = await saveCurrentToLibrary(msg.name);
    post({ type: 'library', list: await libEntries(), current: await currentName(), saved: r, counts: engine.counts() });
  },
  // Open a saved puzzle: the current one is saved first (nothing is lost).
  async libOpen(msg) {
    if (!db) return;
    const e = await tx('library', 'readonly', (s) => s.get(msg.key));
    if (!e) return;
    if (engine.pieces.size) await saveCurrentToLibrary();
    engine.importState({ pieces: e.pieces || [], box: e.box || null, boardRef: e.boardRef || null });
    engine.importAsms(e.asm);
    engine.importCellVotes(e.cellVotes);
    engine.fbLog = Array.isArray(e.feedback) ? e.feedback : [];
    engine.refitCalib();
    engine.pframe = null;
    if (e.pframe && engine.box && e.pframe.cols === engine.box.cols && e.pframe.rows === engine.box.rows) {
      try { engine.pframe = PH.PuzzleFrame.fromJSON(e.pframe); } catch (_) { /* mark again */ }
    }
    await tx('pieces', 'readwrite', (s) => { s.clear(); for (const p of e.pieces || []) s.put(p); });
    await tx('meta', 'readwrite', (s) => {
      if (e.box) s.put(e.box, 'box'); else s.delete('box');
      s.put(engine.fbLog, 'feedback');
      if (e.pframe) s.put(e.pframe, 'pframe'); else s.delete('pframe');
      s.put(e.asm || [], 'asm');
      s.put(e.cellVotes || null, 'cellVotes');
      s.put(e.boardRef || null, 'boardRef');
      s.put({ key: e.key, name: e.name }, 'current');
    });
    post({ type: 'ready', counts: engine.counts(), box: boxInfo(), settings: settingsInfo(), border: !!engine.pframe, opened: e.name });
    post({ type: 'feedbackStats', stats: engine.feedbackStats() });
    post({ type: 'library', list: await libEntries(), current: e.name });
  },
  async libDelete(msg) {
    if (db) await tx('library', 'readwrite', (s) => s.delete(msg.key));
    post({ type: 'library', list: await libEntries(), current: await currentName() });
  },
  async reset(msg) {
    // A new puzzle: the old catalog goes into the library first (nothing lost).
    if (msg.keepOld !== false && engine.pieces.size) await saveCurrentToLibrary();
    if (db) await tx('meta', 'readwrite', (s) => s.delete('current'));
    const keepBox = msg.keepBox ? engine.box : null;
    engine.reset();
    if (keepBox) engine.box = keepBox;
    // A new puzzle is often a new table (or new light): taught colours from the
    // old one make the board look like a piece. The page asks; this forgets.
    if (msg.forgetTable) { forgetTable(); await saveSettings(); }
    if (db) {
      await tx('pieces', 'readwrite', (s) => s.clear());
      await tx('meta', 'readwrite', (s) => s.delete('feedback')); // the answer key belongs to the old catalog
      if (!keepBox) await tx('meta', 'readwrite', (s) => s.delete('box'));
      await tx('meta', 'readwrite', (s) => s.delete('pframe')); // a new puzzle has its own border
      await tx('meta', 'readwrite', (s) => s.delete('boardRef')); // (and its own board colour reference)
      await tx('meta', 'readwrite', (s) => { s.delete('asm'); s.delete('cellVotes'); }); // and its own assembled part
    }
    post({ type: 'ready', counts: engine.counts(), box: boxInfo(), settings: settingsInfo() });
    post({ type: 'feedbackStats', stats: engine.feedbackStats() });
  },
};

// Process messages one at a time; frames that arrive while busy are dropped
// by the page (it waits for each result before sending the next frame).
// A WebAssembly trap ("Out of bounds memory access", "unreachable", an abort)
// leaves OpenCV's memory broken: every later call fails the same way (owner's
// screenshots 2026-10-04: "Out of bounds memory access (evaluating
// 'rawConstructor()')" on every frame). The catalog itself is plain
// JavaScript and still fine, so save it all and let the page start a fresh
// worker. A heap close to its 1 GB ceiling gets the same fresh start before
// it fails (iOS refuses to grow it long before that).
const HEAP_LIMIT_MB = 640;
let cvDead = false;
const heapMB = () => (PH.cv && PH.cv.HEAP8 ? +(PH.cv.HEAP8.buffer.byteLength / 1048576).toFixed(1) : null);
const isFatal = (err) => (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) ||
  typeof err === 'number' || /out of bounds memory|memory access out of bounds|unreachable|aborted|abort\(|out of memory|cannot enlarge memory/i.test(String((err && err.message) || err));
async function flushAll() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!db || !engine) return;
  const { put, del } = engine.takeDirty();
  if (put.length || del.length) await tx('pieces', 'readwrite', (s) => { for (const p of put) s.put(p); for (const id of del) s.delete(id); });
  await tx('meta', 'readwrite', (s) => { s.put(engine.fbLog || [], 'feedback'); s.put(engine.exportAsms(), 'asm'); });
}
async function retire(why, where, err) {
  cvDead = true;
  camStop();
  try { await flushAll(); } catch (_) { /* best effort: most of the catalog is saved already */ }
  post({ type: 'cvDead', why, where, message: String((err && err.message) || err || why),
    stack: err && err.stack ? String(err.stack).slice(0, 1200) : null, heapMB: heapMB(), build: PH.cvBuild || null });
}
let chain = Promise.resolve();
self.onmessage = (e) => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      if (cvDead || (!engine && msg.type !== 'init')) { if (msg.bitmap) msg.bitmap.close(); if (msg.track) msg.track.stop(); return; }
      await handlers[msg.type](msg);
      const h = heapMB();
      if (h && h > HEAP_LIMIT_MB) await retire('heap', msg.type, new Error(`vision memory at ${h} MB`));
    } catch (err) {
      if (msg.bitmap) try { msg.bitmap.close(); } catch (_) { /* already closed */ }
      if (engine && isFatal(err)) { await retire('trap', msg.type, err); return; }
      post({ type: 'error', message: (err && err.message) || String(err), where: msg.type, stack: err && err.stack ? String(err.stack).slice(0, 600) : null, heapMB: heapMB() });
    }
  });
};
