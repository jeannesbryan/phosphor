/* Pagination for the timeline.

   index.html asked for `"limit": 40` and never sent `until`, so anything older
   than the newest 40 notes was unreachable from Phosphor. That is fine for a
   quick look and useless for reading somebody's older writing.

   The rules live here, as pure functions, because the tricky parts are all edge
   cases rather than DOM work:
   - `until` is INCLUSIVE in Nostr, so a naive "until = oldest seen" asks for the
     boundary note again. Duplicates are removed by id instead of by bumping the
     timestamp, because several notes can share a created_at and bumping would
     silently skip one of them.
   - a relay that returns only duplicates means there is nothing older HERE, not
     that there is nothing older anywhere. The caller decides what to say; this
     only reports it.
*/
(function (global) {
    'use strict';

    function idOf(ev) {
        return ev && typeof ev.id === 'string' ? ev.id : null;
    }

    function createdAtOf(ev) {
        var n = Number(ev && ev.created_at);
        return isFinite(n) ? n : null;
    }

    /* The oldest timestamp in a set, or null for an empty set. */
    function oldestCreatedAt(events) {
        var oldest = null;
        (events || []).forEach(function (ev) {
            var t = createdAtOf(ev);
            if (t === null) return;
            if (oldest === null || t < oldest) oldest = t;
        });
        return oldest;
    }

    function newestCreatedAt(events) {
        var newest = null;
        (events || []).forEach(function (ev) {
            var t = createdAtOf(ev);
            if (t === null) return;
            if (newest === null || t > newest) newest = t;
        });
        return newest;
    }

    /* Merge without duplicates, newest first. Order is stable for equal
       timestamps: whichever arrived first keeps its place, so two relays cannot
       shuffle the feed between loads. */
    function mergePage(existing, incoming) {
        var seen = {};
        var out = [];
        function add(ev) {
            var id = idOf(ev);
            if (!id || seen[id]) return false;
            seen[id] = true;
            out.push(ev);
            return true;
        }
        (existing || []).forEach(add);
        var added = 0;
        (incoming || []).forEach(function (ev) { if (add(ev)) added++; });
        out.sort(function (a, b) {
            var ta = createdAtOf(a), tb = createdAtOf(b);
            if (ta === null) return 1;
            if (tb === null) return -1;
            return tb - ta;
        });
        return { events: out, added: added };
    }

    /* The filter for the next page: same shape, `until` set to the oldest note we
       already hold. Returns null when there is nothing to page from. */
    function nextFilter(baseFilter, heldEvents, pageSize) {
        if (!baseFilter || typeof baseFilter !== 'object') return null;
        var oldest = oldestCreatedAt(heldEvents);
        if (oldest === null) return null;
        var f = {};
        for (var k in baseFilter) if (Object.prototype.hasOwnProperty.call(baseFilter, k)) f[k] = baseFilter[k];
        f.until = oldest;
        if (typeof pageSize === 'number' && pageSize > 0) f.limit = pageSize;
        delete f.since;
        return f;
    }

    /* A page is "full" when the relay gave us as many as we asked for, which is
       the only signal Nostr offers that more may exist. */
    function looksFull(receivedCount, pageSize) {
        if (typeof pageSize !== 'number' || pageSize <= 0) return false;
        return receivedCount >= pageSize;
    }

    /* Everything the caller needs to decide whether to keep paging, in one place
       so the page does not re-derive it (and get it wrong) in three spots. */
    function pageState(heldEvents, receivedEvents, pageSize) {
        var merged = mergePage(heldEvents, receivedEvents);
        var full = looksFull((receivedEvents || []).length, pageSize);
        var progressed = merged.added > 0;
        return {
            events: merged.events,
            added: merged.added,
            full: full,
            progressed: progressed,
            /* Stop when the relay returned nothing new: either we hit the end, or
               this relay simply has nothing older for this filter. */
            exhausted: !progressed,
            oldest: oldestCreatedAt(merged.events)
        };
    }

    var api = {
        oldestCreatedAt: oldestCreatedAt,
        newestCreatedAt: newestCreatedAt,
        mergePage: mergePage,
        nextFilter: nextFilter,
        looksFull: looksFull,
        pageState: pageState
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrPaginate = api;
})(typeof window !== 'undefined' ? window : globalThis);
