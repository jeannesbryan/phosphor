/* ==========================================================================
   blossom-auth.js — aturan unggah media ke server Blossom, ditulis SEKALI.

   Kenapa berkas ini ada (2026-10-09)
   ----------------------------------
   Phosphor punya TUJUH halaman yang masing-masing bisa mengunggah media
   (index, thread, notes, notifications, bookmark, relay, profile). Blok yang
   sama — hitung sha256 berkas, susun peristiwa otorisasi kind 24242, tanda
   tangani, bungkus jadi header `Authorization: Nostr <base64>`, lalu PUT —
   disalin ke ketujuhnya, dengan pesan galat yang sudah mulai berbeda-beda
   (halaman `bookmark` bahkan tidak pernah menampilkan teks penolakan server).

   Pada 2026-10-07 salinan-salinan itu terbukti berbahaya: blossom-server 6.4.1
   memperketat BUD-11 sehingga tag `x` (sha256 blob) menjadi WAJIB. Salinan
   Phosphor mengirim tag bernama `payload`, jadi SEMUA unggahan ditolak
   `403 Auth token does not authorize operation on blob <hash>` — termasuk post
   24H_PULSE. Perbaikannya saat itu juga harus dikerjakan di ketujuh salinan.

   Sekarang aturannya hidup di sini saja. Kalau protokolnya berubah lagi,
   satu tempat ini yang berubah.

   Cara pakai di halaman:
     <script src="/assets/blossom-auth.js"></script>     (di <head>)
     window.BlossomAuth.uploadSelectedFiles(files, btnElement, textareaElement, {
         servers: BLOSSOM_SERVERS,       // dari config.json, boleh kosong
         fallbackServer: 'https://blossom.jeannesbryan.my.id',
         pubkey: currentUserPubkey,
         sign: (ev) => window.nostr.signEvent(ev)
     });

   Kegagalan modul ini TIDAK boleh senyap. Halaman WAJIB memeriksa
   `window.BlossomAuth` lebih dulu dan memberi tahu pengguna kalau berkas ini
   tidak termuat — kalau tidak, tombol media hanya diam tanpa penjelasan.

   Aturan BUD-11 yang dipegang (jangan diubah tanpa alasan)
   --------------------------------------------------------
   - kind 24242, tag `x` = sha256 heksadesimal dari ISI BERKAS (wajib sejak
     blossom 6.4.1; `payload` ditolak). `x` yang cocok juga diterima server
     6.3.x yang longgar, jadi tidak ada versi server yang dirugikan.
   - `u` = URL upload persis, `method` = PUT, `t` = upload, `expiration` =
     created_at + 60 detik.
   ========================================================================== */
(function (root, factory) {
    var api = factory(root);
    root.BlossomAuth = api;
    // supaya bisa diuji tanpa browser: node tests/blossom-auth.test.mjs
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    /* Jenis peristiwa otorisasi BUD-11 (NIP-B7 / Blossom). */
    var AUTH_KIND = 24242;
    /* Isi peristiwa otorisasi. Server tidak memeriksanya, tetapi dibiarkan
       konstan supaya mudah dikenali di log. */
    var AUTH_CONTENT = 'Phosphor Blossom Auth';
    /* Batas unggahan per catatan (sama di semua halaman). */
    var MAX_FILES = 4;
    /* Umur token otorisasi: cukup untuk satu PUT, tidak lebih. */
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

    /* sha256 heksadesimal dari isi berkas. Nama berkas di Blossom = hash ini. */
    function sha256Hex(arrayBuffer, cryptoObj) {
        var c = cryptoObj || root.crypto;
        if (!c || !c.subtle) {
            return Promise.reject(new Error('crypto.subtle tidak tersedia (butuh konteks aman: https atau localhost)'));
        }
        return c.subtle.digest('SHA-256', arrayBuffer).then(function (buf) {
            return bytesToHex(new Uint8Array(buf));
        });
    }

    /* "blossom.example.com" -> "https://blossom.example.com/upload".
       Daftar server dari config boleh kosong -> pakai fallback. */
    function uploadEndpointFor(serverSpec, fallbackServer) {
        var s = String(serverSpec == null ? '' : serverSpec).trim();
        if (!s) s = String(fallbackServer || DEFAULT_SERVER).trim();
        if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
        s = s.replace(/\/+$/, '');
        return s + '/upload';
    }

    /* Peristiwa otorisasi yang ditandatangani klien. Inilah "kontrak" dengan
       blossom — satu-satunya tempat tag-tag ini disusun. */
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

    /* Header yang dipakai Phosphor: "Nostr " + base64(JSON peristiwa bertanda
       tangan). Dulu memakai unescape(encodeURIComponent(...)) yang sudah usang;
       TextEncoder memberi hasil sama untuk konten ASCII kita. */
    function encodeAuthHeader(signedEvent, btoaImpl) {
        var enc = btoaImpl || root.btoa;
        return 'Nostr ' + enc(utf8ToBinary(JSON.stringify(signedEvent)));
    }

    /* Satu berkas: hash -> peristiwa -> tanda tangan -> PUT -> {ok, url, ...}.
       Mengembalikan objek, bukan melempar — pemanggil yang memutuskan pesannya. */
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

    /* Seluruh alur UI: peringatan batas berkas, teks tombol, tempel URL ke
       textarea, dan pesan galat. Halaman hanya menyediakan elemen + kredensial. */
    function uploadSelectedFiles(files, btnElement, textareaElement, config) {
        config = config || {};
        var alertFn = config.alertFn || root.alert;
        var maxFiles = config.maxFiles || MAX_FILES;
        var list = Array.prototype.slice.call(files || []);
        var result = { uploaded: [], endpoint: null };

        if (!list.length) return Promise.resolve(result);

        if (list.length > maxFiles) {
            alertFn('> WARNING: Maksimal ' + maxFiles + ' berkas media per catatan. Hanya ' + maxFiles + ' pertama yang diproses.');
            list = list.slice(0, maxFiles);
        }

        if (!config.pubkey || !config.sign) {
            alertFn('> ERROR: Belum masuk (login) — unggahan dibatalkan.');
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
                    } else {
                        alertFn('> ERROR: Server menolak ' + file.name + ' (HTTP ' + res.status + '). ' + res.error);
                    }
                });
            });
        });

        return chain
            .catch(function () {
                alertFn('> ERROR: Tidak bisa menghubungi server Blossom. Bisa jadi masalah CORS atau server sedang mati.');
            })
            .then(function () {
                if (btnElement) btnElement.textContent = UPLOAD_LABEL;
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
        uploadSelectedFiles: uploadSelectedFiles
    };
}));
