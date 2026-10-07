/* Browser end-to-end check: runs the real page in headless Edge/Chrome with a
 * fake camera that plays a synthetic sweep over scattered puzzle pieces.
 * Run: node test/e2e.js   (needs network for the OpenCV.js CDN)
 * Writes screenshots to test/out/. */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const S = require('./synth');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
];

function writeY4M(file, frames, W, H, fps) {
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F${fps}:1 Ip A1:1 C420jpeg\n`);
  const Y = Buffer.alloc(W * H), U = Buffer.alloc((W / 2) * (H / 2)), V = Buffer.alloc((W / 2) * (H / 2));
  for (const rgba of frames) {
    for (let i = 0, p = 0; p < W * H; p++, i += 4) Y[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    for (let y = 0; y < H / 2; y++) for (let x = 0; x < W / 2; x++) {
      const i = ((2 * y) * W + 2 * x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      U[y * (W / 2) + x] = Math.max(0, Math.min(255, 128 - 0.168736 * r - 0.331264 * g + 0.5 * b));
      V[y * (W / 2) + x] = Math.max(0, Math.min(255, 128 + 0.5 * r - 0.418688 * g - 0.081312 * b));
    }
    fs.writeSync(fd, 'FRAME\n'); fs.writeSync(fd, Y); fs.writeSync(fd, U); fs.writeSync(fd, V);
  }
  fs.closeSync(fd);
}
function writePng(file, mat) {
  const raw = file + '.rgba';
  fs.writeFileSync(raw, Buffer.from(mat.data));
  execFileSync('python', ['-c', `from PIL import Image; Image.frombytes('RGBA',(${mat.cols},${mat.rows}),open(r'${raw}','rb').read()).convert('RGB').save(r'${file}')`]);
  fs.unlinkSync(raw);
}

(async () => {
  let cv = require('@techstark/opencv-js');
  if (cv instanceof Promise) cv = await cv; else if (!cv.Mat) await new Promise((r) => (cv.onRuntimeInitialized = r));

  console.log('Generating synthetic sweep…');
  const P = S.makePuzzle(cv, { cols: 8, rows: 6, cs: 48, seed: 3 });
  const blocks = [{ r0: 2, c0: 1, rows: 3, cols: 3 }];
  const subset = P.pieces.map((p, i) => i).filter((i) => !(P.pieces[i].r >= 2 && P.pieces[i].r < 5 && P.pieces[i].c >= 1 && P.pieces[i].c < 4));
  const sc = S.scatter(cv, P, { scale: 2.2, seed: 5, subset, blocks });
  const FW = 1280, FH = 720, zoom = 1.0;
  const frames = [];
  const xs = [], n = 40;
  for (let i = 0; i < n; i++) xs.push(FW / 2 + ((sc.TW - FW) * (0.5 - 0.5 * Math.cos((i / n) * Math.PI * 2))));
  for (let i = 0; i < n; i++) {
    const y = sc.TH / 2 + Math.sin((i / n) * Math.PI * 4) * (sc.TH - FH) * 0.45;
    const fr = S.cameraFrame(cv, sc.table, xs[i], y, Math.sin(i * 0.2) * 0.05, zoom, FW, FH);
    frames.push(new Uint8Array(fr.data));
    fr.delete();
  }
  const y4m = path.join(OUT, 'sweep.y4m');
  writeY4M(y4m, frames, FW, FH, 5);
  const photo = S.boxPhoto(cv, P);
  writePng(path.join(OUT, 'box.jpg'), photo.mat);
  writePng(path.join(OUT, 'table.jpg'), sc.table);

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'serve.js')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const { chromium } = require('playwright-core');
  const exe = BROWSERS.find((b) => fs.existsSync(b));
  const browser = await chromium.launch({
    executablePath: exe, headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`],
  });
  let failures = 0;
  const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
  try {
    const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGE ERROR', e.message); });
    page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('CONSOLE ERROR', m.text()); } });
    await page.goto('http://localhost:8080/?closeSide=40'); // (synthetic pieces are small; the phone's close reads are 120+ px)
    await page.click('#startBtn');
    await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
    await page.evaluate(() => { const t = document.getElementById('debugToggle'); t.checked = true; t.dispatchEvent(new Event('change')); });
    // Wait for OpenCV download + first frames.
    // (v0.20: the top bar counts checked pieces; entries still being checked
    // show as "scan closer at N" - together, what has been catalogued; v0.22:
    // "reading N in view" until the first piece is checked = 0 checked)
    const catalogued = (t) => (parseInt(t, 10) || 0) + ((t.match(/scan closer at (\d+)/) || [0, 0])[1] | 0);
    await page.waitForFunction(() => { const t = document.getElementById('stats').textContent; return (parseInt(t, 10) || 0) + ((t.match(/scan closer at (\d+)/) || [0, 0])[1] | 0) > 0; }, null, { timeout: 120000 });
    await page.waitForTimeout(15000);
    const stats1 = await page.textContent('#stats');
    const dbg = await page.textContent('#debug');
    console.log('stats after sweep:', stats1, '\n' + dbg);
    await page.screenshot({ path: path.join(OUT, 'e2e-scan.png') });
    const n1 = catalogued(stats1);
    check('live camera catalogs pieces', n1 >= 25 && n1 <= 48, `${n1} pieces for 48 on the table (sweep sees part of the table)`);

    // Box picture.
    await page.click('#boxBtn');
    await page.setInputFiles('#boxInput', path.join(OUT, 'box.jpg'));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, 'e2e-box.png') });
    const grid = [await page.inputValue('#boxCols'), await page.inputValue('#boxRows')];
    await page.fill('#boxPieces', '48');
    await page.dispatchEvent('#boxPieces', 'input');
    const grid2 = [await page.inputValue('#boxCols'), await page.inputValue('#boxRows')];
    check('box grid auto-sized from piece count', grid2[0] === '8' && grid2[1] === '6', `1000 → ${grid.join('x')}, 48 → ${grid2.join('x')}`);
    await page.click('#boxUse');
    await page.waitForSelector('#minimap:not([hidden])', { timeout: 20000 });

    // Snap photo of the whole table.
    await page.setInputFiles('#snapInput', path.join(OUT, 'table.jpg'));
    await page.waitForFunction(() => /Photo:/.test(document.getElementById('toast').textContent), null, { timeout: 60000 });
    const toast = await page.textContent('#toast');
    console.log('snap toast:', toast);
    await page.waitForTimeout(6000);
    const stats2 = await page.textContent('#stats');
    console.log('stats after snap + box:', stats2);
    const n2 = catalogued(stats2);
    check('snap adds the rest without duplicating', n2 >= 37 && n2 <= 42, `${n2} pieces (39 loose + an assembled 3x3 block on the table)`);
    check('pieces placed on the box', /(\d+) on box picture/.test(stats2) && parseInt(stats2.match(/(\d+) on box picture/)[1], 10) >= 20, stats2);

    // Tap a piece that has a shape model and check the Find panel.
    const pt = await page.evaluate(() => window.__phPick && window.__phPick());
    if (pt) {
      await page.mouse.click(pt[0], pt[1]);
      await page.waitForSelector('#findPanel:not([hidden])', { timeout: 10000 });
      await page.waitForTimeout(1500);
      const title = await page.textContent('#selTitle'), sub = await page.textContent('#selSub');
      const cands = await page.$$eval('.cand', (els) => els.length);
      console.log('find panel:', title, '|', sub, '|', cands, 'candidates');
      await page.screenshot({ path: path.join(OUT, 'e2e-find.png') });
      check('tapping a piece opens its matches', cands > 0, `${cands} candidate thumbnails`);
      // Tier 1 (RESEARCH-ai-puzzle.md): verdict words, the box spot in words,
      // the piece drawn upright, and "In the puzzle" with undo.
      const verdicts = await page.$$eval('.cand .verdict', (els) => els.map((e) => e.textContent).filter(Boolean));
      check('suggestions carry a verdict word', verdicts.length > 0 && verdicts.every((v) => /^(Strong match|Likely|Maybe|Unlikely|Look-alike)$/.test(v)), verdicts.slice(0, 4).join(', '));
      check('box spot said in words', /Box: .*(sure|likely|look alike)|Not placed|Add a box/.test(sub), sub);
      const upright = await page.evaluate(() => !document.getElementById('uprightBox').hidden);
      const placedSpot = /Box: column/.test(sub);
      check('placed piece is shown upright', upright || !placedSpot, `upright ${upright}`);
      const before = await page.textContent('#stats');
      await page.click('#inPuzzleBtn');
      await page.waitForFunction(() => /in puzzle/.test(document.getElementById('stats').textContent) && document.getElementById('inPuzzleBtn').classList.contains('on'), null, { timeout: 5000 }).catch(() => {});
      const marked = await page.evaluate(() => ({ stats: document.getElementById('stats').textContent, on: document.getElementById('inPuzzleBtn').classList.contains('on') }));
      await page.click('#inPuzzleBtn');
      await page.waitForFunction(() => !document.getElementById('inPuzzleBtn').classList.contains('on'), null, { timeout: 5000 }).catch(() => {});
      const undone = await page.evaluate(() => !document.getElementById('inPuzzleBtn').classList.contains('on') && !/in puzzle/.test(document.getElementById('stats').textContent));
      check('"In the puzzle" marks and undoes', marked.on && /1 in puzzle/.test(marked.stats) && undone, `${before} -> ${marked.stats}; undone ${undone}`);
    // Owner's screenshot (2026-10-03): the Find chips sat on top of the panel's Fits/No buttons.
    const chipsHidden = await page.evaluate(() => { const b = document.getElementById('findBar'); return !document.getElementById('findPanel').hidden && (b.hidden || getComputedStyle(b).display === 'none'); });
    check('Find chips are hidden while a piece panel is open', chipsHidden);
    } else {
      check('tapping a piece opens its matches', false, 'no shaped piece on screen to tap');
    }
    // The assembled block (js/vision/assembly.js): built up, found on the box
    // and shaded on the box picture; tapping one of its open spots lists the
    // loose pieces for it. (The fake camera is a looping video: wait for the
    // block to pan back into view.)
    await page.click('#closeFind').catch(() => {});
    const asm = await page.waitForFunction(() => { const a = window.__phAsm(); return a.info && a.info.place && a.shaded >= 6 && a.spot ? a : null; }, null, { timeout: 45000, polling: 200 })
      .then((h) => h.jsonValue()).catch(async () => page.evaluate(() => window.__phAsm()));
    check('the assembled block is built up, found on the box and shaded there', !!(asm.info && asm.info.place) && asm.shaded >= 6,
      JSON.stringify({ cells: asm.info && asm.info.cells, place: asm.info && asm.info.place, shaded: asm.shaded }));
    if (asm.spot && await page.evaluate(() => window.__phOpenSpot())) {
      const ok = await page.waitForFunction(() => /Spot: column/.test(document.getElementById('selTitle').textContent), null, { timeout: 8000 }).then(() => true).catch(() => false);
      await page.screenshot({ path: path.join(OUT, 'e2e-section.png') });
      check('tapping an open spot of the assembled block lists pieces for it', ok, await page.textContent('#selSub'));
    } else check('tapping an open spot of the assembled block lists pieces for it', false, 'no open spot with a box cell in view');
    // Teach background: tap a bare spot, expect it to be learned, then clear.
    await page.click('#closeFind').catch(() => {});
    await page.click('#menuBtn');
    await page.click('#teachBtn');
    await page.mouse.click(12, 400);
    await page.waitForFunction(() => /1 spot/.test(document.getElementById('teachCount').textContent), null, { timeout: 5000 }).catch(() => {});
    const taught = await page.textContent('#teachCount');
    await page.click('#teachClear');
    await page.click('#teachDone');
    check('teach background learns a tapped color', /1 spot/.test(taught), taught);
    // Flashlight (owner, 2026-10-06: "tapping it does nothing"): the switch is
    // in the menu, where the camera is off - the light must be asked for when
    // the camera comes back, and survive the frame-rate changes.
    {
      await page.evaluate(() => {
        window.__cons = [];
        const orig = MediaStreamTrack.prototype.applyConstraints;
        MediaStreamTrack.prototype.applyConstraints = function (c) { window.__cons.push(JSON.stringify(c || {})); return orig.call(this, c); };
      });
      await page.click('#menuBtn');
      const shown = await page.evaluate(() => !document.getElementById('torchRow').hidden);
      if (shown) {
        await page.click('#torchToggle');
        const t = await page.textContent('#toast');
        await page.click('#closeMenu').catch(() => {});
        await page.waitForFunction(() => window.__cons.some((c) => /"torch":true/.test(c)), null, { timeout: 8000 }).catch(() => {});
        const cons = await page.evaluate(() => window.__cons);
        check('Flashlight: switched on in the menu, asked for when the camera is back', cons.some((c) => /"torch":true/.test(c)) && /close this menu|not allow/.test(t), `${t} | ${cons.length} camera requests, torch in ${cons.filter((c) => /"torch":true/.test(c)).length}`);
        await page.click('#menuBtn');
        await page.click('#torchToggle');
        await page.click('#closeMenu').catch(() => {});
      } else { check('Flashlight: switch shown with the camera on', false, 'hidden'); await page.click('#closeMenu').catch(() => {}); }
    }
    // Border (toolbar): corners + edge pieces in one tap, off on the second.
    await page.click('#closeFind').catch(() => {});
    await page.click('#edgesBtn');
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'e2e-border-lit.png') }); // whole outlines, shaded
    const borderOn = await page.evaluate(() => ({ pressed: document.getElementById('edgesBtn').getAttribute('aria-pressed'), toast: document.getElementById('toast').textContent }));
    await page.click('#edgesBtn');
    await page.waitForTimeout(300);
    const borderOff = await page.evaluate(() => document.getElementById('edgesBtn').getAttribute('aria-pressed'));
    check('Border button lights up corners + edges and toggles off', borderOn.pressed === 'true' && /border pieces/.test(borderOn.toast) && borderOff === 'false', `${borderOn.toast} | off: ${borderOff}`);
    check('Snap is off the toolbar (kept under More)', await page.evaluate(() => !document.querySelector('#toolbar #snapBtn') && !!document.querySelector('#menu #snapBtn')));

    // Zones (tray sorting) and "fill this spot" on the enlarged box picture.
    await page.click('#toolbar [data-mode="find"]').catch(() => {});
    await page.click('#findBar [data-filter="zones"]');
    await page.waitForTimeout(800);
    const zones = await page.evaluate(() => ({ on: document.querySelector('#findBar [data-filter="zones"]').classList.contains('on'), toast: document.getElementById('toast').textContent }));
    await page.click('#findBar [data-filter="zones"]');
    check('Zones lights pieces by area of the box', zones.on && /colour of their area/.test(zones.toast), zones.toast.slice(0, 90));
    const mm = await page.$('#minimap');
    if (mm && await mm.isVisible()) {
      let b = await mm.boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); // enlarge
      await page.waitForTimeout(400);
      b = await mm.boundingBox();
      await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.5); // pick the middle spot
      const ok = await page.waitForFunction(() => !document.getElementById('findPanel').hidden && /^Spot: column/.test(document.getElementById('selTitle').textContent), null, { timeout: 6000 }).then(() => true).catch(() => false);
      const info = ok ? await page.evaluate(() => `${document.getElementById('selTitle').textContent} | ${document.querySelectorAll('#edgeRows .cand').length} pieces`) : 'panel did not open';
      check('Fill this spot: tapping a spot lists pieces for it', ok && /[1-9]\d* pieces/.test(info), info);
      await page.click('#closeFind').catch(() => {});
    } else check('Fill this spot: tapping a spot lists pieces for it', false, 'box picture not visible');

    // Matches: step through pairs; the pair is shaded and joined by an arc.
    await page.click('#pairsBtn');
    const mOpen = await page.waitForFunction(() => !document.getElementById('matchBar').hidden, null, { timeout: 15000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(1200);
    const mLabel = mOpen ? await page.textContent('#matchLabel') : '';
    await page.screenshot({ path: path.join(OUT, 'e2e-matches.png') });
    check('Matches: pairs listed with a verdict', mOpen && /(Strong match|Likely|Maybe|Look-alike|Unlikely) \d+%/.test(mLabel), mLabel || 'match bar did not open');
    if (mOpen) await page.click('#matchClose').catch(() => {});

    // Mark the finished border: aim, capture, Use (the default corners are
    // fine here: what matters is that the view is learned and found again).
    await page.click('#menuBtn');
    await page.click('#frameBtn');
    await page.waitForSelector('#frameBar:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(800);
    await page.click('#frameShot');
    const modal = await page.waitForSelector('#frameModal:not([hidden])', { timeout: 5000 }).then(() => true).catch(() => false);
    const canvasW = await page.evaluate(() => document.getElementById('frameCanvas').clientWidth);
    await page.screenshot({ path: path.join(OUT, 'e2e-border-mark.png') });
    check('Mark border: camera still with 4 numbered corners', modal && canvasW > 100, `canvas ${canvasW}px wide`);
    await page.click('#frameUse');
    const marked = await page.waitForFunction(() => /Border marked/.test(document.getElementById('toast').textContent), null, { timeout: 15000 }).then(() => true).catch(() => false);
    check('Mark border: border marked', marked, await page.textContent('#toast'));
    const seen = await page.waitForFunction(() => { const b = window.__phBorder(); return b && b.visible; }, null, { timeout: 15000, polling: 200 }).then(() => true).catch(() => false);
    check('Mark border: found again in the live view', seen, JSON.stringify(await page.evaluate(() => window.__phBorder())).slice(0, 120));
    await page.evaluate(() => window.__phSelectStatus('placed'));
    await page.waitForFunction(() => !document.getElementById('findPanel').hidden && /^Piece #/.test(document.getElementById('selTitle').textContent), null, { timeout: 10000 }).catch(() => {});
    const spot = await page.waitForFunction(() => { const b = window.__phBorder(); return b && b.target; }, null, { timeout: 15000, polling: 200 }).then(() => true).catch(() => false);
    check('Mark border: a selected piece gets its spot inside the border', spot, JSON.stringify(await page.evaluate(() => window.__phBorder())).slice(0, 120));
    const peekShown = await page.evaluate(() => !document.getElementById('findPeek').hidden);
    if (peekShown) await page.click('#findPeek');
    await page.waitForTimeout(500);
    const panelH = await page.evaluate(() => document.getElementById('findPanel').getBoundingClientRect().height);
    await page.screenshot({ path: path.join(OUT, 'e2e-border-spot.png') });
    check('Mark border: "Show spot" folds the piece panel out of the way', peekShown && panelH < 140, `panel ${Math.round(panelH)}px tall`);
    await page.click('#closeFind').catch(() => {});
    await page.click('#menuBtn');
    const forgetShown = await page.evaluate(() => !document.getElementById('frameForget').hidden);
    await page.click('#frameForget');
    check('Mark border: can be forgotten', forgetShown);

    // Send report: in a desktop browser the files are downloaded.
    await page.click('#menuBtn');
    const dls = [];
    let reportJson = null;
    page.on('download', async (d) => {
      dls.push(d.suggestedFilename());
      if (d.suggestedFilename().endsWith('.json')) { try { reportJson = JSON.parse(fs.readFileSync(await d.path(), 'utf8')); } catch (_) { /* checked below */ } }
    });
    await page.click('#reportBtn');
    await page.waitForTimeout(4000);
    check('send report produces frame + analyzed view + data files', dls.some((n) => n.endsWith('.json')) && dls.some((n) => n.endsWith('frame.jpg')) && dls.some((n) => n.endsWith('analyzed.jpg')), dls.join(', '));
    const want = ['mainThread', 'stats', 'settings', 'device', 'flow'], wantW = ['engine', 'catalog', 'session'];
    const missing = reportJson ? want.filter((k) => !reportJson[k]).concat(wantW.filter((k) => !(reportJson.worker || {})[k])) : ['(no JSON)'];
    const w = (reportJson && reportJson.worker) || {};
    check('vision runs on our SIMD OpenCV build (CDN build as fallback)', w.cvBuild === 'simd', `${w.cvBuild} (simd supported: ${w.simd})${w.cvError ? ' error: ' + w.cvError : ''}`);
    check('report carries the diagnostic blocks', !missing.length,
      missing.length ? 'missing ' + missing.join(', ') : `session ${JSON.stringify(reportJson.worker.session).slice(0, 120)}… | wasm ${reportJson.worker.engine.wasmHeapMB} MB | lag in history: ${reportJson.history.some((r) => r.lag != null)}`);
    // The vision library "crashes" (a WebAssembly trap, as in the owner's
    // screenshots 2026-10-04): the worker saves, the page starts a fresh one,
    // and the catalog comes back.
    const pre = await page.evaluate(() => window.__phRestarts());
    await page.evaluate(() => window.__phTrap());
    const post = await page.waitForFunction(() => { const r = window.__phRestarts(); return r.restarts >= 1 && r.ready && r.pieces !== null ? r : null; }, null, { timeout: 90000, polling: 300 })
      .then((h) => h.jsonValue()).catch(async () => page.evaluate(() => window.__phRestarts()));
    check('a vision-library crash restarts the engine and keeps the catalog', post.restarts >= 1 && post.ready && post.pieces >= pre.pieces,
      `${pre.pieces} pieces before, ${post.pieces} after; restarts ${post.restarts}`);
    // Phone tilted ~35°: feed gravity readings, then tap a piece through the
    // corrected mapping (outline -> screen -> tap -> back to the piece).
    await page.evaluate(() => {
      window.__fakeTilt = setInterval(() => window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        accelerationIncludingGravity: { x: 0, y: -5.6, z: -8.0 }, acceleration: { x: 0, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 },
      })), 50);
    });
    await page.waitForTimeout(6000);
    const tiltInfo = await page.evaluate(() => ({ stats: document.getElementById('stats').textContent, dbg: document.getElementById('debug').textContent }));
    console.log('tilted:', tiltInfo.stats, '|', tiltInfo.dbg.split(String.fromCharCode(10)).pop());
    check('tilt reading shown and correction applied', /3[0-9]° tilt/.test(tiltInfo.stats) && /corrected/.test(tiltInfo.dbg), tiltInfo.stats);
    await page.click('#closeFind').catch(() => {});
    const pt2 = await page.evaluate(() => window.__phPick && window.__phPick());
    if (pt2) {
      await page.mouse.click(pt2[0], pt2[1]);
      const opened = await page.waitForSelector('#findPanel:not([hidden])', { timeout: 8000 }).then(() => true).catch(() => false);
      check('tapping a piece works with tilt correction', opened, opened ? await page.textContent('#selTitle') : 'panel did not open');
    } else check('tapping a piece works with tilt correction', false, 'no shaped piece visible');

    // Table view (Map mode): camera off, pieces drawn from above, same tools.
    await page.click('#closeFind').catch(() => {});
    await page.click('#toolbar [data-mode="map"]');
    await page.waitForFunction(() => window.__phMapState && window.__phMapState().pieces > 0, null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(400);
    const ms = await page.evaluate(() => window.__phMapState());
    check('Map: camera off, scanned pieces drawn as pictures', !ms.hidden && !ms.active && ms.drawn > 5, `${ms.drawn} of ${ms.pieces} drawn`);
    await page.screenshot({ path: path.join(OUT, 'e2e-map.png') });
    const sz = ms.size || [];
    check('Map: every picture drawn at one piece size', sz.length > 5 && sz[0] > 0.75 && sz[sz.length - 1] < 1.3, sz.length ? `${sz[0]} - ${sz[sz.length - 1]} (median ${sz[sz.length >> 1]})` : 'none');
    const mp = await page.evaluate(() => window.__phMapPick());
    if (mp) {
      await page.mouse.click(mp[0], mp[1]);
      const opened = await page.waitForFunction(() => !document.getElementById('findPanel').hidden && /Piece #/.test(document.getElementById('selTitle').textContent), null, { timeout: 5000 }).then(() => true).catch(() => false);
      check('Map: tapping a piece opens its matches', opened, opened ? await page.textContent('#selTitle') : `tapped #${mp[2]}, panel did not open`);
      await page.click('#closeFind').catch(() => {});
    } else check('Map: tapping a piece opens its matches', false, 'no drawn piece on screen');
    await page.click('#edgesBtn');
    await page.waitForTimeout(400);
    const stillMap = await page.evaluate(() => !document.getElementById('tableMap').hidden && document.getElementById('edgesBtn').getAttribute('aria-pressed') === 'true');
    check('Map: Border lights up on the map without leaving it', stillMap);
    await page.click('#edgesBtn');
    await page.click('#toolbar [data-mode="scan"]');
    await page.waitForTimeout(1500);
    const back = await page.evaluate(() => window.__phMapState());
    check('Scan again: camera back on, map hidden', back.hidden && back.active, `hidden ${back.hidden}, camera ${back.active}`);
    // ---- v0.16.0: in-app photo, puzzle library, camera path ----
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'E2E puzzle' : undefined));
    const camPath = await page.evaluate(() => window.__phCamPath && window.__phCamPath());
    console.log('camera path:', camPath);
    // "Catalog from a photo" from the menu: in the app when ImageCapture works
    await page.click('#menuBtn');
    await page.click('#snapBtn');
    const photoOk = await page.waitForFunction(() => /^Photo: \d+ pieces found/.test(document.getElementById('toast').textContent) || /inside the app/.test(document.getElementById('toast').textContent), null, { timeout: 30000 }).then(() => true).catch(() => false);
    const photoMsg = await page.textContent('#toast');
    check('Catalog from a photo, inside the app (or the camera app if it can\'t)', photoOk, photoMsg.slice(0, 100));
    await page.waitForTimeout(1500);
    const n0 = await page.evaluate(() => (document.getElementById('stats').textContent.match(/^(\d+) pieces/) || [])[1]);
    await page.click('#menuBtn');
    await page.click('#libSave');
    const saved = await page.waitForFunction(() => /E2E puzzle/.test(document.getElementById('libList').textContent), null, { timeout: 8000 }).then(() => true).catch(() => false);
    // (saving runs a full housekeeping pass first - v0.20: the count to get back is the one shown now)
    await page.waitForTimeout(500);
    const nSaved = await page.evaluate(() => (document.getElementById('stats').textContent.match(/^(\d+) pieces/) || [])[1]);
    await page.click('#newPuzzle');
    await page.waitForFunction(() => /^(0 pieces|reading \d+ in view)/.test(document.getElementById('stats').textContent), null, { timeout: 8000 }).catch(() => {});
    const afterNew = await page.textContent('#stats');
    await page.click('#menuBtn');
    await page.waitForFunction(() => document.querySelectorAll('#libList .lib-row button').length > 0, null, { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => { const row = [...document.querySelectorAll('#libList .lib-row')].find((r) => /E2E puzzle/.test(r.textContent)); if (row) row.querySelector('button').click(); });
    const reopened = await page.waitForFunction((n) => (document.getElementById('stats').textContent.match(/^(\d+) pieces/) || [])[1] === n, nSaved, { timeout: 10000 }).then(() => true).catch(() => false);
    check('Puzzle library: save, start a new puzzle, open the saved one again', saved && /^(0 pieces|reading \d+ in view)/.test(afterNew) && reopened, `saved ${saved} (${n0} pieces before, ${nSaved} as saved); after New: ${afterNew}; reopened with ${nSaved} pieces: ${reopened}`);
    await page.click('#closeMenu').catch(() => {});

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll browser checks passed');
  process.exitCode = failures ? 1 : 0;
})();
