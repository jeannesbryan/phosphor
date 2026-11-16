/* Profile lookup that actually finishes, plus one definition of how a profile
   is shown.

   Two separate faults were measured on 2026-11-16, both making a real person
   appear as "Node_3B4A" instead of their name:

   1. The request was sent ONCE, only to sockets that happened to be OPEN at
      that instant. Measured on the live page: `prof-lookup-b6f2d38b` went out
      to strfry and damus only, while relay.primal.net (which does hold that
      profile) had not opened yet. Nothing retried it, and the page marked the
      pubkey "pending" forever, so the card kept the placeholder for the whole
      session. Same pubkey showed its name on one load and Node_XXXX on another,
      which is the signature of a race rather than missing data.
   2. Only the four timeline relays were asked. Probing nine relays for five
      pubkeys showed purpose-built profile indexes hold profiles the timeline
      relays do not: relay.nostr.net held all five, purplepag.es two, nostr.mom
      three.

   This module keeps the rules in one place so every page can stop copying them.
   It never blocks rendering and never invents a name: if a profile cannot be
   found, the honest fallback stays.
*/
(function (global) {
    'use strict';

    function escapeHtml(str) {
        return String(str === undefined || str === null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function fallbackName(pubkey) {
        return 'Node_' + String(pubkey || '').substring(0, 4).toUpperCase();
    }

    function fallbackHandle(pubkey) {
        return '@' + String(pubkey || '').substring(0, 8);
    }

    function fallbackProfile(pubkey) {
        return {
            name: fallbackName(pubkey),
            handleLine: escapeHtml(fallbackHandle(pubkey)),
            handle: fallbackHandle(pubkey),
            nip05: '',
            picture: null,
            resolved: false
        };
    }

    /* What a profile looks like on screen, defined once.

       The handle follows the page's existing convention: prefer the NIP-05 local
       part (so a name cannot be squatted by editing `name`), lowercase it, and
       show the domain next to it. handleLine goes into innerHTML on the pages,
       so it is escaped here; `name` is set via textContent and stays raw. */
    function makeProfile(meta, pubkey) {
        meta = meta || {};
        var nip05 = typeof meta.nip05 === 'string' ? meta.nip05 : '';
        var local = '', domain = '';
        if (nip05.indexOf('@') !== -1) {
            var parts = nip05.split('@');
            local = parts[0];
            domain = parts.slice(1).join('@');
        }
        var rawName = meta.name || meta.display_name || String(pubkey || '').substring(0, 8);
        var handle = local
            ? '@' + String(local).toLowerCase()
            : '@' + String(rawName).toLowerCase().replace(/\s+/g, '');
        var handleLine = domain ? escapeHtml(handle) + ' ' + escapeHtml(domain) : escapeHtml(handle);
        return {
            name: meta.display_name || meta.name || String(pubkey || '').substring(0, 6),
            handleLine: handleLine,
            handle: handle,
            nip05: nip05,
            picture: meta.picture || null,
            resolved: true
        };
    }

    /* A resolver that retries instead of firing once.

       Injected so the retry logic can be tested without a network or a browser:
       - getSockets()      returns the sockets to send on (main plus any profile ones)
       - openProfileRelays()  called once, on the deeper attempt, so the page can
                              lazily connect to profile indexes only when a lookup
                              actually fails. Keeps the normal load at 4 sockets.
       - onResolve(pubkey, profile)  handed the parsed profile
       - schedule/cancel   defaults to setTimeout/clearTimeout
       - retryPlan         ms delays after the first attempt
    */
    function createResolver(opts) {
        opts = opts || {};
        var getSockets = opts.getSockets || function () { return []; };
        var openProfileRelays = opts.openProfileRelays || null;
        var onResolve = opts.onResolve || function () {};
        var onGiveUp = opts.onGiveUp || function () {};
        var schedule = opts.schedule || function (fn, ms) { return setTimeout(fn, ms); };
        var cancel = opts.cancel || function (h) { if (h) clearTimeout(h); };
        var retryPlan = opts.retryPlan || [1200, 3000];
        var deepAttempt = opts.deepAttempt === undefined ? 2 : opts.deepAttempt;

        var state = {};       // pubkey -> { attempt, timers, done, deepAsked }
        var sends = 0;

        function openSockets() {
            var socks = getSockets() || [];
            var out = [];
            for (var i = 0; i < socks.length; i++) {
                var s = socks[i];
                if (s && s.readyState === 1) out.push(s);   // WebSocket.OPEN
            }
            return out;
        }

        function reqFor(pubkey) {
            return JSON.stringify(['REQ', 'prof-lookup-' + String(pubkey).substring(0, 8),
                { kinds: [0], authors: [pubkey], limit: 1 }]);
        }

        function sendNow(pubkey) {
            var socks = openSockets();
            if (!socks.length) return 0;
            var req = reqFor(pubkey);
            for (var i = 0; i < socks.length; i++) {
                try { socks[i].send(req); sends++; } catch (e) { /* one dead socket must not stop the rest */ }
            }
            return socks.length;
        }

        function finish(pubkey) {
            var st = state[pubkey];
            if (!st) return;
            st.done = true;
            for (var i = 0; i < st.timers.length; i++) cancel(st.timers[i]);
            st.timers = [];
        }

        function attempt(pubkey) {
            var st = state[pubkey];
            if (!st || st.done) return;
            st.attempt++;
            sendNow(pubkey);
            /* Profile indexes are connected only from the SECOND attempt (the
               default). The usual case resolves on the first, so a normal page
               load keeps its original four sockets instead of opening extra ones
               for every visitor. */
            if (st.attempt === deepAttempt && typeof openProfileRelays === 'function' && !st.deepAsked) {
                st.deepAsked = true;
                try { openProfileRelays(); } catch (e) {}
                /* The new sockets open asynchronously; flush() is called by the
                   page from onopen, which is where these pending requests land. */
            }
            if (st.attempt > retryPlan.length) {
                st.gaveUp = true;
                finish(pubkey);
                onGiveUp(pubkey);
            }
        }

        function lookup(pubkey) {
            if (!pubkey) return false;
            if (state[pubkey] && (state[pubkey].done || state[pubkey].gaveUp)) return false;
            if (state[pubkey]) return false;   // already in flight, never start twice
            var st = { attempt: 0, timers: [], done: false, deepAsked: false, gaveUp: false };
            state[pubkey] = st;
            attempt(pubkey);
            for (var i = 0; i < retryPlan.length; i++) {
                (function (delay, pk) {
                    st.timers.push(schedule(function () { attempt(pk); }, delay));
                })(retryPlan[i], pubkey);
            }
            return true;
        }

        /* Called by the page when any socket opens: requests made before that
           socket existed are sent to it now. This is the fix for fault 1. */
        function flush() {
            var n = 0;
            for (var pk in state) {
                if (!state[pk].done && !state[pk].gaveUp) { n += sendNow(pk); }
            }
            return n;
        }

        /* Feed every incoming event here. Returns true when the event resolved a
           profile we were waiting for. Anything malformed is ignored, never
           thrown: a bad kind 0 from one relay must not break the page. */
        function absorb(ev) {
            if (!ev || ev.kind !== 0 || !ev.pubkey) return false;
            var meta;
            try { meta = JSON.parse(ev.content); } catch (e) { return false; }
            if (!meta || typeof meta !== 'object') return false;
            var profile = makeProfile(meta, ev.pubkey);
            finish(ev.pubkey);
            onResolve(ev.pubkey, profile);
            return true;
        }

        function stats() {
            var pending = [], done = [], gaveUp = [];
            for (var pk in state) {
                if (state[pk].gaveUp) gaveUp.push(pk);
                else if (state[pk].done) done.push(pk);
                else pending.push(pk);
            }
            return { pending: pending, done: done, gaveUp: gaveUp, sends: sends };
        }

        return {
            lookup: lookup,
            flush: flush,
            absorb: absorb,
            stats: stats,
            isPending: function (pk) { return !!(state[pk] && !state[pk].done && !state[pk].gaveUp); }
        };
    }

    var api = {
        makeProfile: makeProfile,
        fallbackName: fallbackName,
        fallbackHandle: fallbackHandle,
        fallbackProfile: fallbackProfile,
        createResolver: createResolver,
        escapeHtml: escapeHtml,
        DEFAULT_PROFILE_RELAYS: ['wss://purplepag.es', 'wss://relay.nostr.net']
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrProfile = api;
})(typeof window !== 'undefined' ? window : globalThis);
