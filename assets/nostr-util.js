/* Small shared helpers, so nine pages stop carrying their own copies.

   escapeHtml was byte-identical in all nine pages and timeAgo in seven. Two
   duplicated helpers are how a project ends up with two different notions of
   "one hour ago" after somebody fixes the bug in only one place.

   Kept tiny on purpose: this is not a utility dumping ground.
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

    /* `now` in seconds is injectable, so a test does not depend on the wall clock
       and cannot start failing at a month boundary. */
    function timeAgo(unixTimestamp, nowSeconds) {
        var now = typeof nowSeconds === 'number' && isFinite(nowSeconds)
            ? nowSeconds
            : Date.now() / 1000;
        var ts = Number(unixTimestamp);
        if (!isFinite(ts)) return 'Just now';
        var seconds = Math.floor(now - ts);
        /* A timestamp in the future (clock skew between relays) is not "in -3
           seconds"; showing "Just now" is the honest reading. */
        if (seconds < 0) seconds = 0;
        var intervals = { year: 31536000, month: 2592000, day: 86400, hour: 3600, minute: 60 };
        if (seconds < 60) return 'Just now';
        for (var key in intervals) {
            var count = Math.floor(seconds / intervals[key]);
            if (count >= 1) return count + ' ' + key + (count > 1 ? 's' : '') + ' ago';
        }
        return 'Just now';
    }

    /* Show an image full size. Was one identical line in seven pages.
       Returns false instead of throwing when the page has no lightbox, so a page
       without one cannot break a media click. */
    function openLightbox(imgSrc, root) {
        var doc = (root && root.ownerDocument) || global.document;
        if (!doc) return false;
        var img = doc.getElementById('lightboxImg');
        var modal = doc.getElementById('lightboxModal');
        if (!img || !modal) return false;
        img.src = String(imgSrc === undefined || imgSrc === null ? '' : imgSrc);
        modal.style.display = 'flex';
        return true;
    }

    function closeLightbox(root) {
        var doc = (root && root.ownerDocument) || global.document;
        if (!doc) return false;
        var modal = doc.getElementById('lightboxModal');
        if (!modal) return false;
        modal.style.display = 'none';
        return true;
    }

    /* NIP-19 style short form, used for placeholders before a profile is known. */
    function shortHex(hex, len) {
        var n = typeof len === 'number' && len > 0 ? len : 8;
        return String(hex === undefined || hex === null ? '' : hex).substring(0, n);
    }

    var api = {
        escapeHtml: escapeHtml,
        timeAgo: timeAgo,
        shortHex: shortHex,
        openLightbox: openLightbox,
        closeLightbox: closeLightbox
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrUtil = api;
})(typeof window !== 'undefined' ? window : globalThis);
