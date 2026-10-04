/* Tiny static server for testing.
 *   npm run serve          -> http://localhost:8080 (camera works on this PC)
 *   npm run serve:https    -> https://<your-PC-IP>:8443 for the iPhone on the same Wi-Fi
 * The https mode uses a self-signed certificate from `npm run cert`; Safari
 * shows a warning once (Show Details -> visit this website). */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '..');
const useHttps = process.argv.includes('--https');
const port = useHttps ? 8443 : 8080;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

function handler(req, res) {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.normalize(path.join(root, url));
  if (!file.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // Byte ranges: browsers need them to seek in a video (tools/replay-video.js, tools/video-frames.js).
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? +m[1] : Math.max(0, data.length - +m[2]), end = m[1] && m[2] ? Math.min(+m[2], data.length - 1) : data.length - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' });
      return res.end(data.subarray(start, end + 1));
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

let server;
if (useHttps) {
  const key = path.join(__dirname, 'key.pem'), cert = path.join(__dirname, 'cert.pem');
  if (!fs.existsSync(key)) { console.error('No certificate yet. Run: npm run cert'); process.exit(1); }
  server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler);
} else {
  server = http.createServer(handler);
}
server.listen(port, () => {
  console.log(`Serving ${root}`);
  console.log(`  ${useHttps ? 'https' : 'http'}://localhost:${port}/`);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal) console.log(`  ${useHttps ? 'https' : 'http'}://${a.address}:${port}/   (phone on same Wi-Fi${useHttps ? '' : ' — camera needs https'})`);
  }
});
