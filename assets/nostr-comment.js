/* ==========================================================================
   nostr-comment.js — NIP-22 comments (kind 1111).

   Why this file exists
   --------------------
   Phosphor only knew NIP-10 replies: kind 1 notes that point at another note
   through `e` tags with root/reply markers. NIP-22 defines a separate thing —
   kind 1111 — where a comment is scoped to a *root* item and may hang off a
   *parent* item, and the two are told apart by tag CASE:

       ["E", <root id>]     uppercase = the root scope
       ["K", "30023"]       the root's kind        (MUST be present)
       ["P", <root author>]
       ["e", <parent id>]   lowercase = the item being replied to
       ["k", "1111"]        the parent's kind      (MUST be present)
       ["p", <parent author>]

   A top-level comment has the same value in `E` and `e`. A reply to a comment
   keeps the original root in `E` and puts the comment in `e`.

   ⚠️ THE TRAP THIS FILE EXISTS TO AVOID
   The NIP-10 marker logic reads `tag[3]` as "root"/"reply"/"mention". A real
   NIP-22 tag looks like this:

       ["e", "<id>", "wss://relay", "<pubkey>"]

   `tag[3]` is a *pubkey*, which is truthy, so marker logic concludes "this is
   a marked tag that matches nothing" and returns null. Every kind 1111
   comment was therefore treated as not-a-reply and silently dropped, even
   after the events arrived. Comments are read here by tag name and casing
   instead, never by position-based markers.

   Scope can also be external (a URL, a podcast episode) via `I`/`i` and
   `K`/`k` with values from NIP-73. Those are parsed so a comment on a web
   page is not mistaken for a comment on an event.
   ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.NostrComment = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var KIND = 1111;

    function isComment(ev) {
        return !!ev && ev.kind === KIND;
    }

    function esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    /* First tag with this name, as an array. Only well-formed tags count: the
       name and the value must both be non-empty strings. */
    function tagOf(ev, name) {
        if (!ev || !Array.isArray(ev.tags)) return null;
        for (var i = 0; i < ev.tags.length; i++) {
            var t = ev.tags[i];
            if (Array.isArray(t) && t[0] === name && typeof t[1] === 'string' && t[1]) return t;
        }
        return null;
    }

    /* Is the value a plain kind number? Guards against "K" carrying junk. */
    function kindOf(value) {
        if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) return null;
        var n = parseInt(value, 10);
        return n > 0 ? n : null;
    }

    /* Scope of a comment. Returns null for events that are not comments.

       `ok` says whether the event satisfies the parts the spec makes
       mandatory (K and k, plus some way to identify both items). Rendering
       stays lenient — a comment with a missing K is still worth showing — but
       the flag lets a caller warn instead of pretending the data is sound.
       Publishing is strict (see buildTags). */
    function parse(ev) {
        if (!isComment(ev)) return null;

        var out = {
            kind: KIND,
            root: { id: null, kind: null, address: null, pubkey: null, relay: null },
            parent: { id: null, kind: null, address: null, pubkey: null, relay: null },
            external: { I: null, i: null },
            issues: [],
            topLevel: false,
            ok: true
        };

        // ---- root scope: uppercase tags ----
        var E = tagOf(ev, 'E');
        var A = tagOf(ev, 'A');
        var K = tagOf(ev, 'K');
        var P = tagOf(ev, 'P');
        // ---- parent item: lowercase tags ----
        var e = tagOf(ev, 'e');
        var a = tagOf(ev, 'a');
        var k = tagOf(ev, 'k');
        var p = tagOf(ev, 'p');
        // ---- external scope (NIP-73) ----
        var I = tagOf(ev, 'I');
        var i = tagOf(ev, 'i');

        if (E) { out.root.id = E[1]; out.root.relay = E[2] || null; }
        if (A) { out.root.address = A[1]; out.root.relay = A[2] || null; }
        if (K) out.root.kind = kindOf(K[1]);
        if (P) out.root.pubkey = P[1];

        if (e) { out.parent.id = e[1]; out.parent.relay = e[2] || null; }
        if (a) { out.parent.address = a[1]; out.parent.relay = a[2] || null; }
        if (k) out.parent.kind = kindOf(k[1]);
        if (p) out.parent.pubkey = p[1];

        if (I) out.external.I = I[1];
        if (i) out.external.i = i[1];

        /* Comments that point at an addressable item carry its address in A
           and its id in E; comments that point at a replaceable event may
           carry only the address. */
        if (out.root.address && !out.root.id) out.root.addressOnly = true;

        // ---- spec checks ----
        if (!K) out.issues.push('missing K (root kind)');
        else if (out.root.kind == null) out.issues.push('K is not a kind number');

        if (!k) out.issues.push('missing k (parent kind)');
        else if (out.parent.kind == null) out.issues.push('k is not a kind number');

        var hasRoot = !!(out.root.id || out.root.address || out.external.I);
        var hasParent = !!(out.parent.id || out.parent.address || out.external.i);
        if (!hasRoot) out.issues.push('no root reference (E/A/I)');
        if (!hasParent) out.issues.push('no parent reference (e/a/i)');

        out.ok = out.issues.length === 0;

        /* Top level = the parent IS the root. Compare by the strongest
           identifier available so an address-only root still works. */
        out.topLevel = isTopLevelByScope(out);

        return out;
    }

    function isTopLevelByScope(scope) {
        if (!scope) return false;
        if (scope.external.I && scope.external.i) return scope.external.I === scope.external.i;
        if (scope.root.address && scope.parent.address) return scope.root.address === scope.parent.address;
        if (scope.root.id && scope.parent.id) return scope.root.id === scope.parent.id;
        return false;
    }

    /* The event id of the root, when the comment names one. */
    function rootId(ev) {
        var s = parse(ev);
        return s ? s.root.id : null;
    }

    /* The event id of the item being replied to. */
    function parentId(ev) {
        var s = parse(ev);
        return s ? s.parent.id : null;
    }

    function rootKind(ev) {
        var s = parse(ev);
        return s ? s.root.kind : null;
    }

    function parentKind(ev) {
        var s = parse(ev);
        return s ? s.parent.kind : null;
    }

    function isTopLevel(ev) {
        var s = parse(ev);
        return s ? s.topLevel : false;
    }

    /* A comment that hangs directly off `id` — the NIP-22 equivalent of a
       level-one reply. Works for both shapes:
         - top level:  E == e == id
         - first level: E == id, e == some other comment (must be excluded)
       When the root has an address but no id (address-only scope), fall back
       to matching the parent id we do have. */
    function isDirectComment(ev, id) {
        if (!id) return false;
        var s = parse(ev);
        if (!s) return false;

        /* The question is only ever "is the PARENT this item", so compare the
           parent — in every shape it exists:
             top level     -> e == E == id      (parent is the root)
             reply         -> e == the comment  (parent is that comment)
             address-only  -> a/i carries it    (no ids involved)
           Comparing against the root instead would make a reply-to-comment
           look like it hung off the original note. */
        if (s.parent.id) return s.parent.id === id;
        if (s.parent.address) return s.parent.address === id;
        if (s.external.i) return s.external.i === id;
        return false;
    }

    /* Tags for publishing a comment. Strict: throws rather than produce an
       event that violates the spec's MUST rules, because a malformed comment
       lands in other clients' databases and cannot be taken back.

         opts = {
           rootId, rootKind, rootPubkey, rootRelay, rootAddress,
           parentId, parentKind, parentPubkey, parentRelay, parentAddress
         }

       For a top-level comment, omit the parent* fields: they are copied from
       the root, which is exactly what the spec's own examples do. */
    function buildTags(opts) {
        opts = opts || {};

        var rootKindNum = kindOf(String(opts.rootKind == null ? '' : opts.rootKind));
        if (rootKindNum == null) throw new Error('NIP-22: rootKind is required');

        if (!opts.rootId && !opts.rootAddress) throw new Error('NIP-22: root needs an id or an address');

        var parentIsRoot = !opts.parentId && !opts.parentAddress;
        var tags = [];

        /* ---- root scope (uppercase) ---- */
        if (opts.rootAddress) tags.push(['A', String(opts.rootAddress)].concat(opts.rootRelay ? [opts.rootRelay] : []));
        if (opts.rootId) tags.push(['E', String(opts.rootId)].concat(opts.rootRelay ? [opts.rootRelay] : []));
        tags.push(['K', String(rootKindNum)]);
        if (opts.rootPubkey) tags.push(['P', String(opts.rootPubkey)].concat(opts.rootRelay ? [opts.rootRelay] : []));

        /* ---- parent item (lowercase) ---- */
        var parentKindNum = parentIsRoot
            ? rootKindNum
            : kindOf(String(opts.parentKind == null ? '' : opts.parentKind));
        if (parentKindNum == null) throw new Error('NIP-22: parentKind is required when the parent is not the root');

        var pId = parentIsRoot ? opts.rootId : opts.parentId;
        var pAddr = parentIsRoot ? opts.rootAddress : opts.parentAddress;
        var pPub = parentIsRoot ? opts.rootPubkey : opts.parentPubkey;
        var pRelay = parentIsRoot ? opts.rootRelay : opts.parentRelay;

        if (pAddr) tags.push(['a', String(pAddr)].concat(pRelay ? [pRelay] : []));
        if (pId) tags.push(['e', String(pId)].concat(pRelay ? [pRelay] : []));
        tags.push(['k', String(parentKindNum)]);
        if (pPub) tags.push(['p', String(pPub)].concat(pRelay ? [pRelay] : []));

        return tags;
    }

    /* Which kinds a thread page must ask for to receive comments on `kind`.
       Comments are their own kind, but a relay filter cannot express "kind
       1111 whose E equals this id" any differently than via #e, so the caller
       merges this list into the reply subscription. */
    function replyKinds() {
        return [1, KIND];
    }

    /* Human label for the badge. Keeps "comment" distinct from "reply" so a
       reader can tell NIP-22 from NIP-10 at a glance. */
    function describe(ev) {
        var s = parse(ev);
        if (!s) return null;
        if (s.topLevel) return 'COMMENT';
        return 'COMMENT_REPLY';
    }

    /* Short scope description for the UI, e.g. "on video_stream" or "on web".
       Falls back to null when the kind is unknown. */
    function scopeLabel(kind) {
        if (typeof kind !== 'number') return null;
        var map = {
            1: 'text_note', 20: 'picture_event', 21: 'video_stream', 22: 'short_video',
            30023: 'long_form_article', 1111: 'comment', 30000: 'addressable',
            30001: 'addressable', 33400: 'web_app', 34235: 'video_stream', 34236: 'short_video'
        };
        if (map[kind]) return map[kind];
        if (kind >= 30000 && kind < 40000) return 'addressable';
        return 'kind_' + kind;
    }

    return {
        KIND: KIND,
        isComment: isComment,
        parse: parse,
        rootId: rootId,
        parentId: parentId,
        rootKind: rootKind,
        parentKind: parentKind,
        isTopLevel: isTopLevel,
        isDirectComment: isDirectComment,
        buildTags: buildTags,
        replyKinds: replyKinds,
        describe: describe,
        scopeLabel: scopeLabel,
        esc: esc
    };
});
