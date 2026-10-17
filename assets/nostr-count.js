/* ==========================================================================
   nostr-count.js — NIP-45 event counts, and the metrics flow behind them.

   Why this file exists
   --------------------
   Every card in Phosphor shows four counters: replies, reposts, likes, zaps.
   The old way asked a relay for *every* event behind those numbers and counted
   them in the browser:

       ["REQ", "metrics-x", {"#e": [ids...], "kinds": [1, 6, 7, 16, 9735]}]

   For ten ordinary notes that was 176 KB across 248 events — and we threw all
   of it away after incrementing four integers. NIP-45 defines a verb that
   returns just the number:

       ["COUNT", "c1", {"#e": [<id>], "kinds": [7]}]
       ["COUNT", "c1", {"count": 76}]

   Measured against nos.lol on the same ten notes: 176,530 bytes became 43,096
   (76% less). The remainder is almost entirely zaps, because a zap amount
   cannot be counted — you have to read each 9735 event to sum its sats. So
   zaps stay on REQ and everything countable moves to COUNT.

   Two rules that keep the numbers honest
   --------------------------------------
   1. NEVER SUM ACROSS RELAYS. Counts are per-relay views of the same events:
       the follower count for one pubkey came back as 3,324 from nos.lol and
      6,692 from primal.net. Adding them invents 10,016 people who do not
      exist. We keep the maximum, which can under-report but never fabricates
      an audience, and we mark the value approximate when relays disagree.
   2. NEVER COUNT TWICE. Once COUNT has answered for a kind, the event-based
      tally for that kind is switched off. Otherwise a relay that answered
      COUNT and then also streamed the events would double every number.

   HLL
   ---
   The spec lets a relay return a 256-register HyperLogLog value for merging.
   None of the relays we talked to return one, so it is parsed and kept but not
   turned into an estimate: writing an estimator I could not check against real
   data would be worse than not having it. The spec's own two examples do not
   validate a simple estimator either (the first lands within 9%, the second is
   off by 6x), so there was no ground truth to test against.

   ⚠️ Counts are still only as trustworthy as the relay: see the spec's note on
   mining pubkeys to inflate them. We do not present them as authoritative.
   ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.NostrCount = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /* Kinds we can count. Kind 16 is the generic repost, treated like kind 6. */
    var COUNTABLE = { likes: [7], replies: [1], reposts: [6, 16] };
    var ZAP_KIND = 9735;

    var debounceMs = 1500;
    var refusalWindowMs = 6000;   // how long we wait before assuming no COUNT

    var cfg = null;              // set by init()
    var pendingIds = null;       // Set of target ids waiting for a batch
    var timer = null;
    var pendingSubs = {};        // subId -> { target, kind, sentAt }
    var seenCounts = {};         // "target|kind" -> { max, sources:Set, approximate }
    var relayRefusals = 0;

    // ---------------------------------------------------------------- helpers

    function isValidCount(n) {
        return typeof n === 'number' && isFinite(n) && n >= 0 &&
               Math.floor(n) === n && n <= Number.MAX_SAFE_INTEGER;
    }

    /* ["COUNT", id, {"count": n, ...}] -> { id, count, approximate, hll }
       Returns null for anything that is not a usable count, so a malformed or
       hostile message can never poison a counter. */
    function parse(msg) {
        if (!Array.isArray(msg) || msg[0] !== 'COUNT') return null;
        var id = msg[1], payload = msg[2];
        if (typeof id !== 'string' || !payload || typeof payload !== 'object') return null;
        if (!isValidCount(payload.count)) return null;

        var out = { id: id, count: payload.count, approximate: payload.approximate === true, hll: null };

        /* Kept for completeness; see the header note on why it is not merged.
           A real HLL is 256 registers = 512 hex characters. */
        if (typeof payload.hll === 'string' && /^[0-9a-f]{512}$/i.test(payload.hll)) out.hll = payload.hll;

        return out;
    }

    /* ["CLOSED", id, "auth-required: ..."] -> { id, reason } or null. A relay
       that does not know COUNT often answers this way instead of ignoring us. */
    function parseRefusal(msg) {
        if (!Array.isArray(msg) || msg[0] !== 'CLOSED') return null;
        if (typeof msg[1] !== 'string') return null;
        return { id: msg[1], reason: typeof msg[2] === 'string' ? msg[2] : '' };
    }

    function buildFrame(subId, filters) {
        var frame = ['COUNT', subId];
        (Array.isArray(filters) ? filters : [filters]).forEach(function (f) { frame.push(f); });
        return frame;
    }

    function filterFor(kind, targets) {
        var f = { '#e': targets.slice(), kinds: COUNTABLE[kind].slice() };
        return f;
    }

    /* Merge the counts collected for one target+kind. Maximum, never a sum —
       see rule 1 at the top of this file. `approximate` turns on when the
       relays disagreed, which is the only honest signal we have that the true
       number is unknown. */
    function mergeCounts(list) {
        var vals = (list || []).filter(function (x) { return isValidCount(x && x.count); })
                               .map(function (x) { return x.count; });
        if (!vals.length) return null;
        var max = Math.max.apply(null, vals);
        var distinct = {};
        vals.forEach(function (v) { distinct[v] = true; });
        return {
            count: max,
            sources: vals.length,
            agreed: Object.keys(distinct).length === 1,
            approximate: Object.keys(distinct).length > 1
        };
    }

    var seq = 0;
    function newSubId(kind) {
        seq += 1;
        return 'cnt-' + kind + '-' + seq + '-' + Math.random().toString(36).slice(2, 6);
    }

    // ------------------------------------------------------------- the flow

    function openSockets() {
        var list = cfg && typeof cfg.sockets === 'function' ? cfg.sockets() : [];
        return (list || []).filter(function (s) { return s && s.readyState === 1; });
    }

    function ensureEntry(id) {
        if (cfg && typeof cfg.ensure === 'function') cfg.ensure(id);
        return cfg && cfg.cache ? cfg.cache[id] : null;
    }

    function repaint(id) {
        if (cfg && typeof cfg.update === 'function') cfg.update(id);
    }

    /* Called by pages when a note needs its counters. Batched, exactly like the
       single big REQ was: many cards appear at once, and one frame per card
       would be worse than one frame per batch. */
    function requestMetrics(id) {
        if (!pendingIds) return;
        pendingIds.add(id);
        /* Only arm the timer if it is not already armed. The old code reset it
           on every call, and a busy feed calls this once per incoming card —
           so the window kept being pushed back and the flush never ran. In a
           live timeline that left the counters waiting forever while the id
           set grew without bound. Batching from the FIRST request instead
           means a burst still becomes one frame, but it always gets sent. */
        if (!timer) timer = setTimeout(flush, cfg && cfg.debounceMs ? cfg.debounceMs : debounceMs);
    }

    function flush() {
        timer = null;                 // the window is over; a new one may open
        var ids = pendingIds ? Array.from(pendingIds) : [];
        if (!ids.length) return;
        pendingIds.clear();

        var sockets = openSockets();
        if (!sockets.length) return;

        var frames = [];

        /* One COUNT per target per kind: filters are OR'd together into a
           single number, so asking for several ids at once would give a total,
           not a per-note breakdown. */
        ids.forEach(function (target) {
            Object.keys(COUNTABLE).forEach(function (kind) {
                var subId = newSubId(kind);
                pendingSubs[subId] = { target: target, kind: kind, at: Date.now() };
                frames.push(buildFrame(subId, [filterFor(kind, [target])]));
            });
        });

        /* Zaps still need every event: a count cannot sum sats. */
        frames.push(['REQ', 'zaps-' + Date.now().toString(36), { '#e': ids.slice(), kinds: [ZAP_KIND] }]);

        sockets.forEach(function (sock) {
            frames.forEach(function (f) {
                try { sock.send(JSON.stringify(f)); } catch (e) { /* socket died mid-loop */ }
            });
        });

        /* If no COUNT at all comes back, the relay is probably counting-blind;
           fall back to the old REQ so the numbers still fill in. */
        setTimeout(function () {
            var stale = ids.filter(function (target) {
                return target && !seenCounts[target + '|likes'] && !seenCounts[target + '|replies'] &&
                       !seenCounts[target + '|reposts'];
            });
            if (stale.length) sendEventFallback(stale);

            /* Entries are kept for the whole window so every relay gets a
               chance to answer; this is where they are finally released. */
            var cutoff = Date.now() - refusalWindowMs;
            Object.keys(pendingSubs).forEach(function (subId) {
                if (pendingSubs[subId].at < cutoff) delete pendingSubs[subId];
            });
        }, refusalWindowMs);
    }

    /* Ask for the raw events for these targets, so the page's own EVENT handler
       can tally them the old way. Safe to call when COUNT already answered:
       the tallies are switched off per kind, so nothing is counted twice. */
    function sendEventFallback(ids) {
        if (!ids || !ids.length) return;
        var sockets = openSockets();
        if (!sockets.length) return;
        var req = ['REQ', 'metrics-fb-' + Math.random().toString(36).slice(2, 8),
                   { '#e': ids.slice(), kinds: [1, 6, 7, 16] }];
        sockets.forEach(function (s) { try { s.send(JSON.stringify(req)); } catch (e) {} });
    }

    /* Returns true when the message belonged to this module, so a page can bail
       out of its own handler instead of treating a COUNT as an unknown verb. */
    function handleMessage(msg) {
        if (!Array.isArray(msg)) return false;

        if (msg[0] === 'COUNT') {
            var res = parse(msg);
            if (!res) return true;                    // malformed: consume, never count it
            var pending = pendingSubs[res.id];
            if (!pending) return true;                // not ours (or already answered)

            var key = pending.target + '|' + pending.kind;
            var entry = seenCounts[key] || (seenCounts[key] = { max: -1, sources: 0, agreed: true });
            var merged = mergeCounts([
                { count: entry.max < 0 ? res.count : entry.max },
                { count: res.count }
            ]);
            /* mergeCounts cannot see "there was only one source"; track it here
               so a single relay answering does not look like disagreement. */
            entry.max = merged.count;
            entry.sources += 1;
            entry.agreed = entry.agreed && merged.agreed;
            entry.approximate = !entry.agreed;

            /* Deliberately NOT deleted here: the same frame goes to every
               relay, so several relays answer with this subId. Removing it on
               the first answer silently dropped every other relay's count —
               which is how a "5" stayed a "5" when another relay knew "8". */
            applyCount(pending.target, pending.kind, entry);
            return true;
        }

        if (msg[0] === 'CLOSED') {
            var refusal = parseRefusal(msg);
            if (!refusal || !pendingSubs[refusal.id]) return false;    // not ours
            var p = pendingSubs[refusal.id];
            /* Also kept until cleanup: one relay refusing must not silence a
               different relay that is perfectly able to count. */
            relayRefusals += 1;
            /* This relay will not count. Some may refuse with "auth-required"
               while others answer; fall back only for the ids nobody answered. */
            if (p && p.target && !seenCounts[p.target + '|' + p.kind]) {
                if (!seenCounts[p.target + '|likes'] && !seenCounts[p.target + '|replies'] &&
                    !seenCounts[p.target + '|reposts']) {
                    sendEventFallback([p.target]);
                }
            }
            return true;
        }

        return false;
    }

    /* Say out loud when the number is uncertain. Relays disagree whenever one of
       them simply does not hold the events, and then we can only show the
       highest view — a tooltip is enough to be honest about that without putting
       a "~" on every counter in the feed. Done here rather than in each page so
       the wording cannot drift across six copies. */
    function annotate(target) {
        if (typeof document === 'undefined' || !document.getElementById) return;
        var m = cfg && cfg.cache ? cfg.cache[target] : null;
        if (!m) return;

        ['likes', 'replies', 'reposts'].forEach(function (kind) {
            var el = document.getElementById('metric-' + kind + '-' + target);
            if (!el) return;
            if (m.approximate && m.approximate[kind]) {
                el.title = 'Relays disagree on this count; showing the highest one.';
            } else if (el.removeAttribute) {
                el.removeAttribute('title');
            }
        });
    }

    /* Write a counted value into the page's cache and switch the event tally off
       for that kind (rule 2). */
    function applyCount(target, kind, entry) {
        var m = ensureEntry(target);
        if (!m || !entry) return;

        if (!m.countSourced) m.countSourced = {};
        var sourceKey = kind === 'reposts' ? 'reposts' : kind;   // cache field name
        m[sourceKey] = entry.max;
        m.countSourced[sourceKey] = true;
        m.approximate = m.approximate || {};
        m.approximate[sourceKey] = !!entry.approximate;

        repaint(target);
        annotate(target);
    }

    /* Used by the pages' EVENT handlers: true when events for this kind must be
       ignored because COUNT already owns the number. */
    function isCountSourced(id, kind) {
        var m = cfg && cfg.cache ? cfg.cache[id] : null;
        return !!(m && m.countSourced && m.countSourced[kind]);
    }

    function init(options) {
        cfg = options || {};
        if (typeof cfg.debounceMs === 'number') debounceMs = cfg.debounceMs;
        if (typeof cfg.refusalWindowMs === 'number') refusalWindowMs = cfg.refusalWindowMs;
        pendingIds = new Set();
        pendingSubs = {};
        seenCounts = {};
        relayRefusals = 0;
    }

    function reset() {
        pendingIds = new Set();
        pendingSubs = {};
        seenCounts = {};
        relayRefusals = 0;
        clearTimeout(timer);
    }

    return {
        COUNTABLE: COUNTABLE,
        ZAP_KIND: ZAP_KIND,
        parse: parse,
        parseRefusal: parseRefusal,
        isValidCount: isValidCount,
        buildFrame: buildFrame,
        filterFor: filterFor,
        mergeCounts: mergeCounts,
        init: init,
        reset: reset,
        requestMetrics: requestMetrics,
        flush: flush,
        handleMessage: handleMessage,
        isCountSourced: isCountSourced,
        annotate: annotate,
        /* exposed for tests */
        _state: function () { return { seenCounts: seenCounts, relayRefusals: relayRefusals }; }
    };
});
