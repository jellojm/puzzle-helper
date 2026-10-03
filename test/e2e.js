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
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('http://localhost:8080/');
    await page.click('#startBtn');
    await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
    await page.evaluate(() => { const t = document.getElementById('debugToggle'); t.checked = true; t.dispatchEvent(new Event('change')); });
    // Wait for OpenCV download + first frames.
    await page.waitForFunction(() => /^[1-9]\d* pieces/.test(document.getElementById('stats').textContent), null, { timeout: 120000 });
    await page.waitForTimeout(15000);
    const stats1 = await page.textContent('#stats');
    const dbg = await page.textContent('#debug');
    console.log('stats after sweep:', stats1, '\n' + dbg);
    await page.screenshot({ path: path.join(OUT, 'e2e-scan.png') });
    const n1 = parseInt(stats1, 10);
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
    const n2 = parseInt(stats2, 10);
    check('snap adds the rest without duplicating', n2 >= 37 && n2 <= 42, `${n2} pieces (39 loose + 1 section on the table)`);
    check('pieces placed on the box', /(\d+) placed/.test(stats2) && parseInt(stats2.match(/(\d+) placed/)[1], 10) >= 20, stats2);

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
    } else {
      check('tapping a piece opens its matches', false, 'no shaped piece on screen to tap');
    }
    // Assembled section: tap it -> section view with its loose neighbors.
    await page.click('#closeFind').catch(() => {});
    // the section has to come fully into the (moving) fake camera view
    const sp = await page.waitForFunction(() => window.__phPick && window.__phPick('section'), null, { timeout: 30000, polling: 200 }).then((h) => h.jsonValue()).catch(async () => {
      console.log('statuses seen:', await page.evaluate(() => JSON.stringify(window.__phStatuses && window.__phStatuses())));
      return null;
    });
    // Fall back to selecting it from the catalog. The fake camera is a video
    // file, and the app now releases the camera behind a modal, so re-opening
    // it restarts that file — the section may simply never pan back into view
    // here. test/live-sections.js covers the engine side deterministically;
    // what this check is really for is the panel the selection produces.
    const picked = sp || await page.evaluate(() => window.__phSelectStatus('section')) ||
      await page.evaluate(() => window.__phSelectKind && window.__phSelectKind('section'));
    if (picked) {
      if (sp) await page.mouse.click(sp[0], sp[1]);
      const ok = await page.waitForFunction(() => /Assembled section/.test(document.getElementById('selTitle').textContent), null, { timeout: 8000 }).then(() => true).catch(() => false);
      const sub = await page.textContent('#selSub');
      await page.screenshot({ path: path.join(OUT, 'e2e-section.png') });
      check('tapping an assembled section shows where it goes', ok && /column/.test(sub), sub);
    } else check('tapping an assembled section shows where it goes', false, 'no section in the catalog at all');
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
    // Send report: in a desktop browser the files are downloaded.
    await page.click('#menuBtn');
    const dls = [];
    page.on('download', (d) => dls.push(d.suggestedFilename()));
    await page.click('#reportBtn');
    await page.waitForTimeout(4000);
    check('send report produces frame + analyzed view + data files', dls.some((n) => n.endsWith('.json')) && dls.some((n) => n.endsWith('frame.jpg')) && dls.some((n) => n.endsWith('analyzed.jpg')), dls.join(', '));
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
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll browser checks passed');
  process.exitCode = failures ? 1 : 0;
})();
