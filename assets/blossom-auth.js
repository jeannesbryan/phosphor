/* ==========================================================================
   blossom-auth.js — media upload rules for a Blossom server, written ONCE.

   Why this file exists (2026-10-09)
   ----------------------------------
   Phosphor has SEVEN pages that can each upload media (index, thread, notes,
   notifications, bookmark, relay, profile). The same block — hash the file
   with sha256, build a kind 24242 authorization event, sign it, wrap it as the
   header `Authorization: Nostr <base64>`, then PUT — was copied into all
   seven, with error messages that had already started to drift (the
   `bookmark` page did not even show the server's rejection text).

   On 2026-10-07 those copies proved dangerous: blossom-server 6.4.1 tightened
   BUD-11 so the `x` tag (sha256 of the blob) became MANDATORY. The Phosphor
   copies sent a tag named `payload`, so EVERY upload was rejected with
   `403 Auth token does not authorize operation on blob <hash>` — including
   the 24H_PULSE post. The fix then also had to be applied to all seven copies.

   Now the rules live only here. If the protocol changes again, this one place
   changes.

   How to use it in a page:
     <script src="/assets/blossom-auth.js"></script>     (in <head>)
     window.BlossomAuth.uploadSelectedFiles(files, btnElement, textareaElement, {
         servers: BLOSSOM_SERVERS,       // from config.json, may be empty
         fallbackServer: 'https://blossom.jeannesbryan.my.id',
         pubkey: currentUserPubkey,
         sign: (ev) => window.nostr.signEvent(ev)
     });

   A failure of this module MUST NOT be silent. Pages MUST check
   `window.BlossomAuth` first and tell the user when this file did not load —
   otherwise the media button just sits there with no explanation.

   BUD-11 rules honoured here (do not change without a reason)
   ----------------------------------------------------------
   - kind 24242, tag `x` = hexadecimal sha256 of the FILE CONTENT (mandatory
     since blossom 6.4.1; `payload` is rejected). A matching `x` is also
     accepted by the lenient 6.3.x server, so no server version loses out.
   - `u` = the exact upload URL, `method` = PUT, `t` = upload, `expiration` =
     created_at + 60 seconds.
   ========================================================================== */
(function (root, factory) {
    var api = factory(root);
    root.BlossomAuth = api;
    // so it can be tested without a browser: node tests/blossom-auth.test.mjs
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    /* BUD-11 authorization event kind (NIP-B7 / Blossom). */
    var AUTH_KIND = 24242;
    /* Authorization event content. The server does not check it, but it is kept
       constant so it is easy to spot in logs. */
    var AUTH_CONTENT = 'Phosphor Blossom Auth';
    /* Upload limit per note (the same on every page). */
    var MAX_FILES = 4;
    /* Authorization token lifetime: enough for one PUT, no more. */
    var AUTH_TTL_SECONDS = 60;
    var DEFAULT_SERVER = 'https://blossom.jeannesbryan.my.id';
    var UPLOAD_LABEL = '[ MEDIA (0/4) ]';

    function bytesToHex(bytes) {
        var out = '';
        for (var i = 0; i < bytes.length; i++) {
            out += bytes[i].toString(16).padStart(2, '0');
        }
        return out;
    }

    /* Hexadecimal sha256 of the file content. The Blossom file name is this hash. */
    function sha256Hex(arrayBuffer, cryptoObj) {
        var c = cryptoObj || root.crypto;
        if (!c || !c.subtle) {
            return Promise.reject(new Error('crypto.subtle unavailable (needs a secure context: https or localhost)'));
        }
        return c.subtle.digest('SHA-256', arrayBuffer).then(function (buf) {
            return bytesToHex(new Uint8Array(buf));
        });
    }

    /* "blossom.example.com" -> "https://blossom.example.com/upload".
       The server list from config may be empty -> use the fallback. */
    function uploadEndpointFor(serverSpec, fallbackServer) {
        var s = String(serverSpec == null ? '' : serverSpec).trim();
        if (!s) s = String(fallbackServer || DEFAULT_SERVER).trim();
        if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
        s = s.replace(/\/+$/, '');
        return s + '/upload';
    }

    /* The client-signed authorization event. This is the "contract" with
       blossom — the single place these tags are assembled. */
    function buildAuthEvent(opts) {
        var now = opts.now == null ? Math.floor(Date.now() / 1000) : opts.now;
        return {
            kind: AUTH_KIND,
            created_at: now,
            tags: [
                ['u', opts.uploadEndpoint],
                ['method', 'PUT'],
                ['x', opts.hashHex],
                ['expiration', String(now + AUTH_TTL_SECONDS)],
                ['t', 'upload']
            ],
            content: AUTH_CONTENT,
            pubkey: opts.pubkey
        };
    }

    function utf8ToBinary(str) {
        var bytes = new TextEncoder().encode(str);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return bin;
    }

    /* Header used by Phosphor: "Nostr " + base64(JSON of the signed event).
       It used to rely on the obsolete unescape(encodeURIComponent(...));
       TextEncoder gives the same result for our ASCII content. */
    function encodeAuthHeader(signedEvent, btoaImpl) {
        var enc = btoaImpl || root.btoa;
        return 'Nostr ' + enc(utf8ToBinary(JSON.stringify(signedEvent)));
    }

    /* One file: hash -> event -> signature -> PUT -> {ok, url, ...}.
       Returns an object instead of throwing — the caller decides the message. */
    function uploadFile(file, opts) {
        var fetchImpl = opts.fetchImpl || root.fetch;
        var endpoint = opts.uploadEndpoint;
        return Promise.resolve(file.arrayBuffer())
            .then(function (buf) {
                return sha256Hex(buf, opts.cryptoImpl);
            })
            .then(function (hashHex) {
                var authEvent = buildAuthEvent({
                    uploadEndpoint: endpoint,
                    hashHex: hashHex,
                    pubkey: opts.pubkey,
                    now: opts.now
                });
                return Promise.resolve(opts.sign(authEvent)).then(function (signedAuth) {
                    return fetchImpl(endpoint, {
                        method: 'PUT',
                        headers: { 'Authorization': encodeAuthHeader(signedAuth, opts.btoaImpl) },
                        body: file
                    }).then(function (response) {
                        if (response.ok) {
                            return response.json().then(function (data) {
                                return { ok: true, url: data.url, status: response.status, hash: hashHex, endpoint: endpoint };
                            });
                        }
                        return response.text().then(function (errText) {
                            return { ok: false, status: response.status, error: errText, hash: hashHex, endpoint: endpoint };
                        });
                    });
                });
            });
    }

    /* What NIP-92 wants to know about a file we just uploaded. Everything here
       is already at hand except the dimensions, which need decoding the image:
       that is best effort, because createImageBitmap does not exist in older
       browsers or in Node, and a missing `dim` must never fail an upload.

       `alt` is deliberately NOT filled in from file.name — "IMG_2014.jpg" is
       noise, not a description, and a wrong alt is worse for a screen reader
       than an absent one. Callers that know better can pass `altFor(file)`. */
    function describeFile(file, res, opts) {
        opts = opts || {};
        var meta = { url: res.url };
        if (file && file.type) meta.m = file.type;
        if (res && res.hash) meta.x = res.hash;
        if (file && typeof file.size === 'number' && file.size > 0) meta.size = file.size;
        if (file && typeof opts.altFor === 'function') {
            var alt = opts.altFor(file);
            if (alt) meta.alt = String(alt);
        }

        var isImage = !!(file && /^image\//.test(file.type || ''));
        var bmpFn = opts.createImageBitmapImpl || root.createImageBitmap;
        if (!isImage || typeof bmpFn !== 'function') return Promise.resolve(meta);

        return Promise.resolve(bmpFn(file)).then(function (bmp) {
            if (bmp && bmp.width && bmp.height) meta.dim = { w: bmp.width, h: bmp.height };
            if (bmp && typeof bmp.close === 'function') bmp.close();
            return meta;
        }).catch(function () { return meta; });
    }

    /* The whole UI flow: file-limit warning, button text, pasting URLs into the
       textarea, and error messages. Pages only supply elements + credentials. */
    function uploadSelectedFiles(files, btnElement, textareaElement, config) {
        config = config || {};
        var alertFn = config.alertFn || root.alert;
        var maxFiles = config.maxFiles || MAX_FILES;
        var list = Array.prototype.slice.call(files || []);
        /* `meta` carries the NIP-92 facts about each uploaded file. It is kept
           next to `uploaded` (the plain URLs) so existing callers that only
           read `uploaded` keep working untouched. */
        var result = { uploaded: [], meta: [], endpoint: null };

        if (!list.length) return Promise.resolve(result);

        if (list.length > maxFiles) {
            alertFn('> WARNING: At most ' + maxFiles + ' media files per note. Only the first ' + maxFiles + ' will be processed.');
            list = list.slice(0, maxFiles);
        }

        if (!config.pubkey || !config.sign) {
            alertFn('> ERROR: Not logged in — upload cancelled.');
            return Promise.resolve(result);
        }

        var endpoint = uploadEndpointFor((config.servers || [])[0], config.fallbackServer);
        result.endpoint = endpoint;

        var chain = Promise.resolve();
        list.forEach(function (file, i) {
            chain = chain.then(function () {
                if (btnElement) btnElement.textContent = '[ UPLOADING ' + (i + 1) + '/' + list.length + '... ]';
                return uploadFile(file, {
                    uploadEndpoint: endpoint,
                    pubkey: config.pubkey,
                    sign: config.sign,
                    fetchImpl: config.fetchImpl,
                    cryptoImpl: config.cryptoImpl,
                    btoaImpl: config.btoaImpl,
                    now: config.now
                }).then(function (res) {
                    if (res.ok) {
                        result.uploaded.push(res.url);
                        if (textareaElement) {
                            textareaElement.value += (textareaElement.value ? '\n' : '') + res.url;
                        }
                        /* NIP-92: record what we now know about this file.
                           The sha256 is already computed for the BUD-11 auth
                           tag, so publishing it as `x` costs nothing extra. */
                        return describeFile(file, res, {
                            altFor: config.altFor,
                            createImageBitmapImpl: config.createImageBitmapImpl
                        }).then(function (meta) {
                            result.meta.push(meta);
                        });
                    } else {
                        alertFn('> ERROR: Server rejected ' + file.name + ' (HTTP ' + res.status + '). ' + res.error);
                    }
                });
            });
        });

        return chain
            .catch(function () {
                alertFn('> ERROR: Could not reach the Blossom server. It may be a CORS problem or the server is down.');
            })
            .then(function () {
                if (btnElement) btnElement.textContent = UPLOAD_LABEL;
                /* Hand the collected metadata to the NIP-92 module. It sits in
                   a registry until the note is signed, because the event does
                   not exist yet at upload time. Guarded: if the module failed
                   to load, uploads still work and notes just carry no imeta. */
                if (root.NostrImeta && result.meta.length) {
                    root.NostrImeta.remember(result.meta);
                }
                return result;
            });
    }

    return {
        AUTH_KIND: AUTH_KIND,
        AUTH_CONTENT: AUTH_CONTENT,
        AUTH_TTL_SECONDS: AUTH_TTL_SECONDS,
        MAX_FILES: MAX_FILES,
        DEFAULT_SERVER: DEFAULT_SERVER,
        bytesToHex: bytesToHex,
        sha256Hex: sha256Hex,
        uploadEndpointFor: uploadEndpointFor,
        buildAuthEvent: buildAuthEvent,
        encodeAuthHeader: encodeAuthHeader,
        uploadFile: uploadFile,
        describeFile: describeFile,
        uploadSelectedFiles: uploadSelectedFiles
    };
}));
