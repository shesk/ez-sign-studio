// EZ Sign Studio service worker.
// App files: network-first, so an online phone always gets the latest push; cache is the offline fallback.
// Google Fonts: cache-first (they never change).
// Bump VERSION only if you need to force-clear old caches; normal updates don't require it.
const VERSION = "ezsign-v3";
const APP_FILES = ["./", "index.html", "ezs-core.js", "templates.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const isFont = url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com");
  if (isFont) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res;
    })));
    return;
  }
  if (url.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(hit => hit || caches.match("index.html"))));
});
