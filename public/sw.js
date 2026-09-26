/* NameTag service worker: precache the whole app, serve cache-first, update on demand. */
const VERSION = 'dev'; // replaced at build time by scripts/stamp-version.mjs
const CACHE = `nametag-${VERSION}`;
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/theme-init.js', 'js/app.js',
  'js/core/utils.js', 'js/core/ui.js', 'js/core/sources.js', 'js/core/remap.js', 'js/core/remap-ui.js', 'js/core/planner.js', 'js/core/manifest.js', 'js/core/history.js',
  'js/renamer/rules.js', 'js/renamer/analyzer.js', 'js/renamer/presets.js', 'js/renamer/extensions.js', 'js/renamer/renamer-ui.js',
  'js/tagger/bytes.js', 'js/tagger/model.js', 'js/tagger/id3.js', 'js/tagger/mpeg.js', 'js/tagger/flac.js', 'js/tagger/vorbis.js',
  'js/tagger/ogg.js', 'js/tagger/mp4.js', 'js/tagger/riff.js', 'js/tagger/index.js', 'js/tagger/tools.js', 'js/tagger/online.js', 'js/tagger/tagger-ui.js',
  'vendor/jszip.min.js',
  'fonts/next-latin-400.woff2', 'fonts/next-latin-600.woff2', 'fonts/next-latin-800.woff2',
  'fonts/next-latin-ext-400.woff2', 'fonts/next-latin-ext-600.woff2', 'fonts/next-latin-ext-800.woff2',
  'fonts/mono-latin-400.woff2', 'fonts/mono-latin-600.woff2', 'fonts/mono-latin-ext-400.woff2', 'fonts/mono-latin-ext-600.woff2',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('nametag-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data?.type === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // MusicBrainz, LRCLIB, Cover Art Archive go straight to the network
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      return (await cache.match('index.html')) || fetch(req);
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch {
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
