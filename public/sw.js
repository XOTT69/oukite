const CACHE = "oukitel-home-static-v3.1.0";
const ASSETS = [
  "/",
  "/index.html",
  "/styles.css?v=3.1.0",
  "/app.js?v=3.1.0",
  "/core.mjs?v=3.1.0",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))),
);
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith("oukitel-home-static-") && key !== CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // HTML and its versioned modules are one installed release. A waiting
      // worker activates only after the user accepts the update or closes tabs.
      if (event.request.mode === "navigate") {
        const shell = await cache.match("/");
        if (shell) return shell;
      }
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        return await fetch(event.request);
      } catch {
        return new Response(
          "Немає інтернету. Поверніться на головну сторінку.",
          {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        );
      }
    })(),
  );
});
