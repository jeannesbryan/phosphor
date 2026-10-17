/* ==========================================================================
   nostr-imeta.js — NIP-92 media attachment metadata ("imeta" tags).

   What NIP-92 is for
   ------------------
   A note that carries media only puts a bare URL in its content. That URL
   says nothing about the file: how big it is, its real MIME type, its
   dimensions, what the picture shows (for screen readers), or where to find
   a mirror when the host dies. NIP-92 adds an `imeta` tag next to the URL:

     ["imeta", "url https://host/abc.jpg", "m image/jpeg", "x <sha256>",
      "dim 3024x4032", "alt A scenic photo", "fallback https://mirror/x.jpg"]

   Each entry is a space-delimited "key value" pair, and the tag is variadic.
   The rule from the spec: every `imeta` tag SHOULD match a URL that really
   appears in the event content — a tag pointing at some other URL is to be
   ignored. `url` is mandatory and at least one other field is required.

   Both directions live here
   -------------------------
   PUBLISH  remember() collects what the uploader learned about each file
            (MIME, sha256, size, dimensions); finalize() then attaches the
            matching tags to the event just before it is signed.
   RENDER   parse() turns an event's tags into a lookup so the media builder
            can use `alt`, `fallback`, `m` and `thumb` instead of guessing
            from the file extension.

   ⚠️ SECURITY: `imeta` comes from other people's events. Everything that
   reaches HTML here goes through esc() first — `alt` in particular, because
   an unescaped quote would break out of the attribute and let a stranger run
   script on this page. URLs additionally go through the same safe-URL rule
   the media builder uses (no quotes, angle brackets or whitespace).
   ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.NostrImeta = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /* Fields kept from NIP-94 that this client actually acts on. Others are
       preserved on publish but ignored on render. */
    var KNOWN = ['url', 'm', 'x', 'size', 'dim', 'alt', 'blurhash', 'summary',
                 'thumb', 'image', 'fallback', 'duration'];

    /* Metadata collected from uploads in this session, keyed by URL.
       Only used at publish time; an entry is attached to an event only if the
       same URL appears in that event's content. */
    var registry = {};

    function esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    /* Same rule as nostr-embed.js: a URL that could break out of an HTML
       attribute is not a usable URL. Kept duplicated on purpose so this
       module has no load-order dependency on the embed module. */
    function safeUrl(src) {
        if (typeof src !== 'string' || !src) return null;
        if (/["'<>\\\s]/.test(src)) return null;
        if (!/^https?:\/\//i.test(src)) return null;
        return src;
    }

    /* "dim 3024x4032" -> { w: 3024, h: 4032 } (or null when unusable) */
    function parseDim(value) {
        var m = String(value == null ? '' : value).match(/^(\d{1,6})x(\d{1,6})$/);
        if (!m) return null;
        var w = parseInt(m[1], 10), h = parseInt(m[2], 10);
        if (!w || !h) return null;
        return { w: w, h: h };
    }

    /* One `imeta` tag -> a metadata object, or null when the tag is not
       usable. Entries are "key value"; the value may itself contain spaces
       ("alt A scenic photo"), so split on the FIRST space only. */
    function parseTag(tag) {
        if (!Array.isArray(tag) || tag[0] !== 'imeta') return null;

        var meta = { fallback: [] };
        var fields = 0;          // fields OTHER than url (spec: url + >=1 more)

        for (var i = 1; i < tag.length; i++) {
            var entry = tag[i];
            if (typeof entry !== 'string') continue;
            var sp = entry.indexOf(' ');
            if (sp <= 0) continue;                       // "url" with no value
            var key = entry.slice(0, sp);
            var val = entry.slice(sp + 1);
            if (!val) continue;
            if (KNOWN.indexOf(key) === -1) continue;

            /* `url` is mandatory, so it does not count towards the "at least
               one other field" rule — a tag carrying nothing but url carries
               no metadata and is dropped below. */
            if (key === 'url') { meta.url = val; continue; }

            if (key === 'fallback') { meta.fallback.push(val); fields++; continue; }
            if (key === 'dim') {
                var d = parseDim(val);
                if (d) { meta.dim = d; fields++; }
                continue;
            }
            if (key === 'size') {
                var n = parseInt(val, 10);
                if (!isNaN(n) && n >= 0) { meta.size = n; fields++; }
                continue;
            }
            meta[key] = val;
            fields++;
        }

        /* NIP-92: url is mandatory, plus at least one other field. */
        if (!meta.url || fields < 1) return null;
        meta.url = String(meta.url).trim();
        if (!meta.url) return null;

        return meta;
    }

    /* All imeta tags of an event -> { url: meta }. Duplicate tags for the
       same URL keep the first usable one, matching "one tag per URL". */
    function parse(tags) {
        var map = {};
        if (!Array.isArray(tags)) return map;
        for (var i = 0; i < tags.length; i++) {
            var meta = parseTag(tags[i]);
            if (!meta) continue;
            if (map[meta.url]) continue;
            map[meta.url] = meta;
        }
        return map;
    }

    function buildTag(meta) {
        if (!meta || !meta.url) return null;
        var tag = ['imeta', 'url ' + meta.url];
        var extra = 0;

        if (meta.m) { tag.push('m ' + meta.m); extra++; }
        if (meta.x) { tag.push('x ' + meta.x); extra++; }
        if (typeof meta.size === 'number' && meta.size > 0) { tag.push('size ' + meta.size); extra++; }
        if (meta.dim) { tag.push('dim ' + meta.dim.w + 'x' + meta.dim.h); extra++; }
        if (meta.alt) { tag.push('alt ' + meta.alt); extra++; }
        if (meta.blurhash) { tag.push('blurhash ' + meta.blurhash); extra++; }
        if (meta.thumb) { tag.push('thumb ' + meta.thumb); extra++; }
        if (Array.isArray(meta.fallback)) {
            meta.fallback.forEach(function (f) { tag.push('fallback ' + f); });
        }

        return extra ? tag : null;      // "url and at least one other field"
    }

    /* Record what the uploader learned. `list` is an array of metadata
       objects (see blossom-auth.js). Entries without a usable URL are
       dropped, so callers do not have to pre-filter. */
    function remember(list) {
        if (!list) return 0;
        var arr = Array.isArray(list) ? list : [list];
        var kept = 0;
        arr.forEach(function (meta) {
            if (!meta || typeof meta !== 'object') return;
            var url = meta.url;
            if (!url) return;
            registry[url] = meta;
            kept++;
        });
        return kept;
    }

    function forget() { registry = {}; }

    /* Attach imeta tags to an event about to be signed. Only URLs that really
       appear in the content are covered (NIP-92), and a URL that already has
       a tag is left alone — this is idempotent, so calling it twice is safe. */
    function finalize(event) {
        if (!event || !Array.isArray(event.tags)) return event;
        var content = String(event.content == null ? '' : event.content);
        if (!content) return event;

        var covered = {};
        event.tags.forEach(function (t) {
            if (Array.isArray(t) && t[0] === 'imeta') {
                for (var i = 1; i < t.length; i++) {
                    if (typeof t[i] === 'string' && t[i].indexOf('url ') === 0) {
                        covered[t[i].slice(4).trim()] = true;
                        break;
                    }
                }
            }
        });

        Object.keys(registry).forEach(function (url) {
            if (covered[url]) return;
            if (content.indexOf(url) === -1) return;
            var tag = buildTag(registry[url]);
            if (!tag) return;
            event.tags.push(tag);
            covered[url] = true;
        });

        return event;
    }

    /* Attributes for an <img>, built from metadata. Returns '' when there is
       nothing to add, so the caller can stay on its old path.

       Layout note: Phosphor's CSS gives media tiles a fixed aspect ratio and
       object-fit: cover, so `dim` here is not about layout shift — it feeds
       the lightbox and keeps the intrinsic ratio correct for anyone who
       changes that CSS. `alt` is the real win: without it every image is
       announced as "Media". */
    function imgAttrs(meta, defaultAlt) {
        if (!meta) return '';
        var out = '';

        var altText = meta.alt ? esc(meta.alt) : null;
        if (altText) out += ' alt="' + altText + '"';

        if (meta.dim) out += ' width="' + meta.dim.w + '" height="' + meta.dim.h + '"';

        var fbs = (meta.fallback || []).map(safeUrl).filter(function (u) {
            return u && u !== meta.url;
        });
        if (fbs.length) {
            /* Stored as JSON in a data attribute and read by retry(), not
               interpolated into an onerror string — that keeps an attacker's
               URL out of executable position entirely. */
            var json = JSON.stringify(fbs).replace(/'/g, '&#39;');
            out += " data-fb='" + json + "' onerror=\"window.NostrImeta&&window.NostrImeta.retry(this)\"";
        }

        return out;
    }

    /* Walk the fallback chain of an <img> that failed to load. Each call
       consumes one entry; when the list runs out the handler is cleared so a
       broken image cannot loop forever. */
    function retry(el) {
        if (!el || !el.getAttribute) return false;
        var raw = el.getAttribute('data-fb');
        if (!raw) { if ('onerror' in el) el.onerror = null; return false; }

        var list;
        try { list = JSON.parse(raw); } catch (e) { list = null; }
        if (!Array.isArray(list) || !list.length) {
            if ('onerror' in el) el.onerror = null;
            el.removeAttribute('data-fb');
            return false;
        }

        var next = list.shift();
        el.setAttribute('data-fb', JSON.stringify(list));
        el.setAttribute('src', next);
        if (!list.length) { if ('onerror' in el) el.onerror = null; el.removeAttribute('data-fb'); }
        return true;
    }

    /* Poster/thumbnail declared for a video, if any. */
    function poster(meta) {
        if (!meta) return null;
        return safeUrl(meta.thumb) || safeUrl(meta.image) || null;
    }

    /* Declared MIME type, when it is a sane "type/subtype" string. */
    function mime(meta) {
        if (!meta || !meta.m) return null;
        return /^[a-z]+\/[a-z0-9.+-]+$/i.test(meta.m) ? meta.m : null;
    }

    return {
        KNOWN: KNOWN,
        esc: esc,
        safeUrl: safeUrl,
        parseDim: parseDim,
        parseTag: parseTag,
        parse: parse,
        buildTag: buildTag,
        remember: remember,
        forget: forget,
        finalize: finalize,
        imgAttrs: imgAttrs,
        retry: retry,
        poster: poster,
        mime: mime,
        /* exposed for tests only */
        _registry: function () { return registry; }
    };
});
