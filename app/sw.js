// Ship Desk offline support: cache-first for the app shell, scripts, styles, vendored libraries and
// the sample file. Change VERSION whenever app files change so every browser picks up the new copy.

const VERSION = "shipdesk-v20";

const FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icon.svg",
  "css/app.css",
  "js/app.js",
  "js/store.js",
  "js/csv.js",
  "js/plan.js",
  "js/tracking.js",
  "js/paste.js",
  "js/render.js",
  "js/slips.js",
  "js/history.js",
  "js/pirate.js",
  "vendor/jspdf.umd.min.js",
  "vendor/pdf.min.js",
  "vendor/pdf.worker.min.js",
  "vendor/qrcode.js",
  "samples/tcgplayer-sample.csv",
];

// Paths that must always come from the server (the test pages, the test result endpoint, and the API:
// saved files, phone photos, the pairing link).
const SKIP = /\/(tests\/|__|api\/)/;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // One by one, so a single missing file doesn't stop the rest from being cached.
    await Promise.all(FILES.map((f) => cache.add(new Request(f, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("shipdesk-v") && key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || SKIP.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") cache.put(req, res.clone());
      return res;
    } catch (e) {
      if (req.mode === "navigate") {
        const page = await cache.match("index.html");
        if (page) return page;
      }
      throw e;
    }
  })());
});
