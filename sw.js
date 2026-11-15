/* IELTS Studio KH - service worker
 * Makes the site open fast and keep working on a weak or missing connection.
 *  - Our own pages and files: network first (a new version shows up straight away), saved copy when offline or slow
 *  - Libraries, icons and fonts from CDNs: saved once, then served from the phone (saves mobile data)
 *  - AI, login and database traffic is never touched or stored
 * Bump VERSION when a library changes so phones fetch the new copy.
 */
const VERSION = 'v1';
const OWN = `ielts-own-${VERSION}`, LIBS = `ielts-libs-${VERSION}`;
const CDN_HOSTS = ['cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com'];
const SLOW_MS = 3500;

// Save the page and everything it needs, so the very next visit can work offline
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const own = await caches.open(OWN), libs = await caches.open(LIBS);
    const save = async (cache, url, mode) => {
      try { const res = await fetch(new Request(url, { cache: 'reload', mode })); if (res && (res.ok || res.type === 'opaque')) await cache.put(url, res); } catch (e) { /* best effort */ }
    };
    await Promise.all(['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'].map(u => save(own, u, 'same-origin')));
    try {
      const html = await (await fetch('index.html', { cache: 'reload' })).text();
      await own.put('index.html', new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
      const urls = new Set();
      for (const m of html.matchAll(/(?:src|href)="([^"#]+)"|from "([^"]+)"/g)) urls.add(m[1] || m[2]);
      await Promise.all([...urls].map(async (u) => {
        let abs; try { abs = new URL(u, self.registration.scope); } catch (e) { return; }
        if (abs.origin === self.location.origin) { if (/\.(css|js|png|webmanifest)$/.test(abs.pathname)) await save(own, abs.href, 'same-origin'); }
        else if (CDN_HOSTS.includes(abs.hostname)) await save(libs, abs.href, /gstatic\.com\/firebasejs/.test(abs.href) ? 'cors' : 'no-cors');
      }));
    } catch (e) { /* offline during install: the next visit will fill the cache */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== OWN && k !== LIBS && k.startsWith('ielts-')) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function ownFirstNetwork(req) {
  const cache = await caches.open(OWN);
  const net = fetch(req, { cache: 'no-cache' }).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; });
  const saved = await cache.match(req) || (req.mode === 'navigate' ? (await cache.match('index.html') || await cache.match('./')) : await cache.match(req, { ignoreSearch: true }));
  if (!saved) return net;
  net.catch(() => {});
  return Promise.race([net, new Promise(r => setTimeout(() => r(saved), SLOW_MS))]).catch(() => saved);
}

async function libFirst(req) {
  const cache = await caches.open(LIBS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) event.respondWith(ownFirstNetwork(req));
  else if (CDN_HOSTS.includes(url.hostname)) event.respondWith(libFirst(req));
});
