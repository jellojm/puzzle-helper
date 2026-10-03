// Page controller: camera, frame pump to the vision worker, overlay, UI.
import { frameMapping, sizeCanvas, drawOverlay, drawThumb, EDGE_COLORS } from './overlay.js';
import { BoxSetup } from './boxSetup.js';

const APP_VERSION = '0.10.0';
const $ = (id) => document.getElementById(id);
const video = $('video'), overlay = $('overlay'), minimap = $('minimap');

// Things under the top bar sit below its real height (it wraps on long messages).
new ResizeObserver(() => {
  const r = $('topbar').getBoundingClientRect();
  document.documentElement.style.setProperty('--top-h', Math.round(r.bottom) + 'px');
}).observe($('topbar'));

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
  gravity: null,    // smoothed accelerationIncludingGravity (device axes)
  fov: 66,          // camera field of view across the long side (degrees)
  tiltOn: true,
  errors: [],       // recent errors, included in reports
  history: [],      // recent frame timings, included in reports
  // power
  running: false,   // the app screen is up
  active: false,    // camera + vision loop are actually running
  idle: false,      // auto-paused after the phone was left still
  idleOn: true,
  calm: 0,          // consecutive frames that taught us nothing (slows the pump)
  lastActivity: 0,
  // rendering / analysis cost
  procW: 640,       // live analysis width; see Settings > Scan detail
  outlines: false,  // dots by default, full outlines on request
  // camera-motion tracker (js/vision/flow.js): marks follow the camera between analyses
  follow: true,     // Settings > "Marks follow the camera"
  flow: null,       // {w, h, prev, total:[dx,dy] thumb px, at, steps, lowConf, ms, speed}
  flowAtSend: null, // flow.total when the frame now being analysed was grabbed
  drawnShift: null, // shift used for the last overlay draw (css px)
  // find bar
  filter: null,     // 'corner' | 'border' | 'unplaced' | 'unread'
  mapHidden: false,
  pairs: [],
  pairIdx: 0,
};
const IDLE_MS = 90000;   // phone left sitting still -> pause the camera
const BASE_GAP = 110;    // ~9 frames/s while something is happening
const MAX_GAP = 600;     // ~1.7 frames/s when nothing at all is changing
window.addEventListener('error', (e) => logError('page: ' + e.message));
window.addEventListener('unhandledrejection', (e) => logError('promise: ' + (e.reason && e.reason.message || e.reason)));
function logError(msg) { S.errors.push({ t: new Date().toISOString(), msg: String(msg) }); if (S.errors.length > 50) S.errors.shift(); }
// Session counters and main-thread health, for "Send report".
const STATS = { started: new Date().toISOString(), framesSent: 0, results: 0, cameraOpens: 0, cameraReleases: 0, idlePauses: 0,
  hidden: 0, wakeLocks: 0, reports: 0, filters: {}, drawMs: 0, drawMax: 0 };
const RAF_GAPS = new Float32Array(300); let rafGapN = 0, rafPrev = 0;
const bump = (k) => { STATS[k] = (STATS[k] || 0) + 1; };

// ---------- worker ----------
const worker = new Worker('js/worker.js');
const W = { post: (m, t) => worker.postMessage(m, t || []) };
const boxSetup = new BoxSetup(W, () => toast('Preparing box picture…'), toast, () => applyPower());

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
      W.post({ type: 'settings', settings: { procW: S.procW } }); // kept on the page, not in the worker's store
      updateStats(m.counts);
      break;
    case 'frame': {
      const now = performance.now();
      S.fps = S.fps * 0.8 + (1000 / Math.max(1, now - (S.lastResult || now))) * 0.2;
      S.lastResult = now;
      // Where the tracker stood when this frame was grabbed; marks are drawn
      // shifted by however far the camera has moved since.
      m.flowBase = S.flowAtSend;
      S.last = m;
      S.busy = false;
      bump('results');
      // lag = send -> result on the page (grab + transfer + queue + analysis + reply).
      S.history.push({ t: Math.round(now), grab: Math.round(S.grabMs || 0), lag: S.sentAt ? Math.round(now - S.sentAt) : null, ...Object.fromEntries(Object.entries(m.timings).map(([k, v]) => [k, Math.round(v)])),
        dets: m.dets.length, tracking: m.tracking, island: m.island, still: S.lastStill, tilt: m.rect ? Math.round(m.rect.tilt) : 0, proc: [m.procW, m.procH], flowEvery: S.flow ? S.flow.every : null });
      if (S.history.length > 240) S.history.shift();
      // Did this frame change anything? If not, ease off the frame pump.
      const c = m.counts, pc = S.prevCounts;
      const changed = !pc || c.pieces !== pc.pieces || c.shaped !== pc.shaped || c.placed !== pc.placed || c.sections !== pc.sections;
      S.prevCounts = c;
      // The view itself moving must also wake the pump, and it has to be
      // judged from the picture, not the motion sensor: on iOS Chrome the
      // motion permission is often off, and then isStill() is always true.
      let sx = 0, sy = 0;
      for (const d of m.dets) { sx += d.cx; sy += d.cy; }
      const sig = m.dets.length ? [m.dets.length, sx / m.dets.length, sy / m.dets.length] : null;
      const moved = !sig || !S.sig || sig[0] !== S.sig[0] ||
        Math.hypot(sig[1] - S.sig[1], sig[2] - S.sig[2]) > m.procW * 0.01;
      S.sig = sig;
      if (changed || moved || !S.lastStill || m.timings.t1 || m.timings.t2) { if (changed) noteActivity(); S.calm = 0; }
      else S.calm++;
      updateStats(m.counts, m.tracking);
      showDistanceHint(m.view);
      if (S.debug) showDebug(m);
      break;
    }
    case 'snap': {
      S.snapping = false;
      const r = m.result;
      S.lastSnapResult = Object.assign({}, r, { recognized: (r.recognized || []).length });
      const tiltNote = r.tilt ? ` Straightened for ${r.tilt}° tilt${S.snapTilt ? '' : ' (estimated from the photo)'}.` : '';
      toast(`Photo: ${r.found} pieces found, ${r.added} new, ${r.shaped} shapes read${r.located ? '' : ' (not yet linked to your table map — sweep over it to connect)'}.${tiltNote}`, 5000);
      updateStats(r.counts);
      break;
    }
    case 'box': setBox(m.box); toast(`Box picture ready: ${m.box.cols} × ${m.box.rows} grid.`); break;
    case 'taught': showTaught(m.count); break;
    case 'boxCorners': if (m.corners) boxSetup.setCorners(m.corners); break;
    case 'selected': showFind(m.desc); break;
    case 'region': S.region = m.cells; toast(m.count ? `${m.count} catalogued pieces belong in that area.` : 'No catalogued pieces placed in that area yet.'); drawMinimap(); break;
    case 'filter': {
      const label = { corner: 'corner pieces', border: 'edge pieces', edges: 'border pieces (corners and edges)', unplaced: 'pieces not placed on the box', unread: 'pieces whose shape is unread' }[m.kind];
      if (m.kind) toast(m.count ? `${m.count} ${label} highlighted. Arrows point to the nearest ones off screen.` : `No ${label} found yet — read more shapes first.`, 3500);
      S.needDraw = true;
      break;
    }
    case 'pairs':
      S.pairs = m.pairs;
      S.pairsDone = m.done;
      if (!m.done) { toast(`Looking for matches… ${m.from} of ${m.total}`, 20000); W.post({ type: 'pairs', from: m.from }); }
      else $('toast').hidden = true;
      showMatches();
      break;
    case 'feedbackStats': showAccuracy(m.stats); break;
    case 'tidied':
      toast(m.removed ? `Tidied up: removed ${m.removed} duplicate or leftover entries. ${m.counts.pieces} pieces now.`
        : 'Nothing to tidy — no duplicates found.', 5000);
      updateStats(m.counts);
      break;
    case 'report': finishReport(m.data, m.analyzed, m.boxImg); break;
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
  bump('cameraOpens');
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
  if (!S.usingCamera || S.reopening || !scanningWanted()) return;
  const dead = !S.track || S.track.readyState === 'ended' || S.track.muted || video.paused;
  if (!dead) return;
  S.reopening = true;
  try { await openCamera(); } catch (e) { logError('camera reopen: ' + e.message); }
  S.reopening = false;
  applyPower();
}

// ---------- power ----------
// The camera and the vision loop are the whole battery budget, so both stop
// the moment nothing is looking at the camera view: Settings or the box editor
// open, the app in the background, or the phone left sitting still. The camera
// is released outright (not just paused) so the recording indicator goes out.
function scanningWanted() {
  return S.running && !document.hidden && !S.pickerOpen && !S.idle &&
    $('menu').hidden && $('boxModal').hidden && $('start').hidden;
}
// Last real camera view, kept when the camera is switched off (menu, idle)
// so "Send report" can still include what the camera saw.
function keepLastFrame() {
  if (!video.videoWidth || !(video.srcObject || video.currentSrc)) return;
  const c = S.lastFrame || (S.lastFrame = document.createElement('canvas'));
  c.width = video.videoWidth; c.height = video.videoHeight;
  try { c.getContext('2d').drawImage(video, 0, 0); S.lastFrameAt = Date.now(); } catch (_) { /* not ready */ }
}
function releaseCamera() {
  bump('cameraReleases');
  keepLastFrame();
  const st = video.srcObject;
  if (st) for (const t of st.getTracks()) t.stop();
  video.srcObject = null;
  S.track = null;
  try { video.pause(); } catch (_) { /* already paused */ }
}
function applyPower() {
  const want = scanningWanted();
  $('resume').hidden = !(S.idle && S.running && !document.hidden && $('menu').hidden && $('boxModal').hidden);
  if (want === S.active) return;
  S.active = want;
  if (want) {
    acquireWakeLock();
    S.calm = 0; S.lastSend = 0; S.lastActivity = performance.now();
    // The camera was off: the tracker's last thumbnail is stale, so restart it,
    // and don't shift the old result's marks until the next one arrives.
    if (S.flow) S.flow.T.reset();
    if (S.last) S.last.flowBase = null;
    if (S.usingCamera && (!S.track || S.track.readyState === 'ended')) ensureCamera();
    else video.play().catch(() => {});
    if (!S.rafId) S.rafId = requestAnimationFrame(loop);
  } else {
    releaseWakeLock();
    if (S.usingCamera) releaseCamera();
    else try { video.pause(); } catch (_) { /* test video */ }
    if (S.rafId) { cancelAnimationFrame(S.rafId); S.rafId = null; }
    S.busy = false;
  }
}
// The screen must stay on while sweeping, but not while a menu is up.
async function acquireWakeLock() {
  if (!navigator.wakeLock || S.wakeLock) return;
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    bump('wakeLocks');
    S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
  } catch (_) { /* not supported, or denied while hidden */ }
}
function releaseWakeLock() {
  if (!S.wakeLock) return;
  S.wakeLock.release().catch(() => {});
  S.wakeLock = null;
}
// Anything that means "the user is still working" postpones the idle pause.
function noteActivity() {
  S.lastActivity = performance.now();
  S.calm = 0;
  if (S.idle) { S.idle = false; applyPower(); }
}
document.addEventListener('pointerdown', noteActivity, true);
$('resume').onclick = noteActivity;
// Whatever hides or shows a full-screen panel, the camera follows it. Watching
// the attribute is more reliable than remembering to call applyPower() from
// every button that opens or closes one.
const powerWatch = new MutationObserver(() => applyPower());
['menu', 'boxModal', 'start'].forEach((id) => powerWatch.observe($(id), { attributes: true, attributeFilter: ['hidden'] }));
// The Find chips float just above the toolbar; while the piece panel (a bottom
// sheet) is open they sat on top of its Fits/No buttons (owner's screenshot,
// 2026-10-03). Hide them while it's open — closing the panel brings them back.
const panelWatch = new MutationObserver(() => document.body.classList.toggle('panel-open', !$('findPanel').hidden));
panelWatch.observe($('findPanel'), { attributes: true, attributeFilter: ['hidden'] });
$('idleToggle').onchange = (e) => { S.idleOn = e.target.checked; noteActivity(); saveLocal(); };
// While a photo picker has the camera, don't fight it for the camera.
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('#snapBtn, #boxPick, #boxRetake')) { S.pickerOpen = true; applyPower(); }
}, true);
const pickerDone = () => { S.pickerOpen = false; noteActivity(); applyPower(); setTimeout(ensureCamera, 300); };
['snapInput', 'boxInput'].forEach((id) => { $(id).addEventListener('change', pickerDone); $(id).addEventListener('cancel', pickerDone); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { bump('hidden'); rafPrev = 0; }
  applyPower(); // backgrounded: drop the camera and the loop straight away
  if (!document.hidden) setTimeout(pickerDone, 800);
});
window.addEventListener('focus', () => setTimeout(pickerDone, 800));
setInterval(() => { if (S.active) ensureCamera(); }, 2000);

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
  S.running = true;
  noteActivity();
  setMode('scan');
  applyPower();
}

// Device motion -> "still" flag so blurry frames aren't used for shape reading.
async function requestMotion() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      await DeviceMotionEvent.requestPermission();
    }
  } catch (_) { /* denied: treat as always still */ }
  window.addEventListener('devicemotion', (e) => {
    const g = e.accelerationIncludingGravity;
    if (g && g.x != null) {
      const k = 0.2, v = [g.x, g.y, g.z];
      S.gravity = S.gravity ? S.gravity.map((x, i) => x * (1 - k) + v[i] * k) : v;
    }
    const r = e.rotationRate || {}, a = e.acceleration || {};
    const rot = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
    const acc = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
    S.motion.rot = S.motion.rot * 0.7 + rot * 0.3;
    S.motion.acc = S.motion.acc * 0.7 + acc * 0.3;
    S.motion.t = performance.now();
    S.hasMotion = true;
    // Picking the phone up or sweeping it counts as "still working"; the small
    // wobble of a phone propped on the table does not.
    if (rot > 12 || acc > 0.4) noteActivity();
  });
}
function isStill() {
  // No motion sensor (permission denied, desktop): judge from the picture. The
  // tracker's recent per-step shift is a sensor-free blur guard, so shapes are
  // not read from frames smeared by a sweep.
  if (performance.now() - S.motion.t > 1500) return !S.follow || !S.flow || S.flow.T.speed < FLOW_STILL;
  return S.motion.rot < 25 && S.motion.acc < 0.7;
}

// ---------- camera-motion tracker ----------
// A ~96 px thumbnail of the live video is matched against the frame last
// handed to the analysis (PH.FlowTracker in js/vision/flow.js: keyframe block
// matching, ~1 ms). Analysis runs a few times a second; this runs every other
// display frame, so the marks follow the pieces in between instead of jumping.
// test/flow-overlay.js checks the whole chain lands marks within ~1 px.
const FLOW_MAX = 96;        // thumbnail long side, px
// Thumb px per step (~30 Hz) under which the view counts as still: 0.12 thumb
// px ≈ 2–3 camera px of smear per frame; the noise floor when still is ~0.05.
const FLOW_STILL = 0.12;
function trackStep() {
  if (!window.PH || !PH.FlowTracker || !video.videoWidth || video.readyState < 2) return false;
  const vw = video.videoWidth, vh = video.videoHeight;
  const sc = FLOW_MAX / Math.max(vw, vh);
  const w = Math.max(8, Math.round(vw * sc)), h = Math.max(8, Math.round(vh * sc));
  let F = S.flow;
  if (!F || F.w !== w || F.h !== h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    F = S.flow = { w, h, c, g: c.getContext('2d', { willReadFrequently: true }), T: new PH.FlowTracker(w, h), ms: 0, readMs: 0, matchMs: 0, maxMs: 0, every: 2, scale: vw / w };
    if (S.last) S.last.flowBase = null; // old reference frame belonged to another tracker
  }
  // Resuming after a pause (no dots to move for a while): the last thumbnail
  // is stale, so start over rather than match across the gap.
  const t0 = performance.now();
  if (F.lastAt && t0 - F.lastAt > 500) { F.T.reset(); if (S.last) S.last.flowBase = null; F.resumes = (F.resumes || 0) + 1; }
  F.lastAt = t0;
  // Timed in two parts for the report: getting the thumbnail out of the video
  // (a GPU read-back on iOS) and matching it.
  F.g.drawImage(video, 0, 0, w, h);
  const g = PH.flowGray(F.g.getImageData(0, 0, w, h).data, w, h);
  const t1 = performance.now();
  const r = F.T.push(g);
  const t2 = performance.now();
  F.readMs = F.readMs * 0.9 + (t1 - t0) * 0.1;
  F.matchMs = F.matchMs * 0.9 + (t2 - t1) * 0.1;
  F.ms = F.ms * 0.9 + (t2 - t0) * 0.1;
  F.maxMs = Math.max(F.maxMs, t2 - t0);
  // Self-limiting: a step may use ~half a display frame on average. The
  // phone measured 21-54 ms a step in v0.9.0 (0.7 ms in node), which at
  // every other frame would have eaten the whole main thread.
  F.every = Math.max(2, Math.min(12, Math.ceil(F.ms / 8)));
  return r.moved;
}
// Only worth tracking when there are dots to move, or when the tracker is
// the stillness signal (no motion sensor).
function trackingNeeded() {
  if (!S.follow) return false;
  if (!S.hasMotion) return true;
  return !!(S.last && S.last.dets && S.last.dets.length);
}
// Camera-frame pixels the image has moved since result `res` was grabbed.
function shiftSince(res) {
  if (!S.follow || !S.flow || !res || !res.flowBase) return null;
  const k = S.flow.scale, t = S.flow.T.total;
  return { dx: (t[0] - res.flowBase[0]) * k, dy: (t[1] - res.flowBase[1]) * k };
}

// Gravity direction in camera image coordinates (X right, Y down, Z out of
// the lens) for the current screen orientation. The sign convention of the
// sensor doesn't matter: the camera is pointed at the table, so "down" is
// whichever sign has Z > 0.
function currentTilt() {
  if (!S.tiltOn || !S.gravity || performance.now() - S.motion.t > 1500) return null;
  const [dx, dy, dz] = S.gravity;
  const ang = ((screen.orientation && screen.orientation.angle) || window.orientation || 0) * Math.PI / 180;
  const sx = dx * Math.cos(ang) - dy * Math.sin(ang), sup = dx * Math.sin(ang) + dy * Math.cos(ang);
  let down = [sx, -sup, -dz];
  if (down[2] < 0) down = down.map((v) => -v);
  const n = Math.hypot(...down);
  if (!n) return null;
  return { down: down.map((v) => v / n), fov: S.fov };
}
function tiltDegOf(t) { return t ? Math.acos(Math.min(1, t.down[2])) * 180 / Math.PI : 0; }

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
  // Sample the tracker at the grab, so the marks' reference point matches the
  // frame the worker is about to analyse.
  if (trackingNeeded()) trackStep();
  if (S.flow) S.flow.T.mark(); // this frame becomes the tracker's keyframe
  S.flowAtSend = S.flow ? S.flow.T.total.slice() : null;
  S.lastStill = isStill();
  S.lastTilt = currentTilt();
  S.sentAt = performance.now() - S.grabMs; // the page-side send->result lag starts at the grab
  bump('framesSent');
  W.post({ type: 'frame', bitmap: bmp, still: S.lastStill, tilt: S.lastTilt, sentAt: performance.timeOrigin + performance.now() }, [bmp]);
}

// Frames are only worth sending while something is changing. Each frame that
// teaches the engine nothing (same counts, nothing read, phone held still)
// backs the pump off, down to about 1 frame/s; any movement or new piece
// snaps it straight back to full rate.
function frameGap() {
  // While something is highlighted the user is hunting for it on the table, so
  // keep the view responsive however long they hold still.
  const cap = S.last && S.last.highlights && S.last.highlights.length ? 250 : MAX_GAP;
  return Math.min(cap, BASE_GAP * Math.pow(1.5, Math.min(S.calm, 6)));
}

function loop() {
  S.rafId = requestAnimationFrame(loop);
  const t = performance.now();
  // Gaps between display frames: long ones mean the main thread is overloaded.
  if (rafPrev && t - rafPrev < 1000) RAF_GAPS[rafGapN++ % RAF_GAPS.length] = t - rafPrev;
  rafPrev = t;
  // Only auto-pause on a device that actually reports motion, so a desktop
  // test run (or a phone with motion permission denied) never stalls.
  if (S.idleOn && S.hasMotion && t - S.lastActivity > IDLE_MS) { S.idle = true; bump('idlePauses'); rafPrev = 0; applyPower(); return; }
  // Track camera motion every other display frame (~30 Hz): enough to keep
  // marks on the pieces during a hand sweep, half the cost of every frame.
  S.rafN = (S.rafN || 0) + 1;
  if (trackingNeeded() && S.rafN % (S.flow ? S.flow.every : 2) === 0) trackStep();
  const shift = shiftSince(S.last);
  // Redraw only when there is a new result, the camera moved the marks by
  // more than half a pixel, a pulsing highlight (capped at ~20 fps) or
  // something asked for one — not 60 times a second regardless.
  const pulsing = S.last && S.last.highlights && S.last.highlights.length > 0;
  const k = S.last ? Math.max(overlay.clientWidth / S.last.frameW, overlay.clientHeight / S.last.frameH) : 1;
  const ds = S.drawnShift, sh = shift ? [shift.dx * k, shift.dy * k] : [0, 0];
  const followMoved = !ds || Math.hypot(sh[0] - ds[0], sh[1] - ds[1]) > 0.5;
  if (S.last !== S.drawn || S.needDraw || followMoved || (pulsing && t - (S.lastPulse || 0) > 50)) {
    S.needDraw = false;
    S.lastPulse = t;
    const ctx = sizeCanvas(overlay);
    if (S.last && video.videoWidth) {
      const M = frameMapping(video, overlay, S.last, shift);
      S.map = M;
      const d0 = performance.now();
      drawOverlay(ctx, S.last, M, { mode: S.mode, marks: !S.outlines });
      const dm = performance.now() - d0;
      STATS.drawMs = STATS.drawMs * 0.9 + dm * 0.1; if (dm > STATS.drawMax) STATS.drawMax = dm;
      S.drawn = S.last;
      S.drawnShift = sh;
    }
  }
  if (S.ready && !S.busy && !S.snapping && video.readyState >= 2 && t - S.lastSend > frameGap()) {
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
  $('findBar').hidden = mode !== 'find';
  document.body.classList.toggle('findbar', mode === 'find');
  if (mode === 'scan') {
    closeFind(); closeMatches(); clearFilter();
    W.post({ type: 'clearHighlights' });
    S.region = null; S.needDraw = true;
    drawMinimap();
  }
}
document.querySelectorAll('#toolbar [data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

function modeHint(mode) {
  return mode === 'scan' ? 'Sweep slowly over the pieces' : 'Tap a piece, or pick a group below';
}

function updateStats(c, tracking) {
  if (!c) return;
  S.counts = c;
  const parts = [`${c.pieces} pieces`];
  if (c.sections) parts.push(`${c.sections} section${c.sections > 1 ? 's' : ''}`);
  if (S.box) parts.push(`${c.placed} placed`);
  const tilt = tiltDegOf(S.lastTilt);
  if (tilt >= 4) parts.push(`${Math.round(tilt)}° tilt`);
  const over = c.expected && c.pieces > c.expected;
  $('stats').textContent = parts.join(' · ');
  $('stats').classList.toggle('warn', tilt > 50 || over);
  if (tilt > 50) $('modeHint').textContent = 'Tilt the phone less (under ~45°)';
  else if (S.ready && $('modeHint').textContent.startsWith('Tilt the phone')) $('modeHint').textContent = modeHint(S.mode);
  $('menuStats').textContent = `${c.pieces} pieces catalogued, ${c.shaped} shapes read, ${c.placed} placed on the box, ${c.located} on the table map`
    + (c.islands > 1 ? `, in ${c.islands} scan groups.` : '.')
    + (S.box ? ` Corners found: ${c.corner} of 4${c.cornerUnplaced ? ` (+${c.cornerUnplaced} corner-shaped piece${c.cornerUnplaced > 1 ? 's' : ''} not placed on the box yet)` : ''}.` : '')
    + (c.cornerDoubt ? ` ${c.cornerDoubt} more piece${c.cornerDoubt > 1 ? 's look' : ' looks'} like a corner but a better one already holds that corner (duplicate or misread) — Tidy up merges duplicates.` : '');
  // The catalog can't honestly hold more pieces than the puzzle has. When it
  // does, tracking broke and the same pieces were catalogued twice.
  const warn = $('countWarn');
  warn.hidden = !over && !(c.islands > 3);
  if (!warn.hidden) {
    warn.textContent = over
      ? `That's more than the ${c.expected} pieces this puzzle has — the same pieces were probably catalogued more than once after tracking was lost. Tidy up to fold them back together.`
      : `${c.islands} separate scan groups: tracking keeps breaking, so pieces may be catalogued twice. Tidy up to fold them back together.`;
  }
  // Chip counts, so you know whether it's worth tapping.
  const chip = (k, n, label) => { const b = $('findBar').querySelector(`[data-filter=${k}]`); b.textContent = n ? `${label} (${n})` : label; b.disabled = !n; };
  // The chip counts what lighting it up will show: corners placed + candidates.
  chip('corner', c.corner + (c.cornerUnplaced || 0), 'Corners');
  chip('border', c.border, 'Edges');
  chip('unplaced', Math.max(0, c.shaped - c.placed), 'Unplaced');
  chip('unread', Math.max(0, c.pieces - c.shaped), 'Unread');
  $('pairsBtn').disabled = c.shaped < 2;
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
    `still ${isStill()}  rot ${S.motion.rot.toFixed(0)}°/s  tilt ${tiltDegOf(S.lastTilt).toFixed(0)}° ${m.rect ? '(corrected)' : ''}`,
  ].join('\n');
}

// ---------- teach background ----------
// "Move closer" when the pieces are too small in the picture to read their
// shapes (the shot-quality gate rejects them), with the distance that would
// work for THIS puzzle's piece size when it is known.
function showDistanceHint(v) {
  if (!v || S.mode !== 'scan' || !S.ready) return;
  const far = $('modeHint').textContent.startsWith('Too far');
  if (v.tooFar) $('modeHint').textContent = v.needCm ? `Too far to read pieces — hold the phone about ${v.needCm} cm above the table` : 'Too far to read pieces — hold the phone closer';
  else if (far) $('modeHint').textContent = modeHint(S.mode);
}
// Running match accuracy from Fits/No answers (the answer key).
function showAccuracy(st) {
  const el = $('accuracyNote');
  if (!st || !st.judged) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `Match answers: ${st.fits} fit, ${st.no} didn't — ${Math.round(st.accuracy * 100)}% of judged suggestions were right. Send report to share them.`;
}
function showTaught(n) {
  S.taughtN = n || 0;
  $('teachCount').textContent = n ? `${n} spot${n > 1 ? 's' : ''}` : 'auto';
  if (S.teaching) $('teachText').textContent = n ? `${n} spot${n > 1 ? 's' : ''} learned. Keep tapping any surface that still shows outlines; tap Done when pieces stand out.` : 'Tap bare table in a few spots — every different surface (cloth, wood, tile, glass, shadow).';
}
// Average color of a small patch of the camera image under a screen point.
function sampleVideo(clientX, clientY) {
  if (!S.map || !S.last) return null;
  const r = overlay.getBoundingClientRect();
  const [fx, fy] = S.map.toVideo(clientX - r.left, clientY - r.top);
  const vx = Math.round(fx), vy = Math.round(fy);
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
  S.needDraw = true;
  drawMinimap();
  if (!desc) { closeFind(); return; }
  closeMatches(); clearFilter();
  $('findPanel').hidden = false;
  $('menu').hidden = true;
  applyPower();
  if (desc.section) { showSection(desc); return; }
  const p = desc.piece;
  drawThumb($('selThumb'), p, null);
  $('selTitle').textContent = `Piece #${p.id}` + (p.code ? ` · ${p.code.split('').map((c) => SIDE[c][0].toUpperCase()).join('')}` : '');
  let sub = desc.status || '';
  if (!sub && p.t2 && p.t2.cands.length) {
    const c = p.t2.cands[0];
    sub = `Box: column ${c.col + 1}, row ${c.row + 1} · ${Math.round(p.t2.conf * 100)}% sure`;
  } else if (!sub) sub = S.box ? 'Not placed on the box yet' : 'Add a box picture to see where it goes';
  // A shape is trusted once two separate views agreed on it.
  if (p.code) sub += p.confirmed ? ' · shape confirmed' : ' · shape read once — look at it again later to confirm';
  $('selSub').textContent = sub;
  const rows = $('edgeRows');
  rows.innerHTML = '';
  if (desc.attach && desc.attach.length) {
    const note = document.createElement('div');
    note.className = 'edge-row';
    note.innerHTML = '<h4><span class="sw" style="background:#c084fc"></span> Attaches to an assembled section</h4>';
    const t = document.createElement('div');
    t.className = 'empty';
    t.textContent = desc.attach.map((a) => `Section #${a.section} (edge ${a.edges.map((e) => e + 1).join(' & ')} of this piece touches it)${a.located ? '' : ' — not in view'}`).join('; ') + '. It is outlined in purple.';
    note.append(t);
    rows.append(note);
  }
  desc.edges.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'edge-row';
    const h = document.createElement('h4');
    const sw = document.createElement('canvas');
    sw.width = sw.height = 44; sw.style.width = sw.style.height = '22px';
    drawThumb(sw, p, e.edge, EDGE_COLORS[e.edge]);
    h.append(sw, document.createTextNode(` Edge ${e.edge + 1}: ${SIDE[e.type]}${e.unc ? ' (unsure — shallow)' : ''}`));
    row.append(h);
    const list = document.createElement('div');
    list.className = 'cands';
    if (e.type === 'F' && !e.unc) list.innerHTML = '<span class="empty">Border edge — nothing attaches here.</span>';
    else if (e.joined) list.innerHTML = '<span class="empty">Marked as joined.</span>';
    else if (!e.matches.length) list.innerHTML = '<span class="empty">No candidates yet — scan more pieces.</span>';
    const likely = e.matches[0] && e.matches[0].prob >= 0.5;
    if (e.type !== 'F' && !e.joined && e.pNone >= 0.4) {
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = `Partner probably not scanned yet (${Math.round(e.pNone * 100)}%)` +
        (e.spot && !e.spot.scanned ? ` — look for the piece from column ${e.spot.col + 1}, row ${e.spot.row + 1} of the box picture.` : '.') +
        (e.matches.length ? ' Possible:' : '');
      row.append(note);
    }
    e.matches.slice(0, 4).forEach((m, i) => {
      const c = document.createElement('div');
      const trusted = m.loopOk || (p.confirmed && m.confirmed);
      c.className = 'cand ' + (i === 0 && likely && trusted ? 'gold' : i < 3 ? 'silver' : '') + (m.confirmed ? '' : ' unconfirmed');
      const cv = document.createElement('canvas');
      cv.width = cv.height = 144;
      drawThumb(cv, m, m.edgeB, EDGE_COLORS[e.edge]);
      const label = document.createElement('div');
      label.textContent = `#${m.id} · ${Math.round((m.prob || 0) * 100)}%${m.loopOk ? ' · 2×2 ✓' : m.adj > 0.3 ? ' · box ✓' : ''}${m.confirmed ? '' : ' · ?'}`;
      label.title = (m.located ? '' : 'Not on the table map right now. ') + (m.confirmed ? '' : 'Its shape has been read only once (dashed frame).');
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
// An assembled section: where it sits on the box and which scanned loose
// pieces attach to it (they glow gold on the table).
function showSection(desc) {
  const ctx = $('selThumb').getContext('2d');
  ctx.clearRect(0, 0, 72, 72); ctx.fillStyle = '#c084fc'; ctx.fillRect(8, 8, 56, 56);
  $('selTitle').textContent = `Assembled section #${desc.piece.id}`;
  const sec = desc.sec;
  $('selSub').textContent = desc.status || (sec ? `About ${sec.cells.length} pieces · around column ${Math.round(sec.center[0]) + 1}, row ${Math.round(sec.center[1]) + 1} of the box` : '');
  const rows = $('edgeRows');
  rows.innerHTML = '';
  if (!sec) return;
  const row = document.createElement('div');
  row.className = 'edge-row';
  row.innerHTML = `<h4>${desc.partners.length ? `${desc.partners.length} scanned piece${desc.partners.length > 1 ? 's' : ''} attach to it (gold on the table)` : 'No scanned pieces attach to it yet'}</h4>`;
  const list = document.createElement('div');
  list.className = 'cands';
  desc.partners.slice(0, 12).forEach((m) => {
    const c = document.createElement('div');
    c.className = 'cand gold';
    const cv = document.createElement('canvas');
    cv.width = cv.height = 144;
    drawThumb(cv, m, m.edges[0], '#c084fc');
    const label = document.createElement('div');
    label.textContent = `#${m.id} · col ${m.cell[0] + 1}, row ${m.cell[1] + 1}${m.located ? '' : ' · ?'}`;
    c.append(cv, label);
    list.append(c);
  });
  row.append(list);
  rows.append(row);
}

function closeFind() {
  $('findPanel').hidden = true;
  if (S.desc) { S.desc = null; W.post({ type: 'select', id: null }); }
  drawMinimap();
}
$('closeFind').onclick = closeFind;

// ---------- find bar: piece groups, match cycling, map toggle ----------
// Light up a whole class of pieces at once — corners and edges first, since
// that's where most people start a puzzle. Needs no box picture.
function clearFilter() {
  S.filter = null;
  $('findBar').querySelectorAll('[data-filter]').forEach((b) => b.classList.remove('on'));
  showBorderBtn();
}
function showBorderBtn() {
  const on = S.filter === 'edges';
  $('edgesBtn').classList.toggle('on', on);
  $('edgesBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
}
function setFilter(kind) {
  const next = S.filter === kind ? null : kind;
  clearFilter();
  S.filter = next;
  if (next) STATS.filters[next] = (STATS.filters[next] || 0) + 1; // which finders actually get used
  $('findBar').querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('on', b.dataset.filter === next));
  showBorderBtn();
  if (next) { closeFind(); closeMatches(); }
  W.post({ type: 'filter', kind: next });
}
$('findBar').querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => setFilter(b.dataset.filter)));

// "Matches": scan the whole catalog for pairs that fit and step through them.
$('pairsBtn').onclick = () => {
  if (!$('matchBar').hidden) { closeMatches(); return; }
  clearFilter();
  closeFind();
  S.pairs = []; S.pairIdx = 0; S.pairsDone = false;
  toast('Looking for matches…', 20000);
  W.post({ type: 'filter', kind: null });
  W.post({ type: 'pairs', from: 0 });
};
function showMatches() {
  if (!S.pairs.length) {
    if (S.pairsDone) { toast('No confident matches in the catalog yet — read more piece shapes first.', 4000); closeMatches(); }
    return;
  }
  $('matchBar').hidden = false;
  $('pairsBtn').classList.add('on');
  document.body.classList.add('matchbar');
  S.pairIdx = Math.max(0, Math.min(S.pairIdx, S.pairs.length - 1));
  const p = S.pairs[S.pairIdx];
  drawThumb($('matchA'), p.A, p.edgeA, '#ffffff');
  drawThumb($('matchB'), p.B, p.edgeB, EDGE_COLORS[p.edgeA]);
  const where = p.aLocated && p.bLocated ? '' : ' · not both on the table map';
  $('matchLabel').textContent = `${S.pairIdx + 1} of ${S.pairs.length}${S.pairsDone ? '' : '+'} · #${p.a} + #${p.b} · ${Math.round(p.prob * 100)}%${p.loopOk ? ' · 2×2 ✓' : ''}${where}`;
  $('matchPrev').disabled = S.pairIdx === 0;
  $('matchNext').disabled = S.pairIdx >= S.pairs.length - 1;
  W.post({ type: 'showPair', a: p.a, b: p.b });
  S.needDraw = true;
}
function stepMatch(n) { S.pairIdx += n; showMatches(); }
$('matchPrev').onclick = () => stepMatch(-1);
$('matchNext').onclick = () => stepMatch(1);
// Judge the pair shown, then move on: the quickest way to build the answer key.
const judgePair = (kind) => {
  const p = S.pairs[S.pairIdx];
  if (!p) return;
  W.post({ type: 'feedback', kind, a: p.a, ka: p.edgeA, b: p.b, kb: p.edgeB, source: 'pairs' });
  if (kind === 'wrong') { S.pairs.splice(S.pairIdx, 1); showMatches(); } else stepMatch(1);
};
$('matchFits').onclick = () => judgePair('joined');
$('matchNo').onclick = () => judgePair('wrong');
$('matchClose').onclick = () => closeMatches();
function closeMatches() {
  if ($('matchBar').hidden) return;
  $('matchBar').hidden = true;
  $('pairsBtn').classList.remove('on');
  document.body.classList.remove('matchbar');
  W.post({ type: 'showPair', a: null, b: null });
  S.needDraw = true;
}

// The box picture is useful but it covers a third of the view; let it go away.
$('mapBtn').onclick = () => { S.mapHidden = !S.mapHidden; saveLocal(); applyMapVisibility(); };
function applyMapVisibility() {
  const show = !!S.box && !S.mapHidden;
  minimap.hidden = !show;
  $('mapBtn').disabled = !S.box;
  $('mapBtn').classList.toggle('on', show);
  $('mapBtn').textContent = S.box ? (show ? 'Hide map' : 'Show map') : 'Map';
  if (show) drawMinimap();
}

// ---------- minimap ----------
function setBox(box) {
  S.box = box;
  if (!box) { S.boxImg = null; S.region = null; applyMapVisibility(); return; }
  const c = document.createElement('canvas');
  c.width = box.preview.w; c.height = box.preview.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(box.preview.data), box.preview.w, box.preview.h), 0, 0);
  S.boxImg = c;
  applyMapVisibility();
}
function drawMinimap() {
  if (!S.box || !S.boxImg || minimap.hidden) return;
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
  const secOf = S.desc && S.desc.section ? S.desc.sec : null;
  if (secOf) {
    ctx.fillStyle = 'rgba(192,132,252,0.45)';
    for (const id of secOf.cells) ctx.fillRect((id % b.cols) * cw, Math.floor(id / b.cols) * ch, cw, ch);
    ctx.setLineDash([3, 2]); ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = 1.5;
    for (const id of secOf.open) ctx.strokeRect((id % b.cols) * cw, Math.floor(id / b.cols) * ch, cw, ch);
    ctx.setLineDash([]);
  }
  if (S.desc && S.desc.edges) {
    for (const e of S.desc.edges) {
      if (!e.spot || e.spot.scanned) continue;
      ctx.setLineDash([3, 2]); ctx.strokeStyle = '#ffb347'; ctx.lineWidth = 2;
      ctx.strokeRect(e.spot.col * cw, e.spot.row * ch, cw, ch);
      ctx.setLineDash([]);
    }
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
    // Single tap: small -> enlarge; enlarged -> shrink back out of the way.
    // (Dragging across it, at either size, lights up pieces from that area.)
    minimap.classList.toggle('big');
    mmStart = null; S.dragCells = null; drawMinimap();
    return;
  }
  mmStart = null; S.dragCells = null;
  minimap.classList.remove('big');
  if (S.mode !== 'find') { S.mode = 'find'; document.querySelectorAll('#toolbar [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'find')); }
  $('findPanel').hidden = true;
  W.post({ type: 'region', c0, r0, c1, r1 });
});

// ---------- snap / box / menu ----------
// Photo cataloguing lives under More now (the owner wasn't using it from the
// toolbar); the toolbar slot went to Border.
$('snapBtn').onclick = () => { endTeaching(); $('menu').hidden = true; S.snapTilt = currentTilt(); $('snapInput').click(); };
// Border: the whole frame of the puzzle — corners and edge pieces — in one tap,
// from any mode. Tap again to turn it off.
$('edgesBtn').onclick = () => {
  endTeaching();
  if (S.mode !== 'find') setMode('find');
  setFilter('edges');
};
$('snapInput').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  S.snapping = true;
  S.lastSnapFile = f;
  toast('Cataloging photo…', 15000);
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    W.post({ type: 'snap', bitmap: bmp, tilt: S.snapTilt }, [bmp]);
  } catch (err) {
    S.snapping = false;
    toast('Could not read that photo.');
  }
};
$('boxBtn').onclick = () => { endTeaching(); boxSetup.open(); };
$('menuBtn').onclick = () => {
  endTeaching();
  $('menu').hidden = !$('menu').hidden;
  $('findPanel').hidden = true;
  applyPower(); // Settings is a full-screen read: no reason to hold the camera
};
$('closeMenu').onclick = () => { $('menu').hidden = true; noteActivity(); applyPower(); };
$('tidyBtn').onclick = () => {
  $('menu').hidden = true;
  noteActivity(); applyPower();
  closeFind(); closeMatches(); clearFilter();
  toast('Tidying up…', 30000);
  W.post({ type: 'tidy' });
};
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
$('detail').oninput = (e) => {
  S.procW = +e.target.value;
  $('detailVal').textContent = S.procW;
  W.post({ type: 'settings', settings: { procW: S.procW } });
  saveLocal();
};
$('outlineToggle').onchange = (e) => { S.outlines = e.target.checked; S.needDraw = true; saveLocal(); };
$('followToggle').onchange = (e) => { S.follow = e.target.checked; S.flow = null; S.needDraw = true; saveLocal(); };
$('tiltToggle').onchange = (e) => { S.tiltOn = e.target.checked; saveLocal(); };
$('fovRange').oninput = (e) => { S.fov = +e.target.value; $('fovVal').textContent = S.fov + '°'; saveLocal(); };
function saveLocal() {
  try {
    localStorage.setItem('ph-view', JSON.stringify({ tiltOn: S.tiltOn, fov: S.fov, mapHidden: S.mapHidden, idleOn: S.idleOn, procW: S.procW, outlines: S.outlines, follow: S.follow }));
  } catch (_) { /* private mode */ }
}
try {
  const v = JSON.parse(localStorage.getItem('ph-view') || 'null');
  if (v) {
    S.tiltOn = v.tiltOn !== false; S.fov = v.fov || 66; S.mapHidden = !!v.mapHidden;
    S.idleOn = v.idleOn !== false; S.procW = v.procW || 640; S.outlines = !!v.outlines; S.follow = v.follow !== false;
  }
} catch (_) { /* ignore */ }
$('tiltToggle').checked = S.tiltOn; $('fovRange').value = S.fov; $('fovVal').textContent = S.fov + '°';
$('idleToggle').checked = S.idleOn;
$('detail').value = S.procW; $('detailVal').textContent = S.procW;
// Chrome/Firefox on iOS are WKWebView: no Wake Lock API, so the screen sleeps
// mid-sweep however long you hold the phone still. Safari (16.4+) has it.
if (!navigator.wakeLock) {
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const n = $('compatNote');
  n.hidden = false;
  n.textContent = iOS
    ? 'This browser can\'t keep the screen awake, so it will dim mid-scan. Open the app in Safari (and Share → Add to Home Screen) to avoid that.'
    : 'This browser can\'t keep the screen awake while scanning.';
}
$('outlineToggle').checked = S.outlines;
$('followToggle').checked = S.follow;
applyMapVisibility();
$('debugToggle').onchange = (e) => { S.debug = e.target.checked; $('debug').hidden = !S.debug; };
function afterReset() {
  closeFind(); closeMatches(); clearFilter();
  S.region = null; S.prevCounts = null; S.pairs = []; S.needDraw = true;
  $('menu').hidden = true;
  noteActivity(); applyPower();
}
// Taught table colours survive a reset unless forgotten here: on a different
// table (or under different light) they make the board itself look like a
// piece, which is what happened moving from the white board to the glass table.
$('newPuzzle').onclick = () => {
  if (!confirm('Forget all catalogued pieces? The box picture is kept.')) return;
  const forgetTable = S.taughtN > 0 && confirm(`Also forget the ${S.taughtN} table colour${S.taughtN > 1 ? 's' : ''} you taught?\n\n`
    + 'Choose OK if you moved to a different table or the lighting changed. Choose Cancel to keep them for the same table.');
  W.post({ type: 'reset', keepBox: true, forgetTable });
  afterReset();
};
$('clearAll').onclick = () => {
  const what = S.taughtN > 0 ? 'all pieces, the box picture and the taught table colours' : 'all pieces and the box picture';
  if (confirm(`Forget ${what}?`)) { W.post({ type: 'reset', keepBox: false, forgetTable: true }); afterReset(); }
};

// ---------- debug report ----------
// Bundles what's needed to diagnose problems: the current camera frame (full
// resolution), the last Snap photo, and a JSON file with timings, settings,
// what was detected and the catalog. Shared via the iOS share sheet, so it
// can be saved to Files/OneDrive or sent anywhere.
$('reportBtn').onclick = () => {
  $('menu').hidden = true;
  noteActivity(); applyPower(); // the camera was off behind the menu; let it come back
  toast('Preparing report…', 10000);
  // Give the stream a moment so the report still carries a live camera frame.
  setTimeout(() => W.post({ type: 'report' }), 900);
};
function rafSummary() {
  const n = Math.min(rafGapN, RAF_GAPS.length);
  if (!n) return null;
  const a = Array.from(RAF_GAPS.subarray(0, n)).sort((x, y) => x - y);
  const q = (p) => +a[Math.min(n - 1, Math.floor(n * p))].toFixed(1);
  return { samples: n, gapP50: q(0.5), gapP95: q(0.95), gapMax: +a[n - 1].toFixed(1), over50ms: a.filter((v) => v > 50).length };
}
async function deviceInfo() {
  const d = { cores: navigator.hardwareConcurrency || null, memoryGB: navigator.deviceMemory || null, lang: navigator.language,
    standalone: !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches) || !!navigator.standalone,
    online: navigator.onLine, motionSensor: !!S.hasMotion, wakeLockApi: !!navigator.wakeLock, offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    swControlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller) };
  try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); d.storageMB = +((e.usage || 0) / 1048576).toFixed(1); d.quotaMB = Math.round((e.quota || 0) / 1048576); } } catch (_) { /* not available */ }
  return d;
}
async function finishReport(workerData, analyzed, boxImg) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const files = [];
  try {
    // Live camera if it's running, otherwise the view saved when it was switched off.
    let c = null;
    if (video.videoWidth && (video.srcObject || video.currentSrc)) {
      c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
    } else if (S.lastFrame) c = S.lastFrame;
    if (c) {
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      if (blob) files.push(new File([blob], `puzzle-report-${stamp}-frame.jpg`, { type: 'image/jpeg' }));
    }
  } catch (e) { logError('report frame: ' + e.message); }
  if (analyzed) files.push(new File([analyzed], `puzzle-report-${stamp}-analyzed.jpg`, { type: 'image/jpeg' }));
  if (boxImg) files.push(new File([boxImg], `puzzle-report-${stamp}-box.jpg`, { type: 'image/jpeg' }));
  if (S.lastSnapFile) files.push(new File([S.lastSnapFile], `puzzle-report-${stamp}-snap.jpg`, { type: S.lastSnapFile.type || 'image/jpeg' }));
  bump('reports');
  const data = {
    app: APP_VERSION, time: new Date().toISOString(), userAgent: navigator.userAgent,
    screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio, viewW: innerWidth, viewH: innerHeight },
    video: { w: video.videoWidth, h: video.videoHeight, settings: S.track && S.track.getSettings ? S.track.getSettings() : null,
      // What the camera could do (focus/exposure/zoom ranges, torch), for tuning.
      capabilities: (() => { try { return S.track && S.track.getCapabilities ? S.track.getCapabilities() : null; } catch (_) { return null; } })(),
      readyState: video.readyState, live: !!video.srcObject },
    mode: S.mode, fps: S.fps, motion: S.motion, gravity: S.gravity, tilt: S.lastTilt, tiltOn: S.tiltOn, fov: S.fov,
    power: { active: S.active, idle: S.idle, idleOn: S.idleOn, calm: S.calm, gap: Math.round(frameGap()), wakeLock: !!S.wakeLock },
    // Camera-motion tracker health: how often it was sure of a step, its cost
    // on this phone, and the recent motion level it uses for stillness.
    flow: S.flow ? { on: S.follow, thumb: [S.flow.w, S.flow.h], steps: S.flow.T.steps, lowConf: S.flow.T.lowConf, rekeys: S.flow.T.rekeys,
      predicted: S.flow.T.predicted, fullSearch: S.flow.T.fullSearch, resumes: S.flow.resumes || 0, every: S.flow.every,
      msPerStep: +S.flow.ms.toFixed(2), readMs: +S.flow.readMs.toFixed(2), matchMs: +S.flow.matchMs.toFixed(2), maxMs: +S.flow.maxMs.toFixed(1),
      speed: +S.flow.T.speed.toFixed(3), total: S.flow.T.total.map((v) => +v.toFixed(1)) } : { on: S.follow },
    // Main thread: display-frame gaps (ms) and overlay drawing cost.
    mainThread: rafSummary(),
    stats: Object.assign({}, STATS, { drawMs: +STATS.drawMs.toFixed(2), drawMax: +STATS.drawMax.toFixed(1) }),
    settings: { procW: S.procW, outlines: S.outlines, follow: S.follow, idleOn: S.idleOn, tiltOn: S.tiltOn, fov: S.fov, mapHidden: S.mapHidden,
      debug: S.debug, sens: +$('sens').value, taught: S.taughtN || 0 },
    device: await deviceInfo(),
    ui: { filter: S.filter, mapHidden: S.mapHidden, pairs: S.pairs.length, pairsDone: !!S.pairsDone },
    orientation: (screen.orientation && screen.orientation.angle) || window.orientation || 0,
    history: S.history, errors: S.errors,
    lastFrame: S.last, lastSnap: S.lastSnapResult || null, snapTilt: S.snapTilt || null, selected: S.desc, worker: workerData,
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
window.__phPick = (want) => {
  if (!S.last || !S.map) return null;
  const r = overlay.getBoundingClientRect();
  for (const d of S.last.dets) {
    if (!d.id || (d.border && !want) || !(want ? d.status === want : d.status === 'placed' || d.status === 'shaped')) continue;
    // a point inside the outline that is on screen and not under a panel
    const cands = [[d.cx, d.cy]];
    for (let i = 0; i < d.pts.length; i += 2) cands.push([(d.pts[i] * 3 + d.cx) / 4, (d.pts[i + 1] * 3 + d.cy) / 4]);
    for (const [px, py] of cands) {
      if (!pointInPoly(px, py, d.pts)) continue;
      const [x, y] = S.map.toScreen(px, py);
      if (x > 0 && y > 0 && x < r.width && y < r.height && document.elementFromPoint(x + r.left, y + r.top) === overlay) return [x + r.left, y + r.top];
    }
  }
  return null;
};

window.__phSelectStatus = (want) => { const d = S.last && S.last.dets.find((x) => x.id && x.status === want); if (!d) return false; setMode('find'); W.post({ type: 'select', id: d.id }); return true; };
// Select a catalogued piece/section even when it isn't in view right now.
window.__phSelectKind = (kind) => { setMode('find'); W.post({ type: 'selectKind', kind }); return true; };
window.__phStatuses = () => S.last && S.last.dets.map((d) => d.status + (d.border ? '/border' : ''));

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
