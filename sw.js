// Bump this version string every time index.html changes, so phones
// reliably pick up the new version instead of getting stuck on an old one.
const CACHE_NAME = 'harder-work-orders-v177';

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
  'https://cdn.jsdelivr.net/npm/@babel/standalone@7.25.6/babel.min.js',
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

// Network-first: always try to get the latest version when online (so
// updates show up right away), but fall back to the cached copy — of the
// app itself, or any CDN library — when there's no signal at all. Only
// navigation requests (loading the page itself) fall back to index.html;
// falling back to it for a failed script/CSS request would serve HTML
// content where JS was expected, breaking the app with a syntax error.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') return caches.match('./index.html');
          return new Response('', { status: 504, statusText: 'Offline and not cached' });
        })
      )
  );
});
