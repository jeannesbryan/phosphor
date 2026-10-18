/* ==========================================================================
   nostr-pulse-event.js — the ONE definition of "is this a 24H pulse".

   Why this file exists (2026-10-18)
   ---------------------------------
   The same rule was written by hand on seven pages:

     index.html, notes.html, profile.html
       (kind >= 20000 && kind < 30000) || (kind === 1 && hasExpiration)

     bookmark.html, relay.html, thread.html
       (kind >= 20000 && kind < 30000 && !isSportActivity)
       || (kind === 1 && hasExpiration)

   Three pages had the extra guard, three did not — the copies had already
   drifted. And the first half of that expression is wrong.

   What kind 20000-29999 really is
   -------------------------------
   Those kinds are EPHEMERAL (NIP-16): a relay is supposed to broadcast them
   and not store them. A probe of four relays on 2026-10-18 returned 62 real
   ephemeral events, and not one of them was a pulse:

     kind 20001 (29 events)  {"type":"presence","payload":"online"}
                             with tag t=stickerpals_broadcast
     kind 20004              "probe"
     kind 20000              empty content

   Because the old rule treated that whole range as a pulse, a Stickerpals
   presence broadcast would be shown with a "24H_PULSE / EPHEMERAL_STORY"
   badge in the global timeline. The range adds nothing for real pulses
   either: the owner posts pulses from Phosphor and from Amethyst, and both
   write kind 1 with an "expiration" tag (verified by reading the relay).

   So the only thing the kind range contributed was false positives.

   The real definition
   -------------------
   A pulse is a note carrying an "expiration" tag (NIP-40) whose time has not
   passed. Nothing about the kind. That is what this module implements.

   Failure behaviour
   -----------------
   If this file fails to load, pages stop marking anything as a pulse: the
   badge and the card border disappear, but every note still renders. Nothing
   is hidden and nothing is lost — the failure mode is a missing label, not a
   missing event.
   ========================================================================== */

(function (global) {
    'use strict';

    /* NIP-16 ephemeral kinds. Exported so pages can ask the question
       explicitly, but this is NOT a pulse test — see isPulse below. */
    function isEphemeralKind(kind) {
        return typeof kind === 'number' && kind >= 20000 && kind < 30000;
    }

    function tagValues(ev, name) {
        if (!ev || !Array.isArray(ev.tags)) return [];
        var out = [];
        for (var i = 0; i < ev.tags.length; i++) {
            var t = ev.tags[i];
            if (Array.isArray(t) && t[0] === name) out.push(t);
        }
        return out;
    }

    /* Unix seconds from the "expiration" tag, or null when absent or
       unreadable. A tag such as ["expiration", "soon"] must not turn into NaN
       and quietly become a pulse that never expires. */
    function expirationOf(ev) {
        var tags = tagValues(ev, 'expiration');
        if (!tags.length) return null;
        var raw = tags[0][1];
        if (typeof raw === 'number' && isFinite(raw)) return Math.floor(raw);
        if (typeof raw !== 'string') return null;
        var n = parseInt(raw.trim(), 10);
        return isNaN(n) ? null : n;
    }

    function hasExpiration(ev) {
        return expirationOf(ev) !== null;
    }

    function nowSeconds(nowSec) {
        return typeof nowSec === 'number' ? nowSec : Math.floor(Date.now() / 1000);
    }

    /* Expired means the expiration time has arrived.

       NIP-40 calls the tag "a unix timestamp AT WHICH the message SHOULD be
       considered expired", so the boundary is inclusive: exactly at that
       second the pulse is gone. The seven hand-written copies this module
       replaces used "now > expiration", which kept a pulse alive for one
       second longer than the spec says. */
    function isExpired(ev, nowSec) {
        var exp = expirationOf(ev);
        if (exp === null) return false;
        return nowSeconds(nowSec) >= exp;
    }

    /* THE rule: an unexpired note with an expiration tag. The kind is not
       consulted at all — a kind 1 note is a pulse when it carries the tag, and
       a kind 20001 presence broadcast is never one. */
    function isPulse(ev, nowSec) {
        if (!ev) return false;
        if (expirationOf(ev) === null) return false;
        return !isExpired(ev, nowSec);
    }

    function remainingSeconds(ev, nowSec) {
        var exp = expirationOf(ev);
        if (exp === null) return null;
        return exp - nowSeconds(nowSec);
    }

    /* The label the pages already show after "24H_PULSE / ". Kept in the same
       shape so this change is not a visual change: "Exp in 21h 15m". */
    function expiryLabel(ev, nowSec) {
        var left = remainingSeconds(ev, nowSec);
        if (left === null) return '';
        if (left <= 0) return 'Expired';
        return 'Exp in ' + Math.floor(left / 3600) + 'h ' + Math.floor((left % 3600) / 60) + 'm';
    }

    /* Everything a page needs in one call, so no page has to remember the
       ordering of the individual checks. */
    function describe(ev, nowSec) {
        var exp = expirationOf(ev);
        return {
            isPulse: isPulse(ev, nowSec),
            hasExpiration: exp !== null,
            expiresAt: exp,
            expired: isExpired(ev, nowSec),
            label: expiryLabel(ev, nowSec)
        };
    }

    /* Which kinds a page may still ask a relay for. 20000-29999 is absent on
       purpose: those events are not stored, so asking for them bought nothing
       but presence noise. Kept next to the rule so the two cannot drift. */
    var FEED_KINDS = [1, 6, 16, 20, 21, 22, 34235, 34236, 1301, 30023];

    /* Should this event be drawn as a feed card at all? Media kinds are
       decided by nostr-media-event.js; this only answers for notes and
       pulses. */
    function isFeedKind(kind, isMediaFn) {
        if (typeof kind !== 'number') return false;
        if (kind === 1 || kind === 6 || kind === 16 || kind === 1301 || kind === 30023) return true;
        if (typeof isMediaFn === 'function' && isMediaFn(kind)) return true;
        return false;
    }

    var api = {
        isEphemeralKind: isEphemeralKind,
        expirationOf: expirationOf,
        hasExpiration: hasExpiration,
        isExpired: isExpired,
        isPulse: isPulse,
        remainingSeconds: remainingSeconds,
        expiryLabel: expiryLabel,
        describe: describe,
        FEED_KINDS: FEED_KINDS,
        isFeedKind: isFeedKind
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrPulseEvent = api;
}(typeof window !== 'undefined' ? window : globalThis));
