/* ==========================================================================
   nostr-embed.js — YouTube links inside Nostr notes become video players.

   Why this file exists (born 2026-09-29 in jeannesbryan.my.id, used by
   phosphor since 2026-10-04)
   ----------------------------------
   Phosphor has SEVEN pages that each assemble note content themselves
   (index, profile, bookmark, relay, thread, notifications, notes) — ten
   places in total. All of them already recognised images and video files
   (mp4/webm/ogg) from the file extension, but a YouTube link has no file
   extension, so it fell through to the generic URL rule and became plain
   clickable text. Other clients (Jumble, Amethyst) show it as a video —
   that was the difference bos reported.

   The rules "which URLs count as video, what the player looks like, when the
   iframe is loaded, and how media is laid out" are written ONCE here. If the
   rules were copied ten times, the next fix would almost certainly land in
   one copy only and the pages would drift apart again.

   NOT touched: manually uploaded video (mp4/webm/ogg, kind 21/22, imeta).
   Those keep rendering exactly as before — without a thumbnail.

   How to use it in a page:
     <script src="/assets/nostr-embed.js"></script>   (in <head>)
     window.NostrEmbed.youTubeId(url)   -> 11-char id, or null
     window.NostrEmbed.playerHtml(id)   -> player HTML string
     window.NostrEmbed.buildMediaHtml(blocks, gridClass, wrapClass[, extraAttrs])
                                        -> lays out a list of media as HTML
     window.NostrEmbed.upgrade(el)      -> for markdown content (articles)

   A failure of this module MUST NOT silently drop media. Every call site is
   guarded: if the file does not load, images and uploaded video still render
   as before and YouTube links fall back to plain text — no media disappears
   without a trace.

   Privacy / page weight
   ---------------------
   On page load only the thumbnail (i.ytimg.com) is fetched, and even that
   with loading="lazy". No iframe, script, or YouTube cookie until the visitor
   presses play. The iframe uses youtube-nocookie.com.
   ========================================================================== */
(function (root, factory) {
    var api = factory();
    root.NostrEmbed = api;
    // so it can be tested without a browser: node tests/nostr-embed.test.mjs
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var ID_RE = /^[A-Za-z0-9_-]{11}$/;

    /* Selector for "this media is currently hidden behind a cover".
       Phosphor uses the class .t-spoiler for sensitive notes; other sites may
       change this line. If the selector matches nothing on the page, the
       behaviour is the same as without this feature. */
    var CONCEALED_SELECTOR = '.t-spoiler';

    var PLAY_SVG = '<svg viewBox="0 0 68 48" aria-hidden="true" focusable="false">'
        + '<path class="yt-play-bg" d="M66.5 7.7a8.1 8.1 0 0 0-5.7-5.7C55.9.9 34 .9 34 .9s-21.9 0-26.8 1.1A8.1 8.1 0 0 0 1.5 7.7C.3 12.8.3 24 .3 24s0 11.2 1.2 16.3a8.1 8.1 0 0 0 5.7 5.7C12.1 47.1 34 47.1 34 47.1s21.9 0 26.8-1.1a8.1 8.1 0 0 0 5.7-5.7C67.7 35.2 67.7 24 67.7 24s0-11.2-1.2-16.3z"/>'
        + '<path class="yt-play-fg" d="M27.9 34L45.3 24 27.9 14z"/></svg>';

    var CSS = [
        /* 16:9 frame. The colour comes from each site's theme: --yt-border if
           present, otherwise --left-border (jeannesbryan.my.id), otherwise a
           neutral grey. That way this file can move between sites without the
           colours being copied along.
           Inside the media grid its vertical margin is zeroed by the rule
           below, because the grid already handles spacing there. */
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

    /* Extract the video id from a YouTube URL, or null if it is not one.
       Accepts: youtu.be/<id>, youtube.com/watch?v=<id>, /shorts/<id>,
       /live/<id>, /embed/<id>, /v/<id>, with or without www/m/music. */
    function youTubeId(rawUrl) {
        if (!rawUrl) return null;
        var url = String(rawUrl).replace(/&amp;/g, '&').trim();
        /* Link detection can swallow trailing punctuation — "(...youtu.be/xxx)"
           or "...xxx)." — while a video id never contains those characters, so
           trimming them is safe. A trailing comma/period usually appears
           because the URL sits at the end of a sentence. */
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

    /* High-resolution thumbnail first; not every video has maxresdefault, so
       on failure (the error listener below) it falls back to hqdefault.
       object-fit:cover crops the black bars that come with hqdefault. */
    function playerHtml(id) {
        if (!ID_RE.test(String(id || ''))) return '';
        return '<div class="yt-embed" data-yt-id="' + id + '" role="button" tabindex="0"'
            + ' aria-label="Play YouTube video">'
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

    /* Replace a YouTube link that stands alone on its own line (marked output
       in long-form articles: <p><a href="...youtu.be/xxx">...</a></p>) with a
       player. Links in the middle of a sentence are left alone — replacing
       them would delete the surrounding words. */
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

    /* Lay out a list of media as one HTML block.
       blocks : array of objects { html, full }
                  full=false -> may be packed into a grid (images, manually
                                uploaded mp4/webm/ogg)
                  full=true  -> a block of its own, full column width (YouTube
                                player, because a 2-column grid cell makes it
                                too small to watch)
       The original order inside the note is preserved: consecutive packed
       items join one grid, a full-width item breaks that grid.

       extraAttrs (optional) is pasted verbatim onto EVERY wrapper element.
       Used by the Phosphor index page, which hides sensitive media behind the
       class t-spoiler: its onclick attribute must sit on the same element as
       that class, so it cannot be added as an extra outer wrapper. */
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

        /* Installed in the CAPTURE phase, not bubble. The reason is concrete:
           the media wrapper on the index page calls event.stopPropagation() so
           the first click only lifts the cover off a sensitive note. If this
           listener sat in the bubble phase, that propagation would cut it off
           and the video player could never be started on that page.

           While the cover is still active we deliberately DO NOT load the
           player: the first click lifts the cover (that is the wrapper's job),
           the player loads on the next click — the same behaviour as images. */
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

        /* error does not bubble, so its listener must be capture. */
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
