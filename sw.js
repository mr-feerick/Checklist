// =====================================================================
// Daily Checklist — offline support
// - Your own files: try the network first (so changes you push to GitHub
//   show up straight away), fall back to the saved copy when offline.
// - Fonts and icons: use the saved copy (they never change).
// - Supabase (your data): never touched here — always goes to the internet.
// Bump VERSION if you ever want to force every device to re-download everything.
// =====================================================================
const VERSION = "v2";
const CACHE = "checklist-" + VERSION;
const SHELL = [
  "./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest",
  "icon.png", "icon-192.png", "icon-512.png", "apple-touch-icon.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      // add one by one so a single failure doesn't stop the rest
      Promise.all(SHELL.map(url => cache.add(new Request(url, { cache: "reload" })).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("checklist-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Your data lives on Supabase: always live, never cached
  if (/supabase\.co$/.test(url.hostname)) return;

  const sameSite = url.origin === self.location.origin;
  const isLib = url.hostname === "cdn.jsdelivr.net";
  if (!sameSite && !isLib) return;

  const forever = sameSite && /\/fonts\/|\.png$/.test(url.pathname);
  if (forever) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  // network first, saved copy when offline
  event.respondWith(
    fetch(req).then(res => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() =>
      caches.match(req, { ignoreSearch: true }).then(hit =>
        hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error())
      )
    )
  );
});
