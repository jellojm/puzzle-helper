/* Frames of a phone video for Node tests, streamed by tools/video-stream.py
 * (decoded once, never written to disk).
 *   for await (const f of videoFrames(file, { step: 5 })) { f.w, f.h, f.data (RGBA), f.still, f.t }
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');

async function* videoFrames(file, opts) {
  opts = opts || {};
  const args = [path.join(__dirname, '..', 'tools', 'video-stream.py'), file, String(opts.step || 5), String(opts.maxSide || 0), String(opts.from || 0), String(opts.to || 1e9)];
  const py = spawn('python', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0), ended = false, wake = null;
  py.stdout.on('data', (c) => { buf = buf.length ? Buffer.concat([buf, c]) : c; if (wake) { const w = wake; wake = null; w(); } });
  py.stdout.on('end', () => { ended = true; if (wake) { const w = wake; wake = null; w(); } });
  const need = async (n) => { while (buf.length < n && !ended) await new Promise((r) => (wake = r)); return buf.length >= n; };
  try {
    for (;;) {
      let nl;
      while ((nl = buf.indexOf(10)) < 0) { if (ended) return; await new Promise((r) => (wake = r)); }
      const head = JSON.parse(buf.subarray(0, nl).toString());
      buf = buf.subarray(nl + 1);
      const n = head.w * head.h * 4;
      if (!(await need(n))) return;
      const data = new Uint8ClampedArray(n);
      data.set(buf.subarray(0, n));
      buf = buf.subarray(n);
      yield Object.assign(head, { data });
    }
  } finally { py.kill(); }
}

module.exports = { videoFrames };
