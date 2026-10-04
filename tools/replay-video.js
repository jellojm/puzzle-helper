/* Replay a phone video through the real app (headless Edge/Chrome) and log
 * what it sees: pieces, the assembled part (js/vision/assembly.js), open
 * spots. Screenshots go to test/out/replay-*.png.
 *   node tools/replay-video.js reports/IMG_3580.MOV [box.jpg] [seconds] [pieces] [colsxrows]
 * The box picture is optional (a report's *-box.jpg works); pieces = the
 * puzzle's piece count (default 1000). */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const [videoArg, boxArg, secArg, piecesArg, gridArg] = process.argv.slice(2);
if (!videoArg) { console.log('usage: node tools/replay-video.js <video> [box.jpg] [seconds] [pieces]'); process.exit(1); }
const OUT = path.join(root, 'test', 'out');
fs.mkdirSync(OUT, { recursive: true });
const BROWSERS = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'];

(async () => {
  const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.js')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: BROWSERS.find((b) => fs.existsSync(b)), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
    page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text()); });
    const rel = path.relative(root, path.resolve(videoArg)).split(path.sep).join('/');
    await page.goto(`http://localhost:8080/?video=${encodeURIComponent(rel)}`);
    await page.waitForSelector('#app:not([hidden])', { timeout: 30000 });
    await page.waitForFunction(() => window.__phRestarts && window.__phRestarts().ready, null, { timeout: 120000 });
    if (boxArg) {
      await page.click('#boxBtn');
      await page.setInputFiles('#boxInput', path.resolve(boxArg));
      await page.waitForTimeout(2500);
      await page.evaluate(() => window.__phBoxFull()); // a report's box picture is already just the picture
      await page.fill('#boxPieces', String(piecesArg || 1000));
      await page.dispatchEvent('#boxPieces', 'input');
      if (gridArg) { const [c, r] = gridArg.split('x'); await page.fill('#boxCols', c); await page.dispatchEvent('#boxCols', 'input'); await page.fill('#boxRows', r); await page.dispatchEvent('#boxRows', 'input'); }
      console.log('box grid', await page.inputValue('#boxCols'), 'x', await page.inputValue('#boxRows'));
      await page.screenshot({ path: path.join(OUT, 'replay-box.png') });
      await page.click('#boxUse');
      await page.waitForSelector('#minimap:not([hidden])', { timeout: 30000 });
    }
    const secs = +(secArg || 90), t0 = Date.now();
    let shot = 0;
    while (Date.now() - t0 < secs * 1000) {
      await page.waitForTimeout(6000);
      const st = await page.evaluate(() => {
        const a = window.__phAsm(), s = window.__phStatuses() || [];
        const by = {}; for (const x of s) by[x] = (by[x] || 0) + 1;
        return { stats: document.getElementById('stats').textContent, hint: document.getElementById('modeHint').textContent, asm: a.info, shaded: a.shaded, dets: by };
      });
      console.log(`${Math.round((Date.now() - t0) / 1000)}s | ${st.stats} | ${st.hint} | dets ${JSON.stringify(st.dets)} | asm ${JSON.stringify(st.asm)}`);
      await page.screenshot({ path: path.join(OUT, `replay-${String(shot++).padStart(2, '0')}.png`) });
    }
  } finally {
    await browser.close();
    server.kill();
  }
})();
