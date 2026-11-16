/* NIP-42: authenticate to a relay.

   strfry (bos's own relay) and damus.io both advertise nip 42 in their NIP-11
   documents, and strfry also advertises nip 70 (protected events). Without AUTH
   Phosphor cannot read protected events and cannot use any relay that requires
   an identity, so this is the gate for both.

   The flow, per the NIP:
     relay  -> ["AUTH", <challenge>]
     client -> ["AUTH", <signed kind 22242 event>]

   The event must carry exactly the relay URL and that challenge:
     kind 22242, tags [["relay", <ws url>], ["challenge", <challenge>]]

   Nothing here signs anything. Signing is injected, because Phosphor supports an
   extension, a bunker and a stored key, and the module must not care which. That
   also makes the whole state machine testable without a browser or a key.
*/
(function (global) {
    'use strict';

    var KIND_AUTH = 22242;

    function isRelayUrl(u) {
        return typeof u === 'string' && /^wss?:\/\/[^\s]+$/i.test(u.trim());
    }

    /* The relay URLs must be compared in one canonical shape or the tag will not
       match what the relay expects: lowercase host, no trailing slash. Path and
       port stay, because a relay can live at wss://host/relay. */
    function normalizeRelayUrl(u) {
        if (!isRelayUrl(u)) return null;
        var s = String(u).trim();
        var m = /^(wss?:\/\/)([^\/?#]+)(.*)$/i.exec(s);
        if (!m) return null;
        var scheme = m[1].toLowerCase();
        var host = m[2].toLowerCase();
        var rest = m[3] || '';
        rest = rest.replace(/[?#].*$/, '');
        if (rest === '/') rest = '';
        return scheme + host + rest;
    }

    /* Read a raw frame. Returns null for anything that is not an AUTH request, so
       callers can hand every frame in without a type check first. */
    function parseAuthRequest(frame) {
        if (!Array.isArray(frame)) return null;
        if (String(frame[0]).toUpperCase() !== 'AUTH') return null;
        var challenge = frame[1];
        if (typeof challenge !== 'string' || !challenge.trim()) return null;
        return { challenge: challenge };
    }

    /* Relays report a missing auth in two places: CLOSED (subscription) and OK
       (event), both with the machine readable prefix "auth-required:". */
    function isAuthRequired(frame) {
        if (!Array.isArray(frame)) return null;
        var kind = String(frame[0]).toUpperCase();
        if (kind === 'CLOSED') {
            var reason = String(frame[2] || '');
            if (/^auth-required:/i.test(reason)) return { subscription: frame[1], reason: reason };
            return null;
        }
        if (kind === 'OK') {
            if (frame[2] === false && /^auth-required:/i.test(String(frame[3] || ''))) {
                return { id: frame[1], reason: String(frame[3]) };
            }
            return null;
        }
        return null;
    }

    /* The unsigned event. `created_at` is injected so it can be asserted exactly
       instead of being whatever the clock said during a test. */
    function buildAuthEvent(relayUrl, challenge, nowSeconds) {
        var url = normalizeRelayUrl(relayUrl);
        if (!url) return null;
        if (typeof challenge !== 'string' || !challenge.trim()) return null;
        var ts = typeof nowSeconds === 'number' && isFinite(nowSeconds)
            ? Math.floor(nowSeconds)
            : Math.floor(Date.now() / 1000);
        return {
            kind: KIND_AUTH,
            created_at: ts,
            content: '',
            tags: [['relay', url], ['challenge', challenge]]
        };
    }

    /* Validate a signed event before sending it. A relay rejects a mismatched one
       and some close the socket, so it is cheaper to catch it here. */
    function isUsableAuthEvent(ev, relayUrl, challenge) {
        if (!ev || typeof ev !== 'object') return false;
        if (ev.kind !== KIND_AUTH) return false;
        if (typeof ev.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(ev.sig)) return false;
        if (typeof ev.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(ev.pubkey)) return false;
        if (!Array.isArray(ev.tags)) return false;
        var want = normalizeRelayUrl(relayUrl);
        var gotRelay = null, gotChallenge = null;
        for (var i = 0; i < ev.tags.length; i++) {
            var t = ev.tags[i];
            if (!Array.isArray(t)) continue;
            if (t[0] === 'relay') gotRelay = normalizeRelayUrl(t[1]);
            if (t[0] === 'challenge') gotChallenge = t[1];
        }
        return gotRelay === want && gotChallenge === challenge;
    }

    /* Answer one AUTH request.

       opts.sign(template) -> Promise<signed event>, or null when the page has no
       way to sign (not logged in, extension missing).

       Returns a small result object instead of throwing, so a page can show the
       real reason rather than a generic failure:
         { sent: true }                    signed and written to the socket
         { sent: false, reason: 'no-signer' }   nobody can sign here
         { sent: false, reason: 'sign-failed', error }  signer refused or threw
         { sent: false, reason: 'invalid-event' }       signer produced garbage
    */
    function respondToAuth(frame, opts) {
        opts = opts || {};
        var req = parseAuthRequest(frame);
        if (!req) return Promise.resolve({ sent: false, reason: 'not-an-auth-request' });

        if (typeof opts.sign !== 'function') return Promise.resolve({ sent: false, reason: 'no-signer' });
        if (typeof opts.send !== 'function') return Promise.resolve({ sent: false, reason: 'no-socket' });

        var template = buildAuthEvent(opts.relayUrl, req.challenge, opts.now);
        if (!template) return Promise.resolve({ sent: false, reason: 'bad-relay-url' });

        var signed;
        try {
            signed = opts.sign(template);
        } catch (e) {
            return Promise.resolve({ sent: false, reason: 'sign-failed', error: String(e) });
        }
        return Promise.resolve(signed).then(function (ev) {
            if (!isUsableAuthEvent(ev, opts.relayUrl, req.challenge)) {
                return { sent: false, reason: 'invalid-event' };
            }
            try {
                opts.send(JSON.stringify(['AUTH', ev]));
            } catch (e) {
                return { sent: false, reason: 'send-failed', error: String(e) };
            }
            return { sent: true };
        }, function (e) {
            return { sent: false, reason: 'sign-failed', error: String(e) };
        });
    }

    /* Wrap a socket so AUTH requests are answered wherever they arrive.

       Every page sets its own socket.onmessage with its own REQ handling, and
       those handlers ignore frames they do not recognise, so an AUTH request was
       silently dropped. Wrapping the existing handler keeps each page's logic
       untouched and puts the answer in one place.

       An AUTH frame is consumed here and not passed on: it carries no content.
       Returns false when the socket cannot be wrapped, so the caller knows. */
    function wrapSocket(socket, relayUrl, opts) {
        if (!socket || typeof socket.send !== 'function') return false;
        opts = opts || {};
        var previous = socket.onmessage;
        socket.onmessage = function (event) {
            var frame = null;
            try { frame = JSON.parse(event.data); } catch (e) { frame = null; }
            if (Array.isArray(frame) && String(frame[0]).toUpperCase() === 'AUTH') {
                respondToAuth(frame, {
                    relayUrl: relayUrl,
                    sign: opts.sign,
                    send: function (s) { socket.send(s); }
                }).then(function (r) {
                    if (typeof opts.onResult === 'function') opts.onResult(r, relayUrl);
                });
                return;
            }
            if (typeof previous === 'function') return previous.call(socket, event);
        };
        return true;
    }

    /* Counts, so a page can tell "the relay never asked" from "we answered".
       Without this, a protection rule failing open is invisible. */
    function createAuthTracker() {
        var requested = 0, sent = 0, failed = 0, byRelay = {};
        return {
            observe: function (relayUrl, result) {
                requested++;
                byRelay[relayUrl] = byRelay[relayUrl] || { requested: 0, sent: 0, failed: 0 };
                byRelay[relayUrl].requested++;
                if (result && result.sent) { sent++; byRelay[relayUrl].sent++; }
                else { failed++; byRelay[relayUrl].failed++; }
            },
            stats: function () {
                return { requested: requested, sent: sent, failed: failed, byRelay: byRelay };
            }
        };
    }

    var api = {
        KIND_AUTH: KIND_AUTH,
        normalizeRelayUrl: normalizeRelayUrl,
        isRelayUrl: isRelayUrl,
        parseAuthRequest: parseAuthRequest,
        isAuthRequired: isAuthRequired,
        buildAuthEvent: buildAuthEvent,
        isUsableAuthEvent: isUsableAuthEvent,
        respondToAuth: respondToAuth,
        wrapSocket: wrapSocket,
        createAuthTracker: createAuthTracker
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrAuth = api;
})(typeof window !== 'undefined' ? window : globalThis);
