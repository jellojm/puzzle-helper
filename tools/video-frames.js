/* Extract still frames from a phone video (decoded by headless Edge/Chrome,
 * so no ffmpeg needed): node tools/video-frames.js <video> <outDir> [fps] [maxSide]
 * Writes f0000.jpg, f0001.jpg, ... (default 4 fps, long side 1440). */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const [videoArg, outArg, fpsArg, sideArg] = process.argv.slice(2);
if (!videoArg || !outArg) { console.log('usage: node tools/video-frames.js <video> <outDir> [fps] [maxSide]'); process.exit(1); }
const BROWSERS = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'];

(async () => {
  fs.mkdirSync(outArg, { recursive: true });
  const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.js')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: BROWSERS.find((b) => fs.existsSync(b)), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('http://localhost:8080/manifest.json');
    const rel = path.relative(root, path.resolve(videoArg)).split(path.sep).join('/');
    const fps = +(fpsArg || 4), side = +(sideArg || 1440);
    const n = await page.evaluate(async ({ src, fps, side }) => {
      const v = document.createElement('video');
      v.muted = true; v.src = '/' + src; v.preload = 'auto';
      await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('cannot decode')); });
      const s = Math.min(1, side / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
      window.__frames = [];
      for (let t = 0; t < v.duration; t += 1 / fps) {
        v.currentTime = t;
        await new Promise((r) => (v.onseeked = r));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        window.__frames.push(c.toDataURL('image/jpeg', 0.9));
      }
      return window.__frames.length;
    }, { src: rel, fps, side });
    for (let i = 0; i < n; i++) {
      const url = await page.evaluate((k) => window.__frames[k], i);
      fs.writeFileSync(path.join(outArg, `f${String(i).padStart(4, '0')}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
    }
    console.log(`${n} frames -> ${outArg}`);
  } finally {
    await browser.close();
    server.kill();
  }
})();
