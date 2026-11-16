/* NIP-51 sets: which list an event belongs to.

   kind 30003 is an ADDRESSABLE event, so its `d` tag names the set. An account can
   hold several at once: bookmark, liked-songs, liked-albums. They are separate lists
   and must not be mixed.

   bookmark.html did not read the `d` tag at all. It took whichever 30003 arrived with
   the newest created_at, cleared its id set, and rebuilt from that event's e-tags. The
   consequence was measured, not guessed: injecting a newer liked-songs set (which has
   no e-tags) left the page showing "Bookmark list is empty" while the bookmark set was
   untouched on the relay, and the old card stayed in the DOM as a stale leftover.

   Missing `d` is treated as the `bookmark` set. Not scoring points for strictness
   there: older clients may omit it, and refusing those would hide a real list. The
   wrong failure is the one that loses data.
*/
(function (global) {
    'use strict';

    var DEFAULT_SET = 'bookmark';

    /* The set name an event belongs to, or null when the event is not a set at all. */
    function setName(ev) {
        if (!ev || ev.kind !== 30003) return null;
        var tags = Array.isArray(ev.tags) ? ev.tags : [];
        for (var i = 0; i < tags.length; i++) {
            var t = tags[i];
            if (Array.isArray(t) && t[0] === 'd') {
                var v = typeof t[1] === 'string' ? t[1].trim() : '';
                return v || DEFAULT_SET;
            }
        }
        return DEFAULT_SET;
    }

    function belongsTo(ev, wanted) {
        var name = setName(ev);
        if (name === null) return false;
        return name === (wanted || DEFAULT_SET);
    }

    /* The newest event for a given set. Used instead of "newest event overall", which
       is what let a different set take over the page. */
    function newestOf(events, wanted) {
        var best = null;
        (events || []).forEach(function (ev) {
            if (!belongsTo(ev, wanted)) return;
            if (!best || Number(ev.created_at) > Number(best.created_at)) best = ev;
        });
        return best;
    }

    /* Every set name present in a set of events, for a picker later. */
    function names(events) {
        var seen = {};
        (events || []).forEach(function (ev) {
            var n = setName(ev);
            if (n) seen[n] = true;
        });
        return Object.keys(seen).sort();
    }

    /* The e-tags of one event, which is the actual bookmarked id list. */
    function bookmarkedIds(ev) {
        var out = [];
        var tags = (ev && Array.isArray(ev.tags)) ? ev.tags : [];
        for (var i = 0; i < tags.length; i++) {
            var t = tags[i];
            if (Array.isArray(t) && t[0] === 'e' && typeof t[1] === 'string' && t[1]) out.push(t[1]);
        }
        return out;
    }

    var api = {
        DEFAULT_SET: DEFAULT_SET,
        setName: setName,
        belongsTo: belongsTo,
        newestOf: newestOf,
        names: names,
        bookmarkedIds: bookmarkedIds
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrSets = api;
})(typeof window !== 'undefined' ? window : globalThis);
