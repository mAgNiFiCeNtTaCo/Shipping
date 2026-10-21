// Ship Desk Photos offline copy: lets phone.html open with no connection to the PC (at the post office).
// Network first (so the phone always gets the newest page when the PC is reachable), the saved copy when
// the PC doesn't answer within a few seconds. The waiting photos themselves live in IndexedDB (phone.js).
// Registered with scope "./phone", so it never touches the PC app's own service worker (sw.js).

const VERSION = "shipdesk-phone-v5";
const FILES = ["phone.html", "css/phone.css", "js/phone.js", "icon.svg", "apple-touch-icon.png", "vendor/zxing-library-0.21.3.min.js"];
const WAIT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(FILES.map((f) => cache.add(new Request(f, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("shipdesk-phone-") && key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await Promise.race([
        fetch(req),
        new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), WAIT_MS)),
      ]);
      if (res.ok && res.type === "basic") cache.put(req, res.clone());
      return res;
    } catch (e) {
      const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === "navigate" ? await cache.match("phone.html") : null);
      if (hit) return hit;
      throw e;
    }
  })());
});
