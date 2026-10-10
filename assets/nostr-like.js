/* nostr-like.js — satu tempat untuk urusan "suka" (NIP-25) dan pembatalannya.
 *
 * Masalah yang diselesaikan (laporan bos, 2026-10-11):
 *   1. Tidak ada tanda apa pun bahwa kita sudah menyukai sebuah catatan.
 *   2. Menyukai dua kali memunculkan alert, dan TIDAK ada cara membatalkannya.
 *   3. Suka dari HP tidak terlihat di laptop — tiap perangkat menyimpan
 *      catatannya sendiri di memori, tidak pernah bertanya ke relay.
 *
 * Aturan:
 *   - Suka   = kind 7, tag ["e", <id catatan>], ["p", <penulis>], content "+".
 *   - Batal  = kind 5 (NIP-09) yang menunjuk id peristiwa suka tadi — bukan
 *              mengirim suka baru, karena itu akan jadi "dislike", bukan batal.
 *   - Keadaan "sudah suka" SELALU dibangun dari relay: modul berlangganan
 *              kind 7 + 5 milik pubkey kita sendiri. Karena itu perangkat lain
 *              ikut berubah, dan yang baru dibuka tahu keadaan sebenarnya.
 *
 * Kenapa satu modul: dulu tiap halaman menulis likeEvent-nya sendiri (enam
 * salinan), jadi setiap perbaikan harus diulang enam kali — persis kesalahan
 * yang pernah terjadi pada aturan unggah Blossom.
 *
 * KONTRAK untuk halaman (lihat pemanggil di index/profile/thread/notes/
 * bookmark/relay):
 *   NostrLike.init({
 *     pubkey:   currentUserPubkey,           // boleh null (belum masuk)
 *     relays:   RELAYS,
 *     send:     (ev) => { ... },             // kirim EVENT ke relay yang terbuka
 *     onCount:  (id, delta) => { ... },      // sesuaikan angka di kartu
 *     historyMs: 6000                        // opsional
 *   });
 *   NostrLike.toggle(id, targetPubkey)       // dipanggil dari tombol like
 */
(function (global) {
    'use strict';

    var SUB_PREFIX = 'likes-';
    var DEFAULT_HISTORY_MS = 6000;
    var DEFAULT_LIMIT = 500;

    var state = {
        pubkey: null,
        relays: [],
        send: null,
        onCount: null,
        onState: null,
        historyMs: DEFAULT_HISTORY_MS,
        historyPhase: true,
        limit: DEFAULT_LIMIT,
        sockets: [],
        reactions: {},          // id peristiwa suka -> id catatan
        reactionTime: {},       // id peristiwa suka -> created_at
        deleted: {},            // id peristiwa suka yang sudah dihapus (NIP-09)
        byTarget: {},           // id catatan -> id peristiwa suka (yang masih hidup)
        timer: null,
        pending: {}             // id catatan -> true, sedang diproses
    };

    /* Keadaan "sudah suka" untuk satu catatan dihitung dari SELURUH reaksi yang
       kita ketahui minus yang sudah dihapus — bukan dari reaksi terakhir yang
       kebetulan lewat.

       Kenapa: satu catatan bisa punya beberapa reaksi dari kita (bos punya
       EMPAT untuk catatan yang sama), dan sebagian sudah dihapus. Relay lain
       masih menyajikan reaksi basi yang sudah dihapus itu. Dengan aturan lama
       ("reaksi terakhir menang"), urutan kedatangan menentukan hasil: kalau
       reaksi basi + surat hapusnya tiba paling akhir, tanda suka hilang —
       padahal tiga reaksi lain masih hidup. Itu sebabnya halaman ini kadang
       hijau, padahal di halaman lain merah. Aturan sekarang tidak peduli
       urutan. */
    function recomputeTarget(target) {
        var dulu = !!state.byTarget[target];
        var terpilih = null;
        Object.keys(state.reactions).forEach(function (rid) {
            if (state.reactions[rid] !== target) return;
            if (state.deleted[rid]) return;
            var ts = state.reactionTime[rid] || 0;
            if (!terpilih || ts >= terpilih.ts) terpilih = { id: rid, ts: ts };
        });
        if (terpilih) state.byTarget[target] = terpilih.id;
        else delete state.byTarget[target];
        return { dulu: dulu, sekarang: !!terpilih };
    }

    // ---------------------------------------------------------------- util
    function eTags(ev) {
        if (!ev || !Array.isArray(ev.tags)) return [];
        return ev.tags.filter(function (t) {
            return Array.isArray(t) && t[0] === 'e' && typeof t[1] === 'string' && t[1];
        }).map(function (t) { return t[1]; });
    }

    /* Tag "e" yang jadi SASARAN suka. NIP-25: kalau ada beberapa, yang terakhir
       adalah sasarannya (yang di depan biasanya akar/balasan). */
    function reactionTarget(ev) {
        var ids = eTags(ev);
        return ids.length ? ids[ids.length - 1] : null;
    }

    // ------------------------------------------------------------------ API
    function isLiked(targetId) {
        return !!state.byTarget[targetId];
    }

    function reactionFor(targetId) {
        return state.byTarget[targetId] || null;
    }

    function count() {
        return Object.keys(state.byTarget).length;
    }

    /* Tandai UI kartu. Tombol like tidak punya id khusus, jadi dicari lewat
       angka penghitungnya (`metric-likes-<id>`) yang sudah ada di semua
       halaman — dengan begitu tidak perlu mengubah template enam halaman. */
    function applyState(targetId) {
        if (typeof document === 'undefined' || !document.getElementById) return;
        var span = document.getElementById('metric-likes-' + targetId);
        if (!span) return;
        var btn = span.closest ? span.closest('button') : null;
        if (!btn) return;
        var liked = isLiked(targetId);
        if (btn.classList) btn.classList.toggle('is-liked', liked);
        btn.title = liked ? 'Unlike' : 'Like';
        btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
        var first = btn.childNodes && btn.childNodes[0];
        if (first && first.nodeType === 3) first.nodeValue = liked ? '[\u2665] ' : '[+] ';
    }

    function applyAll() {
        Object.keys(state.byTarget).forEach(applyState);
    }

    /* Terapkan ulang setelah kartu digambar ulang (mis. LOAD MORE). Halaman
       boleh memanggil ini kapan saja; aman kalau tidak ada apa-apa. */
    function refreshUI() {
        applyAll();
    }

    // ------------------------------------------------------------- jaringan
    function closeSockets() {
        state.sockets.forEach(function (s) { try { s.close(); } catch (e) {} });
        state.sockets = [];
    }

    /* Jendela "riwayat" dimulai di sini, BUKAN di connect(): kalau ditaruh di
       connect(), daftar relay yang kosong akan membuat fungsi itu keluar lebih
       awal dan fase riwayat tidak pernah ditutup — akibatnya penghitung tidak
       pernah ikut berubah saat perangkat lain menyukai catatan. */
    function startHistoryWindow() {
        if (state.timer) { global.clearTimeout(state.timer); state.timer = null; }
        state.historyPhase = state.historyMs > 0;
        if (state.historyPhase) {
            state.timer = global.setTimeout(function () {
                state.historyPhase = false;
                state.timer = null;
            }, state.historyMs);
        }
    }

    function connect() {
        closeSockets();
        if (!state.pubkey || !state.relays.length) return;
        if (typeof global.WebSocket !== 'function') return;

        state.relays.forEach(function (url) {
            var ws;
            try { ws = new global.WebSocket(url); } catch (e) { return; }
            state.sockets.push(ws);
            ws.onopen = function () {
                try {
                    ws.send(JSON.stringify(['REQ', SUB_PREFIX + Math.random().toString(36).slice(2), {
                        kinds: [7, 5], authors: [state.pubkey], limit: state.limit
                    }]));
                } catch (e) {}
            };
            ws.onmessage = function (m) {
                var msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
                if (msg[0] === 'EOSE') { return; }
                if (msg[0] === 'EVENT' && msg[2]) absorb(msg[2]);
            };
            ws.onerror = function () {};
            ws.onclose = function () {};
        });
    }

    /* Proses satu peristiwa milik kita sendiri (kind 7 suka / kind 5 batal). */
    function absorb(ev) {
        if (!ev || ev.pubkey !== state.pubkey) return false;
        if (ev.kind === 7) {
            var target = reactionTarget(ev);
            if (!target) return false;
            state.reactions[ev.id] = target;
            state.reactionTime[ev.id] = ev.created_at || 0;
            // Reaksi yang sudah pernah kita lihat surat hapusnya tidak dihitung.
            var hasil = recomputeTarget(target);
            if (hasil.dulu !== hasil.sekarang) {
                applyState(target);
                if (!state.historyPhase && typeof state.onCount === 'function') state.onCount(target, hasil.sekarang ? 1 : -1);
            }
            return true;
        }
        if (ev.kind === 5) {
            var ids = eTags(ev);
            var changed = false;
            ids.forEach(function (id) {
                state.deleted[id] = true;
                var target = state.reactions[id];
                if (!target) return;                 // reaksinya belum kita lihat; catat saja
                var hasil = recomputeTarget(target);
                if (hasil.dulu !== hasil.sekarang) {
                    applyState(target);
                    if (!state.historyPhase && typeof state.onCount === 'function') state.onCount(target, -1);
                }
                changed = true;
            });
            return changed;
        }
        return false;
    }

    function broadcast(signed) {
        if (typeof state.send === 'function') { try { state.send(signed); return; } catch (e) {} }
        // Cadangan: pakai soket langganan sendiri kalau halaman tidak memberi `send`.
        state.sockets.forEach(function (s) {
            try { if (s.readyState === 1) s.send(JSON.stringify(['EVENT', signed])); } catch (e) {}
        });
    }

    function signEvent(tpl) {
        if (!global.nostr || typeof global.nostr.signEvent !== 'function') return null;
        return global.nostr.signEvent(tpl);
    }

    // ---------------------------------------------------------------- suka
    function like(targetId, targetPubkey) {
        var raw = {
            kind: 7,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['e', targetId, ''], ['p', targetPubkey || '', '']],
            content: '+',
            pubkey: state.pubkey
        };
        return signEvent(raw).then(function (signed) {
            broadcast(signed);
            state.reactions[signed.id] = targetId;
            state.reactionTime[signed.id] = signed.created_at || 0;
            state.byTarget[targetId] = signed.id;
            applyState(targetId);
            if (typeof state.onCount === 'function') state.onCount(targetId, 1);
            return true;
        });
    }

    function unlike(targetId) {
        var reactionId = state.byTarget[targetId];
        if (!reactionId) return Promise.resolve(false);
        var raw = {
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['e', reactionId], ['k', '7']],
            content: '',
            pubkey: state.pubkey
        };
        return signEvent(raw).then(function (signed) {
            broadcast(signed);
            // Tandai terhapus dan hitung ulang: kalau ternyata masih ada reaksi
            // lain yang hidup untuk catatan ini, keadaannya tetap "disukai".
            state.deleted[reactionId] = true;
            var hasil = recomputeTarget(targetId);
            applyState(targetId);
            // Kalau masih ada reaksi lain yang hidup, angkanya tidak berubah.
            if (typeof state.onCount === 'function') state.onCount(targetId, hasil.sekarang ? 0 : -1);
            return hasil.sekarang;
        });
    }

    /* Satu tombol untuk dua arah: belum suka -> suka, sudah suka -> batal. */
    function toggle(targetId, targetPubkey) {
        if (!targetId) return Promise.resolve(false);
        if (!state.pubkey) { alert('> ERROR: Not logged in!'); return Promise.resolve(false); }
        if (!global.nostr || typeof global.nostr.signEvent !== 'function') {
            alert('> ERROR: Tidak ada penanda tangan. Masuk dulu, ya.');
            return Promise.resolve(false);
        }
        if (state.pending[targetId]) return Promise.resolve(isLiked(targetId));
        state.pending[targetId] = true;

        var work = isLiked(targetId) ? unlike(targetId) : like(targetId, targetPubkey);
        return work.then(function (liked) {
            delete state.pending[targetId];
            return liked;
        }).catch(function () {
            delete state.pending[targetId];
            alert('> ERROR: Gagal mengirim. Coba lagi.');
            return isLiked(targetId);
        });
    }

    // --------------------------------------------------------------- setup
    function init(opts) {
        opts = opts || {};
        state.pubkey = opts.pubkey || null;
        state.relays = Array.isArray(opts.relays) ? opts.relays.slice() : [];
        state.send = typeof opts.send === 'function' ? opts.send : null;
        state.onCount = typeof opts.onCount === 'function' ? opts.onCount : null;
        state.onState = typeof opts.onState === 'function' ? opts.onState : null;
        if (typeof opts.historyMs === 'number') state.historyMs = opts.historyMs;
        if (typeof opts.limit === 'number') state.limit = opts.limit;
        startHistoryWindow();
        connect();
        return { pubkey: state.pubkey, relays: state.relays.length };
    }

    function setRelays(list) {
        state.relays = Array.isArray(list) ? list.slice() : [];
    }

    /* Untuk uji: bersihkan seluruh keadaan tanpa menyentuh jaringan. */
    function reset() {
        closeSockets();
        if (state.timer) { global.clearTimeout(state.timer); state.timer = null; }
        state.byTarget = {};
        state.reactions = {};
        state.reactionTime = {};
        state.deleted = {};
        state.pending = {};
        state.pubkey = null;
        state.send = null;
        state.onCount = null;
        state.historyPhase = true;
    }

    // ----------------------------------------------------------------- gaya
    var CSS = [
        /* Tombol yang sudah disukai: warna hangat + pendar, supaya jelas beda
           dari tombol lain yang hijau. Dua kelas -> menang dari .text-success. */
        '.t-feed-btn.is-liked{color:#ff4d6d !important;text-shadow:0 0 8px rgba(255,77,109,0.65);}',
        '.t-feed-btn.is-liked:hover{color:#ff8095 !important;}'
    ];

    function installStyles() {
        if (typeof document === 'undefined' || document.__nostrLikeStyles) return;
        document.__nostrLikeStyles = true;
        var style = document.createElement('style');
        style.setAttribute('data-nostr-like', '1');
        style.textContent = CSS.join('\n');
        (document.head || document.documentElement).appendChild(style);
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installStyles);
        else installStyles();
    }

    var api = {
        init: init,
        setRelays: setRelays,
        reset: reset,
        isLiked: isLiked,
        reactionFor: reactionFor,
        count: count,
        toggle: toggle,
        absorb: absorb,
        refreshUI: refreshUI,
        applyState: applyState
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrLike = api;
})(typeof window !== 'undefined' ? window : globalThis);
