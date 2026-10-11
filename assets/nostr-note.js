/* ==========================================================================
   nostr-note.js — rules about note STRUCTURE, plus GitHub link previews.

   What it covers (2026-10-04)
   ---------------------------
   1. NIP-10: which notes are REPLIES. The timeline must not show them as
      ordinary notes — back then a reply "Yes 100%" showed up in the timeline
      even though other clients hid it.
   2. NIP-18: which notes QUOTE another note. Back then a quote rendered
      empty, because the quote marker on that note was in the "q" tag — and
      Phosphor had never read that tag at all.
   3. GitHub link previews: repo/file links such as
      github.com/owner/repo/blob/main/docs/FILE.md that used to be plain text
      are now a small card with the repo name, description, stars, language.

   Why one file
   ------------
   The seven Phosphor pages each assemble note content themselves (ten places).
   If these rules were written inside each page, the next fix would land in
   only some of them — that has already happened.
   All the pure rules below can be tested without a browser and without a
   network:
       node tests/nostr-note.test.mjs

   Failure != loss
   ---------------
   If this file does not load, or GitHub cannot be reached (rate limit, for
   example), pages keep showing the link as before. Nothing is hidden and no
   empty box is left hanging.
   ========================================================================== */

(function (global) {
    'use strict';

    // ---------------------------------------------------------------- NIP-10
    /* A note counts as a REPLY when it points at a parent note through an "e"
       tag. What tells them apart:
         - "e" tag with a "root"/"reply" marker  -> definitely a reply
         - "e" tag with no marker                -> old-style NIP-10; the tag
                                                    points at the parent, so a reply
         - "e" tags ALL marked "mention"         -> only a mention, not a reply
       With no "e" tag at all, it is an ordinary note. */
    function isReply(ev) {
        if (!ev || !Array.isArray(ev.tags)) return false;
        var eTags = ev.tags.filter(function (t) {
            return Array.isArray(t) && t[0] === 'e' && typeof t[1] === 'string' && t[1];
        });
        if (!eTags.length) return false;
        if (eTags.some(function (t) { return t[3] === 'root' || t[3] === 'reply'; })) return true;
        return eTags.some(function (t) { return !t[3]; });
    }

    /* Who the DIRECT PARENT of a reply is (NIP-10).
       - With markers: the one marked "reply" is the parent. If only "root" is
         present (and no "reply"), the reply hangs directly off the root.
       - With no markers at all (old style): a single "e" tag is the parent;
         with several, the LAST one is what was replied to.
       Returns null when there is no hint at all. */
    function replyParent(ev) {
        if (!ev || !Array.isArray(ev.tags)) return null;
        var eTags = ev.tags.filter(function (t) {
            return Array.isArray(t) && t[0] === 'e' && typeof t[1] === 'string' && t[1];
        });
        if (!eTags.length) return null;
        var marked = eTags.filter(function (t) { return t[3]; });
        if (marked.length) {
            var replies = marked.filter(function (t) { return t[3] === 'reply'; });
            if (replies.length) return replies[replies.length - 1][1];
            var root = marked.filter(function (t) { return t[3] === 'root'; });
            if (root.length) return root[root.length - 1][1];
            return null;                       // "mention" only: not a reply
        }
        return eTags[eTags.length - 1][1];
    }

    /* A LEVEL-ONE reply to a note: its direct parent is that note itself.
       Replies to replies (and beyond) are not included. */
    function isDirectReply(ev, rootId) {
        if (!rootId) return false;
        return replyParent(ev) === rootId;
    }

    // ------------------------------------------------------- machine notes
    /* Some kind 1 notes are not human writing but JSON messages from other
       software — "presence" heartbeats, telemetry, etc. Real examples from
       bos's relay (2026-10-11):
         {"type":"presence","payload":"online"}
         {"v":1,"online":true,"ts":1791657534}
         {"type":"PresenceHeartbeat","senderKey":"...","senderName":"test999",...}
       Notes like these flood the timeline and weigh the browser down, because
       their content is drawn as a long <pre> JSON block with no meaning for a
       reader. So pages do not show them at all.

       IMPORTANT: Gaspool SPORT activities are ALSO JSON and MUST keep showing
       (they have a dedicated card). So JSON carrying "sport"/"activity" is
       exempt from this rule.

       Requirements for a machine note:
         - kind 1
         - the whole content is one JSON object (not an array, not plain text)
         - not a sport activity
         - has >=2 keys, OR a machine marker tag

       Why just >=2 keys (instead of a list of key names): the next real
       samples used unexpected key names and still had to be filtered —
         {"id":"p179…","n":"Abolfazll","t":"","ts":1791659484990,"ty":"p"}
         {"proxies": [], "updated": 1791659463}
       Human writing whose entire content is one JSON object with >=2 keys
       practically does not exist; and even if it did, hiding it is far cheaper
       than rendering a long JSON block that makes the page heavy.
       A single-key object is left visible as a safety valve.
    */
    var MACHINE_TAGS = ['presence', 'type', 'telemetry', 'heartbeat', 'online'];

    function parsedJsonObject(ev) {
        if (!ev || ev.kind !== 1 || typeof ev.content !== 'string') return null;
        var s = ev.content.trim();
        if (s.charAt(0) !== '{' || s.charAt(s.length - 1) !== '}') return null;
        try {
            var o = JSON.parse(s);
            return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
        } catch (e) { return null; }
    }

    function isSportJson(obj) {
        return !!(obj && (obj.sport || obj.activity || obj.type === 'sport'));
    }

    function isMachineNote(ev) {
        var obj = parsedJsonObject(ev);
        if (!obj) return false;
        if (isSportJson(obj)) return false;
        if (Object.keys(obj).length >= 2) return true;      // a whole JSON object = machine
        if (Array.isArray(ev.tags)) {
            return ev.tags.some(function (t) {
                return Array.isArray(t) && typeof t[1] === 'string'
                    && (t[0] === 't' || t[0] === 'd')
                    && MACHINE_TAGS.indexOf(t[1].toLowerCase()) !== -1;
            });
        }
        return false;
    }

    /* A note with no content at all and no media — nothing can be shown, so do
       not draw it as an empty card. Real example from the relay: kind 20000
       with content "" and tags []. */
    function isEmptyNote(ev) {
        if (!ev) return true;
        if (ev.kind !== 1 && !(ev.kind >= 20000 && ev.kind < 30000)) return false;
        if (typeof ev.content !== 'string' || ev.content.trim() !== '') return false;
        if (Array.isArray(ev.tags)) {
            var hasMedia = ev.tags.some(function (t) {
                return Array.isArray(t) && (t[0] === 'imeta' || t[0] === 'r' || t[0] === 'e' || t[0] === 'q');
            });
            if (hasMedia) return false;
        }
        return true;
    }

    /* One door for "do not draw this note". Used by pages so the rule does not
       spread. */
    function shouldHideNote(ev) {
        return isMachineNote(ev) || isEmptyNote(ev);
    }

    // ---------------------------------------------------------------- NIP-18
    /* List of quoted notes. Tag shape:
         ["q", <event id>, <relay, optional>, <pubkey, optional>]
       Only 64-character hexadecimal ids are accepted, so a broken tag does not
       make the page ask the relay for a garbage id. */
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

    // -------------------------------------------------------- GitHub links
    /* Top-level github.com pages that are not repos. This list keeps
       github.com/settings/profile from being read as the repo "settings/profile". */
    var RESERVED_OWNERS = [
        'settings', 'explore', 'topics', 'collections', 'sponsors', 'marketplace',
        'notifications', 'pulls', 'issues', 'orgs', 'users', 'about', 'features',
        'enterprise', 'login', 'signup', 'new', 'search', 'trending', 'apps',
        'gist', 'dashboard', 'codespaces', 'account'
    ];

    /* Turn a GitHub link into {owner, repo, path, url}, or null if it is not a
       repo link. The host is checked strictly: github.com.evil.com does NOT
       pass. */
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

    /* The repo card. Its data comes from api.github.com, so only the fields
       actually used are kept; if one is empty, that part is not rendered. */
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

    /* 1200 -> "1.2k". Display only; the number is never rounded up, so it does
       not look more popular than it really is. */
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
        } catch (e) { /* full quota / private mode: just skip it */ }
    }

    /* Fetch repo data with caching. Always settles (resolves null on failure)
       so callers do not need to handle network errors.
       The cache key uses lowercase owner/repo, so one repo linked many times is
       requested once. */
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
            /* 403 = rate limit hit, 404 = private/missing repo.
               Neither is a page error; just do not show a card. */
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

    /* Turn GitHub links inside root into cards. The card is inserted AFTER the
       link (the original link stays) so that if the request fails, nothing
       changes. Each link is marked so it is not processed twice when the page
       redraws. */
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

    // -------------------------------------------------- NIP-19 / in-page links
    /* Previously each page replaced `nostr:nevent1…` with a link whose href was
       "nostr:…". In a browser such an href triggers a protocol handler — it
       looks like "opening an app" even though no app exists. Now NIP-19 ids
       are translated to Phosphor's own pages (thread.html / profile.html /
       notes.html), like Nostr apps generally do: a click = go to a page, not
       open a strange tab.

       This part of the file is small and pure, so it can be tested without a
       browser. */
    var B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    var B32MAP = {};
    for (var bi = 0; bi < B32.length; bi++) B32MAP[B32.charAt(bi)] = bi;
    var B32GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

    function bech32Polymod(values) {
        var chk = 1;
        for (var p = 0; p < values.length; p++) {
            var top = chk >> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ values[p];
            for (var i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= B32GEN[i];
        }
        return chk;
    }

    function bech32Verify(hrp, data) {
        var values = [];
        var i;
        for (i = 0; i < hrp.length; i++) values.push(hrp.charCodeAt(i) >> 5);
        values.push(0);
        for (i = 0; i < hrp.length; i++) values.push(hrp.charCodeAt(i) & 31);
        for (i = 0; i < data.length; i++) values.push(data[i]);
        return bech32Polymod(values) === 1;
    }

    function bech32Decode(str) {
        if (typeof str !== 'string' || str.length < 8) return null;
        var lower = str.toLowerCase();
        if (lower !== str && str.toUpperCase() !== str) return null;   // mixed case
        var pos = lower.lastIndexOf('1');
        if (pos < 1 || pos + 7 > lower.length) return null;
        var hrp = lower.slice(0, pos);
        var words = [];
        for (var i = pos + 1; i < lower.length; i++) {
            var v = B32MAP[lower.charAt(i)];
            if (v === undefined) return null;
            words.push(v);
        }
        if (!bech32Verify(hrp, words)) return null;
        return { hrp: hrp, words: words.slice(0, -6) };   // drop the 6 checksum words
    }

    function wordsToBytes(words) {
        var out = [], acc = 0, bits = 0;
        for (var i = 0; i < words.length; i++) {
            acc = (acc << 5) | words[i];
            bits += 5;
            if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
        }
        return out;
    }

    function bytesToHex(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
        return s;
    }

    function bytesToUtf8(bytes) {
        if (typeof TextDecoder === 'function') {
            try { return new TextDecoder().decode(new Uint8Array(bytes)); } catch (e) {}
        }
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return s;
    }

    function bytesToUint(bytes) {
        var n = 0;
        for (var i = 0; i < bytes.length; i++) n = (n * 256) + bytes[i];
        return n;
    }

    function parseTlv(bytes) {
        var out = [], i = 0;
        while (i + 2 <= bytes.length) {
            var t = bytes[i], l = bytes[i + 1];
            var v = bytes.slice(i + 2, i + 2 + l);
            if (v.length !== l) break;
            out.push({ type: t, value: v });
            i += 2 + l;
        }
        return out;
    }

    /* Translate a NIP-19 id into the parts we need. Returns null when it is not
       valid bech32 — the caller then leaves the text as it is. */
    function nip19Decode(id) {
        if (typeof id !== 'string') return null;
        var d = bech32Decode(id);
        if (!d) return null;
        var bytes = wordsToBytes(d.words);
        if (d.hrp === 'note') {
            return bytes.length === 32 ? { type: 'note', id: bytesToHex(bytes) } : null;
        }
        if (d.hrp === 'npub') {
            return bytes.length === 32 ? { type: 'npub', pubkey: bytesToHex(bytes) } : null;
        }
        if (d.hrp === 'nevent') {
            var r = { type: 'nevent', relays: [] };
            parseTlv(bytes).forEach(function (e) {
                if (e.type === 0 && e.value.length === 32) r.id = bytesToHex(e.value);
                else if (e.type === 1) r.relays.push(bytesToUtf8(e.value));
                else if (e.type === 2 && e.value.length === 32) r.author = bytesToHex(e.value);
                else if (e.type === 3) r.kind = bytesToUint(e.value);
            });
            return r.id ? r : null;
        }
        if (d.hrp === 'nprofile') {
            var p = { type: 'nprofile', relays: [] };
            parseTlv(bytes).forEach(function (e) {
                if (e.type === 0 && e.value.length === 32) p.pubkey = bytesToHex(e.value);
                else if (e.type === 1) p.relays.push(bytesToUtf8(e.value));
            });
            return p.pubkey ? p : null;
        }
        if (d.hrp === 'naddr') {
            var a = { type: 'naddr', relays: [] };
            parseTlv(bytes).forEach(function (e) {
                if (e.type === 0) a.identifier = bytesToUtf8(e.value);
                else if (e.type === 1) a.relays.push(bytesToUtf8(e.value));
                else if (e.type === 2 && e.value.length === 32) a.author = bytesToHex(e.value);
                else if (e.type === 3) a.kind = bytesToUint(e.value);
            });
            return a;
        }
        return { type: d.hrp };
    }

    /* The Phosphor page for an event. Long-form articles (kind 30023) have no
       thread page, so they go to notes.html with `d`. */
    function notePageUrl(ev) {
        if (!ev || !ev.id) return null;
        if (ev.kind === 30023) {
            var d = '';
            (ev.tags || []).forEach(function (t) { if (Array.isArray(t) && t[0] === 'd') d = t[1]; });
            return 'notes.html?d=' + encodeURIComponent(d) + '&author=' + encodeURIComponent(ev.pubkey || '');
        }
        return 'thread.html?id=' + encodeURIComponent(ev.id);
    }

    function nip19PageUrl(id) {
        var d = nip19Decode(id);
        if (!d) return null;
        if (d.type === 'note') return 'thread.html?id=' + d.id;
        if (d.type === 'nevent') {
            if (d.kind === 30023) return 'notes.html?d=&author=' + (d.author || '');
            return 'thread.html?id=' + d.id;
        }
        if (d.type === 'npub' || d.type === 'nprofile') return 'profile.html?pubkey=' + d.pubkey;
        if (d.type === 'naddr') {
            return 'notes.html?d=' + encodeURIComponent(d.identifier || '')
                + '&author=' + (d.author || '') + '&kind=' + (d.kind || '');
        }
        return null;
    }

    /* Replace every NIP-19 id inside note content (already escaped by the page)
       with an in-page link. One important exception: if the id points at a note
       that is CURRENTLY being drawn as a quote card, its link is dropped —
       otherwise the same note shows twice (once as a card, once as a
       [NOSTR: …] line). That is what confused bos. */
    function linkifyNostrUris(text, ev) {
        if (typeof text !== 'string') return text;
        var quoteIds = ev ? quoteTargets(ev).map(function (t) { return t.id; }) : [];
        var removed = 0;
        var out = text.replace(/(?:nostr:)?(n(?:pub|sec|ote|profile|event|addr|relay)1[a-z0-9]+)/gi, function (match, id) {
            var decoded = nip19Decode(id);
            if (decoded && decoded.id && quoteIds.indexOf(decoded.id) !== -1) { removed++; return ''; }
            var shortId = id.substring(0, 10) + '...' + id.substring(id.length - 4);
            var url = nip19PageUrl(id);
            if (url) {
                return '<a href="' + url + '" class="nostr-embed-link" onclick="event.stopPropagation()">[NOSTR: ' + shortId + ']</a>';
            }
            return '<a href="nostr:' + id + '" class="nostr-embed-link" target="_blank" rel="noopener" onclick="event.stopPropagation()">[NOSTR: ' + shortId + ']</a>';
        });
        // If an id was dropped as a duplicate, clean up the leftover empty line too.
        if (removed) out = out.replace(/\s+$/, '');
        return out;
    }

    // ------------------------------------------------------------- quotes
    /* A compact card for a quoted note. The classes author-<pubkey> and
       avatar-<pubkey> are used on purpose so the page's existing profile
       mechanism (updatePostUI) also fills in the name and avatar once the
       profile data arrives — with no second path to maintain. */
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

        /* The whole card is a link to the QUOTED note (not the quoting one) —
           like an X quote card. Since there are two different notes in one
           card, the link must use the quoted note's id. */
        var url = notePageUrl(ev);
        var tag = url ? 'a' : 'div';
        var open = url
            ? '<a class="t-quote-card" href="' + esc(url) + '" onclick="event.stopPropagation()">'
            : '<div class="t-quote-card">';

        return open
            + '<div class="t-quote-head">'
            + '<span class="avatar-' + esc(pk) + ' t-quote-avatar">' + (pk ? '[' + esc(pk.slice(0, 2).toUpperCase()) + ']' : '[?]') + '</span>'
            + '<span class="t-quote-authorbox">'
            + '<span class="author-' + esc(pk) + ' t-quote-author">' + esc(pk ? pk.slice(0, 8) : '?') + '</span>'
            + '<span class="handle-' + esc(pk) + ' t-quote-handle"></span>'
            + '</span>'
            + '</div>'
            + (body ? '<div class="t-quote-body">' + esc(body) + (truncated ? '\u2026' : '') + '</div>' : '')
            + (img ? '<div class="t-quote-media"><img src="' + esc(img) + '" alt="" loading="lazy"></div>' : '')
            + '</' + tag + '>';
    }

    /* The first image inside the note content, if any. Used only for the quote
       preview; the main media is still handled by the media assembler. */
    function firstImageUrl(ev) {
        if (!ev || typeof ev.content !== 'string') return null;
        var m = ev.content.match(/https?:\/\/[^\s<]+?\.(png|jpg|jpeg|gif|webp)(\?[^\s]*)?/i);
        return m ? m[0] : null;
    }

    /* Mount quote cards into `holder`. The page supplies how to fetch a note
       (`load`) and what to do afterwards (`onEvent`), so this logic lives once
       and works for both the timeline and the thread page.

       `get` is optional: if the quoted note is already in the page cache,
       there is no need to ask the relay at all. */
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
                if (!fetched) return;            // failure: leave it, no empty box
                if (appendQuoteCard(holder, fetched, onEvent) && typeof opts.after === 'function') {
                    opts.after(fetched);
                }
            });
        });
        return shown;
    }

    /* The quote-card holder inside a note card. If the page does not provide
       .t-quote-holder, the holder is created here — right before the action
       row, so its position is always the same on every page. That way a new
       page just calls decorateCard() without touching its template. */
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

    /* One call for all extras on a note card: quote cards (NIP-18) and GitHub
       link previews. Used by every page so none is left behind when the rules
       change. */
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
        /* The quote author's profile data may ALREADY be in the page cache
           before this card is created (e.g. the author is the same as the main
           note's, or the profile was fetched for another card). In that case
           the page will not call its UI filler again and this card's
           name/avatar stay empty — exactly bos's complaint. So after mounting
           the card we ask the page to apply it once more; if the data is not
           there yet, the function does nothing (safe). */
        applyPageProfile(ev.pubkey);
        return el;
    }

    /* Calling pages have an updatePostUI(pubkey) function that fills elements
       with the classes author-<pk> / handle-<pk> / avatar-<pk>. The name is the
       same on every page so one call here is enough — a new page just provides
       that function and does not change the module. */
    function applyPageProfile(pubkey) {
        if (!pubkey) return;
        var fn = global.updatePostUI;
        if (typeof fn === 'function') { try { fn(pubkey); } catch (e) {} }
    }

    // -------------------------------------------------------- helper relay
    /* Phosphor has its own socket for the timeline, but this module needs a way
       to fetch a single note by id (for quotes). A separate socket, opened
       briefly and then closed — it does not disturb the timeline socket. */
    var relayList = [];

    function setRelays(list) {
        relayList = Array.isArray(list) ? list.filter(function (r) { return typeof r === 'string'; }) : [];
    }

    /* extraRelays: additional relays for this note only. Important for quotes:
       the "q" tag usually names the origin relay of the quoted note, and that
       note is often NOT on our own relay. Without trying its origin relay, a
       quote from another relay looks empty. */
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

            /* If no relay could be opened at all, do not hang until the
               timeout expires. */
            if (!sockets.length) { global.clearTimeout(timer); finish(null); }
        });
    }

    // ----------------------------------------------------------------- utils
    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ---------------------------------------------------------------- styles
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
        /* The quote card is now an <a>: full block, inherits colour, and has a
           hover cue so it clearly looks clickable (going to the quoted note). */
        '.t-quote-card{display:block;border-left:3px solid var(--yt-border, var(--left-border, #2a2a2a));'
            + 'padding:8px 12px;margin-top:10px;background:rgba(255,255,255,0.02);'
            + 'text-decoration:none;color:inherit;cursor:pointer;transition:background 0.15s,border-color 0.15s;}',
        '.t-quote-card:hover{background:rgba(255,255,255,0.06);border-left-color:var(--t-green);}',
        '.t-quote-head{display:flex;align-items:center;gap:8px;font-size:0.85em;}',
        '.t-quote-avatar{font-size:0.9em;opacity:0.9;flex-shrink:0;}',
        '.t-quote-avatar img{width:20px;height:20px;border-radius:3px;object-fit:cover;display:block;}',
        '.t-quote-authorbox{display:flex;align-items:baseline;gap:6px;min-width:0;overflow:hidden;}',
        '.t-quote-author{font-weight:bold;}',
        '.t-quote-handle{font-size:0.92em;opacity:0.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
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
        isMachineNote: isMachineNote,
        isEmptyNote: isEmptyNote,
        shouldHideNote: shouldHideNote,
        replyParent: replyParent,
        isDirectReply: isDirectReply,
        quoteTargets: quoteTargets,
        nip19Decode: nip19Decode,
        nip19PageUrl: nip19PageUrl,
        notePageUrl: notePageUrl,
        linkifyNostrUris: linkifyNostrUris,
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
