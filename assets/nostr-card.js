/* Pure pieces of the feed card renderer.

   `renderPost` in index.html is 360 lines and builds four different card shapes
   (note, article, media, activity). It cannot be lifted as a unit: it reads three
   page-level variables (profileCache, eventsCache, currentUserPubkey) and calls
   fifteen page functions, so moving it would mean lifting all of that state first,
   one page at a time.

   What CAN be lifted, and is worth lifting on its own terms, is the part with no
   page state at all: reading tags, detecting a JSON payload, turning URLs into
   anchors, choosing the activity icon, and the pace/speed arithmetic. That last one
   is the reason this module exists: it is real arithmetic with real edge cases
   (zero distance, a duration in the wrong shape, an unknown sport) and it was
   previously reachable only by rendering a card in a browser.

   Every function here is pure. Nothing reads a global, a cache or the DOM.
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

    /* NIP-36 content warning. Returns the author's own reason when they gave one. */
    function contentWarning(ev) {
        var isNSFW = false;
        var reason = 'NSFW';
        var tags = (ev && ev.tags) || [];
        for (var i = 0; i < tags.length; i++) {
            var t = tags[i];
            if (Array.isArray(t) && t[0] === 'content-warning') {
                isNSFW = true;
                if (t[1]) reason = t[1];
            }
        }
        return { isNSFW: isNSFW, reason: reason };
    }

    /* The two tags a card reads once: which client published it, and the article
       slug. Later tags win, matching the original forEach order. */
    function eventMeta(ev) {
        var clientName = 'unknown';
        var dTag = '';
        var tags = (ev && ev.tags) || [];
        for (var i = 0; i < tags.length; i++) {
            var t = tags[i];
            if (!Array.isArray(t)) continue;
            if (t[0] === 'client') clientName = t[1];
            if (t[0] === 'd') dTag = t[1];
        }
        return { clientName: clientName, dTag: dTag };
    }

    /* A kind 1 note whose content is a bare JSON object is shown as a code block
       rather than as prose, pretty-printed so it is readable. Anything that does
       not parse stays prose: a broken payload must not vanish. */
    function jsonPayload(ev) {
        if (!ev || ev.kind !== 1) return { isJson: false, pretty: '' };
        var content = typeof ev.content === 'string' ? ev.content.trim() : '';
        if (!content || content.charAt(0) !== '{' || content.charAt(content.length - 1) !== '}') {
            return { isJson: false, pretty: '' };
        }
        try {
            return { isJson: true, pretty: JSON.stringify(JSON.parse(content), null, 2) };
        } catch (e) {
            return { isJson: false, pretty: '' };
        }
    }

    /* Turn URLs in ALREADY-ESCAPED text into anchors.

       The input is escaped text, so `&` appears as `&amp;`; the href needs the raw
       ampersand back or the query string is corrupted. That un-escaping is the one
       subtlety here, and it is why this is tested directly. */
    function linkifyHtml(escapedText) {
        var text = String(escapedText === undefined || escapedText === null ? '' : escapedText);
        return text.replace(/(https?:\/\/[^\s<]+)/gi, function (url) {
            var href = url.replace(/&amp;/g, '&');
            return '<a href="' + href + '" target="_blank" rel="noopener noreferrer"'
                + ' style="color: var(--t-green); text-decoration: underline; word-break: break-all;">'
                + url + '</a>';
        });
    }

    /* Escape first, then linkify. The order matters: linkifying before escaping
       would let a crafted URL inject markup. */
    function renderText(raw) {
        return linkifyHtml(escapeHtml(String(raw === undefined || raw === null ? '' : raw).trim()));
    }

    /* Activity icon. Deliberately substring based, because activity types arrive as
       free text ("cycling", "E-Bike Ride", "running"). */
    function activityIcon(activityType) {
        var t = String(activityType === undefined || activityType === null ? '' : activityType).toLowerCase();
        if (t.indexOf('cycl') !== -1 || t.indexOf('bike') !== -1) return '[BIKE]';
        if (t.indexOf('run') !== -1 || t.indexOf('walk') !== -1) return '[WALK]';
        return '[A]';
    }

    /* Seconds from "h:mm:ss" or "m:ss". Returns null when the shape is not one of
       those, so a caller can leave the metric out instead of printing NaN. */
    function parseDuration(text) {
        if (typeof text !== 'string') return null;
        var parts = text.split(':');
        if (parts.length === 3) {
            var h = Number(parts[0]), m = Number(parts[1]), s = Number(parts[2]);
            if (!isFinite(h) || !isFinite(m) || !isFinite(s)) return null;
            return h * 3600 + m * 60 + s;
        }
        if (parts.length === 2) {
            var m2 = Number(parts[0]), s2 = Number(parts[1]);
            if (!isFinite(m2) || !isFinite(s2)) return null;
            return m2 * 60 + s2;
        }
        return null;
    }

    var SPEED_SPORTS = ['cycling', 'biking', 'ebike', 'driving', 'motorcycling'];
    var WATER_SPORTS = ['swimming'];

    /* Average speed or pace, per sport.

       Cycling and driving report km/h; swimming reports minutes per 100 m;
       everything else reports minutes per km. Returns null when there is nothing
       honest to show (no distance, no duration, or a zero distance), because
       dividing by zero would print "Infinity /km" on the card. */
    function paceSpeed(opts) {
        opts = opts || {};
        var distNum = parseFloat(opts.distance);
        if (!isFinite(distNum) || distNum <= 0) return null;
        var totalSeconds = parseDuration(opts.duration);
        if (totalSeconds === null || totalSeconds <= 0) return null;

        var exercise = String(opts.activityType || '').toLowerCase();
        if (SPEED_SPORTS.indexOf(exercise) !== -1) {
            var hours = totalSeconds / 3600;
            return { value: (distNum / hours).toFixed(2) + ' km/h', label: 'Avg Speed' };
        }
        if (WATER_SPORTS.indexOf(exercise) !== -1) {
            var distance100m = (distNum * 1000) / 100;
            var per100 = (totalSeconds / 60) / distance100m;
            return { value: clockFromMinutes(per100) + ' /100m', label: 'Avg Pace' };
        }
        var minutes = totalSeconds / 60;
        return { value: clockFromMinutes(minutes / distNum) + ' /km', label: 'Avg Pace' };
    }

    /* m:ss from a decimal minute count. Kept separate so the rounding rule is in one
       place: 59.6 seconds must read ":00", not ":60". */
    function clockFromMinutes(decimalMinutes) {
        var mins = Math.floor(decimalMinutes);
        var secs = Math.round((decimalMinutes - mins) * 60);
        if (secs === 60) { mins += 1; secs = 0; }
        return mins + ':' + (secs < 10 ? '0' : '') + secs;
    }

    var api = {
        escapeHtml: escapeHtml,
        contentWarning: contentWarning,
        eventMeta: eventMeta,
        jsonPayload: jsonPayload,
        linkifyHtml: linkifyHtml,
        renderText: renderText,
        activityIcon: activityIcon,
        parseDuration: parseDuration,
        paceSpeed: paceSpeed,
        clockFromMinutes: clockFromMinutes
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrCard = api;
})(typeof window !== 'undefined' ? window : globalThis);
