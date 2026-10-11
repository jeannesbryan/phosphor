/* ==========================================================================
   nostr-nip05.js — NIP-05 identity verification, written ONCE.

   Why this file exists (2026-10-11)
   ---------------------------------
   Every page printed "handle ✓ domain" the moment a profile merely CONTAINED a
   nip05 field. Nothing was ever fetched, so the check mark was a pure claim:
   anyone could put someone else's handle in their kind 0 and Phosphor would
   show it as verified. That is a lie told to the reader, not a missing feature.

   Now the check mark appears only after
       https://<domain>/.well-known/nostr.json?name=<local>
   has been fetched and its `names[<local>]` really equals the author's pubkey.

   How a page uses it
   ------------------
     <script src="/assets/nostr-nip05.js"></script>       (in <head>)
     window.NostrNip05.applyTo(element, info.nip05, pubkey);

   `applyTo` takes over the element that shows the handle:
     - valid        -> "@local ✓ <a>domain</a>"  (check mark + green link)
     - invalid      -> "@local domain"           (no check mark, title explains)
     - error/none   -> "@local domain"           (no check mark)
   Without the module (it failed to load) the page simply keeps its own plain
   "@local domain" text — no check mark is ever invented.

   Failure != lie: a network error, a 404, a timed-out request or a malformed
   answer all mean "not proven", and "not proven" is displayed as such.

   Safety
   ------
   - https only; the domain must look like a hostname (no path, no port, no
     credentials, no IP literal).
   - The only thing that can make the check mark appear is an exact hex pubkey
     match, and only for the local part this identifier actually claims.
   - The local part and the domain are escaped before they reach the DOM.
   - Results are cached (memory + localStorage, 6 h) and in-flight requests are
     de-duplicated, so a page full of one author does not hammer their server.
   ========================================================================== */
(function (root, factory) {
    var api = factory(root);
    root.NostrNip05 = api;
    // so it can be tested without a browser: node tests/nostr-nip05.test.mjs
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    var CACHE_KEY = 'phosphor_nip05_cache_v1';
    var CACHE_TTL_MS = 6 * 60 * 60 * 1000;
    var TIMEOUT_MS = 6000;
    /* A hostname: labels of [a-z0-9-], separated by dots, at least one dot, no
       leading/trailing dash, no slash/colon/@ (so no port, path or credentials). */
    var DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
    var LOCAL_RE = /^[a-z0-9._-]{1,64}$/;
    var HEX64_RE = /^[0-9a-f]{64}$/;

    var state = {
        results: {},     // "local@domain|pubkey" -> 'valid' | 'invalid'
        inflight: {},    // "local@domain|pubkey" -> Promise
        fetchImpl: null  // injected in tests
    };

    function cacheId(local, domain, pubkey) {
        return local + '@' + domain + '|' + pubkey;
    }

    /* Parse a NIP-05 identifier into { local, domain } or null when it is not
       usable. A bare domain means the local part is "_" (NIP-05). */
    function parse(identifier) {
        if (typeof identifier !== 'string') return null;
        var raw = identifier.trim().toLowerCase();
        if (!raw || raw.length > 200) return null;
        if (raw.indexOf('/') !== -1 || raw.indexOf(':') !== -1 || /\s/.test(raw)) return null;

        var at = raw.indexOf('@');
        var local, domain;
        if (at === -1) { local = '_'; domain = raw; }
        else { local = raw.slice(0, at); domain = raw.slice(at + 1); }

        if (!domain || !DOMAIN_RE.test(domain)) return null;
        if (!LOCAL_RE.test(local)) return null;
        /* Reject IP literals: the top-level label of a real hostname is never
           all digits (this also covers IPv4 such as 192.168.1.1). */
        if (/^\d+$/.test(domain.split('.').pop())) return null;
        return { local: local, domain: domain };
    }

    /* The well-known URL for an identifier, or null. */
    function wellKnownUrl(identifier) {
        var p = parse(identifier);
        if (!p) return null;
        return 'https://' + p.domain + '/.well-known/nostr.json?name=' + encodeURIComponent(p.local);
    }

    /* The handle text as it should read WITHOUT any check mark. */
    function plainHandle(identifier) {
        var p = parse(identifier);
        if (!p) return null;
        return p.local === '_' ? p.domain : '@' + p.local + ' ' + p.domain;
    }

    function readCache(local, domain, pubkey) {
        var id = cacheId(local, domain, pubkey);
        var v = state.results[id];
        if (v) return v;
        try {
            if (!root.localStorage) return null;
            var all = JSON.parse(root.localStorage.getItem(CACHE_KEY) || '{}');
            var row = all[id];
            if (!row || (Date.now() - (row.t || 0)) > CACHE_TTL_MS) return null;
            state.results[id] = row.s;
            return row.s;
        } catch (e) { return null; }
    }

    function writeCache(local, domain, pubkey, status) {
        var id = cacheId(local, domain, pubkey);
        state.results[id] = status;
        try {
            if (!root.localStorage) return;
            var all = JSON.parse(root.localStorage.getItem(CACHE_KEY) || '{}');
            all[id] = { s: status, t: Date.now() };
            root.localStorage.setItem(CACHE_KEY, JSON.stringify(all));
        } catch (e) { /* full quota / private mode: memory cache is enough */ }
    }

    /* Verify an identifier against a pubkey.
       Resolves to 'valid' | 'invalid' | 'error' | 'none'. It never rejects and
       never throws: "could not prove" is a result, not an exception. */
    function verify(identifier, pubkey) {
        var p = parse(identifier);
        var pk = typeof pubkey === 'string' ? pubkey.trim().toLowerCase() : '';
        if (!p || !HEX64_RE.test(pk)) return Promise.resolve('none');

        var cached = readCache(p.local, p.domain, pk);
        if (cached) return Promise.resolve(cached);

        var id = cacheId(p.local, p.domain, pk);
        if (state.inflight[id]) return state.inflight[id];

        var doFetch = state.fetchImpl || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
        if (!doFetch) return Promise.resolve('none');

        var url = wellKnownUrl(identifier);
        var timer = null, aborter = null;
        var opts = { headers: { 'Accept': 'application/json' } };
        try {
            if (typeof root.AbortController === 'function') {
                aborter = new root.AbortController();
                opts.signal = aborter.signal;
                timer = setTimeout(function () { try { aborter.abort(); } catch (e) {} }, TIMEOUT_MS);
            }
        } catch (e) { aborter = null; }

        var p2 = doFetch(url, opts).then(function (res) {
            if (!res || res.status !== 200) return 'invalid';
            return res.json().then(function (data) {
                var names = data && data.names;
                if (!names || typeof names !== 'object') return 'invalid';
                var claimed = names[p.local];
                if (typeof claimed !== 'string') return 'invalid';
                return claimed.trim().toLowerCase() === pk ? 'valid' : 'invalid';
            });
        }).catch(function () {
            /* Aborted (timeout) also lands here -> not proven. */
            return 'error';
        }).then(function (status) {
            if (timer) clearTimeout(timer);
            delete state.inflight[id];
            if (status === 'valid' || status === 'invalid') writeCache(p.local, p.domain, pk, status);
            return status;
        });

        state.inflight[id] = p2;
        return p2;
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /* Take over an element that shows a handle. `identifier` is the nip05 field
       from kind 0 (may be empty); `pubkey` is the author. Returns a Promise that
       resolves to the status, mainly so tests can await it. */
    function applyTo(el, identifier, pubkey) {
        if (!el) return Promise.resolve('none');
        var p = parse(identifier);
        if (!p) return Promise.resolve('none');

        var plain = plainHandle(identifier);
        // Show the honest version immediately (no check mark yet), then upgrade
        // it if — and only if — the domain really vouches for this pubkey.
        el.textContent = plain;
        el.removeAttribute('title');

        return verify(identifier, pubkey).then(function (status) {
            if (status === 'valid') {
                var doc = el.ownerDocument;
                var link = doc.createElement('a');
                link.href = 'relay.html?domain=' + encodeURIComponent(p.domain);
                link.className = 'text-success';
                link.style.textDecoration = 'none';
                link.textContent = p.domain;
                /* For _@domain the domain IS the handle, so do not print it twice:
                   "fiatjaf.com ✓" instead of "fiatjaf.com ✓ fiatjaf.com". */
                el.textContent = p.local === '_' ? '' : '@' + p.local + ' ';
                el.appendChild(link);
                el.appendChild(doc.createTextNode(' \u2713'));
                el.title = 'NIP-05 verified: ' + p.local + '@' + p.domain;
            } else {
                el.textContent = plain;
                el.title = status === 'error'
                    ? 'NIP-05 could not be verified (network error)'
                    : 'NIP-05 not verified (does not match this pubkey)';
            }
            return status;
        });
    }

    /* Tests: clear memory cache and the injected fetch. */
    function reset() {
        state.results = {};
        state.inflight = {};
        state.fetchImpl = null;
    }
    function setFetch(fn) { state.fetchImpl = fn; }

    return {
        parse: parse,
        wellKnownUrl: wellKnownUrl,
        plainHandle: plainHandle,
        verify: verify,
        applyTo: applyTo,
        escapeHtml: escapeHtml,
        reset: reset,
        setFetch: setFetch,
        CACHE_KEY: CACHE_KEY,
        CACHE_TTL_MS: CACHE_TTL_MS
    };
}));
