/* Service worker: let a saved article be read offline.

   Phosphor is a static client that pulls everything from relays, so with no
   network there was nothing to read at all. This caches the shell (pages, assets)
   so the app itself opens offline; relay data still needs a connection, which is
   honest and is stated in the UI instead of pretending otherwise.

   Decisions, and why:

   - Navigations are NETWORK FIRST with a cache fallback. Cache-first would serve
     a stale page after a deploy, and this project deploys often. The fallback is
     what makes offline work.
   - Static assets (js/css/png/ico) are CACHE FIRST with a background refresh, so
     a repeat visit is instant but the next one gets the new file.
   - Only GET is handled. A POST to blossom would be a media upload; caching or
     replaying it would be wrong.
   - Only same-origin is handled. Relay traffic is WebSocket (never seen by a
     service worker) and third-party requests are left entirely alone.
   - The cache name carries a version, and activate deletes every older one, so a
     deploy does not leave a growing pile of dead caches.

   The policy functions are exported when this file is loaded outside a worker, so
   the rules can be tested in Node instead of only being trusted.
*/
(function (global) {
    'use strict';

    var CACHE_NAME = 'phosphor-shell-v1';

    /* The shell: what must exist for the app to open offline. Kept short on
       purpose. A missing file here fails the whole install, so this list is only
       pages and the shared assets they need. */
    var PRECACHE = [
        './',
        './index.html',
        './compose.html',
        './notifications.html',
        './notes.html',
        './profile.html',
        './thread.html',
        './bookmark.html',
        './relay.html',
        './config.json',
        './assets/terminal.css',
        './assets/terminal.js',
        './assets/nostr-note.js',
        './assets/nostr-profile.js',
        './assets/nostr-embed.js',
        './assets/nostr-media-event.js',
        './assets/nostr-nip27.js',
        './assets/nostr-auth.js',
        './assets/nostr-draft.js',
        './assets/nostr-paginate.js',
        './assets/nostr-notif-order.js',
        './assets/nostr-util.js',
        './assets/nostr-session.js',
        './assets/nostr-relay.js',
        './assets/nostr-card.js',
        './assets/nostr-like.js'
,
        './assets/blossom-auth.js',
        './assets/form-utils.js',
        './assets/nostr-article.js',
        './assets/nostr-comment.js',
        './assets/nostr-count.js',
        './assets/nostr-imeta.js',
        './assets/nostr-nip05.js',
        './assets/nostr-pulse-event.js',
        './assets/nostr-relay-info.js',
        './assets/nostr-report.js'
    ];

    var ASSET_EXT = /\.(?:js|css|png|jpe?g|svg|ico|woff2?|webp)$/i;

    /* Should this worker touch the request at all? */
    function shouldHandle(request) {
        if (!request) return false;
        if (String(request.method).toUpperCase() !== 'GET') return false;
        var url;
        try { url = new URL(request.url); } catch (e) { return false; }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        return true;
    }

    /* Same-origin only. Third-party fonts, images and CDN scripts are left to the
       browser: caching them here would hide the fact that the page depends on
       someone else's server. */
    function isSameOrigin(request, origin) {
        try { return new URL(request.url).origin === origin; } catch (e) { return false; }
    }

    function isNavigation(request) {
        return !!(request && request.mode === 'navigate');
    }

    function isStaticAsset(pathname) {
        return ASSET_EXT.test(String(pathname || ''));
    }

    /* Which strategy: 'network-first' for a page so a deploy is seen immediately,
       'cache-first' for an asset so repeat views are instant. */
    function strategyFor(request, origin) {
        if (!shouldHandle(request)) return 'ignore';
        if (!isSameOrigin(request, origin)) return 'ignore';
        if (isNavigation(request)) return 'network-first';
        try {
            if (isStaticAsset(new URL(request.url).pathname)) return 'cache-first';
        } catch (e) { /* fall through */ }
        return 'network-first';
    }

    function olderCaches(names, current) {
        return (names || []).filter(function (n) { return n !== current; });
    }

    var api = {
        CACHE_NAME: CACHE_NAME,
        PRECACHE: PRECACHE,
        shouldHandle: shouldHandle,
        isSameOrigin: isSameOrigin,
        isNavigation: isNavigation,
        isStaticAsset: isStaticAsset,
        strategyFor: strategyFor,
        olderCaches: olderCaches
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;

    /* Real worker wiring, only when actually running inside a worker. */
    if (typeof global.addEventListener === 'function' && typeof global.registration === 'object' && global.registration !== null) {
        global.addEventListener('install', function (event) {
            event.waitUntil(
                global.caches.open(CACHE_NAME).then(function (cache) {
                    /* addAll rejects the whole install if ONE entry 404s, which would
                       leave the app with no offline support at all. Each file is
                       added on its own so one bad path cannot sink the rest. */
                    return Promise.all(PRECACHE.map(function (url) {
                        return cache.add(new Request(url, { cache: 'reload' })).catch(function () { return null; });
                    }));
                }).then(function () { return global.skipWaiting(); })
            );
        });

        global.addEventListener('activate', function (event) {
            event.waitUntil(
                global.caches.keys().then(function (names) {
                    return Promise.all(olderCaches(names, CACHE_NAME).map(function (n) {
                        return global.caches.delete(n);
                    }));
                }).then(function () { return global.clients.claim(); })
            );
        });

        global.addEventListener('fetch', function (event) {
            var request = event.request;
            var mode = strategyFor(request, global.location.origin);
            if (mode === 'ignore') return;

            if (mode === 'cache-first') {
                event.respondWith(
                    global.caches.match(request).then(function (hit) {
                        if (hit) {
                            /* Refresh in the background so the NEXT visit is current. */
                            event.waitUntil(
                                fetch(request).then(function (res) {
                                    if (res && res.ok) return global.caches.open(CACHE_NAME).then(function (c) { return c.put(request, res.clone()); });
                                }).catch(function () { return null; })
                            );
                            return hit;
                        }
                        return fetch(request).then(function (res) {
                            if (res && res.ok) {
                                var copy = res.clone();
                                event.waitUntil(global.caches.open(CACHE_NAME).then(function (c) { return c.put(request, copy); }));
                            }
                            return res;
                        });
                    })
                );
                return;
            }

            /* network-first, fall back to the cached shell when offline */
            event.respondWith(
                fetch(request).then(function (res) {
                    if (res && res.ok) {
                        var copy = res.clone();
                        event.waitUntil(global.caches.open(CACHE_NAME).then(function (c) { return c.put(request, copy); }));
                    }
                    return res;
                }).catch(function () {
                    return global.caches.match(request).then(function (hit) {
                        return hit || global.caches.match('./index.html');
                    });
                })
            );
        });
    }
})(typeof self !== 'undefined' ? self : globalThis);
