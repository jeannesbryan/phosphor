/* ==========================================================================
   nostr-report.js — NIP-56 reports (kind 1984).

   What a report is
   ----------------
   A kind 1984 event saying "this thing is objectionable", pointing at a note
   (`e`), a person (`p`) or a blob (`x`). The spec requires a report *type* as
   the THIRD entry of the tag being reported:

       ["e", "<note id>", "spam"]
       ["p", "<pubkey>",  "nudity"]

   Types: nudity, malware, profanity, illegal, spam, impersonation, other.
   Reporting a note also requires a `p` tag for its author. Reporting a blob
   (`x`) requires an `e` tag for the event that carries it, and may add a
   `server` tag naming where the blob lives.

   Two decisions this file makes on purpose
   ----------------------------------------
   1. A REPORT IS ALWAYS THE USER'S OWN ACTION. Nothing here reports anything
      on its own: buildTags() only assembles what the person in front of the
      screen explicitly confirmed. Auto-reporting would be a way to get a
      stranger's account flagged without their knowledge, and the API is shaped
      so that it cannot happen by accident.

   2. REPORTS READ FROM THE NETWORK NEVER HIDE CONTENT. The spec's own note is
      the reason: "It is not recommended that relays perform automatic
      moderation using reports, as they can be easily gamed." A report costs
      one event, so anyone can file a thousand of them; a client that blurs or
      hides on that signal hands a griefing tool to whoever is most motivated.
      We therefore read reports only to know what the CURRENT USER already
      reported — so they do not file duplicates, and so the state follows them
      to another device instead of living only in one browser.

   ⚠️ `x` (blob) reports carry the sha256 from an event's NIP-92 `imeta` tag
   when it is available, so reporting a picture does not require downloading
   it just to hash it.
   ========================================================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.NostrReport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var KIND = 1984;

    var TYPES = ['nudity', 'malware', 'profanity', 'illegal', 'spam', 'impersonation', 'other'];

    /* Short descriptions shown in the picker. Kept next to the type list so a
       new type cannot be added without saying what it means. */
    var TYPE_LABELS = {
        nudity: 'nudity / explicit imagery',
        malware: 'malware or a dangerous file',
        profanity: 'profanity or hateful speech',
        illegal: 'possibly illegal content',
        spam: 'spam',
        impersonation: 'pretending to be someone else',
        other: 'something else'
    };

    function isReport(ev) {
        return !!ev && ev.kind === KIND;
    }

    function isValidType(t) {
        return typeof t === 'string' && TYPES.indexOf(t) !== -1;
    }

    function safeUrl(src) {
        if (typeof src !== 'string' || !src) return null;
        if (/["'<>\\\s]/.test(src)) return null;
        return /^https?:\/\//i.test(src) ? src : null;
    }

    /* A stable key for "this thing", used to remember what the user already
       reported. A note key prefers the note id; a profile key uses the pubkey. */
    function targetKey(opts) {
        opts = opts || {};
        if (opts.eventId) return 'e:' + opts.eventId;
        if (opts.blobHash) return 'x:' + opts.blobHash;
        if (opts.pubkey) return 'p:' + opts.pubkey;
        return null;
    }

    /* Tags for a report.

         opts = { type, pubkey, eventId, blobHash, server }

       Throws instead of producing a report the spec would reject: a malformed
       report still costs a signature, still lands in other clients, and makes
       the reporting user look careless. The spec's MUSTs are enforced here:
         - a known type, as the 3rd entry of the tag being reported
         - a `p` tag for the author when a note is reported
         - an `e` tag whenever an `x` blob is reported */
    function buildTags(opts) {
        opts = opts || {};

        if (!isValidType(opts.type)) {
            throw new Error('NIP-56: type must be one of ' + TYPES.join(', '));
        }
        if (!opts.eventId && !opts.blobHash && !opts.pubkey) {
            throw new Error('NIP-56: nothing to report (need a note, a blob or a pubkey)');
        }
        if (opts.blobHash && !opts.eventId) {
            throw new Error('NIP-56: a blob report must also name the event that carries it');
        }

        var type = opts.type;
        var tags = [];

        /* The tag being reported carries the type. */
        if (opts.eventId) tags.push(['e', String(opts.eventId), type]);
        if (opts.blobHash) tags.push(['x', String(opts.blobHash), type]);

        /* The author is required for a note report. When only a profile is
           being reported, the `p` tag IS the thing reported and carries the
           type itself (the spec's profile example does exactly that). */
        if (opts.pubkey) {
            if (opts.eventId || opts.blobHash) tags.push(['p', String(opts.pubkey)]);
            else tags.push(['p', String(opts.pubkey), type]);
        } else if (opts.eventId) {
            throw new Error('NIP-56: a note report must also name its author');
        }

        var server = safeUrl(opts.server);
        if (server) tags.push(['server', server]);

        return tags;
    }

    /* The sha256 of the first blob an event declares in its NIP-92 `imeta`
       tags. Reporting a picture then costs nothing extra: the hash is already
       in the event, so there is no need to download the file to compute it.
       Returns null when no blob hash is declared. */
    function blobHashOf(ev) {
        if (!ev || !Array.isArray(ev.tags)) return null;
        for (var i = 0; i < ev.tags.length; i++) {
            var t = ev.tags[i];
            if (!Array.isArray(t) || t[0] !== 'imeta') continue;
            for (var j = 1; j < t.length; j++) {
                if (typeof t[j] !== 'string') continue;
                if (t[j].indexOf('x ') !== 0) continue;
                var hash = t[j].slice(2).trim();
                if (/^[0-9a-f]{64}$/i.test(hash)) return hash;
            }
        }
        return null;
    }

    /* Read a kind 1984 event. Returns null when it is not a report.

       `ok` and `issues` describe whether it satisfies the spec. Rendering stays
       tolerant — an old or sloppy report is still readable — but the caller
       knows when the data is unsound instead of pretending otherwise. */
    function parse(ev) {
        if (!isReport(ev)) return null;

        var out = {
            kind: KIND,
            targets: [],          // [{ tag: 'e'|'p'|'x', value, type }]
            server: null,
            note: typeof ev.content === 'string' ? ev.content : '',
            issues: [],
            ok: true
        };

        if (!Array.isArray(ev.tags)) {
            out.issues.push('no tags');
            out.ok = false;
            return out;
        }

        var hasE = false, hasP = false, hasX = false;

        ev.tags.forEach(function (t) {
            if (!Array.isArray(t) || typeof t[0] !== 'string') return;
            var name = t[0];
            if (name !== 'e' && name !== 'p' && name !== 'x' && name !== 'server') return;
            if (typeof t[1] !== 'string' || !t[1]) return;

            if (name === 'server') { out.server = safeUrl(t[1]); return; }

            var type = typeof t[2] === 'string' && t[2] ? t[2] : null;
            if (name === 'e') hasE = true;
            if (name === 'p') hasP = true;
            if (name === 'x') hasX = true;
            out.targets.push({ tag: name, value: t[1], type: type });
        });

        if (!out.targets.length) out.issues.push('no e/p/x target');
        if (!hasP) out.issues.push('missing p tag (the spec requires the reported author)');
        if (hasX && !hasE) out.issues.push('x blob without an e tag naming its event');

        /* A report must say WHY. The type lives on the tag being reported, so
           require at least one typed target. */
        var typed = out.targets.filter(function (t) { return isValidType(t.type); });
        if (!typed.length) {
            var anyType = out.targets.some(function (t) { return !!t.type; });
            out.issues.push(anyType ? 'unknown report type' : 'no report type');
        }
        out.types = typed.map(function (t) { return t.type; });

        out.ok = out.issues.length === 0;
        return out;
    }

    /* The primary type of a report, for display. */
    function primaryType(ev) {
        var p = parse(ev);
        return p && p.types.length ? p.types[0] : null;
    }

    /* ---- what the current user has already reported ---------------------- */

    /* Keyed by targetKey(); the value records the type and when it happened, so
       the UI can say "you reported this as spam" instead of a bare flag. */
    var mine = {};

    /* Fold reports into "what I already reported".

       Passing `myPubkey` is what makes this safe: anything signed by someone
       else is ignored, so a caller cannot accidentally treat a stranger's
       report as the user's own (which would then block the user from reporting
       that item themselves). Callers that already filtered by author may omit
       it, but the pages pass it. */
    function absorbOwn(events, myPubkey) {
        if (!Array.isArray(events)) return 0;
        var added = 0;
        events.forEach(function (ev) {
            if (myPubkey && ev && ev.pubkey && ev.pubkey !== myPubkey) return;
            if (myPubkey && ev && !ev.pubkey) return;
            var p = parse(ev);
            if (!p || !p.ok) return;
            p.targets.forEach(function (t) {
                if (!isValidType(t.type)) return;
                var key = t.tag + ':' + t.value;
                if (mine[key]) return;
                mine[key] = { type: t.type, at: ev.created_at || 0 };
                added++;
            });
        });
        return added;
    }

    function hasReported(opts) {
        var key = targetKey(opts);
        if (!key) return null;
        return mine[key] || null;
    }

    function markReported(opts, type, at) {
        var key = targetKey(opts);
        if (!key || !isValidType(type)) return null;
        mine[key] = { type: type, at: at || Math.floor(Date.now() / 1000) };
        return mine[key];
    }

    function forgetAll() { mine = {}; }
    function all() { return mine; }

    /* Persist to localStorage so a reload does not forget. Storage can be
       unavailable (private mode, quota) — that must not break reporting. */
    function load(storage) {
        if (!storage || typeof storage.getItem !== 'function') return 0;
        try {
            var raw = storage.getItem('myReports');
            if (!raw) return 0;
            var parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return 0;
            Object.keys(parsed).forEach(function (k) {
                var v = parsed[k];
                if (v && isValidType(v.type)) mine[k] = { type: v.type, at: v.at || 0 };
            });
            return Object.keys(mine).length;
        } catch (e) { return 0; }
    }

    function save(storage) {
        if (!storage || typeof storage.setItem !== 'function') return false;
        try { storage.setItem('myReports', JSON.stringify(mine)); return true; }
        catch (e) { return false; }
    }

    /* Labels for the picker. Returned as a copy so a caller cannot mutate the
       module's list. */
    function typeOptions() {
        return TYPES.map(function (t) { return { value: t, label: TYPE_LABELS[t] || t }; });
    }

    return {
        KIND: KIND,
        TYPES: TYPES,
        TYPE_LABELS: TYPE_LABELS,
        isReport: isReport,
        isValidType: isValidType,
        typeOptions: typeOptions,
        targetKey: targetKey,
        blobHashOf: blobHashOf,
        buildTags: buildTags,
        parse: parse,
        primaryType: primaryType,
        absorbOwn: absorbOwn,
        hasReported: hasReported,
        markReported: markReported,
        forgetAll: forgetAll,
        all: all,
        load: load,
        save: save
    };
});
