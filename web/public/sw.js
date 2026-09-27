// Minimal service worker: no offline caching (videos are streamed live),
// only the Web Share Target so Android can "share" videos straight into the app.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "POST" || url.pathname !== "/share") return;
  e.respondWith(
    (async () => {
      const form = await e.request.formData();
      const cache = await caches.open("vv-share");
      let i = 0;
      for (const f of form.getAll("videos")) {
        if (!(f instanceof File)) continue;
        await cache.put(
          `/shared/${Date.now()}-${i++}`,
          new Response(f, { headers: { "content-type": f.type || "video/mp4", "x-name": encodeURIComponent(f.name) } }),
        );
      }
      return Response.redirect("/all?share=1", 303);
    })(),
  );
});
