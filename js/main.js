// Page controller: camera, frame pump to the vision worker, overlay, UI.
import { frameMapping, sizeCanvas, drawOverlay, drawThumb, EDGE_COLORS } from './overlay.js';
import { BoxSetup } from './boxSetup.js';

const APP_VERSION = '0.3.0';
const $ = (id) => document.getElementById(id);
const video = $('video'), overlay = $('overlay'), minimap = $('minimap');

const S = {
  mode: 'scan',
  ready: false,
  busy: false,
  last: null,       // latest frame result from the worker
  box: null,        // {cols, rows, preview}
  boxImg: null,     // canvas with the box preview
  desc: null,       // selected piece description
  region: null,     // [c0, r0, c1, r1]
  debug: false,
  lastSend: 0,
  motion: { rot: 0, acc: 0, t: 0 },
  fps: 0,
  errors: [],       // recent errors, included in reports
  history: [],      // recent frame timings, included in reports
};
window.addEventListener('error', (e) => logError('page: ' + e.message));
window.addEventListener('unhandledrejection', (e) => logError('promise: ' + (e.reason && e.reason.message || e.reason)));
function logError(msg) { S.errors.push({ t: new Date().toISOString(), msg: String(msg) }); if (S.errors.length > 50) S.errors.shift(); }

// ---------- worker ----------
const worker = new Worker('js/worker.js');
const W = { post: (m, t) => worker.postMessage(m, t || []) };
const boxSetup = new BoxSetup(W, () => toast('Preparing box picture…'), toast);

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'status': setStatus(m.text); break;
    case 'ready':
      S.ready = true;
      setStatus('');
      $('modeHint').textContent = modeHint(S.mode);
      setBox(m.box);
      if (m.settings) { $('sens').value = m.settings.minDE; $('sensVal').textContent = m.settings.minDE; showTaught(m.settings.taught); }
      updateStats(m.counts);
      break;
    case 'frame': {
      const now = performance.now();
      S.fps = S.fps * 0.8 + (1000 / Math.max(1, now - (S.lastResult || now))) * 0.2;
      S.lastResult = now;
      S.last = m;
      S.busy = false;
      S.history.push({ t: Math.round(now), grab: Math.round(S.grabMs || 0), ...Object.fromEntries(Object.entries(m.timings).map(([k, v]) => [k, Math.round(v)])), dets: m.dets.length, tracking: m.tracking, island: m.island, still: S.lastStill });
      if (S.history.length > 60) S.history.shift();
      updateStats(m.counts, m.tracking);
      if (S.debug) showDebug(m);
      break;
    }
    case 'snap': {
      S.snapping = false;
      const r = m.result;
      toast(`Photo: ${r.found} pieces found, ${r.added} new, ${r.shaped} shapes read${r.located ? '' : ' (not yet linked to your table map — sweep over it to connect)'}.`, 4500);
      updateStats(r.counts);
      break;
    }
    case 'box': setBox(m.box); toast(`Box picture ready: ${m.box.cols} × ${m.box.rows} grid.`); break;
    case 'taught': showTaught(m.count); break;
    case 'boxCorners': if (m.corners) boxSetup.setCorners(m.corners); break;
    case 'selected': showFind(m.desc); break;
    case 'region': S.region = m.cells; toast(m.count ? `${m.count} catalogued pieces belong in that area.` : 'No catalogued pieces placed in that area yet.'); drawMinimap(); break;
    case 'report': finishReport(m.data); break;
    case 'error':
      S.busy = false; S.snapping = false;
      logError(`worker(${m.where}): ${m.message}`);
      console.error('worker:', m.where, m.message);
      toast('Error: ' + m.message, 4000);
      break;
  }
};
worker.onerror = (e) => { setStatus('Vision worker failed to start: ' + (e.message || 'unknown error')); };

function setStatus(t) {
  $('startStatus').textContent = t || '';
  if (t && !$('app').hidden) $('modeHint').textContent = t;
}

// ---------- camera / video ----------
async function openCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  video.srcObject = stream;
  S.track = stream.getVideoTracks()[0];
  S.track.addEventListener('ended', () => ensureCamera());
  await video.play();
}
// iOS hands the camera to the photo picker (Box/Snap) or another app and
// doesn't give it back; reopen it whenever we come back to a dead stream.
async function ensureCamera() {
  if (!S.usingCamera || S.reopening || document.hidden || S.pickerOpen) return;
  const dead = !S.track || S.track.readyState === 'ended' || S.track.muted || video.paused;
  if (!dead) return;
  S.reopening = true;
  try { await openCamera(); } catch (e) { logError('camera reopen: ' + e.message); }
  S.reopening = false;
}
// While a photo picker has the camera, don't fight it for the camera.
document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('#snapBtn, #boxPick, #boxRetake')) S.pickerOpen = true; }, true);
const pickerDone = () => { S.pickerOpen = false; setTimeout(ensureCamera, 300); };
['snapInput', 'boxInput'].forEach((id) => { $(id).addEventListener('change', pickerDone); $(id).addEventListener('cancel', pickerDone); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(pickerDone, 800); });
window.addEventListener('focus', () => setTimeout(pickerDone, 800));
setInterval(ensureCamera, 2000);

async function startCamera() {
  $('startBtn').disabled = true;
  setStatus('Starting camera…');
  await requestMotion();
  try {
    await openCamera();
    S.usingCamera = true;
    $('torchRow').hidden = false;
    enterApp();
  } catch (e) {
    $('startBtn').disabled = false;
    setStatus(window.isSecureContext ? 'Camera unavailable: ' + e.message : 'The camera needs an https:// address (or localhost).');
  }
}
async function startVideoFile(file) {
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  video.loop = true;
  await video.play();
  enterApp();
}
function enterApp() {
  $('start').hidden = true;
  $('app').hidden = false;
  if (!S.workerStarted) { S.workerStarted = true; W.post({ type: 'init' }); }
  if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  setMode('scan');
  requestAnimationFrame(loop);
}

// Device motion -> "still" flag so blurry frames aren't used for shape reading.
async function requestMotion() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      await DeviceMotionEvent.requestPermission();
    }
  } catch (_) { /* denied: treat as always still */ }
  window.addEventListener('devicemotion', (e) => {
    const r = e.rotationRate || {}, a = e.acceleration || {};
    const rot = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
    const acc = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    S.motion.rot = S.motion.rot * 0.7 + rot * 0.3;
    S.motion.acc = S.motion.acc * 0.7 + acc * 0.3;
    S.motion.t = performance.now();
  });
}
function isStill() {
  if (performance.now() - S.motion.t > 1500) return true; // no sensor data
  return S.motion.rot < 25 && S.motion.acc < 0.7;
}

async function sendFrame() {
  S.busy = true;
  S.lastSend = performance.now();
  const g0 = performance.now();
  let bmp;
  try {
    bmp = await createImageBitmap(video);
  } catch (_) {
    const c = S.grab || (S.grab = document.createElement('canvas'));
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    bmp = await createImageBitmap(c);
  }
  S.grabMs = performance.now() - g0;
  S.lastStill = isStill();
  W.post({ type: 'frame', bitmap: bmp, still: S.lastStill }, [bmp]);
}

function loop() {
  requestAnimationFrame(loop);
  const ctx = sizeCanvas(overlay);
  if (S.last && video.videoWidth) {
    const M = frameMapping(video, overlay, S.last);
    S.map = M;
    drawOverlay(ctx, S.last, M, { mode: S.mode });
  }
  const minGap = 110; // ~8 frames/s is plenty and saves battery
  if (S.ready && !S.busy && !S.snapping && video.readyState >= 2 && !document.hidden && performance.now() - S.lastSend > minGap) {
    sendFrame().catch(() => { S.busy = false; });
  }
}

// ---------- UI ----------
function endTeaching() { S.teaching = false; $('teachBar').hidden = true; }
function setMode(mode) {
  endTeaching();
  S.mode = mode;
  document.querySelectorAll('#toolbar [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('modeHint').textContent = S.ready ? modeHint(mode) : $('modeHint').textContent;
  if (mode === 'scan') { closeFind(); W.post({ type: 'clearHighlights' }); S.region = null; drawMinimap(); }
}
document.querySelectorAll('#toolbar [data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

function modeHint(mode) {
  return mode === 'scan' ? 'Sweep slowly over the pieces' : 'Tap a piece to find its matches';
}

function updateStats(c, tracking) {
  if (!c) return;
  const parts = [`${c.pieces} pieces`];
  if (S.box) parts.push(`${c.placed} placed`);
  $('stats').textContent = parts.join(' · ');
  $('menuStats').textContent = `${c.pieces} pieces catalogued, ${c.shaped} shapes read, ${c.placed} placed on the box, ${c.located} on the table map.`;
  const dot = $('trackDot');
  if (tracking !== undefined) {
    dot.className = 'dot ' + (tracking ? 'on' : 'lost');
    const lost = !tracking && c.pieces > 0 && S.last && S.last.dets.length > 0;
    $('banner').hidden = !lost || S.teaching;
    if (lost) $('banner').textContent = 'Lost my place — hold still over pieces you have already scanned.';
  }
}

let toastTimer = null;
function toast(text, ms) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms || 2500);
}

function showDebug(m) {
  const t = m.timings;
  const el = $('debug');
  el.hidden = false;
  el.textContent = [
    `fps ${S.fps.toFixed(1)}  frame ${m.frameW}x${m.frameH} → ${m.procW}x${m.procH}`,
    `seg ${t.seg.toFixed(0)}  map ${t.map.toFixed(0)}  work ${t.work.toFixed(0)}  total ${t.total.toFixed(0)} ms`,
    `shapes +${t.t1}  placed +${t.t2}  dets ${m.dets.length}  island ${m.island}`,
    `bg Lab ${m.bg.L.toFixed(0)},${m.bg.a.toFixed(0)},${m.bg.b.toFixed(0)}  thresh ΔE ${m.thresh.toFixed(1)}`,
    `still ${isStill()}  rot ${S.motion.rot.toFixed(0)}°/s`,
  ].join('\n');
}

// ---------- teach background ----------
function showTaught(n) {
  $('teachCount').textContent = n ? `${n} spot${n > 1 ? 's' : ''}` : 'auto';
  if (S.teaching) $('teachText').textContent = n ? `${n} spot${n > 1 ? 's' : ''} learned. Keep tapping any surface that still shows outlines; tap Done when pieces stand out.` : 'Tap bare table in a few spots — every different surface (cloth, wood, tile, glass, shadow).';
}
// Average color of a small patch of the camera image under a screen point.
function sampleVideo(clientX, clientY) {
  if (!S.map || !S.last) return null;
  const r = overlay.getBoundingClientRect();
  const [fx, fy] = S.map.toFrame(clientX - r.left, clientY - r.top);
  const vx = Math.round(fx / S.last.scale), vy = Math.round(fy / S.last.scale);
  const c = S.sampler || (S.sampler = document.createElement('canvas'));
  c.width = c.height = 9;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(video, vx - 4, vy - 4, 9, 9, 0, 0, 9, 9);
  const d = g.getImageData(0, 0, 9, 9).data;
  const med = (k) => { const v = []; for (let i = k; i < d.length; i += 4) v.push(d[i]); v.sort((a, b) => a - b); return v[v.length >> 1]; };
  return [med(0), med(1), med(2)];
}
$('teachBtn').onclick = () => { S.teaching = true; $('menu').hidden = true; $('teachBar').hidden = false; showTaught(+($('teachCount').textContent.match(/\d+/) || [0])[0]); };
$('teachDone').onclick = endTeaching;
$('teachUndo').onclick = () => W.post({ type: 'undoBg' });
$('teachClear').onclick = () => W.post({ type: 'clearBg' });

// Tap on the overlay: select the piece under the finger.
let tapStart = null;
overlay.addEventListener('pointerdown', (e) => { tapStart = [e.clientX, e.clientY]; });
overlay.addEventListener('pointerup', (e) => {
  if (!tapStart || Math.hypot(e.clientX - tapStart[0], e.clientY - tapStart[1]) > 12) return;
  tapStart = null;
  if (!S.last || !S.map) return;
  if (S.teaching) {
    const rgb = sampleVideo(e.clientX, e.clientY);
    if (rgb) W.post({ type: 'teachBg', rgb });
    return;
  }
  const r = overlay.getBoundingClientRect();
  const [fx, fy] = S.map.toFrame(e.clientX - r.left, e.clientY - r.top);
  const hit = S.last.dets.find((d) => d.id && pointInPoly(fx, fy, d.pts));
  if (hit) {
    if (S.mode !== 'find') setMode('find');
    W.post({ type: 'select', id: hit.id });
  } else if (S.mode === 'find') {
    W.post({ type: 'select', id: null });
  }
});
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length / 2 - 1; i < pts.length / 2; j = i++) {
    const xi = pts[2 * i], yi = pts[2 * i + 1], xj = pts[2 * j], yj = pts[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- find panel ----------
const SIDE = { T: 'tab', B: 'blank', F: 'flat edge' };
function showFind(desc) {
  S.desc = desc;
  drawMinimap();
  if (!desc) { closeFind(); return; }
  $('findPanel').hidden = false;
  $('menu').hidden = true;
  const p = desc.piece;
  drawThumb($('selThumb'), p, null);
  $('selTitle').textContent = `Piece #${p.id}` + (p.code ? ` · ${p.code.split('').map((c) => SIDE[c][0].toUpperCase()).join('')}` : '');
  let sub = desc.status || '';
  if (!sub && p.t2 && p.t2.cands.length) {
    const c = p.t2.cands[0];
    sub = `Box: column ${c.col + 1}, row ${c.row + 1} · ${Math.round(p.t2.conf * 100)}% sure`;
  } else if (!sub) sub = S.box ? 'Not placed on the box yet' : 'Add a box picture to see where it goes';
  $('selSub').textContent = sub;
  const rows = $('edgeRows');
  rows.innerHTML = '';
  desc.edges.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'edge-row';
    const h = document.createElement('h4');
    const sw = document.createElement('canvas');
    sw.width = sw.height = 44; sw.style.width = sw.style.height = '22px';
    drawThumb(sw, p, e.edge, EDGE_COLORS[e.edge]);
    h.append(sw, document.createTextNode(` Edge ${e.edge + 1}: ${SIDE[e.type]}`));
    row.append(h);
    const list = document.createElement('div');
    list.className = 'cands';
    if (e.type === 'F') list.innerHTML = '<span class="empty">Border edge — nothing attaches here.</span>';
    else if (e.joined) list.innerHTML = '<span class="empty">Marked as joined.</span>';
    else if (!e.matches.length) list.innerHTML = '<span class="empty">No candidates yet — scan more pieces.</span>';
    e.matches.slice(0, 4).forEach((m, i) => {
      const c = document.createElement('div');
      c.className = 'cand ' + (i === 0 ? 'gold' : i < 3 ? 'silver' : '');
      const cv = document.createElement('canvas');
      cv.width = cv.height = 144;
      drawThumb(cv, m, m.edgeB, EDGE_COLORS[e.edge]);
      const label = document.createElement('div');
      label.textContent = `#${m.id} · ${Math.round((m.prob || 0) * 100)}%${m.loopOk ? ' · 2×2 ✓' : m.adj > 0.3 ? ' · box ✓' : ''}`;
      label.title = m.located ? '' : 'Not on the table map right now';
      const acts = document.createElement('div');
      acts.className = 'acts';
      const yes = document.createElement('button'); yes.className = 'yes'; yes.textContent = 'Fits';
      const no = document.createElement('button'); no.textContent = 'No';
      yes.onclick = () => W.post({ type: 'feedback', kind: 'joined', a: p.id, ka: e.edge, b: m.id, kb: m.edgeB });
      no.onclick = () => W.post({ type: 'feedback', kind: 'wrong', a: p.id, ka: e.edge, b: m.id, kb: m.edgeB });
      acts.append(yes, no);
      c.append(cv, label, acts);
      list.append(c);
    });
    row.append(list);
    if (e.loop && e.matches[0] && e.matches[0].loopOk) {
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = `Confirmed: #${e.loop.partner}, #${e.loop.others[0]} and #${e.loop.others[1]} close a 2×2 block with this piece.`;
      row.append(note);
    }
    rows.append(row);
  });
}
function closeFind() {
  $('findPanel').hidden = true;
  if (S.desc) { S.desc = null; W.post({ type: 'select', id: null }); }
  drawMinimap();
}
$('closeFind').onclick = closeFind;

// ---------- minimap ----------
function setBox(box) {
  S.box = box;
  if (!box) { minimap.hidden = true; return; }
  const c = document.createElement('canvas');
  c.width = box.preview.w; c.height = box.preview.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(box.preview.data), box.preview.w, box.preview.h), 0, 0);
  S.boxImg = c;
  minimap.hidden = false;
  drawMinimap();
}
function drawMinimap() {
  if (!S.box || !S.boxImg) return;
  const b = S.box, img = S.boxImg;
  const cssW = minimap.clientWidth || 200;
  const cssH = Math.round((cssW * img.height) / img.width);
  minimap.style.height = cssH + 'px';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  minimap.width = Math.round(cssW * dpr); minimap.height = Math.round(cssH * dpr);
  const ctx = minimap.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(img, 0, 0, cssW, cssH);
  const cw = cssW / b.cols, ch = cssH / b.rows;
  const cell = (c, r, color, width) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.strokeRect(c * cw, r * ch, cw, ch); };
  if (S.region) {
    const [c0, r0, c1, r1] = S.region;
    ctx.fillStyle = 'rgba(255,79,216,0.25)';
    ctx.fillRect(c0 * cw, r0 * ch, (c1 - c0 + 1) * cw, (r1 - r0 + 1) * ch);
    ctx.strokeStyle = '#ff4fd8'; ctx.lineWidth = 2;
    ctx.strokeRect(c0 * cw, r0 * ch, (c1 - c0 + 1) * cw, (r1 - r0 + 1) * ch);
  }
  if (S.desc && S.desc.piece.t2) {
    const cands = S.desc.piece.t2.cands;
    cands.slice(1, 3).forEach((k) => cell(k.col, k.row, 'rgba(255,255,255,0.6)', 1.5));
    if (cands[0]) {
      const k = cands[0];
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(k.col * cw, k.row * ch, cw, ch);
      cell(k.col, k.row, '#ffffff', 2.5);
    }
  }
  if (S.dragCells) {
    const [c0, r0, c1, r1] = S.dragCells;
    ctx.setLineDash([4, 3]); ctx.strokeStyle = '#ff4fd8'; ctx.lineWidth = 2;
    ctx.strokeRect(c0 * cw, r0 * ch, (c1 - c0 + 1) * cw, (r1 - r0 + 1) * ch);
    ctx.setLineDash([]);
  }
}
function cellAt(e) {
  const r = minimap.getBoundingClientRect();
  const c = Math.floor(((e.clientX - r.left) / r.width) * S.box.cols);
  const rr = Math.floor(((e.clientY - r.top) / r.height) * S.box.rows);
  return [Math.max(0, Math.min(S.box.cols - 1, c)), Math.max(0, Math.min(S.box.rows - 1, rr))];
}
let mmStart = null;
minimap.addEventListener('pointerdown', (e) => { mmStart = cellAt(e); minimap.setPointerCapture(e.pointerId); S.dragCells = [mmStart[0], mmStart[1], mmStart[0], mmStart[1]]; drawMinimap(); });
minimap.addEventListener('pointermove', (e) => {
  if (!mmStart) return;
  const c = cellAt(e);
  S.dragCells = [Math.min(mmStart[0], c[0]), Math.min(mmStart[1], c[1]), Math.max(mmStart[0], c[0]), Math.max(mmStart[1], c[1])];
  drawMinimap();
});
minimap.addEventListener('pointerup', () => {
  if (!mmStart) return;
  let [c0, r0, c1, r1] = S.dragCells;
  if (c0 === c1 && r0 === r1) {
    // Single tap: toggle the large view, or pick a 3x3 block when already large.
    if (!minimap.classList.contains('big')) { minimap.classList.add('big'); mmStart = null; S.dragCells = null; drawMinimap(); return; }
    c0 = Math.max(0, c0 - 1); r0 = Math.max(0, r0 - 1); c1 = Math.min(S.box.cols - 1, c1 + 1); r1 = Math.min(S.box.rows - 1, r1 + 1);
  }
  mmStart = null; S.dragCells = null;
  minimap.classList.remove('big');
  if (S.mode !== 'find') { S.mode = 'find'; document.querySelectorAll('#toolbar [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'find')); }
  $('findPanel').hidden = true;
  W.post({ type: 'region', c0, r0, c1, r1 });
});

// ---------- snap / box / menu ----------
$('snapBtn').onclick = () => { endTeaching(); $('snapInput').click(); };
$('snapInput').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  S.snapping = true;
  S.lastSnapFile = f;
  toast('Cataloging photo…', 15000);
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    W.post({ type: 'snap', bitmap: bmp }, [bmp]);
  } catch (err) {
    S.snapping = false;
    toast('Could not read that photo.');
  }
};
$('boxBtn').onclick = () => { endTeaching(); boxSetup.open(); };
$('menuBtn').onclick = () => {
  endTeaching(); $('menu').hidden = !$('menu').hidden; $('findPanel').hidden = true; };
$('closeMenu').onclick = () => ($('menu').hidden = true);
$('sens').oninput = (e) => {
  const v = parseInt(e.target.value, 10);
  $('sensVal').textContent = v;
  W.post({ type: 'settings', settings: { minDE: v } });
};
// Flashlight: iOS Safari 17.5+ accepts the torch constraint even when
// getCapabilities() doesn't advertise it, so just try it.
$('torchToggle').onchange = async (e) => {
  try {
    await S.track.applyConstraints({ advanced: [{ torch: e.target.checked }] });
  } catch (err) {
    e.target.checked = false;
    toast('This phone/browser does not allow the flashlight from a web page.');
  }
};
$('debugToggle').onchange = (e) => { S.debug = e.target.checked; $('debug').hidden = !S.debug; };
$('newPuzzle').onclick = () => {
  if (confirm('Forget all catalogued pieces? The box picture is kept.')) { W.post({ type: 'reset', keepBox: true }); closeFind(); }
};
$('clearAll').onclick = () => {
  if (confirm('Forget all pieces and the box picture?')) { W.post({ type: 'reset', keepBox: false }); closeFind(); }
};

// ---------- debug report ----------
// Bundles what's needed to diagnose problems: the current camera frame (full
// resolution), the last Snap photo, and a JSON file with timings, settings,
// what was detected and the catalog. Shared via the iOS share sheet, so it
// can be saved to Files/OneDrive or sent anywhere.
$('reportBtn').onclick = () => {
  $('menu').hidden = true;
  toast('Preparing report…', 10000);
  W.post({ type: 'report' });
};
async function finishReport(workerData) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const files = [];
  try {
    if (video.videoWidth) {
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      if (blob) files.push(new File([blob], `puzzle-report-${stamp}-frame.jpg`, { type: 'image/jpeg' }));
    }
  } catch (e) { logError('report frame: ' + e.message); }
  if (S.lastSnapFile) files.push(new File([S.lastSnapFile], `puzzle-report-${stamp}-snap.jpg`, { type: S.lastSnapFile.type || 'image/jpeg' }));
  const data = {
    app: APP_VERSION, time: new Date().toISOString(), userAgent: navigator.userAgent,
    screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio, viewW: innerWidth, viewH: innerHeight },
    video: { w: video.videoWidth, h: video.videoHeight, settings: S.track && S.track.getSettings ? S.track.getSettings() : null },
    mode: S.mode, fps: S.fps, motion: S.motion, history: S.history, errors: S.errors,
    lastFrame: S.last, selected: S.desc, worker: workerData,
  };
  files.push(new File([JSON.stringify(data)], `puzzle-report-${stamp}.json`, { type: 'application/json' }));
  $('toast').hidden = true;
  try {
    if (navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, title: 'Puzzle Helper report' });
      return;
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    logError('share: ' + e.message);
  }
  // Desktop fallback: download each file.
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

$('startBtn').onclick = startCamera;
$('videoTest').onclick = (e) => { e.preventDefault(); $('videoInput').click(); };
$('videoInput').onchange = (e) => { const f = e.target.files[0]; if (f) startVideoFile(f); };
window.addEventListener('resize', drawMinimap);

// Test hook (used by test/e2e.js): screen point of a visible piece with a shape model.
window.__phPick = () => {
  if (!S.last || !S.map) return null;
  const r = overlay.getBoundingClientRect();
  for (const d of S.last.dets) {
    if (!d.id || d.border || !(d.status === 'placed' || d.status === 'shaped')) continue;
    const [x, y] = S.map.toScreen(d.cx, d.cy);
    if (document.elementFromPoint(x + r.left, y + r.top) === overlay) return [x + r.left, y + r.top];
  }
  return null;
};

// ?video=URL plays a recorded sweep instead of the camera (desktop testing).
const params = new URLSearchParams(location.search);
if (params.get('video')) {
  video.src = params.get('video');
  video.loop = true;
  video.muted = true;
  video.play().then(enterApp).catch((e) => setStatus('Could not play test video: ' + e.message));
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
