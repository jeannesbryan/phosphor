/* ==========================================================================
   nostr-relay-info.js — NIP-11 Relay Information Document, written ONCE.

   What it does (2026-10-11)
   -------------------------
   relay.html already probes a host for an open WebSocket and then streams its
   events, but it knows nothing about the relay itself: who runs it, which NIPs
   it speaks, whether it requires auth or payment, and what its limits are.
   NIP-11 defines exactly that: fetch the same URL over HTTP(S) with
       Accept: application/nostr+json
   and the server answers with a JSON document.

   How to use it in a page
   -----------------------
     <script src="/assets/nostr-relay-info.js"></script>   (in <head>)
     window.NostrRelayInfo.load(targetWsUrl, panelElement);

   `load` fetches the document, renders the parts that exist, and returns the
   info object (or null). If it fails — no CORS, a dead host, a timeout, or a
   server that does not answer NIP-11 at all — the panel keeps a short, honest
   message instead of an empty box.

   ⚠️ SECURITY: the document is written by a THIRD PARTY (whoever runs the
   relay) and is not trustworthy. Every string from it is escaped before it
   reaches the DOM. Do not paste a field into innerHTML raw.

   Failure != a broken page: when the info cannot be read, the explorer still
   works exactly as before — this panel is only an addition.
   ========================================================================== */
(function (root, factory) {
    var api = factory(root);
    root.NostrRelayInfo = api;
    // so it can be tested without a browser: node tests/nostr-relay-info.test.mjs
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    var TIMEOUT_MS = 6000;

    /* Turn a WebSocket URL into the HTTP(S) URL NIP-11 is served from.
       wss:// -> https://, ws:// -> http://; host, port and path are kept
       (NIP-11 says to ask the same URL). Returns null for anything else. */
    function infoUrl(wsUrl) {
        if (typeof wsUrl !== 'string') return null;
        var url = wsUrl.trim();
        if (!url) return null;
        if (/^wss:\/\//i.test(url)) return 'https://' + url.slice(6);
        if (/^ws:\/\//i.test(url)) return 'http://' + url.slice(5);
        if (/^https:\/\//i.test(url) || /^http:\/\//i.test(url)) return url;
        return null;
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function asArray(v) {
        return Array.isArray(v) ? v : [];
    }

    /* Keep only what we display, and only in the shape we expect. Anything
       unexpected (a string where a number belongs, a huge list, a nested
       object) is dropped rather than trusted — the document is not ours. */
    function summarize(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

        function str(v, max) {
            if (typeof v !== 'string') return '';
            var s = v.trim();
            return s.length > (max || 400) ? s.slice(0, max || 400) + '\u2026' : s;
        }
        function num(v) {
            return (typeof v === 'number' && isFinite(v)) ? v : null;
        }

        var lim = (raw.limitation && typeof raw.limitation === 'object' && !Array.isArray(raw.limitation))
            ? raw.limitation : {};

        /* Only NIP numbers make sense as tags here; drop anything odd so a
           hostile document cannot inject markup through this list. */
        var nips = asArray(raw.supported_nips)
            .filter(function (n) { return Number.isInteger(n) && n > 0 && n < 10000; })
            .slice(0, 200);

        return {
            name: str(raw.name, 120),
            description: str(raw.description, 800),
            banner: str(raw.banner, 400),
            icon: str(raw.icon, 400),
            pubkey: str(raw.pubkey, 64),
            contact: str(raw.contact, 160),
            software: str(raw.software, 80),
            version: str(raw.version, 60),
            postingPolicy: str(raw.posting_policy, 400),
            paymentsUrl: str(raw.payments_url, 400),
            nips: nips,
            limitation: {
                authRequired: lim.auth_required === true,
                paymentRequired: lim.payment_required === true,
                restrictedWrites: lim.restricted_writes === true,
                maxMessageLength: num(lim.max_message_length),
                maxSubscriptions: num(lim.max_subscriptions),
                maxFilters: num(lim.max_filters),
                maxLimit: num(lim.max_limit),
                maxEventTags: num(lim.max_event_tags),
                maxContentLength: num(lim.max_content_length),
                minPowDifficulty: num(lim.min_pow_difficulty)
            }
        };
    }

    /* Render the summary as HTML. Returns '' when there is nothing to show. */
    function renderHtml(sum, host) {
        if (!sum) return '';
        var out = [];

        var title = sum.name || host || 'relay';
        out.push('<div class="t-card-header">&gt; RELAY_INFO <span class="text-muted fs-small">(NIP-11)</span></div>');
        out.push('<div class="font-bold text-success" style="word-break:break-word;">' + escapeHtml(title) + '</div>');

        if (sum.description) {
            out.push('<p class="fs-small opacity-75 mt-2 mb-2" style="white-space:pre-wrap; word-break:break-word;">'
                + escapeHtml(sum.description) + '</p>');
        }

        var meta = [];
        if (sum.software) meta.push(escapeHtml(sum.software) + (sum.version ? ' ' + escapeHtml(sum.version) : ''));
        if (sum.contact) meta.push('contact: ' + escapeHtml(sum.contact));
        if (sum.pubkey) meta.push('pubkey: ' + '<a href="profile.html?pubkey=' + encodeURIComponent(sum.pubkey) + '" class="text-success" style="text-decoration:none;">' + escapeHtml(sum.pubkey.substring(0, 12)) + '…</a>');
        if (meta.length) {
            out.push('<div class="fs-small opacity-75 mt-1">' + meta.join(' &middot; ') + '</div>');
        }

        /* Warnings the visitor actually cares about, shown as badges. */
        var badges = [];
        if (sum.limitation.authRequired) badges.push('<span class="text-warning">[AUTH REQUIRED]</span>');
        if (sum.limitation.paymentRequired) badges.push('<span class="text-warning">[PAYMENT REQUIRED]</span>');
        if (sum.limitation.restrictedWrites) badges.push('<span class="text-muted">[READ-ONLY FOR YOU]</span>');
        if (badges.length) out.push('<div class="fs-small mt-2">' + badges.join(' ') + '</div>');

        /* Each part is plain text (numbers plus fixed words), so escaping once
           at the end is enough — the separator is added after escaping. */
        var lim = [];
        if (sum.limitation.maxMessageLength != null) lim.push('max message ' + sum.limitation.maxMessageLength + ' B');
        if (sum.limitation.maxContentLength != null) lim.push('max content ' + sum.limitation.maxContentLength + ' B');
        if (sum.limitation.maxSubscriptions != null) lim.push('max subs ' + sum.limitation.maxSubscriptions);
        if (sum.limitation.maxFilters != null) lim.push('max filters ' + sum.limitation.maxFilters);
        if (sum.limitation.maxLimit != null) lim.push('max limit ' + sum.limitation.maxLimit);
        if (sum.limitation.maxEventTags != null) lim.push('max tags ' + sum.limitation.maxEventTags);
        if (sum.limitation.minPowDifficulty != null) lim.push('min PoW ' + sum.limitation.minPowDifficulty);
        if (lim.length) {
            var limHtml = lim.map(escapeHtml).join(' &middot; ');
            out.push('<div class="fs-small opacity-75 mt-2">limits: ' + limHtml + '</div>');
        }

        if (sum.nips.length) {
            var tags = sum.nips.map(function (n) {
                return '<a href="https://github.com/nostr-protocol/nips/blob/master/' + (n < 10 ? '0' + n : n) + '.md" target="_blank" rel="noopener noreferrer" class="text-success fs-small" style="text-decoration:none;">NIP-' + n + '</a>';
            });
            out.push('<div class="fs-small mt-2" style="line-height:1.7;">supports: ' + tags.join(' ') + '</div>');
        } else {
            out.push('<div class="fs-small opacity-75 mt-2">supports: (relay did not list its NIPs)</div>');
        }

        if (sum.postingPolicy) {
            out.push('<div class="fs-small mt-2 opacity-75">policy: ' + escapeHtml(sum.postingPolicy) + '</div>');
        }

        return out.join('');
    }

    /* Fetch and summarize. Never rejects; resolves to the summary or null. */
    function fetchInfo(wsUrl, fetchImpl) {
        var url = infoUrl(wsUrl);
        if (!url) return Promise.resolve(null);

        var doFetch = fetchImpl || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
        if (!doFetch) return Promise.resolve(null);

        var timer = null, aborter = null;
        var opts = { headers: { 'Accept': 'application/nostr+json' } };
        try {
            if (typeof root.AbortController === 'function') {
                aborter = new root.AbortController();
                opts.signal = aborter.signal;
                timer = setTimeout(function () { try { aborter.abort(); } catch (e) {} }, TIMEOUT_MS);
            }
        } catch (e) { aborter = null; }

        return doFetch(url, opts).then(function (res) {
            /* Some relays answer 200 with an empty body, or 404 for unknown
               paths. Anything that is not a 2xx is "no document". */
            if (!res || res.status < 200 || res.status >= 300) return null;
            return res.json().then(function (data) {
                var sum = summarize(data);
                if (sum) sum.url = url;
                return sum;
            });
        }).catch(function () {
            return null;   // no CORS / timeout / bad JSON -> simply no document
        }).then(function (out) {
            if (timer) clearTimeout(timer);
            return out;
        });
    }

    /* Load into a panel element. `host` is the relay host, used when the
       document carries no name. Returns the summary (or null). */
    function load(wsUrl, panel, opts) {
        if (!panel) return Promise.resolve(null);
        opts = opts || {};
        var host = '';
        try { host = new URL(infoUrl(wsUrl) || '').host; } catch (e) { host = ''; }

        panel.innerHTML = '<div class="t-card-header">&gt; RELAY_INFO <span class="text-muted fs-small">(NIP-11)</span></div>'
            + '<div class="fs-small opacity-75">Fetching relay information document…</div>';

        return fetchInfo(wsUrl, opts.fetchImpl).then(function (sum) {
            if (!sum) {
                panel.innerHTML = '<div class="t-card-header">&gt; RELAY_INFO <span class="text-muted fs-small">(NIP-11)</span></div>'
                    + '<div class="fs-small opacity-75">This relay did not answer with a NIP-11 information document'
                    + (opts.reason ? ' (' + escapeHtml(opts.reason) + ')' : '')
                    + '. The explorer below still works normally.</div>';
                return null;
            }
            panel.innerHTML = renderHtml(sum, host);
            return sum;
        });
    }

    return {
        infoUrl: infoUrl,
        escapeHtml: escapeHtml,
        summarize: summarize,
        renderHtml: renderHtml,
        fetchInfo: fetchInfo,
        load: load,
        TIMEOUT_MS: TIMEOUT_MS
    };
}));
