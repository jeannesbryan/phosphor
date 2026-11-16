/* Relay connection bookkeeping, in one place.

   Every page opened its own sockets and kept its own `onlineCount`. Two faults
   came out of measuring instead of reading:

   1. `onlineCount` was only ever incremented. It was never decremented on error or
      close, so the status button could say "4/4 ONLINE" while a relay was down. The
      relay MODAL read relayStatusMap and was correct, so the two disagreed. The
      count is now derived from the map, so it cannot drift.
   2. Eight pages showed "[ RELAYS: 2/4 ONLINE ]" (with inner spaces) even though
      their own initial label is "[RELAYS: CONNECTING...]" (no inner spaces). The
      label changed style the moment it updated. index.html was the only page that
      stayed consistent.

   The module answers "which relays are up" and "what does the label say". It does
   NOT decide which subscriptions to send or how to render events: that is genuinely
   per page, and pretending otherwise is how the earlier bulk extraction would have
   gone wrong.
*/
(function (global) {
    'use strict';

    /* One format, matching the label the pages start with. */
    function relayLabel(online, total) {
        var t = typeof total === 'number' && isFinite(total) ? total : 0;
        var o = typeof online === 'number' && isFinite(online) ? online : 0;
        return '[RELAYS: ' + o + '/' + t + ' ONLINE]';
    }

    function connectingLabel() {
        return '[RELAYS: CONNECTING...]';
    }

    /* The status of a set of relays, with the count derived rather than counted.

       opts.button  element whose textContent is updated (optional)
       opts.total   how many relays the page is trying to reach
       opts.label   optional override for the text builder */
    function createPool(opts) {
        opts = opts || {};
        var button = opts.button || null;
        var total = typeof opts.total === 'number' ? opts.total : 0;
        var build = typeof opts.label === 'function' ? opts.label : relayLabel;
        /* Adopt the page's existing map when it has one, instead of replacing it.
           Reassignment would break any code already holding a reference to it, and
           the relay modal reads that map directly. */
        var status = (opts.status && typeof opts.status === 'object') ? opts.status : {};

        function onlineCount() {
            var n = 0;
            for (var k in status) {
                if (Object.prototype.hasOwnProperty.call(status, k) && status[k] === true) n++;
            }
            return n;
        }

        function render() {
            if (button && 'textContent' in button) {
                button.textContent = build(onlineCount(), total);
            }
        }

        function mark(url, isOnline) {
            if (!url) return;
            status[url] = !!isOnline;
            render();
        }

        return {
            status: status,
            total: function () { return total; },
            setTotal: function (n) { if (typeof n === 'number' && isFinite(n)) { total = n; render(); } },
            isOnline: function (url) { return status[url] === true; },
            onlineCount: onlineCount,
            markOnline: function (url) { mark(url, true); },
            markOffline: function (url) { mark(url, false); },
            render: render,
            label: function () { return build(onlineCount(), total); }
        };
    }

    /* Wire one socket: status, error/close, and NIP-42.

       opts.url        the relay
       opts.pool       a pool from createPool()
       opts.onOpen     called with the socket once it opens, for the page's own REQs
       opts.onMessage  the page's message handler
       opts.onAuthResult  forwarded to NostrAuth.wrapSocket
       opts.sign       the signer for NIP-42, or null

       Returns the socket, or null when a WebSocket cannot be made. A page must never
       crash because one relay URL is bad: the loop keeps going.
    */
    function connectRelay(opts) {
        opts = opts || {};
        if (!opts.url || typeof global.WebSocket !== 'function') return null;
        var socket;
        try {
            socket = new global.WebSocket(opts.url);
        } catch (e) {
            if (opts.pool) opts.pool.markOffline(opts.url);
            return null;
        }

        if (opts.pool) opts.pool.markOffline(opts.url);

        socket.onopen = function () {
            if (opts.pool) opts.pool.markOnline(opts.url);
            if (typeof opts.onOpen === 'function') {
                try { opts.onOpen(socket); } catch (e) { /* the page's own failure */ }
            }
        };
        socket.onerror = function () { if (opts.pool) opts.pool.markOffline(opts.url); };
        socket.onclose = function () { if (opts.pool) opts.pool.markOffline(opts.url); };

        if (typeof opts.onMessage === 'function') socket.onmessage = opts.onMessage;

        /* NIP-42 after the page handler is installed, so the wrapper has something to
           wrap and still forwards every non-AUTH frame. */
        if (global.NostrAuth && typeof global.NostrAuth.wrapSocket === 'function') {
            try {
                global.NostrAuth.wrapSocket(socket, opts.url, {
                    sign: opts.sign || null,
                    onResult: typeof opts.onAuthResult === 'function' ? opts.onAuthResult : function () {}
                });
            } catch (e) { /* auth is an enhancement, never a reason to lose the relay */ }
        }

        return socket;
    }

    var api = {
        relayLabel: relayLabel,
        connectingLabel: connectingLabel,
        createPool: createPool,
        connectRelay: connectRelay
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrRelay = api;
})(typeof window !== 'undefined' ? window : globalThis);
