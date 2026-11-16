/* NIP-27 / NIP-21: render `nostr:` references as real links.

   Before this module a mention written as nostr:npub1... or nostr:note1... was
   dead text in every page: no link, no name, nothing to click. NIP-27 says the
   `nostr:` prefix marks a reference, and NIP-21 defines the URI form.

   Rules kept deliberately narrow:
   - only `nostr:` prefixed values are recognised. Bare npub1... in prose is NOT
     linkified, because it would turn any stray bech32 string into a link.
   - nsec is REFUSED. A private key in content must never become a clickable
     thing, and must never be copied into a title or a dataset.
   - a value that fails its bech32 checksum is left as plain text. Half a link is
     worse than none.
   - text inside <a>, <code>, <pre>, <script>, <style> and <textarea> is skipped,
     so code samples stay readable and links are not nested.

   The parsing half is pure (no DOM) so it can be tested without a browser. */
(function (global) {
    'use strict';

    var CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    var GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

    function escapeHtml(str) {
        return String(str === undefined || str === null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function polymod(values) {
        var chk = 1;
        for (var i = 0; i < values.length; i++) {
            var top = chk >>> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ values[i];
            for (var j = 0; j < 5; j++) {
                if ((top >>> j) & 1) chk ^= GENERATOR[j];
            }
        }
        return chk >>> 0;
    }

    function hrpExpand(hrp) {
        var out = [], i;
        for (i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
        out.push(0);
        for (i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
        return out;
    }

    function convertBits(data, from, to, pad) {
        var acc = 0, bits = 0, out = [];
        var maxv = (1 << to) - 1;
        for (var i = 0; i < data.length; i++) {
            acc = (acc << from) | data[i];
            bits += from;
            while (bits >= to) {
                bits -= to;
                out.push((acc >>> bits) & maxv);
            }
        }
        if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
        return out;
    }

    function toHex(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) {
            s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        }
        return s;
    }

    function fromHex(hex) {
        var out = [];
        for (var i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
        return out;
    }

    /* Decode bech32 (not bech32m: Nostr uses the original constant of 1).
       Returns null for anything malformed rather than throwing, because this is
       fed straight from user content. Mixed case is rejected by the spec. */
    function bech32Decode(str) {
        if (typeof str !== 'string') return null;
        if (str.length < 8 || str.length > 2000) return null;
        if (str !== str.toLowerCase() && str !== str.toUpperCase()) return null;
        var lower = str.toLowerCase();
        var pos = lower.lastIndexOf('1');
        if (pos < 1 || pos + 7 > lower.length) return null;
        var hrp = lower.slice(0, pos);
        var data = [];
        for (var i = pos + 1; i < lower.length; i++) {
            var v = CHARSET.indexOf(lower.charAt(i));
            if (v === -1) return null;
            data.push(v);
        }
        if (polymod(hrpExpand(hrp).concat(data)) !== 1) return null;
        var payload = data.slice(0, data.length - 6);
        var bytes = convertBits(payload, 5, 8, false);
        return { hrp: hrp, bytes: bytes, hex: toHex(bytes) };
    }

    function parseTLV(bytes) {
        var out = [], i = 0;
        while (i < bytes.length) {
            if (i + 2 > bytes.length) return null;
            var type = bytes[i];
            var len = bytes[i + 1];
            if (i + 2 + len > bytes.length) return null;
            out.push({ type: type, value: bytes.slice(i + 2, i + 2 + len) });
            i += 2 + len;
        }
        return out;
    }

    function utf8FromBytes(bytes) {
        try {
            return decodeURIComponent(bytes.map(function (b) {
                return '%' + (b < 16 ? '0' : '') + b.toString(16);
            }).join(''));
        } catch (e) {
            return null;
        }
    }

    function readTLV(bytes) {
        var items = parseTLV(bytes);
        if (!items) return null;
        var out = { relays: [], pubkey: null, id: null, identifier: null, kind: null };
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.type === 0) {
                /* Type 0 is the payload: a pubkey/id for nprofile/nevent, and a
                   UTF-8 identifier for naddr. */
                if (it.value.length === 32) out.pubkeyOrId = toHex(it.value);
                else out.identifier = utf8FromBytes(it.value);
            } else if (it.type === 1) {
                var r = utf8FromBytes(it.value);
                if (r) out.relays.push(r);
            } else if (it.type === 2 && it.value.length === 32) {
                out.pubkey = toHex(it.value);
            } else if (it.type === 3 && it.value.length === 4) {
                out.kind = ((it.value[0] << 24) >>> 0) + (it.value[1] << 16) + (it.value[2] << 8) + it.value[3];
            }
        }
        return out;
    }

    /* A parsed reference, or null. `raw` keeps the exact text that was matched so
       a caller can leave it untouched. */
    function parseRef(uri) {
        if (typeof uri !== 'string') return null;
        var m = /^nostr:([a-zA-Z0-9]+)$/.exec(uri.trim());
        if (!m) return null;
        var value = m[1];
        var dec = bech32Decode(value);
        if (!dec) return null;
        var hrp = dec.hrp;

        /* Never, ever turn a private key into something clickable. */
        if (hrp === 'nsec') return null;

        if (hrp === 'npub') {
            if (dec.bytes.length !== 32) return null;
            return { type: 'profile', pubkey: dec.hex, relays: [], raw: uri };
        }
        if (hrp === 'note') {
            if (dec.bytes.length !== 32) return null;
            return { type: 'note', id: dec.hex, relays: [], raw: uri };
        }
        if (hrp === 'nprofile') {
            var p = readTLV(dec.bytes);
            if (!p || !p.pubkeyOrId) return null;
            return { type: 'profile', pubkey: p.pubkeyOrId, relays: p.relays, raw: uri };
        }
        if (hrp === 'nevent') {
            var e = readTLV(dec.bytes);
            if (!e || !e.pubkeyOrId) return null;
            return { type: 'note', id: e.pubkeyOrId, author: e.pubkey, kind: e.kind, relays: e.relays, raw: uri };
        }
        if (hrp === 'naddr') {
            var a = readTLV(dec.bytes);
            if (!a || !a.pubkey || a.identifier === null || a.identifier === undefined) return null;
            return { type: 'article', identifier: a.identifier, pubkey: a.pubkey, kind: a.kind, relays: a.relays, raw: uri };
        }
        return null;
    }

    /* Split free text into plain segments and references.
       Pure: no DOM, so the rules can be tested directly. */
    function splitText(text, opts) {
        var src = typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text);
        var includeBare = !!(opts && opts.includeBare);
        var re = includeBare
            ? /nostr:[a-zA-Z0-9]+|\b(?:npub|note|nprofile|nevent|naddr)1[0-9a-z]+/g
            : /nostr:[a-zA-Z0-9]+/g;
        var out = [];
        var last = 0;
        var m;
        while ((m = re.exec(src)) !== null) {
            var raw = m[0];
            var probe = raw.indexOf('nostr:') === 0 ? raw : 'nostr:' + raw;
            var ref = parseRef(probe);
            if (!ref) continue;                 // leave invalid bech32 as plain text
            if (m.index > last) out.push({ text: src.slice(last, m.index) });
            out.push({ ref: ref, raw: raw });
            last = m.index + raw.length;
        }
        if (last < src.length) out.push({ text: src.slice(last) });
        return out;
    }

    function shortLabel(ref) {
        if (ref.type === 'profile') return '@' + ref.pubkey.substring(0, 8);
        if (ref.type === 'note') return 'note ' + String(ref.id).substring(0, 8);
        return (ref.kind === 30023 ? 'article ' : 'naddr ') + String(ref.identifier).substring(0, 16);
    }

    function hrefFor(ref) {
        if (ref.type === 'profile') return 'profile.html?pubkey=' + encodeURIComponent(ref.pubkey);
        if (ref.type === 'note') return 'thread.html?id=' + encodeURIComponent(ref.id);
        return 'notes.html?kind=' + encodeURIComponent(String(ref.kind || 30023))
            + '&d=' + encodeURIComponent(ref.identifier)
            + '&author=' + encodeURIComponent(ref.pubkey);
    }

    function linkHtml(ref, className) {
        var cls = className || 'nostr-ref';
        return '<a href="' + escapeHtml(hrefFor(ref)) + '" class="' + cls + '" data-nostr-ref="'
            + escapeHtml(ref.raw) + '">' + escapeHtml(shortLabel(ref)) + '</a>';
    }

    var SKIP = { A: 1, CODE: 1, PRE: 1, SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1 };

    /* Linkify the text nodes of a rendered container. Idempotent: a second call
       finds nothing to do because the references are inside <a> already. */
    function upgrade(rootEl, opts) {
        if (!rootEl || !rootEl.ownerDocument) return 0;
        var doc = rootEl.ownerDocument;
        var walker = doc.createTreeWalker(rootEl, 4 /* NodeFilter.SHOW_TEXT */, null);
        var nodes = [];
        var n;
        while ((n = walker.nextNode())) nodes.push(n);

        var changed = 0;
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var parent = node.parentNode;
            if (!parent) continue;
            if (SKIP[String(parent.nodeName).toUpperCase()]) continue;
            if (parent.closest && parent.closest('[data-nostr27="off"]')) continue;
            var parts = splitText(node.nodeValue, opts);
            var hasRef = false;
            for (var k = 0; k < parts.length; k++) if (parts[k].ref) { hasRef = true; break; }
            if (!hasRef) continue;

            var frag = doc.createDocumentFragment();
            for (var j = 0; j < parts.length; j++) {
                if (parts[j].ref) {
                    var a = doc.createElement('a');
                    a.href = hrefFor(parts[j].ref);
                    a.className = 'nostr-ref';
                    a.setAttribute('data-nostr-ref', parts[j].ref.raw);
                    a.textContent = shortLabel(parts[j].ref);
                    frag.appendChild(a);
                } else {
                    frag.appendChild(doc.createTextNode(parts[j].text));
                }
            }
            parent.replaceChild(frag, node);
            changed++;
        }
        return changed;
    }

    var api = {
        bech32Decode: bech32Decode,
        parseRef: parseRef,
        splitText: splitText,
        shortLabel: shortLabel,
        hrefFor: hrefFor,
        linkHtml: linkHtml,
        upgrade: upgrade,
        escapeHtml: escapeHtml,
        fromHex: fromHex,
        toHex: toHex
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrNip27 = api;
})(typeof window !== 'undefined' ? window : globalThis);
