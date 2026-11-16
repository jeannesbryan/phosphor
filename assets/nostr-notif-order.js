/* Where a notification card belongs on a page that is kept NEWEST FIRST.

   Before this module the page used `notifsContainer.prepend(card)`, so the
   order depended on whichever relay answered first. On 2026-11-16 bos reported
   that likes to his posts "never show up" in Phosphor while Amethyst showed
   them. Measured on the live page: 17 reaction cards were rendered, but the top
   card said "1 month ago" and the like from 11 hours ago sat at the very bottom.
   Nothing was missing, it was buried. Amethyst sorts, so the new like is on
   top and visible.

   Kept as a pure function so the rule can be tested without a browser: no DOM,
   no network, no clock.
*/
(function (global) {
    'use strict';

    /* Index at which an item with `createdAt` must be inserted into `keysDesc`,
       an array of created_at values already ordered newest first.

       Equal timestamps keep arrival order (a strict `>`), so two relays
       delivering the same card in different order cannot shuffle the list. */
    function insertIndex(keysDesc, createdAt) {
        var t = Number(createdAt);
        if (!isFinite(t)) return keysDesc.length;
        for (var i = 0; i < keysDesc.length; i++) {
            if (t > Number(keysDesc[i])) return i;
        }
        return keysDesc.length;
    }

    /* A copy of `events` ordered newest first. Used where the whole set is known
       at once (tests and any future full re-render) rather than streaming in. */
    function newestFirst(events, key) {
        var k = key || 'created_at';
        return (events || []).slice().sort(function (a, b) {
            var ta = Number(a && a[k]) || 0;
            var tb = Number(b && b[k]) || 0;
            if (tb !== ta) return tb - ta;
            return 0;
        });
    }

    var api = {
        insertIndex: insertIndex,
        newestFirst: newestFirst
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrNotifOrder = api;
})(typeof window !== 'undefined' ? window : globalThis);
