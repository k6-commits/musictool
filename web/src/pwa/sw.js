// Service worker for the installed app (scripts/build.mjs writes it to dist/sw.js with VERSION filled in): the
// page, its manifest and its icons are cached when it installs, so the app opens without a network. Pages are
// fetched from the network first (a new version shows at once) and come from the cache when the network fails or
// takes more than 3 s. Google Fonts are cached as they are first used. A new build has a new VERSION, so the
// browser installs the new worker, which drops the old cache.
const VERSION = '__VERSION__';
const CACHE = `musictool-${VERSION}`;
const PAGE = './';
const ASSETS = [PAGE, 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('musictool-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Keep a copy of a good response. */
function keep(request, response) {
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (request.mode === 'navigate') {
    // Every page of the app is the same single page.
    const network = fetch(request).then((response) => keep(PAGE, response));
    network.catch(() => {}); // answered from the cache below
    const slow = new Promise((resolve) => setTimeout(resolve, 3000)).then(() => caches.match(PAGE));
    event.respondWith(
      Promise.race([network, slow])
        .then((response) => response || network)
        .catch(() => caches.match(PAGE)),
    );
    return;
  }
  if (url.origin === self.location.origin || FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((response) => keep(request, response))));
  }
});
