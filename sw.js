// Bump this version string every time index.html changes, so phones
// reliably pick up the new version instead of getting stuck on an old one.
const CACHE_NAME = 'harder-work-orders-v382';

// Handles push notifications arriving while the app isn't open — separate
// from the caching logic below, using Firebase Cloud Messaging's own
// background-message handler. Wrapped in try/catch: importScripts() makes
// its own network request every time this file is evaluated, completely
// outside the caching system below — if it fails (e.g. no signal at all),
// an uncaught error here would stop this ENTIRE script cold before any of
// the offline-fallback logic below ever runs. A failure here should only
// mean "no background push handling this time", not "the whole app breaks".
try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: "AIzaSyAcKWZYgawRHLBIqbUWPPYHmP812_4gODI",
    authDomain: "harder-contracting.firebaseapp.com",
    databaseURL: "https://harder-contracting-default-rtdb.firebaseio.com",
    projectId: "harder-contracting",
    storageBucket: "harder-contracting.firebasestorage.app",
    messagingSenderId: "337605513419",
    appId: "1:337605513419:web:f599c3a5fa57f005ed4b4e"
  });
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || 'Harder Contracting';
    const options = {
      body: (payload.notification && payload.notification.body) || '',
      icon: './icon-192.png',
    };
  self.registration.showNotification(title, options);
  });
} catch (e) {
  // No signal, or the import failed for some other reason — background push
  // notifications won't work this time, but the rest of the app (caching,
  // offline fallback, everything below) still works completely normally.
}

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css',
  'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js',
  'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs',
  'https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Same-origin files: normal caching.
      await cache.addAll(APP_SHELL).catch(() => {});
      // Cross-origin CDN files are essential — if even one fails to cache
      // (e.g. a signal drop mid-install), the whole app can break later
      // when truly offline, since there's nowhere else to load it from.
      // Retry each one a few times before giving up.
      await Promise.all(
        CDN_ASSETS.map(async (url) => {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const res = await fetch(url, { mode: 'no-cors' });
              await cache.put(url, res);
              return;
            } catch (e) {
              // wait a moment and try again
              await new Promise((r) => setTimeout(r, 800));
            }
          }
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// How requests are handled (rewritten for weak / no signal):
//  - The page itself (index.html): try the network, but only wait ~3.5 s. If the
//    network hasn't answered by then, open the saved copy right away (the network
//    request keeps going in the background and refreshes the saved copy). With no
//    saved copy yet, wait for the network as before.
//  - The app's own files and the fixed libraries (React, Firebase, fonts, pdf.js):
//    saved copy first (instant, no network), refreshed quietly in the background.
//  - Recorded narration (.mp3): saved copy first; Safari/Android ask for audio in
//    byte ranges, so a saved copy answers range requests too.
//  - Everything else (Firebase data, photos, Google APIs, Cloud Run): NOT touched
//    here. The old version saved every one of those responses; cross-origin photos
//    count as a huge chunk of the phone's storage allowance each, which filled it up
//    and made things stop working.
const CDN_HOSTS = ['cdn.jsdelivr.net', 'www.gstatic.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const PAGE_NETWORK_WAIT_MS = 3500;

async function rangeResponseFromCached(request, cached) {
  const range = request.headers.get('range');
  const m = /bytes=(\d*)-(\d*)/.exec(range || '');
  if (!m) return cached;
  const buf = await cached.arrayBuffer();
  const size = buf.byteLength;
  let start = m[1] === '' ? 0 : parseInt(m[1], 10);
  let end = m[2] === '' ? size - 1 : parseInt(m[2], 10);
  if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
  if (isNaN(start) || isNaN(end) || start >= size) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  end = Math.min(end, size - 1);
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    },
  });
}

function putIfGood(cache, request, res) {
  // Never save partial (206) or error responses.
  if (res && (res.ok || res.type === 'opaque') && res.status !== 206) {
    cache.put(request, res.clone()).catch(() => {});
  }
}

async function handlePage(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const cached = (await cache.match(request)) || (await cache.match('./index.html'));
  const network = fetch(request).then((res) => { putIfGood(cache, request, res); return res; });
  network.catch(() => {});
  event.waitUntil(network.catch(() => {}));
  if (!cached) return network;
  return Promise.race([
    network.catch(() => cached),
    new Promise((resolve) => setTimeout(() => resolve(cached), PAGE_NETWORK_WAIT_MS)),
  ]);
}

async function handleStatic(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const hasRange = request.headers.has('range');
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) {
    if (!hasRange) {
      // refresh quietly for next time
      event.waitUntil(fetch(request).then((res) => putIfGood(cache, request, res)).catch(() => {}));
      return cached;
    }
    return rangeResponseFromCached(request, cached);
  }
  if (hasRange) {
    // Not saved yet: let this request through, and save the whole file for next time.
    const url = new URL(request.url);
    if (url.origin === self.location.origin) {
      event.waitUntil(fetch(url.href).then((res) => putIfGood(cache, url.href, res)).catch(() => {}));
    }
    return fetch(request);
  }
  try {
    const res = await fetch(request);
    putIfGood(cache, request, res);
    return res;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'Offline and not cached' });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CDN_HOSTS.includes(url.hostname)) return; // not ours — leave it to the browser
  const isPage = request.mode === 'navigate' || (sameOrigin && (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')));
  event.respondWith(isPage ? handlePage(event) : handleStatic(event));
});
