/* ==========================================================================
   nostr-media-event.js — NIP-68 picture events and NIP-71 video events.

   Why this file exists
   --------------------
   On a kind 1 note the media URL sits in `content`, so the shared assembler
   can find it by looking for URLs. Picture-first (kind 20) and video (21, 22,
   34235, 34236) events are the opposite: the content is a *description* and
   the media lives only in `imeta` tags. Running the text assembler over them
   finds nothing, which is why these events used to render as a badge and an
   empty box.

   Before this module the video branch was copy-pasted into eight places across
   six pages, all with the same two bugs:
     - it took the LAST `url` of every imeta tag, so an event listing several
       resolutions (or a separate audio track) could end up playing an mp3 in a
       <video> element;
     - `image` is repeatable in NIP-71 (fallback posters), but the copies
       overwrote each other and kept whichever came last.

   NIP-68 (kind 20) puts every picture in its own `imeta` tag, so a post may
   carry many images; NIP-71 lists video variants distinguished by `dim` and
   `m`. Picking one means ranking, not "last one wins".

   ⚠️ SECURITY: every value here is written by strangers. URLs must be http(s)
   and every string that reaches HTML is escaped.
   ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.NostrMediaEvent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var PICTURE_KIND = 20;
    /* 21/22 are the regular kinds, 34235/34236 the addressable ones. A client
       should treat them the same apart from needing a `d` tag. */
    var VIDEO_KINDS = [21, 22, 34235, 34236];
    var ADDRESSABLE_KINDS = [34235, 34236];

    /* Formats a browser can play without extra help. HLS (application/x-mpegURL)
       is deliberately ranked last: only Safari plays it natively. */
    var NATIVE_VIDEO = ['video/mp4', 'video/webm', 'video/ogg'];
    var HLS_TYPES = ['application/x-mpegurl', 'application/vnd.apple.mpegurl'];

    function esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function safeUrl(src) {
        if (typeof src !== 'string' || !src) return null;
        if (/["'<>\\\s]/.test(src)) return null;
        return /^https?:\/\//i.test(src) ? src : null;
    }

    function isPicture(ev) { return !!ev && ev.kind === PICTURE_KIND; }
    function isVideo(ev) { return !!ev && VIDEO_KINDS.indexOf(ev.kind) !== -1; }
    function isMedia(ev) { return isPicture(ev) || isVideo(ev); }
    function isAddressable(ev) { return !!ev && ADDRESSABLE_KINDS.indexOf(ev.kind) !== -1; }

    function tagValue(ev, name) {
        if (!ev || !Array.isArray(ev.tags)) return null;
        for (var i = 0; i < ev.tags.length; i++) {
            var t = ev.tags[i];
            if (Array.isArray(t) && t[0] === name && typeof t[1] === 'string' && t[1] !== '') return t[1];
        }
        return null;
    }

    /* Every `imeta` tag, parsed to {url, m, dim, alt, fallbacks, images,
       duration, bitrate}. Malformed tags are skipped rather than guessed at. */
    function entries(ev) {
        var out = [];
        if (!ev || !Array.isArray(ev.tags)) return out;

        ev.tags.forEach(function (tag) {
            if (!Array.isArray(tag) || tag[0] !== 'imeta') return;
            var e = { url: null, m: null, dim: null, alt: null, fallbacks: [], images: [], duration: null };
            var others = 0;

            for (var i = 1; i < tag.length; i++) {
                if (typeof tag[i] !== 'string') continue;
                var sp = tag[i].indexOf(' ');
                if (sp <= 0) continue;
                var key = tag[i].slice(0, sp), val = tag[i].slice(sp + 1);
                if (!val) continue;

                if (key === 'url') { e.url = val; continue; }
                if (key === 'm') { e.m = val; others++; continue; }
                if (key === 'alt') { e.alt = val; others++; continue; }
                if (key === 'fallback') { e.fallbacks.push(val); others++; continue; }
                /* `image` is the poster in NIP-71 and repeatable for mirrors. */
                if (key === 'image' || key === 'thumb') { e.images.push(val); others++; continue; }
                if (key === 'duration') {
                    var d = parseFloat(val);
                    if (!isNaN(d) && d > 0) { e.duration = d; others++; }
                    continue;
                }
                if (key === 'dim') {
                    var m = val.match(/^(\d{1,6})x(\d{1,6})$/);
                    if (m) {
                        var w = parseInt(m[1], 10), h = parseInt(m[2], 10);
                        if (w && h) { e.dim = { w: w, h: h }; others++; }
                    }
                    continue;
                }
                if (key === 'x' || key === 'size' || key === 'bitrate' ||
                    key === 'blurhash' || key === 'thumbhash' || key === 'summary') others++;
            }

            if (!e.url || !others) return;      // NIP-92: url + at least one more
            e.url = safeUrl(e.url);
            if (!e.url) return;
            e.fallbacks = e.fallbacks.map(safeUrl).filter(Boolean);
            e.images = e.images.map(safeUrl).filter(Boolean);
            out.push(e);
        });

        return out;
    }

    /* `m` may carry parameters — a real event on nostr.download declares
       `video/mp4; codecs="avc1"`. Compare on the bare type, otherwise that
       entry ranks as "unknown" and loses to a plainer one. */
    function baseMime(m) {
        if (typeof m !== 'string') return '';
        return m.split(';')[0].trim().toLowerCase();
    }

    /* Is this entry a moving picture we can try to play? */
    function videoEntry(e) {
        if (e.m) return /^video\//i.test(e.m) || HLS_TYPES.indexOf(baseMime(e.m)) !== -1;
        /* No declared type: judge by extension, but never pick audio. */
        if (/\.(mp4|webm|ogg|ogv|mov|m4v|m3u8)(\?|#|$)/i.test(e.url)) return true;
        return false;
    }

    function imageEntry(e) {
        if (e.m) return /^image\//i.test(e.m);
        return /\.(png|jpe?g|gif|webp|avif|apng|bmp|svg)(\?|#|$)/i.test(e.url);
    }

    function area(e) { return e.dim ? e.dim.w * e.dim.h : 0; }

    /* Rank candidates: a natively playable file beats HLS, then the largest
       resolution wins, then declaration order. Never "last tag wins". */
    function rank(e) {
        var mime = baseMime(e.m);
        var native = NATIVE_VIDEO.indexOf(mime) !== -1 ? 2 : (HLS_TYPES.indexOf(mime) !== -1 ? 0 : 1);
        return { native: native, area: area(e) };
    }

    function pickVideo(list) {
        var candidates = list.filter(videoEntry).map(function (e, i) {
            return { e: e, i: i, r: rank(e) };
        });
        if (!candidates.length) return null;
        candidates.sort(function (a, b) {
            if (a.r.native !== b.r.native) return b.r.native - a.r.native;
            if (a.r.area !== b.r.area) return b.r.area - a.r.area;
            return a.i - b.i;
        });
        var best = candidates[0].e;
        return {
            url: best.url,
            mime: best.m || 'video/mp4',
            dim: best.dim,
            alt: best.alt,
            poster: best.images[0] || null,
            fallbacks: best.fallbacks.slice(),
            duration: best.duration
        };
    }

    /* All pictures of a kind-20 event, in tag order (NIP-68: the order of the
       imeta tags is the order of the gallery). */
    function pictures(ev) {
        return entries(ev).filter(imageEntry).map(function (e) {
            return { url: e.url, alt: e.alt, dim: e.dim, fallbacks: e.fallbacks };
        });
    }

    function video(ev) {
        if (!isVideo(ev)) return null;
        return pickVideo(entries(ev));
    }

    function title(ev) { return tagValue(ev, 'title'); }
    function warning(ev) { return tagValue(ev, 'content-warning'); }
    function altText(ev) { return tagValue(ev, 'alt'); }

    /* What to print under the badge. A real kind-20 event on nos.lol has an
       empty content but carries `alt` = "List of pictures", so falling back to
       the alt tag keeps the description the author actually wrote. */
    function caption(ev) {
        var c = String((ev && ev.content) || '').trim();
        if (c) return c;
        return altText(ev) || '';
    }

    /* Duration: prefer the tag, fall back to the imeta entry. */
    function duration(ev) {
        var t = parseFloat(tagValue(ev, 'duration'));
        if (!isNaN(t) && t > 0) return t;
        var v = video(ev);
        return v && v.duration ? v.duration : null;
    }

    function badge(ev) {
        if (isPicture(ev)) return 'PICTURE';
        if (!isVideo(ev)) return null;
        return ev.kind === 22 || ev.kind === 34236 ? 'SHORT_VIDEO' : 'VIDEO';
    }

    /* Same vocabulary the pages already print at the foot of a card. */
    function eventType(ev) {
        if (isPicture(ev)) return 'picture_event';
        if (!isVideo(ev)) return null;
        return ev.kind === 22 || ev.kind === 34236 ? 'short_video' : 'video_stream';
    }

    function fmtDuration(seconds) {
        if (!seconds && seconds !== 0) return null;
        var s = Math.round(seconds);
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        return h ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
    }

    /* One picture tile. `guard` is the page's spoiler check (a string of JS
       that may precede openLightbox — index uses it to swallow the first
       click on a concealed note). */
    function pictureTile(p, grid, guard, eventAlt) {
        var attrs = '';
        var alt = p.alt || eventAlt || null;
        if (alt) attrs += ' alt="' + esc(alt) + '"';
        if (p.dim) attrs += ' width="' + p.dim.w + '" height="' + p.dim.h + '"';
        var fbs = (p.fallbacks || []).filter(function (u) { return u && u !== p.url; });
        if (fbs.length) {
            attrs += " data-fb='" + esc(JSON.stringify(fbs)) + "' onerror=\"window.NostrImeta&&window.NostrImeta.retry(this)\"";
        }
        return '<div class="t-media-item" onclick="' + (guard || '') + "openLightbox('" + p.url + "')\">" +
               '<img src="' + p.url + '"' + attrs + '></div>';
    }

    /* Gallery for kind 20. Falls back to the text assembler when an event
       carries images only in its content (not spec-compliant, but they exist
       and showing them is better than showing nothing). */
    function pictureHtml(ev, opts) {
        opts = opts || {};
        var pics = pictures(ev);
        if (!pics.length) {
            return opts.contentFallback ? opts.contentFallback() : '';
        }
        var evAlt = altText(ev);
        var tiles = pics.map(function (p) { return pictureTile(p, opts.grid, opts.guard, evAlt); }).join('');
        /* `extraClass` carries the page's spoiler class and `wrapperAttrs` the
           handler that lifts it — identical to the kind-1 media grid, so the
           first click reveals a concealed picture instead of opening it. */
        var cls = (opts.grid || 't-media-grid') + ' ' + (opts.wrap || 'mt-2') +
                  (opts.extraClass ? ' ' + opts.extraClass : '');
        var extra = opts.wrapperAttrs ? ' ' + opts.wrapperAttrs : '';
        return '<div class="' + cls + '"' + extra + '>' + tiles + '</div>';
    }

    /* <video> for kind 21/22/34235/34236. Falls back to the next mirror when a
       source fails; the handler is cleared once the list is exhausted so a
       broken file cannot spin forever. */
    function videoHtml(ev, opts) {
        opts = opts || {};
        var v = video(ev);

        /* No playable file: the event may still point at a YouTube video.
           Reuse the existing player (thumbnail first, no iframe until clicked)
           rather than inventing a second embed rule. */
        if (!v) {
            var embed = opts.embed || (typeof window !== 'undefined' ? window.NostrEmbed : null);
            var ytId = externalVideo(ev, embed);
            if (ytId && embed && typeof embed.playerHtml === 'function') return embed.playerHtml(ytId);
            return opts.contentFallback ? opts.contentFallback() : '';
        }

        /* Event-level `alt` describes the video itself; use it when the imeta
           entry has no alt of its own. */
        var vAlt = v.alt || altText(ev) || null;

        var cls = 't-video-item w-100 mt-2' + (opts.extraClass ? ' ' + opts.extraClass : '');
        var style = opts.style || 'max-height: 500px; border: 1px dashed var(--t-green); background-color: #000;';
        var attrs = 'controls playsinline preload="metadata"';
        if (v.poster) attrs += ' poster="' + v.poster + '"';
        if (vAlt) attrs += ' title="' + esc(vAlt) + '"';
        if (v.dim) attrs += ' width="' + v.dim.w + '" height="' + v.dim.h + '"';
        /* An NSFW video reveals itself on the first click, exactly like the
           kind-1 path always did. */
        if (opts.spoilerRemove && opts.extraClass) {
            attrs += ' onclick="this.classList.remove(\'t-spoiler\');"';
        }

        var mirrors = v.fallbacks.filter(function (u) { return u !== v.url; });
        if (mirrors.length) {
            attrs += " data-vfb='" + esc(JSON.stringify(mirrors)) + "' onerror=\"window.NostrMediaEvent&&window.NostrMediaEvent.retryVideo(this)\"";
        }

        var note = opts.fallbackText || 'Your browser does not support this video format.';
        return '<video ' + attrs + ' class="' + cls + '" style="' + style + '">' +
               '<source src="' + v.url + '" type="' + esc(v.mime) + '">' + esc(note) + '</video>';
    }

    /* Walk the mirror list after a failed load. Returns false (and clears the
       handler) when there is nothing left. */
    function retryVideo(el) {
        if (!el || !el.getAttribute) return false;
        var raw = el.getAttribute('data-vfb');
        if (!raw) { if ('onerror' in el) el.onerror = null; return false; }

        var list;
        try { list = JSON.parse(raw); } catch (e) { list = null; }
        if (!Array.isArray(list) || !list.length) {
            if ('onerror' in el) el.onerror = null;
            el.removeAttribute('data-vfb');
            return false;
        }

        var next = list.shift();
        el.setAttribute('data-vfb', JSON.stringify(list));
        var source = el.querySelector ? el.querySelector('source') : null;
        if (source) source.setAttribute('src', next);
        else el.setAttribute('src', next);
        if (typeof el.load === 'function') el.load();
        if (!list.length) { if ('onerror' in el) el.onerror = null; el.removeAttribute('data-vfb'); }
        return true;
    }

    /* Some video events are not self-hosted files at all: a real kind-21 on
       nos.lol carries a YouTube link in `imeta`, in `r`, in `i` and only a
       thumbnail as its declared media (m image/jpeg). Without this branch those
       events render as a badge and nothing else — the file picker finds no
       playable variant because there is no file.

       `opts.embed` lets a caller inject nostr-embed.js; on a page it defaults
       to the global, and in Node it stays null unless a test passes one. */
    function externalVideo(ev, embed) {
        if (!embed || typeof embed.youTubeId !== 'function') return null;

        var candidates = [];
        entries(ev).forEach(function (e) { candidates.push(e.url); });
        if (ev && Array.isArray(ev.tags)) {
            ev.tags.forEach(function (t) {
                if (!Array.isArray(t)) return;
                if (t[0] === 'r' || t[0] === 'i') {
                    if (typeof t[1] === 'string') candidates.push(t[1]);
                }
            });
        }
        if (ev && typeof ev.content === 'string') candidates.push(ev.content);

        for (var i = 0; i < candidates.length; i++) {
            var id = embed.youTubeId(candidates[i]);
            if (id) return id;
        }
        return null;
    }

    /* One entry point for the pages: pick the right renderer for the kind. */
    function mediaHtml(ev, opts) {
        opts = opts || {};
        if (isPicture(ev)) return pictureHtml(ev, opts);
        if (isVideo(ev)) return videoHtml(ev, opts);
        return '';
    }

    /* The "address" of an addressable event: pubkey + `d`. Returns null for
       kinds that are not addressable, or when the `d` tag is missing — a
       caller then treats the event like any other. Streaming pages use this to
       drop an older version of a video when its replacement arrives. */
    function addressOf(ev) {
        if (!ev || !isAddressable(ev)) return null;
        var d = tagValue(ev, 'd');
        if (d == null) return null;
        return ev.pubkey + ':' + d;
    }

    /* Addressable events (34235/34236) carry a `d` tag and may be republished;
       only the newest version of each address should be shown. Events without
       a `d` tag are left alone rather than silently dropped. */
    function dedupeAddressable(list) {
        if (!Array.isArray(list)) return [];
        var winner = {};      // "pubkey:d" -> event
        var out = [];

        list.forEach(function (ev) {
            if (!ev || !isAddressable(ev)) { out.push(ev); return; }
            var d = tagValue(ev, 'd');
            if (d == null) { out.push(ev); return; }
            var key = ev.pubkey + ':' + d;
            var cur = winner[key];
            if (!cur || (ev.created_at || 0) > (cur.created_at || 0)) {
                if (cur) {
                    var idx = out.indexOf(cur);
                    if (idx !== -1) out.splice(idx, 1);
                }
                winner[key] = ev;
                out.push(ev);
            }
        });

        return out;
    }

    return {
        PICTURE_KIND: PICTURE_KIND,
        VIDEO_KINDS: VIDEO_KINDS,
        ADDRESSABLE_KINDS: ADDRESSABLE_KINDS,
        esc: esc,
        safeUrl: safeUrl,
        isPicture: isPicture,
        isVideo: isVideo,
        isMedia: isMedia,
        isAddressable: isAddressable,
        entries: entries,
        pictures: pictures,
        video: video,
        title: title,
        warning: warning,
        altText: altText,
        caption: caption,
        duration: duration,
        fmtDuration: fmtDuration,
        badge: badge,
        eventType: eventType,
        pictureHtml: pictureHtml,
        videoHtml: videoHtml,
        mediaHtml: mediaHtml,
        externalVideo: externalVideo,
        retryVideo: retryVideo,
        addressOf: addressOf,
        dedupeAddressable: dedupeAddressable
    };
});
