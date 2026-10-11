/* nostr-like.js — one place for "like" (NIP-25) and its undo.
 *
 * Problem being solved (bos report, 2026-10-11):
 *   1. There was no sign at all that a note had already been liked.
 *   2. Liking twice popped an alert, and there was NO way to undo it.
 *   3. A like from the phone was invisible on the laptop — each device kept
 *      its own note of it in memory, never asking the relay.
 *
 * Rules:
 *   - Like = kind 7, tags ["e", <note id>], ["p", <author>], content "+".
 *   - Undo = kind 5 (NIP-09) pointing at the id of that like event — not a
 *            fresh like, because that would be a "dislike", not an undo.
 *   - The "already liked" state is ALWAYS built from the relay: the module
 *            subscribes to kind 7 + 5 events from our own pubkey. That is why
 *            another device follows along, and a freshly opened one knows the
 *            real state.
 *
 * Why one module: each page used to write its own likeEvent (six copies), so
 * every fix had to be repeated six times — exactly the mistake that once
 * happened with the Blossom upload rules.
 *
 * CONTRACT for pages (see callers in index/profile/thread/notes/
 * bookmark/relay):
 *   NostrLike.init({
 *     pubkey:   currentUserPubkey,           // may be null (not logged in)
 *     relays:   RELAYS,
 *     send:     (ev) => { ... },             // broadcast EVENT to open relays
 *     onCount:  (id, delta) => { ... },      // adjust the number on the card
 *     historyMs: 6000                        // optional
 *   });
 *   NostrLike.toggle(id, targetPubkey)       // called from the like button
 */
(function (global) {
    'use strict';

    var SUB_PREFIX = 'likes-';
    var DEFAULT_HISTORY_MS = 6000;
    var DEFAULT_LIMIT = 500;

    var state = {
        pubkey: null,
        relays: [],
        send: null,
        onCount: null,
        onState: null,
        historyMs: DEFAULT_HISTORY_MS,
        historyPhase: true,
        limit: DEFAULT_LIMIT,
        sockets: [],
        reactions: {},          // like event id -> note id
        reactionTime: {},       // like event id -> created_at
        deleted: {},            // like event ids already deleted (NIP-09)
        byTarget: {},           // note id -> live like event id
        timer: null,
        pending: {}             // note id -> true, request in flight
    };

    /* The "already liked" state for one note is computed from EVERY reaction we
       know about minus the deleted ones — not from whichever reaction happened
       to pass by last.

       Why: one note can carry several reactions from us (bos had FOUR for the
       same note), and some were deleted. Other relays still serve the stale,
       already-deleted reaction. Under the old rule ("last reaction wins") the
       arrival order decided the outcome: if the stale reaction plus its
       deletion notice arrived last, the like mark vanished — even though three
       other reactions were still live. That is why this page was sometimes
       green while another page was red. The current rule does not care about
       order. */
    function recomputeTarget(target) {
        var before = !!state.byTarget[target];
        var winner = null;
        Object.keys(state.reactions).forEach(function (rid) {
            if (state.reactions[rid] !== target) return;
            if (state.deleted[rid]) return;
            var ts = state.reactionTime[rid] || 0;
            if (!winner || ts >= winner.ts) winner = { id: rid, ts: ts };
        });
        if (winner) state.byTarget[target] = winner.id;
        else delete state.byTarget[target];
        return { before: before, now: !!winner };
    }

    // ---------------------------------------------------------------- util
    function eTags(ev) {
        if (!ev || !Array.isArray(ev.tags)) return [];
        return ev.tags.filter(function (t) {
            return Array.isArray(t) && t[0] === 'e' && typeof t[1] === 'string' && t[1];
        }).map(function (t) { return t[1]; });
    }

    /* Which reactions count as "we liked this note" (NIP-25).
       Phosphor has one like/love button — no custom emoji picker — so the mark
       must come from any reaction that means "like":
         "+"   the NIP-25 like
         ""    some clients send an empty content for a plain like
         heart "" / heart  the love reaction, so a heart given from another
               client (Amethyst, Jumble…) shows here as already liked
       Everything else is NOT a like — in particular "-" (NIP-25 dislike) and
       plain emoji such as thumbs up. Counting those as likes was a real bug:
       a dislike used to light up the like button.
       Variation selectors (U+FE0F) are stripped first, because "heart" and
       "heart + VS16" are the same reaction to a reader. */
    function isLikeContent(content) {
        var raw = String(content == null ? '' : content).replace(/[\uFE0E\uFE0F]/g, '').trim();
        if (raw === '' || raw === '+') return true;
        return raw === '\u2764' || raw === '\u2665';
    }

    /* The "e" tag that is the TARGET of the like. NIP-25: if there are several,
       the last one is the target (the leading ones are usually root/reply). */
    function reactionTarget(ev) {
        var ids = eTags(ev);
        return ids.length ? ids[ids.length - 1] : null;
    }

    // ------------------------------------------------------------------ API
    function isLiked(targetId) {
        return !!state.byTarget[targetId];
    }

    function reactionFor(targetId) {
        return state.byTarget[targetId] || null;
    }

    function count() {
        return Object.keys(state.byTarget).length;
    }

    /* Mark the card UI. The like button has no id of its own, so it is found
       through its counter (`metric-likes-<id>`), which every page already has
       — that way the six page templates do not need to be changed. */
    function applyState(targetId) {
        if (typeof document === 'undefined' || !document.getElementById) return;
        var span = document.getElementById('metric-likes-' + targetId);
        if (!span) return;
        var btn = span.closest ? span.closest('button') : null;
        if (!btn) return;
        var liked = isLiked(targetId);
        if (btn.classList) btn.classList.toggle('is-liked', liked);
        btn.title = liked ? 'Unlike' : 'Like';
        btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
        var first = btn.childNodes && btn.childNodes[0];
        if (first && first.nodeType === 3) first.nodeValue = liked ? '[\u2665] ' : '[+] ';
    }

    function applyAll() {
        Object.keys(state.byTarget).forEach(applyState);
    }

    /* Re-apply after cards are redrawn (e.g. LOAD MORE). Pages may call this at
       any time; it is safe when there is nothing to do. */
    function refreshUI() {
        applyAll();
    }

    // ------------------------------------------------------------- network
    function closeSockets() {
        state.sockets.forEach(function (s) { try { s.close(); } catch (e) {} });
        state.sockets = [];
    }

    /* The "history" window starts here, NOT in connect(): if it lived in
       connect(), an empty relay list would make that function return early and
       the history phase would never be closed — the counter would then never
       move when another device likes a note. */
    function startHistoryWindow() {
        if (state.timer) { global.clearTimeout(state.timer); state.timer = null; }
        state.historyPhase = state.historyMs > 0;
        if (state.historyPhase) {
            state.timer = global.setTimeout(function () {
                state.historyPhase = false;
                state.timer = null;
            }, state.historyMs);
        }
    }

    function connect() {
        closeSockets();
        if (!state.pubkey || !state.relays.length) return;
        if (typeof global.WebSocket !== 'function') return;

        state.relays.forEach(function (url) {
            var ws;
            try { ws = new global.WebSocket(url); } catch (e) { return; }
            state.sockets.push(ws);
            ws.onopen = function () {
                try {
                    ws.send(JSON.stringify(['REQ', SUB_PREFIX + Math.random().toString(36).slice(2), {
                        kinds: [7, 5], authors: [state.pubkey], limit: state.limit
                    }]));
                } catch (e) {}
            };
            ws.onmessage = function (m) {
                var msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
                if (msg[0] === 'EOSE') { return; }
                if (msg[0] === 'EVENT' && msg[2]) absorb(msg[2]);
            };
            ws.onerror = function () {};
            ws.onclose = function () {};
        });
    }

    /* Process one of our own events (kind 7 like / kind 5 undo). */
    function absorb(ev) {
        if (!ev || ev.pubkey !== state.pubkey) return false;
        if (ev.kind === 7) {
            /* Only likes and loves count (see isLikeContent). A dislike or some
               other emoji is not our "liked" state and must not move it. */
            if (!isLikeContent(ev.content)) return false;
            var target = reactionTarget(ev);
            if (!target) return false;
            state.reactions[ev.id] = target;
            state.reactionTime[ev.id] = ev.created_at || 0;
            // A reaction whose deletion notice we already saw is not counted.
            var result = recomputeTarget(target);
            if (result.before !== result.now) {
                applyState(target);
                if (!state.historyPhase && typeof state.onCount === 'function') state.onCount(target, result.now ? 1 : -1);
            }
            return true;
        }
        if (ev.kind === 5) {
            var ids = eTags(ev);
            var changed = false;
            ids.forEach(function (id) {
                state.deleted[id] = true;
                var target = state.reactions[id];
                if (!target) return;                 // reaction not seen yet; just record it
                var result = recomputeTarget(target);
                if (result.before !== result.now) {
                    applyState(target);
                    if (!state.historyPhase && typeof state.onCount === 'function') state.onCount(target, -1);
                }
                changed = true;
            });
            return changed;
        }
        return false;
    }

    function broadcast(signed) {
        if (typeof state.send === 'function') { try { state.send(signed); return; } catch (e) {} }
        // Fallback: use our own subscription socket if the page gave no `send`.
        state.sockets.forEach(function (s) {
            try { if (s.readyState === 1) s.send(JSON.stringify(['EVENT', signed])); } catch (e) {}
        });
    }

    function signEvent(tpl) {
        if (!global.nostr || typeof global.nostr.signEvent !== 'function') return null;
        return global.nostr.signEvent(tpl);
    }

    // ----------------------------------------------------------------- like
    function like(targetId, targetPubkey) {
        var raw = {
            kind: 7,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['e', targetId, ''], ['p', targetPubkey || '', '']],
            content: '+',
            pubkey: state.pubkey
        };
        return signEvent(raw).then(function (signed) {
            broadcast(signed);
            state.reactions[signed.id] = targetId;
            state.reactionTime[signed.id] = signed.created_at || 0;
            state.byTarget[targetId] = signed.id;
            applyState(targetId);
            if (typeof state.onCount === 'function') state.onCount(targetId, 1);
            return true;
        });
    }

    function unlike(targetId) {
        var reactionId = state.byTarget[targetId];
        if (!reactionId) return Promise.resolve(false);
        var raw = {
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['e', reactionId], ['k', '7']],
            content: '',
            pubkey: state.pubkey
        };
        return signEvent(raw).then(function (signed) {
            broadcast(signed);
            // Mark as deleted and recompute: if another live reaction still
            // exists for this note, the state stays "liked".
            state.deleted[reactionId] = true;
            var result = recomputeTarget(targetId);
            applyState(targetId);
            // If another live reaction remains, the number does not change.
            if (typeof state.onCount === 'function') state.onCount(targetId, result.now ? 0 : -1);
            return result.now;
        });
    }

    /* One button for both directions: not liked -> like, already liked -> undo. */
    function toggle(targetId, targetPubkey) {
        if (!targetId) return Promise.resolve(false);
        if (!state.pubkey) { alert('> ERROR: Not logged in!'); return Promise.resolve(false); }
        if (!global.nostr || typeof global.nostr.signEvent !== 'function') {
            alert('> ERROR: No signer available. Log in first.');
            return Promise.resolve(false);
        }
        if (state.pending[targetId]) return Promise.resolve(isLiked(targetId));
        state.pending[targetId] = true;

        var work = isLiked(targetId) ? unlike(targetId) : like(targetId, targetPubkey);
        return work.then(function (liked) {
            delete state.pending[targetId];
            return liked;
        }).catch(function () {
            delete state.pending[targetId];
            alert('> ERROR: Failed to send. Try again.');
            return isLiked(targetId);
        });
    }

    // --------------------------------------------------------------- setup
    function init(opts) {
        opts = opts || {};
        state.pubkey = opts.pubkey || null;
        state.relays = Array.isArray(opts.relays) ? opts.relays.slice() : [];
        state.send = typeof opts.send === 'function' ? opts.send : null;
        state.onCount = typeof opts.onCount === 'function' ? opts.onCount : null;
        state.onState = typeof opts.onState === 'function' ? opts.onState : null;
        if (typeof opts.historyMs === 'number') state.historyMs = opts.historyMs;
        if (typeof opts.limit === 'number') state.limit = opts.limit;
        startHistoryWindow();
        connect();
        return { pubkey: state.pubkey, relays: state.relays.length };
    }

    function setRelays(list) {
        state.relays = Array.isArray(list) ? list.slice() : [];
    }

    /* For tests: clear the whole state without touching the network. */
    function reset() {
        closeSockets();
        if (state.timer) { global.clearTimeout(state.timer); state.timer = null; }
        state.byTarget = {};
        state.reactions = {};
        state.reactionTime = {};
        state.deleted = {};
        state.pending = {};
        state.pubkey = null;
        state.send = null;
        state.onCount = null;
        state.historyPhase = true;
    }

    // ---------------------------------------------------------------- style
    var CSS = [
        /* A liked button: warm colour + glow, so it clearly differs from the
           other, green buttons. Two classes -> beats .text-success. */
        '.t-feed-btn.is-liked{color:#ff4d6d !important;text-shadow:0 0 8px rgba(255,77,109,0.65);}',
        '.t-feed-btn.is-liked:hover{color:#ff8095 !important;}'
    ];

    function installStyles() {
        if (typeof document === 'undefined' || document.__nostrLikeStyles) return;
        document.__nostrLikeStyles = true;
        var style = document.createElement('style');
        style.setAttribute('data-nostr-like', '1');
        style.textContent = CSS.join('\n');
        (document.head || document.documentElement).appendChild(style);
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installStyles);
        else installStyles();
    }

    var api = {
        init: init,
        setRelays: setRelays,
        reset: reset,
        isLiked: isLiked,
        reactionFor: reactionFor,
        count: count,
        toggle: toggle,
        absorb: absorb,
        refreshUI: refreshUI,
        applyState: applyState,
        isLikeContent: isLikeContent
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrLike = api;
})(typeof window !== 'undefined' ? window : globalThis);
