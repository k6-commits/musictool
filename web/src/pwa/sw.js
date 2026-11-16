// Service worker for the installed app. scripts/build.mjs writes it to dist/sw.js with VERSION (a hash of the page,
// the manifest and the icons), ASSETS (exactly those files) and FONT_HOSTS filled in.
// - Installing fetches this version's files past the HTTP cache (GitHub Pages lets browsers keep files for 10
//   minutes, which could hand an old page to a new version) into a cache of its own; activating drops the caches
//   of older versions. The browser checks sw.js whenever the app is opened and VERSION changes with any change to
//   the page, so a new version installs in the background; the page says so (main.ts) and it shows from the next
//   start.
// - The page is answered from the cache at once, online or not: the app opens without waiting for the network and
//   is never replaced by an error page. Only the page itself: other files opened in a tab go to the network.
// - Google Fonts requests that pass through the worker (from the second start on: the first visit loads them before
//   the worker exists) are kept in a cache that outlives versions, since their URLs never change, trimmed to
//   FONT_LIMIT entries.
const VERSION = '__VERSION__';
const ASSETS = JSON.parse('__ASSETS__');
const FONT_HOSTS = JSON.parse('__FONT_HOSTS__');
const CACHE = `musictool-${VERSION}`;
const FONT_CACHE = 'musictool-fonts';
const FONT_LIMIT = 120;
const PAGE = new URL('./', self.location).href;
const SCOPE = new URL(PAGE).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('musictool-') && k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (request.mode === 'navigate') {
    if (url.origin !== self.location.origin || (url.pathname !== SCOPE && url.pathname !== `${SCOPE}index.html`)) return;
    event.respondWith(caches.match(PAGE, { cacheName: CACHE }).then((page) => page || fetch(request)));
    return;
  }
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(fromFontCache(event, request));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(caches.match(request, { cacheName: CACHE }).then((hit) => hit || fetch(request)));
  }
});

async function fromFontCache(event, request) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  // Stored after the answer, not before it.
  if (response.ok) event.waitUntil(keepFont(cache, request, response.clone()));
  return response;
}

async function keepFont(cache, request, response) {
  await cache.put(request, response);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - FONT_LIMIT)).map((key) => cache.delete(key)));
}
