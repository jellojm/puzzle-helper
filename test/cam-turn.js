/* Pointed check of the worker camera's turned frames (v0.22.0): iPhone
 * frames read in the worker arrive sideways (sensor landscape) while the page
 * shows a portrait video. In headless Edge, with real VideoFrames and canvas:
 *  - a frame turned 90 / 270 degrees (videoFrameSource) matches the same
 *    picture turned pixel by pixel, whole, cropped and scaled;
 *  - the page's thumbnail comparison (camProbeTurn) picks the right turn,
 *    both ways, and gives no answer on a blank view.
 * The functions are taken from js/worker.js and js/main.js as they are.
 * Run: node test/cam-turn.js   (a few seconds; needs Edge or Chrome)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
];
// The source of one top-level function (up to the next line starting "}").
function fnSource(file, name) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(name + ' not found in ' + file);
  const j = src.indexOf('\n}', i);
  return src.slice(i, j + 2);
}

(async () => {
  const code = [
    // worker.js's canvas cache, as the functions under test use it
    'const canvasCache = new Map();', fnSource('worker.js', 'canvas2d'),
    fnSource('worker.js', 'drawTurned'), fnSource('worker.js', 'videoFrameSource'), fnSource('worker.js', 'camProbe'),
    'const S = {};', fnSource('main.js', 'camProbeTurn'), fnSource('main.js', 'camCorr'),
  ].join('\n');
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: BROWSERS.find((b) => fs.existsSync(b)), headless: true });
  let failures = 0;
  const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
  try {
    const page = await browser.newPage();
    const r = await page.evaluate(async (code) => {
      (0, eval)(code + '\nwindow.__t = { videoFrameSource, camProbe, camProbeTurn, S };');
      const { videoFrameSource, camProbe, camProbeTurn, S } = window.__t;
      // A landscape "sensor" picture with no symmetry: smooth ramps plus blocks.
      const FW = 160, FH = 120;
      const src = new OffscreenCanvas(FW, FH), sx = src.getContext('2d');
      const im = sx.createImageData(FW, FH);
      for (let v = 0; v < FH; v++) for (let u = 0; u < FW; u++) {
        const k = 4 * (v * FW + u);
        im.data[k] = (u * 255) / FW; im.data[k + 1] = (v * 255) / FH; im.data[k + 2] = (u < 40 && v < 30) ? 255 : ((u >> 4) + (v >> 4)) % 2 ? 180 : 60; im.data[k + 3] = 255;
      }
      sx.putImageData(im, 0, 0);
      // The same picture turned clockwise, by index: turned point (x, y) shows
      // sensor point (y, FH-1-x) for 90 and (FW-1-y, x) for 270.
      const turned = (rot) => {
        const W = FH, H = FW, out = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const u = rot === 90 ? y : FW - 1 - y, v = rot === 90 ? FH - 1 - x : x;
          for (let c = 0; c < 4; c++) out[4 * (y * W + x) + c] = im.data[4 * (v * FW + u) + c];
        }
        return { w: W, h: H, data: out };
      };
      const diff = (a, b, bx, by, bw) => { // mean abs RGB difference; b may be a larger image (offset bx, by; width bw)
        let s = 0, n = 0;
        for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) for (let c = 0; c < 3; c++) { s += Math.abs(a.data[4 * (y * a.w + x) + c] - b.data[4 * ((y + by) * bw + x + bx) + c]); n++; }
        return s / n;
      };
      const vf = new VideoFrame(src, { timestamp: 0 });
      const out = {};
      for (const rot of [90, 270]) {
        const ref = turned(rot), s = videoFrameSource(vf, rot);
        const whole = s.rgba(), crop = s.getCrop(30, 50, 40, 60);
        const proc = s.getProc(80); // half size
        let sp = 0, np = 0; // scaled: against the reference sampled at 2x
        for (let y = 1; y < proc.h - 1; y++) for (let x = 1; x < proc.w - 1; x++) for (let c = 0; c < 3; c++) {
          let m = 0; for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) m += ref.data[4 * ((2 * y + dy) * ref.w + 2 * x + dx) + c];
          sp += Math.abs(proc.data[4 * (y * proc.w + x) + c] - m / 4); np++;
        }
        // The page's video, here: the true turned picture.
        const video = new OffscreenCanvas(ref.w, ref.h);
        video.getContext('2d').putImageData(new ImageData(ref.data, ref.w, ref.h), 0, 0);
        window.video = video;
        out[rot] = { size: [s.w, s.h], whole: diff(whole, ref, 0, 0, ref.w), crop: diff(crop, ref, 30, 50, ref.w), proc: sp / np, procSize: [proc.w, proc.h], pick: camProbeTurn(camProbe(vf)), corr: S.camProbeLast };
      }
      // A blank (one-colour) view can't tell: no answer.
      const blank = new OffscreenCanvas(FW, FH), bx = blank.getContext('2d');
      bx.fillStyle = '#888'; bx.fillRect(0, 0, FW, FH);
      const bvf = new VideoFrame(blank, { timestamp: 1 });
      window.video = new OffscreenCanvas(FH, FW); const vx = window.video.getContext('2d'); vx.fillStyle = '#888'; vx.fillRect(0, 0, FH, FW);
      out.blank = camProbeTurn(camProbe(bvf));
      vf.close(); bvf.close();
      return out;
    }, code);
    for (const rot of [90, 270]) {
      const o = r[rot];
      check(`turned ${rot}°: portrait size`, o.size[0] === 120 && o.size[1] === 160 && o.procSize[0] === 60 && o.procSize[1] === 80, `${o.size.join('x')}, scaled ${o.procSize.join('x')}`);
      check(`turned ${rot}°: whole frame matches pixel by pixel`, o.whole < 1, `mean diff ${o.whole.toFixed(2)}`);
      check(`turned ${rot}°: a crop matches`, o.crop < 1, `mean diff ${o.crop.toFixed(2)}`);
      check(`turned ${rot}°: the scaled frame matches`, o.proc < 6, `mean diff ${o.proc.toFixed(2)}`);
      check(`the page picks ${rot}° from thumbnails`, o.pick === rot, `picked ${o.pick}, corr 90/270 ${o.corr}`);
    }
    check('a blank view gives no answer', r.blank === null, `picked ${r.blank}`);
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
