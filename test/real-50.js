/* The owner's 50-piece video (reports/IMG_3593.MOV, 2026-10-05): 50 loose
 * pieces of the 300-piece reef puzzle, 10 x 5 on a white counter; overview,
 * close sweep, overview. v0.19.0 catalogued 56-80 entries for them.
 *
 * Every 5th frame (~6 fps, the phone's analysed rate) goes through the live
 * engine as the phone runs it; "still" comes from the image motion (the phone
 * uses its motion sensors). Checks at the end (answer key:
 * test/fixtures/v3593/answer.json, hand-checked):
 *   - exactly 50 checked pieces, 0 left unchecked, one-to-one with the key;
 *   - edge types of every piece = the key; edge / corner counts = the key;
 *   - no assembled part, no open spots, no border;
 * and at no point more than 50 checked pieces.
 * Variants (VARIANT=...): phone6 (every 6th frame), drop30 (30% of piece
 * detections dropped), light (bursts of +-40% brightness), overview (first
 * 3 s only: 0 checked, rings for all).
 * Run: node test/real-50.js   (~2-4 min; needs the video, which is not in git)
 * CASE=3605: the owner's 2-minute video IMG_3605.MOV (2026-10-06) - 38 loose
 * reef pieces on the white counter (counted by eye in its overviews at 72 s
 * and 120 s; no answer key): sweeps up close, overviews at 72-80 s and the end.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./synth');
const { videoFrames } = require('./videoframes');
// The modules the app's worker loads (test/lib/vision.js), with CLOCK=cpu
// (budgets on this process's CPU time: other work on the machine barely
// changes the result), VISION=<other js/vision> and PHSET='{"X":1}'.
const PH = require('./lib/vision')();
const CLK = require('./lib/clock');
const ROOT = path.join(__dirname, '..');
const CASES = {
  // floor: what the last release reaches, less the run-to-run spread on the
  // CPU clock - below it the run FAILS; the exact targets are GOALs (printed,
  // not failed) until the app reaches them
  3593: { video: 'IMG_3593.MOV', n: 50, key: path.join(__dirname, 'fixtures', 'v3593', 'answer.json'), floor: { checked: 46, at30: 32, matched: 45, codes: 45 } },
  // key (2026-10-07): the 38 pieces' centres placed by eye on the 76 s
  // overview, codes from the checked reads, every one checked by eye
  3605: { video: 'IMG_3605.MOV', n: 38, key: path.join(__dirname, 'fixtures', 'v3605', 'answer.json'), floor: { checked: 24, at30: 14 } },
  // glass table over a mixed floor (wood, carpet, tile), ~300 loose pieces of
  // a 300-piece puzzle; for the see-through 'edges' background model. No key.
  3609: { video: 'IMG_3609.MOV', n: 300, key: null, box: 'puzzle-report-2026-10-07T01-09-35-box.jpg', grid: { pieces: 300, cols: 20, rows: 15 } },
};
const CASE = CASES[process.env.CASE || process.argv[2] || 3593]; // (node test/real-50.js 3605)
const N = CASE.n;
const VIDEO = process.env.VIDEO || path.join(ROOT, 'reports', CASE.video);
const BOX = path.join(ROOT, 'reports', CASE.box || 'puzzle-report-2026-10-05T11-14-50-box.jpg');
const KEY = CASE.key || path.join(__dirname, 'fixtures', 'none');
const VARIANT = process.env.VARIANT || 'full';

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
// a target the app doesn't reach yet: printed (GOAL = not yet, MET = reached), never fails the run
const goal = (name, ok, detail) => console.log(`${ok ? 'MET ' : 'GOAL'}  ${name}${detail ? '  — ' + detail : ''}`);
const FLOOR = CASE.floor || {};

(async () => {
  if (!fs.existsSync(VIDEO)) { console.log('SKIP  real-50: video not found (' + VIDEO + ')'); return; }
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));
  PH.cv = cv;
  const { readImage } = require('./imageio');
  const eng = new PH.Engine(process.env.EDGEBG === '0' ? { edgeBg: false } : {});
  if (fs.existsSync(BOX)) {
    const bi = readImage(BOX);
    eng.setBox(PH.createBox(bi, [[0, 0], [bi.w, 0], [bi.w, bi.h], [0, bi.h]], CASE.grid || { pieces: 300, cols: 15, rows: 20 }));
  }
  const rnd = PH.mulberry32(7);
  const step = VARIANT === 'phone6' ? 6 : 5;
  const to = VARIANT === 'overview' ? 3 : 1e9;
  let n = 0, maxChecked = 0, maxAt = 0, firstAt = null, at30 = 0;
  const t0 = Date.now();
  const timeline = [];
  // Identity, not geometry: during the opening overview (the key's own frame,
  // camera nearly still) each key piece is seen at its key position; the
  // entry the engine gives it there is followed through merges to the end.
  const KEYF = fs.existsSync(KEY) ? JSON.parse(fs.readFileSync(KEY, 'utf8')) : null;
  const votes = new Map(); // key n -> Map(entry id -> count)
  const readLog = new Map(); // READS=1: every shape read per entry, to see why one stays unchecked
  // READSTUDY=<file.json>: every close read (frame, entry, sharpness, code),
  // scored against the key at the end (which read was right)
  const study = process.env.READSTUDY ? { reads: [], frames: [] } : null;
  if (study) PH.DEBUG_READ = (id, t1, fNo) => {
    if (!PH.isCloseRead(t1)) { (study.far = study.far || []).push({ fNo, id, side: Math.round(t1.meanSide), q: t1.quality ? t1.quality.q : null }); return; }
    const p = eng.pieces.get(id), o = p && p.t1 && PH.isCloseRead(p.t1) ? p.t1 : null; // the stored close read it is compared with
    const m = o ? PH.samePiece(t1, o) : null, sa = o && !(m && m.ok) ? PH.shapeAgree(t1, o) : null;
    // which key piece this read shows (outline + print against the key's references)
    let keyN = null;
    if (KEYF && study.refs === undefined) study.refs = KEYF.pieces.filter((k) => k.ref).map((k) => ({ n: k.n, t1: { code: k.ref.code, meanSide: k.ref.meanSide, lf: k.ref.lf, white: k.ref.white, edges: k.ref.edges.map((e) => Object.assign({}, e, { sig: Float32Array.from(e.sig) })), square: { lab: Uint8Array.from(k.ref.square.lab), mask: Uint8Array.from(k.ref.square.mask) } } }));
    if (study.refs) { let bd = Infinity; for (const r of study.refs) { const m = PH.samePiece(t1, r.t1, PH.ANCHOR_SHAPE * 1.5); if (m.ok && m.d < bd) { bd = m.d; keyN = r.n; } } }
    study.reads.push({ keyN, fNo, t: curT, id, sharp: t1.quality ? t1.quality.sharp : null, q: t1.quality ? t1.quality.q : null, side: Math.round(t1.meanSide), code: t1.code, centre: t1.centre,
      len: t1.edges.map((e) => +e.lenRel.toFixed(3)), tilt: t1.tilt || null,
      vs: o ? { agree: !!((m && m.ok) || sa), d: m && isFinite(m.d) ? +m.d.toFixed(3) : null, len: o.edges.map((e) => +e.lenRel.toFixed(3)), dNoGate: (() => { const g = PH.LEN_GATE; PH.LEN_GATE = Infinity; const al = PH.shapeAlign(t1, o); PH.LEN_GATE = g; return al.r >= 0 ? { d: +al.d.toFixed(3), r: al.r } : null; })(), sharp: o.quality ? o.quality.sharp : null, q: o.quality ? o.quality.q : null, code: o.code, nObs: o.nObs || 1 } : null });
  };
  if (study) PH.DEBUG_JOB = (id, pri, t1, fNo) => { (study.jobs = study.jobs || []).push([fNo, id, pri, t1 ? Math.round(t1.meanSide) : 0]); };
  if (process.env.READS) PH.DEBUG_Q = (...a) => { if (String(a[0]).includes('read')) { const id = a[1]; if (!readLog.has(id)) readLog.set(id, []); readLog.get(id).push(a.slice(2).join(' ')); } };
  const tilt = { pitch: 0, roll: 0 };
  let curT = 0;
  if (process.env.VOTE) eng.opts.edgeVote = true;
  if (process.env.FORCEBG) { eng.opts.autoBg = false; eng.bgModel = { kind: 'edges', edgeT: JSON.parse(process.env.FORCEBG) }; }
  if (process.env.BGLOG) { const pk = eng.pickBg.bind(eng); eng.pickBg = (tried) => { const r = pk(tried); console.log('t=' + curT.toFixed(1), tried.map((t) => t.c.kind[0] + (t.c.edgeT ? t.c.edgeT[0] : '') + ':' + t.good + '/' + t.fg).join(' '), '->', r ? r.c.kind : null); return r; }; }
  for await (const f of videoFrames(VIDEO, { step, to })) {
    curT = f.t;
    let data = f.data;
    if (VARIANT === 'light' && Math.floor(f.t / 4) % 3 !== 0) { // 4 s bursts, darker then brighter
      const k = Math.floor(f.t / 4) % 3 === 1 ? 0.6 : 1.4;
      data = new Uint8ClampedArray(f.data.length);
      for (let i = 0; i < data.length; i += 4) { data[i] = f.data[i] * k; data[i + 1] = f.data[i + 1] * k; data[i + 2] = f.data[i + 2] * k; data[i + 3] = 255; }
    }
    const mat = new cv.Mat(f.h, f.w, cv.CV_8UC4); mat.data.set(data);
    if (VARIANT === 'drop30') eng.opts.dropDets = (d) => !d.border && rnd() < 0.3;
    const src = S.matSource(cv, mat);
    // The phone straightens tilted views with its motion sensor; the video
    // has none, so the tilt is estimated from the pieces (as for photos),
    // every 3rd frame, smoothed like a sensor.
    if (process.env.TILT !== '0' && n % 3 === 0) {
      const e = eng.estimatePhotoTilt(src);
      if (e && e.gain > 0.05) { tilt.pitch = tilt.pitch * 0.5 + e.pitch * 0.5; tilt.roll = tilt.roll * 0.5 + e.roll * 0.5; }
    }
    CLK.frameAtFor(eng, f.t * 1000); // (CLOCK=model: the frame arrives at its video time)
    const out = eng.processFrame(src, { still: f.still, tilt: { down: PH.downFromAngles(tilt.pitch, tilt.roll), fov: 66 } });
    if (study) (study.seen = study.seen || []).push([eng.fNo, f.still ? 1 : 0, out.dets.filter((d) => d.id && !d.border).map((d) => [d.id, Math.round(Math.sqrt(d.area) / (eng.lastProc ? eng.lastProc.scale : 1) / 1.1), d.merged ? 1 : 0])]);
    if (study) { const P = eng.lastProc; if (P) { let s1 = 0, s2 = 0, m = 0; const W = P.w, D = P.data; for (let y = 2; y < P.h - 2; y += 2) for (let x = 2; x < W - 2; x += 2) { const g = (i) => D[4 * i + 1]; const i = y * W + x, v = 4 * g(i) - g(i - 1) - g(i + 1) - g(i - W) - g(i + W); s1 += v; s2 += v * v; m++; } study.frames.push({ fNo: eng.fNo, t: f.t, still: !!f.still, sharp: +Math.sqrt(Math.max(0, s2 / m - (s1 / m) ** 2)).toFixed(2) }); } }
    if (process.env.DETSTATS) { const g = out.dets.filter((d) => !d.border && d.status !== "merged").length; (globalThis.__ds = globalThis.__ds || []).push([g, f.still ? 1 : 0, eng.edgeVoter ? +(eng.edgeVoter.voted || 0) : 0]); }
    if (KEYF && (KEYF.t ? Math.abs(f.t - KEYF.t) <= 0.6 : f.t >= 1.4 && f.t <= 2.7) && eng.lastProc) { // (the key's overview: IMG_3593 1.4-2.7 s, others at key.t)
      const sc = eng.lastProc.scale, unit = Math.sqrt(eng.unitLive || 1000);
      const at = (k) => { const p = out.rect ? PH.applyH(out.rect.H, k.x, k.y) : [k.x, k.y]; return [p[0] * sc, p[1] * sc]; };
      // A key with its own time (a moving overview): line this frame's
      // pieces up with the key first - the shift most key spots agree on.
      let off = [0, 0];
      if (KEYF.t) {
        const T = eng.tracks.filter((t) => t.id), K = KEYF.pieces.map(at);
        let bestN = -1;
        // (only shifts under a piece: the pieces stand in evenly spaced
        // columns, and a shift by one row lines up with many of them too)
        for (const q of K) for (const t of T) {
          const o = [t.x - q[0], t.y - q[1]];
          if (Math.hypot(o[0], o[1]) > unit) continue;
          let nIn = 0;
          for (const r of K) if (T.some((u) => Math.hypot(u.x - r[0] - o[0], u.y - r[1] - o[1]) < unit * 0.3)) nIn++;
          if (nIn > bestN || (nIn === bestN && Math.hypot(o[0], o[1]) < Math.hypot(off[0], off[1]))) { bestN = nIn; off = o; }
        }
        if (process.env.KEYDBG) console.log(`key t=${f.t.toFixed(2)} shift ${off.map((v) => (v / unit).toFixed(2))} pieces, ${bestN}/${KEYF.pieces.length} key spots on a detection`);
        if (bestN < KEYF.pieces.length * 0.5) off = null; // (this frame doesn't show the layout)
      }
      if (off) for (const k of KEYF.pieces) {
        const p = at(k);
        let best = null, bd = Infinity;
        for (const t of eng.tracks) { if (!t.id) continue; const dd = Math.hypot(t.x - p[0] - off[0], t.y - p[1] - off[1]); if (dd < bd) { bd = dd; best = t; } }
        if (best && bd < unit * 0.5) { if (!votes.has(k.n)) votes.set(k.n, new Map()); const v = votes.get(k.n); v.set(best.id, (v.get(best.id) || 0) + 1); }
      }
    }
    mat.delete();
    n++;
    const c = eng.counts();
    const checked = c.checked !== undefined ? c.checked : c.pieces;
    if (checked > maxChecked) { maxChecked = checked; maxAt = f.t; }
    if (checked && firstAt === null) firstAt = f.t; // (owner: "pieces took a while to read")
    if (f.t <= 30) at30 = checked;
    if (n % 25 === 0) { timeline.push(`${f.t.toFixed(0)}s:${checked}` + (process.env.BG ? `(${eng.bgModel ? eng.bgModel.kind : '-'},${out.dets.length}d,${c.entries})` : '')); }
  }
  const c = eng.counts();
  console.log(`${VARIANT}: ${n} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s; timeline ${timeline.join(' ')}`);
  console.log(`speed: first checked piece at ${firstAt === null ? '-' : firstAt.toFixed(1) + ' s'}, ${at30} checked at 30 s`);
  console.log('counts', JSON.stringify(c));
  console.log('rejects', JSON.stringify(eng.rejects));
  if (globalThis.__ds) { const D = globalThis.__ds, m = (a) => (a.reduce((s, x) => s + x[0], 0) / Math.max(1, a.length)).toFixed(2); console.log('good dets/frame all', m(D), 'still', m(D.filter((x) => x[1])), 'moving', m(D.filter((x) => !x[1])), 'voted frames', D.filter((x) => x[2]).length + '/' + D.length); }
  if (process.env.BG) console.log('bgTried', JSON.stringify(eng.bgTried), 'model', JSON.stringify(eng.bgModel));
  console.log('unchecked because', JSON.stringify(eng.whyUnchecked()), 'housekeeping', JSON.stringify(eng.hk));
  if (process.env.READS && !CASE.key) { // no answer key: the reads of every entry left unchecked
    for (const p of eng.pieces.values()) {
      if (p.state === 'checked') continue;
      console.log(`  unchecked ${p.id}: closeAgree ${p.closeAgree || 0} sightings ${p.sightings || 0} moments ${p.moments || 0} closeViews ${p.closeViews || 0} photo ${!!p.photoRead}`);
      const ids = [...readLog.keys()].filter((id) => eng.finalId(id) === p.id);
      for (const id of ids) for (const r of readLog.get(id).slice(0, 10)) console.log('      read', id, r);
    }
  }
  if (process.env.EVENTS) for (const e of (eng.events || []).filter((e) => e.kind !== 'drop' || process.env.EVENTS === 'all')) console.log('  evt', JSON.stringify(e));
  const checked = c.checked !== undefined ? c.checked : c.pieces;
  if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify([...eng.pieces.values()].map((p) => ({ id: p.id, pos: p.pos, state: p.state || null, code: p.t1 ? p.t1.edges.map((e) => e.type).join('') : null, nObs: p.t1 ? p.t1.nObs || 1 : 0 }))));
  if (VARIANT === 'overview') {
    check('overview only: nothing is checked from far-away reads', checked === 0, `${checked} checked`);
  } else {
    goal(`exactly ${N} checked pieces at the end`, checked === N, `${checked}`);
    if (FLOOR.checked) check(`at least ${FLOOR.checked} checked pieces at the end (floor)`, checked >= FLOOR.checked, `${checked}`);
    if (FLOOR.at30) check(`at least ${FLOOR.at30} checked at 30 s (floor)`, at30 >= FLOOR.at30, `${at30}`);
    check(`never more than ${N} checked pieces`, maxChecked <= N, `max ${maxChecked} at ${maxAt.toFixed(0)} s`);
    if (c.unchecked !== undefined) goal('nothing left unchecked', c.unchecked === 0, `${c.unchecked}`);
    const a = eng.assemblyInfo ? eng.assemblyInfo() : null;
    const shown = a && (a.shown !== undefined ? a.shown : a.cells > 0 || a.spots > 0);
    check('no assembled part / open spots on loose pieces', !shown, a ? JSON.stringify({ n: a.n, cells: a.cells, spots: a.spots }) : '');
    check('no border found on loose pieces', !eng.pframe, eng.pframe ? 'border marked' : '');
    if (c.gone !== undefined) check('nothing marked gone (no piece was moved)', c.gone === 0, `${c.gone} gone`);
  }
  if (study) for (const r of study.reads) { const e = eng.pieces.get(eng.finalId(r.id)); r.fid = e ? e.id : null; r.state = e ? (e.state || 'checking') : 'gone'; r.fAgree = e ? e.closeAgree || 0 : null; }
  // the run's numbers, kept in test/results/history.jsonl (tools/trend.js)
  const M = { checked, entries: c.entries, unchecked: c.unchecked, maxChecked, firstAt: firstAt === null ? null : +firstAt.toFixed(1), at30, border: c.border, corner: c.corner, islands: c.islands, frames: n,
    whyUnchecked: eng.whyUnchecked ? eng.whyUnchecked() : null, stretchAgree: eng.rejects.stretchAgree || 0 };
  if (study) study.entries = [...eng.pieces.values()].map((e) => ({ id: e.id, state: e.state || 'checking', pos: e.pos, island: e.island, gone: !!e.gone, closeAgree: e.closeAgree || 0, close: !!(e.t1 && PH.isCloseRead(e.t1)), code: e.t1 ? e.t1.code : null, sightings: e.sightings || 0 })), study.unit = eng.unitTable ? eng.unitTable() : null;
  if (study && !fs.existsSync(KEY)) { fs.writeFileSync(process.env.READSTUDY, JSON.stringify(study)); console.log(`read study: ${study.reads.length} close reads -> ${process.env.READSTUDY}`); }
  if (fs.existsSync(KEY) && VARIANT !== 'overview') {
    const key = JSON.parse(fs.readFileSync(KEY, 'utf8'));
    // the entry each key piece became (identity from the overview, through merges)
    const byIdentity = new Map();
    let lost = 0;
    for (const [n, v] of votes) { const id = [...v.entries()].sort((a, b) => b[1] - a[1])[0][0]; const e = eng.pieces.get(eng.finalId(id)); if (e) byIdentity.set(n, e); else lost++; } // (an entry dropped outright: position decides)
    M.identity = byIdentity.size;
    console.log(`identity: ${byIdentity.size}/${key.pieces.length} key pieces followed from the key overview (${lost} of their entries were dropped later)`);
    // How true is the table map? Key overview -> map through the pieces
    // followed by identity (a homography: the overview is filmed at an
    // angle), and each one's distance from where the fit puts it, in piece
    // sides. A map that bends over a long sweep shows up here.
    { const pr = [...byIdentity].filter(([, e]) => e.pos);
      const isl = PH.median(pr.map(([, e]) => e.island || 0)); const P = pr.filter(([, e]) => (e.island || 0) === isl);
      const u = eng.unitTable ? eng.unitTable() : null;
      if (P.length >= 8 && u) {
        const src = [], dst = []; for (const [n, e] of P) { const k = key.pieces.find((q) => q.n === n); src.push(k.x, k.y); dst.push(e.pos[0], e.pos[1]); }
        const sm = cv.matFromArray(P.length, 1, cv.CV_32FC2, src), dm = cv.matFromArray(P.length, 1, cv.CV_32FC2, dst);
        // (robust: a few pieces followed to the wrong entry must not bend the fit)
        const H = cv.findHomography(sm, dm, cv.RANSAC, u * 1.0); sm.delete(); dm.delete();
        if (H && H.rows === 3) {
          const h = Array.from(H.data64F); H.delete();
          const res = P.map(([n, e]) => { const k = key.pieces.find((q) => q.n === n), w = h[6] * k.x + h[7] * k.y + h[8]; return Math.hypot((h[0] * k.x + h[1] * k.y + h[2]) / w - e.pos[0], (h[3] * k.x + h[4] * k.y + h[5]) / w - e.pos[1]) / u; }).sort((a, b) => a - b);
          const inl = res.filter((v) => v <= 1.0), out = res.length - inl.length;
          M.mapErr = { n: P.length, within: inl.length, median: inl.length ? +inl[inl.length >> 1].toFixed(2) : null, off: out };
          console.log(`map error vs the key (${P.length} pieces by identity, island ${isl}): within the fit ${inl.length}, median ${inl.length ? inl[inl.length >> 1].toFixed(2) : '-'} piece sides; ${out} more than 1 piece off (worst ${res[res.length - 1].toFixed(2)})`);
        }
      } }
    const got = [...eng.pieces.values()].filter((p) => p.pos && !p.gone && p.state === 'checked');
    // why a key piece has no checked entry: the nearest entry of any state
    { const fitAll = require('./keymatch').fitKey(cv, PH, key.pieces, [...eng.pieces.values()].filter((p) => p.pos));
      for (const k of key.pieces) { const e = byIdentity.has(k.n) ? byIdentity.get(k.n) : fitAll.assign.get(k.n); if (e && e.state === 'checked' && !e.gone) continue;
        if (e && process.env.READS && (!process.env.READS_N || process.env.READS_N.split(',').includes(String(k.n)))) { const ids = [...readLog.keys()].filter((id) => eng.finalId(id) === e.id); for (const id of ids) for (const r of readLog.get(id).slice(0, 12)) console.log('      read', id, r); }
        console.log(`  #${k.n} (${k.code}):`, e ? `entry ${e.id} ${e.state || 'checking'} closeRead ${!!(e.t1 && PH.isCloseRead(e.t1))} side ${e.t1 ? Math.round(e.t1.meanSide) : '-'} q ${e.t1 && e.t1.quality ? e.t1.quality.q : '-'} closeAgree ${e.closeAgree || 0} sightings ${e.sightings || 0} moments ${e.moments || 0} closeViews ${e.closeViews || 0} code ${e.t1 ? e.t1.code : '-'} gone ${!!e.gone}` : 'no entry near it'); } }
    // one-to-one: similarity key -> map by RANSAC on nearest pairs, then nearest within half a piece
    const res = matchKey(key, got, cv, byIdentity);
    Object.assign(M, { matched: res.matched, extra: res.extra, doubles: res.doubles, codeOk: res.codeOk });
    if (study) { // each read's entry (followed through merges) -> its key piece -> right or not
      const keyOf = new Map(); for (const [kn, e] of res.assigned) if (e) keyOf.set(e.id, key.pieces.find((k) => k.n === kn));
      for (const r of study.reads) { const k = keyOf.get(eng.finalId(r.id)); r.key = k ? k.n : null; r.right = k ? cyc(r.code, k.code) : null; }
      fs.writeFileSync(process.env.READSTUDY, JSON.stringify(study));
      console.log(`read study: ${study.reads.length} close reads, ${study.reads.filter((r) => r.key).length} on key pieces -> ${process.env.READSTUDY}`);
    }
    if (process.env.SHEET) { // key crop | the entry's own picture, per key piece (to check the association by eye)
      const rows = key.pieces.map((k) => { const e = res.assigned.get(k.n) || byIdentity.get(k.n); return { n: k.n, code: k.code, id: e ? e.id : null, state: e ? e.state || 'checking' : null, close: !!(e && e.t1 && PH.isCloseRead(e.t1)), ecode: e && e.t1 ? e.t1.code : null, thumb: e && e.t1 ? { w: e.t1.thumb.w, h: e.t1.thumb.h, ox: e.t1.thumb.ox, oy: e.t1.thumb.oy, s: e.t1.thumb.s, data: Array.from(e.t1.thumb.data) } : null, corners: e && e.t1 ? e.t1.corners : null, how: res.assigned.get(k.n) ? (byIdentity.get(k.n) === res.assigned.get(k.n) ? 'id' : 'pos') : 'id-unchecked' }; });
      fs.writeFileSync(process.env.SHEET, JSON.stringify(rows));
    }
    if (FLOOR.matched) check(`at least ${FLOOR.matched} key pieces matched (floor)`, res.matched >= FLOOR.matched, `${res.matched}`);
    goal('one-to-one with the answer key', res.matched === key.pieces.length && res.extra === 0, `${res.matched}/${key.pieces.length} matched, ${res.extra} extra, ${res.doubles} doubles${res.missing.length ? '; no entry for #' + res.missing.join(',#') : ''}`);
    const coded = key.pieces.filter((p) => p.code).length; // (a key may not give every piece's code yet)
    if (coded && FLOOR.codes) check(`at least ${FLOOR.codes} edge codes right (floor)`, res.codeOk >= FLOOR.codes, `${res.codeOk}`);
    if (coded) goal('edge types = the answer key', res.codeOk === coded, `${res.codeOk}/${coded}${res.codeBad.length ? ' wrong: ' + res.codeBad.slice(0, 8).join(' ') : ''}`);
    else console.log('SKIP  edge types: no codes in this key');
    if (key.counts.border !== null && key.counts.border !== undefined) goal('edge-piece count = the key', c.border === key.counts.border, `${c.border} vs ${key.counts.border}`);
    if (key.counts.corner !== null && key.counts.corner !== undefined) goal('corner count = the key', c.corner + (c.cornerUnplaced || 0) === key.counts.corner, `${c.corner}+${c.cornerUnplaced} vs ${key.counts.corner}`);
  }
  require('./lib/results').record('real-50', String(process.env.CASE || process.argv[2] || 3593) + (VARIANT !== 'full' ? '/' + VARIANT : ''), Object.assign(M, { failures }));
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exitCode = failures ? 1 : 0;
})();

const cyc = (a, b) => { for (let r = 0; r < 4; r++) if (a.slice(r) + a.slice(0, r) === b) return true; return false; };
function matchKey(key, got, cv, byIdentity) {
  const K = key.pieces;
  if (!got.length) return { matched: 0, extra: 0, doubles: 0, codeOk: 0, codeBad: [], missing: K.map((k) => k.n) };
  const fit = require('./keymatch').fitKey(cv, PH, K, got);
  // identity first (it can't be fooled by a bent map); position only for key pieces without one
  // 1. by shape: each key piece's reference read (answer.json, checked by eye)
  //    against every checked entry - outline and print, within a loose
  //    window around where the map puts it (the map bends, it doesn't jump)
  fit.assign = new Map();
  const asT1 = (r) => ({ code: r.code, meanSide: r.meanSide, lf: r.lf, white: r.white, edges: r.edges.map((e) => Object.assign({}, e, { sig: Float32Array.from(e.sig) })), square: { lab: Uint8Array.from(r.square.lab), mask: Uint8Array.from(r.square.mask) } });
  const pairs = [];
  for (const k of K) {
    if (!k.ref) continue;
    const ref = asT1(k.ref), g = fit.map(k.x, k.y);
    for (const e of got) {
      if (!e.t1 || Math.hypot(e.pos[0] - g[0], e.pos[1] - g[1]) > fit.unit * 8) continue; // (wide: the global fit can be a row off where the map bends most)
      const m = PH.samePiece(e.t1, ref, PH.ANCHOR_SHAPE * 1.5);
      if (m.ok) pairs.push({ k, e, d: m.d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  { const usedE = new Set(); for (const { k, e } of pairs) { if (fit.assign.has(k.n) || usedE.has(e)) continue; fit.assign.set(k.n, e); usedE.add(e); } }
  // 2. identity from the overview, for pieces the shape didn't settle
  if (byIdentity) for (const k of K) { const e = byIdentity.get(k.n); if (!fit.assign.get(k.n) && e && got.includes(e) && ![...fit.assign.values()].includes(e)) fit.assign.set(k.n, e); }
  // leftovers: a key piece without a match and a checked entry without one,
  // paired by position predicted from the matched neighbours (mutual nearest)
  { const taken = new Set([...fit.assign.values()].filter(Boolean));
    const freeE = got.filter((e) => !taken.has(e)), freeK = K.filter((k) => !fit.assign.get(k.n));
    const kd = PH.median(K.map((k) => Math.min(...K.filter((j) => j !== k).map((j) => Math.hypot(j.x - k.x, j.y - k.y)))));
    const pred = (k) => { const g = fit.map(k.x, k.y), off = []; for (const j of K) { const e = fit.assign.get(j.n); if (!e || j === k || Math.hypot(j.x - k.x, j.y - k.y) > kd * 2.6) continue; const gj = fit.map(j.x, j.y); off.push([e.pos[0] - gj[0], e.pos[1] - gj[1]]); } return off.length ? [g[0] + PH.median(off.map((o) => o[0])), g[1] + PH.median(off.map((o) => o[1]))] : g; };
    for (const k of freeK) {
      const q = pred(k); let best = null, bd = Infinity;
      for (const e of freeE) { const d = Math.hypot(e.pos[0] - q[0], e.pos[1] - q[1]); if (d < bd) { bd = d; best = e; } }
      if (!best || bd > fit.unit * 0.8) continue;
      const back = freeK.reduce((b, j) => { const qj = pred(j), d = Math.hypot(best.pos[0] - qj[0], best.pos[1] - qj[1]); return !b || d < b.d ? { j, d } : b; }, null);
      if (back.j === k) { fit.assign.set(k.n, best); freeE.splice(freeE.indexOf(best), 1); }
    } }
  const used = new Map();
  let matched = 0, codeOk = 0, doubles = 0; const codeBad = [];
  for (const k of K) {
    const p = fit.assign.get(k.n); // (identity from the overview; else position, locally refined)
    if (p) { const near = got.filter((o) => o !== p && Math.hypot(o.pos[0] - p.pos[0], o.pos[1] - p.pos[1]) < fit.unit * 0.5); if (near.length) doubles++; }
    if (!p || used.has(p.id)) continue;
    used.set(p.id, k); matched++;
    const code = p.t1 ? p.t1.edges.map((e) => e.type).join('') : '';
    if (!k.code) continue; // (not in this key)
    if (cyc(code, k.code)) codeOk++; else codeBad.push(`#${k.n}:${k.code}/${code || '-'}`);
  }
  const missing = K.filter((k) => ![...used.values()].includes(k)).map((k) => k.n);
  const assigned = new Map(); for (const [id, k] of used) assigned.set(k.n, got.find((p) => p.id === id));
  return { matched, extra: got.length - used.size, doubles, codeOk, codeBad, missing, assigned };
}
