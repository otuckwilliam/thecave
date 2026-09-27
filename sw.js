// The Cave Ledger — offline support. Keeps the app itself on the device so it opens without internet.
// Network first: when online, always load the newest app files; fall back to the saved copy when offline.
const CACHE = "cave-ledger-v11";
const SHELL = ["./", "index.html", "config.js", "js/app.js", "vendor/supabase.js", "vendor/jspdf.umd.min.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" }))))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return; // database calls go straight to the network
  e.respondWith(caches.open(CACHE).then(async c => {
    try {
      const r = await fetch(e.request, { cache: "no-cache" });
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch (_) {
      return (await c.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  }));
});
