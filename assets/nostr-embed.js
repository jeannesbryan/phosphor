/* ==========================================================================
   nostr-embed.js — tautan YouTube di dalam catatan Nostr jadi video.

   Kenapa berkas ini ada (asal 2026-09-29 di jeannesbryan.my.id, dipakai
   phosphor sejak 2026-10-04)
   ----------------------------------
   Phosphor punya TUJUH halaman yang masing-masing menyusun sendiri isi catatan
   (index, profile, bookmark, relay, thread, notifications, notes) — sepuluh
   tempat seluruhnya. Semuanya sudah mengenali gambar dan berkas video
   (mp4/webm/ogg) dari ekstensi berkas, tapi tautan YouTube tidak punya
   ekstensi berkas, jadi ia jatuh ke aturan URL umum dan hanya jadi teks yang
   bisa diklik. Klien lain (Jumble, Amethyst) menampilkannya sebagai video —
   itulah selisih yang dilaporkan bos.

   Aturan "URL mana yang dianggap video, seperti apa pemutarnya, kapan iframe
   dimuat, dan bagaimana media disusun" ditulis SEKALI di sini. Kalau aturannya
   disalin sepuluh kali, perbaikan berikutnya hampir pasti hanya mendarat di
   satu salinan dan halaman-halamannya kembali menampilkan hal yang berbeda.

   Yang TIDAK disentuh: video yang diunggah manual (mp4/webm/ogg, kind 21/22,
   imeta). Itu tetap dirender seperti sebelumnya — tanpa thumbnail.

   Cara pakai di halaman:
     <script src="/assets/nostr-embed.js"></script>   (di <head>)
     window.NostrEmbed.youTubeId(url)   -> id 11 karakter, atau null
     window.NostrEmbed.playerHtml(id)   -> string HTML pemutar
     window.NostrEmbed.buildMediaHtml(blocks, gridClass, wrapClass[, extraAttrs])
                                        -> menyusun daftar media jadi HTML
     window.NostrEmbed.upgrade(el)      -> untuk konten markdown (artikel)

   Kegagalan modul ini TIDAK boleh menghilangkan media diam-diam. Setiap
   pemakaian di halaman diberi penjaga: kalau berkas ini tidak termuat, gambar
   dan video unggahan tetap tampil seperti sebelumnya dan tautan YouTube kembali
   jadi teks biasa — tidak ada media yang lenyap tanpa jejak.

   Privasi / beban halaman
   -----------------------
   Saat halaman dibuka hanya thumbnail (i.ytimg.com) yang diambil, dan itu pun
   dengan loading="lazy". Tidak ada iframe, skrip, atau cookie YouTube sampai
   pengunjung menekan tombol putar. Iframe-nya memakai youtube-nocookie.com.
   ========================================================================== */
(function (root, factory) {
    var api = factory();
    root.NostrEmbed = api;
    // supaya bisa diuji tanpa browser: node tests/nostr-embed.test.mjs
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var ID_RE = /^[A-Za-z0-9_-]{11}$/;

    /* Selektor untuk "media ini sedang disembunyikan di balik penutup".
       Phosphor memakai kelas .t-spoiler untuk catatan sensitif; situs lain
       boleh mengubah baris ini. Kalau selektornya tidak ada di halaman,
       perilakunya sama seperti tanpa fitur ini. */
    var CONCEALED_SELECTOR = '.t-spoiler';

    var PLAY_SVG = '<svg viewBox="0 0 68 48" aria-hidden="true" focusable="false">'
        + '<path class="yt-play-bg" d="M66.5 7.7a8.1 8.1 0 0 0-5.7-5.7C55.9.9 34 .9 34 .9s-21.9 0-26.8 1.1A8.1 8.1 0 0 0 1.5 7.7C.3 12.8.3 24 .3 24s0 11.2 1.2 16.3a8.1 8.1 0 0 0 5.7 5.7C12.1 47.1 34 47.1 34 47.1s21.9 0 26.8-1.1a8.1 8.1 0 0 0 5.7-5.7C67.7 35.2 67.7 24 67.7 24s0-11.2-1.2-16.3z"/>'
        + '<path class="yt-play-fg" d="M27.9 34L45.3 24 27.9 14z"/></svg>';

    var CSS = [
        /* Bingkai 16:9. Warnanya diambil dari tema masing-masing situs:
           --yt-border kalau ada, kalau tidak --left-border (jeannesbryan.my.id),
           kalau tidak juga abu-abu netral. Dengan begitu berkas ini bisa
           dipindah antar situs tanpa menyalin ulang warnanya.
           Di dalam grid media margin vertikalnya ditiadakan oleh aturan di
           bawah, karena di sana jarak sudah diatur grid. */
        '.yt-embed{position:relative;display:block;width:100%;aspect-ratio:16/9;background:#111;'
            + 'border:1px solid var(--yt-border, var(--left-border, #2a2a2a));cursor:pointer;'
            + 'overflow:hidden;margin:16px 0;}',
        '.media-grid > .yt-embed,.t-media-grid > .yt-embed{margin:0;}',
        '.yt-embed .yt-thumb{display:block;width:100%;height:100%;object-fit:cover;margin:0;'
            + 'border:0;transition:transform .15s ease;}',
        '.yt-embed:hover .yt-thumb{transform:scale(1.02);}',
        '.yt-embed .yt-play{position:absolute;left:50%;top:50%;width:68px;height:48px;'
            + 'transform:translate(-50%,-50%);pointer-events:none;}',
        '.yt-embed .yt-play-bg{fill:#212121;opacity:.78;}',
        '.yt-embed:hover .yt-play-bg{fill:#c00;opacity:1;}',
        '.yt-embed .yt-play-fg{fill:#fff;}',
        '.yt-embed .yt-brand{position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.72);'
            + 'color:#fff;font-size:11px;font-weight:700;letter-spacing:.04em;padding:2px 6px;'
            + 'text-transform:uppercase;}',
        '.yt-embed[data-yt-active] .yt-play,.yt-embed[data-yt-active] .yt-brand{display:none;}',
        '.yt-frame{position:absolute;inset:0;width:100%;height:100%;border:0;}'
    ].join('');

    var STYLE_ID = 'nostr-embed-style';

    /* Mengambil id video dari sebuah URL YouTube, atau null kalau bukan.
       Menerima: youtu.be/<id>, youtube.com/watch?v=<id>, /shorts/<id>,
       /live/<id>, /embed/<id>, /v/<id>, dengan atau tanpa www/m/music. */
    function youTubeId(rawUrl) {
        if (!rawUrl) return null;
        var url = String(rawUrl).replace(/&amp;/g, '&').trim();
        /* Regex pelink-an bisa menelan tanda baca di ekor URL — "(...youtu.be/
           xxx)" atau "...xxx)." — sedangkan id video tidak pernah memuat tanda
           itu, jadi memangkasnya aman. Koma/titik di ekor kerap muncul karena
           URL berada di akhir kalimat. */
        url = url.replace(/^[([{'"\s]+/, '').replace(/[)\]}>.,;:!?'"]+$/, '');

        var parsed;
        try { parsed = new URL(url); } catch (err) { return null; }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

        var host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        host = host.replace(/^(m|music)\./, '');

        if (host === 'youtu.be') {
            var seg = parsed.pathname.split('/')[1] || '';
            return ID_RE.test(seg) ? seg : null;
        }
        if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
            var v = parsed.searchParams.get('v');
            if (v && ID_RE.test(v)) return v;
            var m = parsed.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/);
            if (m) return m[1];
        }
        return null;
    }

    function thumbUrl(id, size) {
        return 'https://i.ytimg.com/vi/' + id + '/' + size + '.jpg';
    }

    /* Thumbnail resolusi tinggi dulu; tidak semua video punya maxresdefault,
       jadi kalau gagal (pendengar error di bawah) turun ke hqdefault.
       object-fit:cover memotong bar hitam yang ikut di hqdefault. */
    function playerHtml(id) {
        if (!ID_RE.test(String(id || ''))) return '';
        return '<div class="yt-embed" data-yt-id="' + id + '" role="button" tabindex="0"'
            + ' aria-label="Putar video YouTube">'
            + '<img class="yt-thumb" alt="" loading="lazy" decoding="async"'
            + ' src="' + thumbUrl(id, 'maxresdefault') + '"'
            + ' data-yt-fallback="' + thumbUrl(id, 'hqdefault') + '">'
            + '<span class="yt-play">' + PLAY_SVG + '</span>'
            + '<span class="yt-brand">YouTube</span>'
            + '</div>';
    }

    function activate(box) {
        var id = box.getAttribute('data-yt-id');
        if (!id || box.getAttribute('data-yt-active')) return;
        box.setAttribute('data-yt-active', '1');
        box.removeAttribute('role');
        box.removeAttribute('tabindex');
        var frame = document.createElement('iframe');
        frame.className = 'yt-frame';
        frame.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0';
        frame.title = 'YouTube';
        frame.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media;'
            + ' gyroscope; picture-in-picture; web-share');
        frame.setAttribute('allowfullscreen', '');
        frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        box.textContent = '';
        box.appendChild(frame);
    }

    /* Ganti tautan YouTube yang berdiri sendiri di satu baris (hasil marked
       pada artikel long-form: <p><a href="...youtu.be/xxx">...</a></p>) jadi
       pemutar. Tautan di tengah kalimat dibiarkan — menggantinya akan
       menghapus kata-kata di sekitarnya. */
    function upgrade(rootEl) {
        if (!rootEl || !rootEl.querySelectorAll) return rootEl;
        var anchors = rootEl.querySelectorAll('a[href]');
        for (var i = 0; i < anchors.length; i++) {
            var a = anchors[i];
            var id = youTubeId(a.getAttribute('href'));
            if (!id) continue;
            var parent = a.parentNode;
            if (!parent) continue;
            var meaningful = 0;
            for (var n = 0; n < parent.childNodes.length; n++) {
                var child = parent.childNodes[n];
                if (child.nodeType === 3 && !String(child.nodeValue || '').trim()) continue;
                meaningful++;
            }
            if (meaningful !== 1) continue;
            var holder = (parent.tagName === 'P' || parent.tagName === 'LI') ? parent : a;
            if (!holder.parentNode) continue;
            var shell = document.createElement('div');
            shell.innerHTML = playerHtml(id);
            var node = shell.firstChild;
            if (!node) continue;
            holder.parentNode.replaceChild(node, holder);
        }
        return rootEl;
    }

    /* Menyusun daftar media jadi satu blok HTML.
       blocks : array objek { html, full }
                  full=false -> boleh dirapatkan jadi grid (gambar, mp4/webm/ogg
                                unggahan manual)
                  full=true  -> blok sendiri selebar kolom (pemutar YouTube,
                                karena di dalam grid 2 kolom ia jadi terlalu kecil
                                untuk ditonton)
       Urutan asli di dalam catatan dipertahankan: yang rapat dan berurutan
       digabung jadi satu grid, yang penuh memutus grid itu.

       extraAttrs (opsional) ditempelkan apa adanya ke SETIAP elemen pembungkus.
       Dipakai halaman index Phosphor yang menyembunyikan media sensitif di
       balik kelas t-spoiler: atribut onclick-nya harus ada di elemen yang sama
       dengan kelas itu, jadi tidak bisa dipasang sebagai pembungkus tambahan. */
    function buildMediaHtml(blocks, gridClass, wrapClass, extraAttrs) {
        if (!blocks || !blocks.length) return '';
        gridClass = gridClass || 'media-grid';
        wrapClass = wrapClass || 'mt-3';
        var extra = extraAttrs ? ' ' + extraAttrs : '';

        var html = '';
        var buf = [];
        var flush = function () {
            if (!buf.length) return;
            html += buf.length > 1
                ? '<div class="' + gridClass + '"' + extra + '>' + buf.join('') + '</div>'
                : '<div class="' + wrapClass + '"' + extra + '>' + buf[0] + '</div>';
            buf = [];
        };

        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            if (!b) continue;
            if (b.full) {
                flush();
                html += '<div class="' + wrapClass + '"' + extra + '>' + b.html + '</div>';
            } else {
                buf.push(b.html);
            }
        }
        flush();
        return html;
    }

    function install() {
        if (typeof document === 'undefined' || document.__nostrEmbedInstalled) return;
        document.__nostrEmbedInstalled = true;

        if (!document.getElementById(STYLE_ID)) {
            var style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
        }

        /* Dipasang di fase CAPTURE, bukan bubble. Alasannya konkret: pembungkus
           media di halaman index memanggil event.stopPropagation() supaya klik
           pertama hanya membuka penutup catatan sensitif. Kalau pendengar ini
           duduk di fase bubble, propagasi itu memutusnya dan pemutar video tidak
           akan pernah bisa diputar di halaman tersebut.

           Selama penutupnya masih aktif kita sengaja TIDAK memuat pemutar:
           klik pertama membuka penutup (itu tugas pembungkusnya), pemutar
           dimuat pada klik berikutnya — sama seperti perilaku gambar. */
        function closestConcealed(el) {
            if (!el || !el.closest) return null;
            return el.closest(CONCEALED_SELECTOR);
        }

        document.addEventListener('click', function (ev) {
            var box = ev.target && ev.target.closest && ev.target.closest('.yt-embed');
            if (box && !closestConcealed(box)) activate(box);
        }, true);

        document.addEventListener('keydown', function (ev) {
            if (ev.key !== 'Enter' && ev.key !== ' ') return;
            var box = ev.target && ev.target.closest && ev.target.closest('.yt-embed');
            if (!box || closestConcealed(box)) return;
            ev.preventDefault();
            activate(box);
        }, true);

        /* error tidak bubble, jadi pendengarnya harus capture. */
        document.addEventListener('error', function (ev) {
            var img = ev.target;
            if (!img || img.tagName !== 'IMG' || !img.classList
                || !img.classList.contains('yt-thumb')) return;
            if (img.getAttribute('data-yt-fallback-used')) return;
            var fallback = img.getAttribute('data-yt-fallback');
            if (!fallback) return;
            img.setAttribute('data-yt-fallback-used', '1');
            img.src = fallback;
        }, true);
    }

    install();

    return {
        youTubeId: youTubeId,
        playerHtml: playerHtml,
        thumbUrl: thumbUrl,
        buildMediaHtml: buildMediaHtml,
        upgrade: upgrade
    };
}));
