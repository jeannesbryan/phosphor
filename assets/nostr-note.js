/* ==========================================================================
   nostr-note.js — aturan tentang STRUKTUR catatan, plus preview tautan GitHub.

   Untuk apa saja (2026-10-04)
   --------------------------
   1. NIP-10: mana catatan yang merupakan BALASAN. Timeline tidak boleh
      menampilkannya sebagai catatan biasa — waktu itu ada balasan "Yes 100%"
      yang ikut muncul di linimasa, padahal klien lain menyembunyikannya.
   2. NIP-18: mana catatan yang MENGUTIP catatan lain. Waktu itu ada kutipan
      yang tampil kosong, karena penanda kutipan pada catatan itu ada di tag
      "q" — dan Phosphor belum pernah membaca tag itu sama sekali.
   3. Preview tautan GitHub: tautan repo berkas seperti
      github.com/owner/repo/blob/main/docs/FILE.md yang tadinya cuma teks,
      sekarang jadi kartu kecil berisi nama repo, deskripsi, bintang, bahasa.

   Kenapa dijadikan satu berkas
   ----------------------------
   Tujuh halaman Phosphor masing-masing menyusun isi catatan sendiri (sepuluh
   tempat). Kalau aturan-aturan ini ditulis di dalam tiap halaman, perbaikan
   berikutnya akan mendarat di sebagian saja — itu sudah pernah terjadi.
   Semua aturan murni di bawah bisa diuji tanpa browser dan tanpa jaringan:
       node tests/nostr-note.test.mjs

   Gagal ≠ hilang
   --------------
   Kalau berkas ini tidak termuat, atau GitHub tidak bisa dihubungi (misalnya
   kena batas permintaan), halaman tetap menampilkan tautan seperti semula.
   Tidak ada yang disembunyikan dan tidak ada kotak kosong yang menggantung.
   ========================================================================== */

(function (global) {
    'use strict';

    // ---------------------------------------------------------------- NIP-10
    /* Catatan dianggap BALASAN kalau ia menunjuk catatan induk lewat tag "e".
       Pembedanya:
         - tag "e" dengan penanda "root"/"reply"  -> pasti balasan
         - tag "e" tanpa penanda                  -> gaya lama NIP-10; tag itu
                                                     menunjuk induk, jadi balasan
         - tag "e" yang SEMUANYA ditandai "mention" -> cuma menyebut, bukan balasan
       Kalau tidak ada tag "e" sama sekali, itu catatan biasa. */
    function isReply(ev) {
        if (!ev || !Array.isArray(ev.tags)) return false;
        var eTags = ev.tags.filter(function (t) {
            return Array.isArray(t) && t[0] === 'e' && typeof t[1] === 'string' && t[1];
        });
        if (!eTags.length) return false;
        if (eTags.some(function (t) { return t[3] === 'root' || t[3] === 'reply'; })) return true;
        return eTags.some(function (t) { return !t[3]; });
    }

    // ---------------------------------------------------------------- NIP-18
    /* Daftar catatan yang dikutip. Bentuk tag:
         ["q", <id event>, <relay, opsional>, <pubkey, opsional>]
       Hanya id berbentuk heksadesimal 64 karakter yang diterima, supaya tag
       rusak tidak membuat halaman meminta id sampah ke relay. */
    function quoteTargets(ev) {
        if (!ev || !Array.isArray(ev.tags)) return [];
        return ev.tags
            .filter(function (t) {
                return Array.isArray(t) && t[0] === 'q'
                    && typeof t[1] === 'string' && /^[0-9a-f]{64}$/i.test(t[1]);
            })
            .map(function (t) {
                return { id: t[1].toLowerCase(), relay: t[2] || null, pubkey: t[3] || null };
            });
    }

    // ------------------------------------------------------- tautan GitHub
    /* Halaman tingkat pertama github.com yang bukan repo. Daftar ini menjaga
       supaya github.com/settings/profile tidak dianggap repo "settings/profile". */
    var RESERVED_OWNERS = [
        'settings', 'explore', 'topics', 'collections', 'sponsors', 'marketplace',
        'notifications', 'pulls', 'issues', 'orgs', 'users', 'about', 'features',
        'enterprise', 'login', 'signup', 'new', 'search', 'trending', 'apps',
        'gist', 'dashboard', 'codespaces', 'account'
    ];

    /* Ubah tautan GitHub jadi {owner, repo, path, url}, atau null kalau bukan
       tautan repo. Host diperiksa ketat: github.com.evil.com TIDAK lolos. */
    function githubRepo(url) {
        if (typeof url !== 'string') return null;
        var u;
        try { u = new URL(url); } catch (e) { return null; }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        var host = u.hostname.toLowerCase();
        if (host !== 'github.com' && host !== 'www.github.com') return null;

        var parts = u.pathname.split('/').filter(function (p) { return p.length > 0; });
        if (parts.length < 2) return null;

        var owner = parts[0];
        var repo = parts[1];
        if (RESERVED_OWNERS.indexOf(owner.toLowerCase()) !== -1) return null;
        if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
        if (!owner || !repo || repo === '.') return null;

        return {
            owner: owner,
            repo: repo,
            path: parts.slice(2).join('/'),
            url: 'https://github.com/' + owner + '/' + repo
        };
    }

    /* Kartu repo. Datanya dari api.github.com, jadi hanya field yang benar-benar
       dipakai yang masuk; kalau ada yang kosong, bagian itu tidak dirender. */
    function repoCardHtml(info, data) {
        if (!info || !data) return '';
        var esc = escapeAttr;
        var name = data.full_name || (info.owner + '/' + info.repo);
        var desc = typeof data.description === 'string' && data.description.trim()
            ? data.description.trim() : '';
        var stars = typeof data.stargazers_count === 'number' ? data.stargazers_count : null;
        var lang = data.language ? String(data.language) : '';
        var avatar = typeof data.owner_avatar === 'string' ? data.owner_avatar : '';

        var meta = [];
        if (stars !== null) meta.push('\u2605 ' + formatCount(stars));
        if (lang) meta.push(esc(lang));

        var pathLine = info.path
            ? '<div class="gh-card-path">' + esc(info.path) + '</div>'
            : '';

        return '<a class="gh-card" href="' + esc(info.url) + '" target="_blank" rel="noopener noreferrer">'
            + (avatar ? '<img class="gh-card-avatar" src="' + esc(avatar) + '" alt="" loading="lazy">' : '')
            + '<div class="gh-card-main">'
            + '<div class="gh-card-name">' + esc(name) + '</div>'
            + (desc ? '<div class="gh-card-desc">' + esc(desc) + '</div>' : '')
            + pathLine
            + (meta.length ? '<div class="gh-card-meta">' + meta.join(' \u00b7 ') + '</div>' : '')
            + '</div></a>';
    }

    /* 1200 -> "1.2k". Hanya untuk tampilan; angkanya tidak pernah dibulatkan
       ke atas supaya tidak terlihat lebih populer daripada kenyataan. */
    function formatCount(n) {
        if (n < 1000) return String(n);
        var k = Math.floor(n / 100) / 10;
        return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + 'k';
    }

    var CACHE_PREFIX = 'phosphor:gh:';
    var CACHE_TTL_MS = 6 * 60 * 60 * 1000;

    function readCache(key) {
        try {
            var raw = global.localStorage && global.localStorage.getItem(key);
            if (!raw) return null;
            var rec = JSON.parse(raw);
            if (!rec || typeof rec.t !== 'number') return null;
            if (Date.now() - rec.t > CACHE_TTL_MS) { global.localStorage.removeItem(key); return null; }
            return rec.v || null;
        } catch (e) { return null; }
    }

    function writeCache(key, value) {
        try {
            if (!global.localStorage) return;
            global.localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value }));
        } catch (e) { /* kuota penuh / mode privat: cukup dilewati */ }
    }

    /* Ambil data repo dengan singgahan. Selalu selesai (resolve null kalau
       gagal) supaya pemanggil tidak perlu menangani galat jaringan.
       Kunci singgahan memakai owner/repo huruf kecil, jadi satu repo yang
       ditautkan berkali-kali hanya meminta sekali. */
    function fetchRepo(info) {
        if (!info) return Promise.resolve(null);
        var key = CACHE_PREFIX + info.owner.toLowerCase() + '/' + info.repo.toLowerCase();

        var cached = readCache(key);
        if (cached) return Promise.resolve(cached);

        if (typeof global.fetch !== 'function') return Promise.resolve(null);

        return global.fetch('https://api.github.com/repos/'
            + encodeURIComponent(info.owner) + '/' + encodeURIComponent(info.repo), {
            headers: { 'Accept': 'application/vnd.github+json' }
        }).then(function (res) {
            /* 403 = batas permintaan habis, 404 = repo privat/tidak ada.
               Keduanya bukan kesalahan halaman; cukup jangan tampilkan kartu. */
            if (!res.ok) return null;
            return res.json();
        }).then(function (d) {
            if (!d || typeof d !== 'object') return null;
            var slim = {
                full_name: typeof d.full_name === 'string' ? d.full_name : (info.owner + '/' + info.repo),
                description: typeof d.description === 'string' ? d.description : '',
                stargazers_count: typeof d.stargazers_count === 'number' ? d.stargazers_count : null,
                language: typeof d.language === 'string' ? d.language : '',
                owner_avatar: d.owner && typeof d.owner.avatar_url === 'string' ? d.owner.avatar_url : ''
            };
            writeCache(key, slim);
            return slim;
        }).catch(function () { return null; });
    }

    /* Ganti tautan GitHub di dalam root menjadi kartu. Kartu disisipkan SETELAH
       tautannya (tautan aslinya tetap ada) supaya kalau permintaan gagal,
       tidak ada yang berubah. Setiap tautan ditandai agar tidak diproses dua
       kali saat halaman menggambar ulang. */
    function upgradeLinks(root, opts) {
        if (!root || typeof root.querySelectorAll !== 'function') return 0;
        opts = opts || {};
        var links = root.querySelectorAll('a[href*="github.com"]');
        var count = 0;

        Array.prototype.forEach.call(links, function (a) {
            if (a.getAttribute('data-note-preview')) return;
            var info = githubRepo(a.getAttribute('href'));
            if (!info) return;
            a.setAttribute('data-note-preview', '1');
            count++;

            var holder = global.document.createElement('div');
            holder.className = 'gh-card-holder';
            if (a.parentNode) a.parentNode.insertBefore(holder, a.nextSibling);

            fetchRepo(info).then(function (data) {
                if (!data) { if (holder.parentNode) holder.parentNode.removeChild(holder); return; }
                holder.innerHTML = repoCardHtml(info, data);
            });
        });

        return count;
    }

    // ------------------------------------------------------------- kutipan
    /* Kartu ringkas untuk catatan yang dikutip. Kelas author-<pubkey> dan
       avatar-<pubkey> sengaja dipakai supaya mekanisme profil yang sudah ada
       di halaman (updatePostUI) ikut mengisi nama dan avatar begitu data
       profilnya tiba — tanpa jalur kedua yang harus dirawat. */
    function quoteCardHtml(ev, opts) {
        if (!ev || typeof ev !== 'object') return '';
        opts = opts || {};
        var esc = escapeAttr;
        var pk = typeof ev.pubkey === 'string' ? ev.pubkey : '';
        var body = typeof ev.content === 'string' ? ev.content.trim() : '';
        var limit = typeof opts.limit === 'number' ? opts.limit : 280;
        var truncated = body.length > limit;
        if (truncated) body = body.slice(0, limit);

        var img = firstImageUrl(ev);

        return '<div class="t-quote-card">'
            + '<div class="t-quote-head">'
            + '<span class="avatar-' + esc(pk) + ' t-quote-avatar">' + (pk ? '[' + esc(pk.slice(0, 2).toUpperCase()) + ']' : '[?]') + '</span>'
            + '<span class="author-' + esc(pk) + ' t-quote-author">' + esc(pk ? pk.slice(0, 8) : '?') + '</span>'
            + '</div>'
            + (body ? '<div class="t-quote-body">' + esc(body) + (truncated ? '\u2026' : '') + '</div>' : '')
            + (img ? '<div class="t-quote-media"><img src="' + esc(img) + '" alt="" loading="lazy"></div>' : '')
            + '</div>';
    }

    /* Gambar pertama di dalam isi catatan, kalau ada. Dipakai hanya untuk
       pratinjau kutipan; media utama tetap ditangani penyusun media. */
    function firstImageUrl(ev) {
        if (!ev || typeof ev.content !== 'string') return null;
        var m = ev.content.match(/https?:\/\/[^\s<]+?\.(png|jpg|jpeg|gif|webp)(\?[^\s]*)?/i);
        return m ? m[0] : null;
    }

    /* Pasang kartu kutipan ke dalam `holder`. Halaman memberi tahu cara
       mengambil catatan (`load`) dan apa yang harus dilakukan setelahnya
       (`onEvent`), sehingga logika ini hidup satu kali saja dan tetap bisa
       dipakai linimasa maupun halaman thread.

       `get` opsional: kalau catatan kutipan sudah ada di singgahan halaman,
       tidak perlu meminta ke relay sama sekali. */
    function mountQuotes(holder, ev, opts) {
        if (!holder || !ev) return 0;
        opts = opts || {};
        var targets = quoteTargets(ev);
        if (!targets.length) return 0;

        var load = typeof opts.load === 'function' ? opts.load : fetchEventById;
        var get = typeof opts.get === 'function' ? opts.get : function () { return null; };
        var onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};

        var shown = 0;
        targets.forEach(function (t) {
            var cached = get(t.id);
            if (cached) { if (appendQuoteCard(holder, cached, onEvent)) shown++; return; }

            load(t.id, t.relay).then(function (fetched) {
                if (!fetched) return;            // gagal: biarkan saja, tanpa kotak kosong
                if (appendQuoteCard(holder, fetched, onEvent) && typeof opts.after === 'function') {
                    opts.after(fetched);
                }
            });
        });
        return shown;
    }

    /* Wadah kartu kutipan di dalam sebuah kartu catatan. Kalau halamannya belum
       menyediakan .t-quote-holder, wadahnya dibuat di sini — tepat sebelum baris
       tombol, supaya posisinya selalu sama di semua halaman. Dengan begitu
       halaman baru cukup memanggil decorateCard() tanpa mengubah templatenya. */
    function quoteHolderIn(card) {
        if (!card || typeof document === 'undefined') return null;
        var existing = card.querySelector('.t-quote-holder');
        if (existing) return existing;
        var holder = document.createElement('div');
        holder.className = 't-quote-holder';
        var actions = card.querySelector('.t-feed-actions');
        if (actions && actions.parentNode) actions.parentNode.insertBefore(holder, actions);
        else card.appendChild(holder);
        return holder;
    }

    /* Satu panggilan untuk semua tambahan pada sebuah kartu catatan: kartu
       kutipan (NIP-18) dan pratinjau tautan GitHub. Dipakai semua halaman
       supaya tidak ada halaman yang tertinggal saat aturannya berubah. */
    function decorateCard(card, ev, opts) {
        if (!card || !ev) return 0;
        opts = opts || {};
        var holder = quoteHolderIn(card);
        var shown = mountQuotes(holder, ev, opts);
        if (typeof upgradeLinks === 'function') upgradeLinks(card);
        return shown;
    }

    function appendQuoteCard(holder, ev, onEvent) {
        if (!holder || !ev || typeof document === 'undefined') return null;
        var host = document.createElement('div');
        host.innerHTML = quoteCardHtml(ev);
        var el = host.firstElementChild;
        if (!el) return null;
        holder.appendChild(el);
        try { onEvent(ev, el); } catch (e) {}
        return el;
    }

    // ----------------------------------------------------------- relay bantu
    /* Phosphor punya socket sendiri untuk linimasa, tapi modul ini butuh cara
       mengambil satu catatan berdasarkan id (untuk kutipan). Socket terpisah,
       dibuka sebentar lalu ditutup — tidak mengganggu socket linimasa. */
    var relayList = [];

    function setRelays(list) {
        relayList = Array.isArray(list) ? list.filter(function (r) { return typeof r === 'string'; }) : [];
    }

    /* extraRelays: relay tambahan untuk catatan ini saja. Penting untuk kutipan:
       tag "q" biasanya menyebut relay asal catatan yang dikutip, dan catatan itu
       sering TIDAK ada di relay kita sendiri. Tanpa mencoba relay asalnya,
       kutipan dari relay lain akan tampak kosong. */
    function fetchEventById(id, timeoutMs, extraRelays) {
        if (!/^[0-9a-f]{64}$/i.test(String(id || ''))) return Promise.resolve(null);
        if (typeof global.WebSocket !== 'function') return Promise.resolve(null);

        var relays = relayList.slice();
        if (Array.isArray(extraRelays)) {
            extraRelays.forEach(function (r) {
                if (typeof r === 'string' && r && relays.indexOf(r) === -1) relays.push(r);
            });
        }
        if (!relays.length) return Promise.resolve(null);
        timeoutMs = timeoutMs || 6000;

        return new Promise(function (resolve) {
            var settled = false;
            var sockets = [];

            var finish = function (value) {
                if (settled) return;
                settled = true;
                sockets.forEach(function (s) { try { s.close(); } catch (e) {} });
                resolve(value);
            };

            var timer = global.setTimeout(function () { finish(null); }, timeoutMs);

            relays.forEach(function (url) {
                var ws;
                try { ws = new global.WebSocket(url); } catch (e) { return; }
                sockets.push(ws);
                ws.onopen = function () {
                    try {
                        ws.send(JSON.stringify(['REQ', 'qn-' + Math.random().toString(36).slice(2), { ids: [id] }]));
                    } catch (e) {}
                };
                ws.onmessage = function (m) {
                    var msg;
                    try { msg = JSON.parse(m.data); } catch (e) { return; }
                    if (msg[0] === 'EVENT' && msg[2] && msg[2].id === id) {
                        global.clearTimeout(timer);
                        finish(msg[2]);
                    }
                };
                ws.onerror = function () {};
            });

            /* Kalau tidak ada relay yang bisa dibuka sama sekali, jangan
               menggantung sampai waktu habis. */
            if (!sockets.length) { global.clearTimeout(timer); finish(null); }
        });
    }

    // ------------------------------------------------------------------ alat
    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ------------------------------------------------------------------ gaya
    var CSS = [
        '.gh-card{display:flex;gap:10px;align-items:flex-start;margin:10px 0;padding:10px 12px;'
            + 'border:1px solid var(--yt-border, var(--left-border, #2a2a2a));background:rgba(255,255,255,0.02);'
            + 'text-decoration:none;color:inherit;}',
        '.gh-card:hover{background:rgba(0,255,65,0.06);}',
        '.gh-card-avatar{width:36px;height:36px;flex:0 0 36px;border-radius:4px;object-fit:cover;}',
        '.gh-card-main{min-width:0;flex:1 1 auto;}',
        '.gh-card-name{font-weight:bold;word-break:break-word;}',
        '.gh-card-desc{font-size:0.85em;opacity:0.85;margin-top:2px;word-break:break-word;}',
        '.gh-card-path{font-size:0.78em;opacity:0.6;margin-top:4px;word-break:break-all;}',
        '.gh-card-meta{font-size:0.78em;opacity:0.7;margin-top:4px;}',
        '.t-quote-card{border-left:3px solid var(--yt-border, var(--left-border, #2a2a2a));'
            + 'padding:8px 12px;margin-top:10px;background:rgba(255,255,255,0.02);}',
        '.t-quote-head{display:flex;align-items:center;gap:8px;font-size:0.85em;}',
        '.t-quote-avatar{font-size:0.9em;opacity:0.9;}',
        '.t-quote-author{font-weight:bold;}',
        '.t-quote-body{font-size:0.9em;margin-top:6px;white-space:pre-wrap;word-break:break-word;}',
        '.t-quote-media img{max-width:100%;margin-top:8px;border:1px solid var(--yt-border, #2a2a2a);}'
    ];

    function install() {
        if (typeof document === 'undefined' || document.__nostrNoteInstalled) return;
        document.__nostrNoteInstalled = true;
        var style = document.createElement('style');
        style.setAttribute('data-nostr-note', '1');
        style.textContent = CSS.join('\n');
        (document.head || document.documentElement).appendChild(style);
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
        else install();
    }

    var api = {
        isReply: isReply,
        quoteTargets: quoteTargets,
        githubRepo: githubRepo,
        repoCardHtml: repoCardHtml,
        formatCount: formatCount,
        fetchRepo: fetchRepo,
        upgradeLinks: upgradeLinks,
        quoteCardHtml: quoteCardHtml,
        quoteHolderIn: quoteHolderIn,
        mountQuotes: mountQuotes,
        decorateCard: decorateCard,
        firstImageUrl: firstImageUrl,
        setRelays: setRelays,
        fetchEventById: fetchEventById
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrNote = api;
})(typeof window !== 'undefined' ? window : globalThis);
