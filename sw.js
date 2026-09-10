// SACCI Portal service worker. It exists for exactly two reasons:
//   1. PWA installability, so the portal can register in Android's share
//      sheet (WhatsApp -> Export chat -> Share -> SACCI).
//   2. Intercepting the Web Share Target POST and stashing the shared
//      files in the 'share-inbox' cache, where portal.html picks them up
//      on its next load (waConsumeSharedInbox).
// It deliberately does NO asset caching: every page load hits the network,
// so a deploy is never served stale from a worker cache.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith((async function () {
      try {
        var form = await e.request.formData();
        var files = form.getAll('media').filter(function (f) { return f && f.name; });
        var cache = await caches.open('share-inbox');
        for (var i = 0; i < files.length; i++) {
          await cache.put('/share-inbox/file-' + Date.now() + '-' + i, new Response(files[i], {
            headers: {
              'X-Name': encodeURIComponent(files[i].name),
              'Content-Type': files[i].type || 'application/octet-stream'
            }
          }));
        }
      } catch (err) { /* fall through to the portal either way */ }
      return Response.redirect('/portal.html?shared=1', 303);
    })());
  }
  // Everything else: no respondWith -> the browser goes to the network.
});
