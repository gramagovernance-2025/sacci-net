// SACCI Portal service worker. It exists for exactly one reason: to intercept
// the Web Share Target POST (WhatsApp -> Export chat -> Share -> SACCI) and
// stash the shared files in the 'share-inbox' cache, where portal.html picks
// them up on its next load (waConsumeSharedInbox).
//
// It deliberately does NO asset caching: every page load hits the network, so a
// deploy is never served stale from a worker cache.
//
// Two deliberate restraints, after the Sept 2026 lockout investigation:
//   1. No clients.claim(). Claiming would take control of pages that are
//      already loading, and a worker seizing a page mid-flight is a plausible
//      way for in-flight cross-origin requests (the portal's Supabase calls) to
//      fail. The share target does not need it: handling a POST navigation to
//      /share-target depends on the worker being active and in scope, not on it
//      having claimed already-open tabs.
//   2. The fetch handler bails on its first line for anything that is not a
//      same-origin POST, before touching new URL() — the cheapest possible
//      pass-through, with no chance of an exception here turning an ordinary
//      request into a network error.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function () { /* intentionally no clients.claim() */ });

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'POST') return;            // everything else untouched
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;    // never touch Supabase / CDNs
  if (url.pathname !== '/share-target') return;

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
});
