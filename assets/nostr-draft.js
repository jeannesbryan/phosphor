/* NIP-37 drafts, plus a local autosave so a misclick cannot eat an article.

   compose.html wrote a long article into a textarea with no safety net: a reload,
   a closed tab or a stray navigation lost all of it. An article is 16 KB of
   thinking, which is the worst thing in this client to lose.

   Two layers, deliberately separate:

   - LOCAL autosave (always on): the text lands in localStorage as you type, so a
     crash or reload costs at most the last debounce window. No key, no relay.
   - NIP-37 event (kind 31234, addressable): a draft that can be published to a
     relay and continued elsewhere. Building it is pure; publishing is the page's
     job.

   The debounce is injectable so the timing rule can be tested without waiting.
*/
(function (global) {
    'use strict';

    var KIND_DRAFT = 31234;

    /* NIP-37 drafts are addressable, so they need a `d` tag. A stable id per draft
       means editing the same article updates one draft instead of piling up new
       ones. */
    function draftId(existing) {
        if (typeof existing === 'string' && existing.trim()) return existing.trim();
        var rand = '';
        var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        for (var i = 0; i < 12; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
        return 'draft-' + Date.now().toString(36) + '-' + rand;
    }

    function cleanStr(v) {
        return typeof v === 'string' ? v : '';
    }

    /* The unsigned NIP-37 draft. `k` records what the draft is FOR (an article is
       kind 30023), which is what lets a client show it in the right editor. */
    function buildDraftEvent(fields, opts) {
        fields = fields || {};
        opts = opts || {};
        var id = draftId(opts.id);
        var targetKind = Number(opts.targetKind) || 30023;
        var now = typeof opts.now === 'number' && isFinite(opts.now)
            ? Math.floor(opts.now)
            : Math.floor(Date.now() / 1000);

        var payload = {
            title: cleanStr(fields.title),
            slug: cleanStr(fields.slug),
            cover: cleanStr(fields.cover),
            tags: cleanStr(fields.tags),
            summary: cleanStr(fields.summary),
            content: cleanStr(fields.content)
        };

        return {
            kind: KIND_DRAFT,
            created_at: now,
            content: JSON.stringify(payload),
            tags: [['d', id], ['k', String(targetKind)]]
        };
    }

    function isDraftKind(ev) {
        return !!ev && ev.kind === KIND_DRAFT;
    }

    function dTagOf(ev) {
        if (!ev || !Array.isArray(ev.tags)) return null;
        for (var i = 0; i < ev.tags.length; i++) {
            var t = ev.tags[i];
            if (Array.isArray(t) && t[0] === 'd') return typeof t[1] === 'string' ? t[1] : null;
        }
        return null;
    }

    function parseDraft(ev) {
        if (!isDraftKind(ev)) return null;
        var id = dTagOf(ev);
        if (!id) return null;
        var payload;
        try { payload = JSON.parse(ev.content); } catch (e) { return null; }
        if (!payload || typeof payload !== 'object') return null;
        return {
            id: id,
            title: cleanStr(payload.title),
            slug: cleanStr(payload.slug),
            cover: cleanStr(payload.cover),
            tags: cleanStr(payload.tags),
            summary: cleanStr(payload.summary),
            content: cleanStr(payload.content),
            created_at: ev.created_at
        };
    }

    /* Where a draft lives locally. Keyed by pubkey when known, so two identities in
       the same browser do not overwrite each other's work, and by a shared key when
       not logged in, because losing the text is worse than the ambiguity. */
    function localKey(pubkey) {
        return 'phosphor_draft_v1:' + (pubkey ? String(pubkey) : 'anonymous');
    }

    function hasContent(fields) {
        if (!fields) return false;
        return !!(cleanStr(fields.title).trim() || cleanStr(fields.content).trim()
            || cleanStr(fields.summary).trim() || cleanStr(fields.slug).trim());
    }

    /* Storage calls are wrapped because localStorage throws in private modes and
       when the quota is full. A failed autosave must be reported, never silent:
       the page shows it, because "saved" that did not save is worse than nothing. */
    function saveLocal(storage, pubkey, fields, nowMs) {
        if (!storage) return { ok: false, reason: 'no-storage' };
        if (!hasContent(fields)) return { ok: false, reason: 'empty' };
        try {
            storage.setItem(localKey(pubkey), JSON.stringify({
                savedAt: typeof nowMs === 'number' ? nowMs : Date.now(),
                fields: {
                    title: cleanStr(fields.title),
                    slug: cleanStr(fields.slug),
                    cover: cleanStr(fields.cover),
                    tags: cleanStr(fields.tags),
                    summary: cleanStr(fields.summary),
                    content: cleanStr(fields.content)
                }
            }));
            return { ok: true };
        } catch (e) {
            return { ok: false, reason: 'write-failed', error: String(e) };
        }
    }

    function loadLocal(storage, pubkey) {
        if (!storage) return null;
        try {
            var raw = storage.getItem(localKey(pubkey));
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (!parsed || !parsed.fields) return null;
            if (!hasContent(parsed.fields)) return null;
            return { savedAt: parsed.savedAt || null, fields: parsed.fields };
        } catch (e) {
            return null;
        }
    }

    function clearLocal(storage, pubkey) {
        if (!storage) return false;
        try { storage.removeItem(localKey(pubkey)); return true; }
        catch (e) { return false; }
    }

    /* Debounce with the clock injected. `fn` receives the latest arguments, so a
       burst of keystrokes results in ONE save of the final state. */
    function createDebouncer(fn, delay, opts) {
        opts = opts || {};
        var schedule = opts.schedule || function (f, ms) { return setTimeout(f, ms); };
        var cancel = opts.cancel || function (h) { if (h) clearTimeout(h); };
        var handle = null;
        var pendingArgs = null;
        /* Compared against null, not tested for truthiness: a scheduler may return
           0 or -1, and `if (!handle)` would treat that live handle as "nothing
           pending", silently losing the save. */
        return {
            trigger: function () {
                pendingArgs = Array.prototype.slice.call(arguments);
                if (handle !== null) cancel(handle);
                handle = schedule(function () {
                    handle = null;
                    var args = pendingArgs;
                    pendingArgs = null;
                    fn.apply(null, args);
                }, delay);
            },
            flush: function () {
                if (handle === null) return false;
                cancel(handle);
                handle = null;
                var args = pendingArgs || [];
                pendingArgs = null;
                fn.apply(null, args);
                return true;
            },
            cancel: function () {
                if (handle !== null) cancel(handle);
                handle = null;
                pendingArgs = null;
            },
            isPending: function () { return handle !== null; }
        };
    }

    var api = {
        KIND_DRAFT: KIND_DRAFT,
        draftId: draftId,
        buildDraftEvent: buildDraftEvent,
        isDraftKind: isDraftKind,
        dTagOf: dTagOf,
        parseDraft: parseDraft,
        localKey: localKey,
        hasContent: hasContent,
        saveLocal: saveLocal,
        loadLocal: loadLocal,
        clearLocal: clearLocal,
        createDebouncer: createDebouncer
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrDraft = api;
})(typeof window !== 'undefined' ? window : globalThis);
