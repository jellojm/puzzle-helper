/* Service worker: makes the app open offline and caches the ~10 MB OpenCV.js
 * download. App files: network first (so updates show up), cache fallback.
 * OpenCV (versioned URL): cache first. */
const CACHE = 'puzzle-helper-v2';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.json',
  'js/main.js', 'js/overlay.js', 'js/boxSetup.js', 'js/worker.js',
  'js/vision/core.js', 'js/vision/segment.js', 'js/vision/pieceModel.js', 'js/vision/box.js',
  'js/vision/matcher.js', 'js/vision/rectify.js', 'js/vision/sections.js', 'js/vision/engine.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const OPENCV = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;
  if (url === OPENCV) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(url);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(url, res.clone());
      return res;
    }));
    return;
  }
  if (new URL(url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
