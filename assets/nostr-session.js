/* Local session restore, in one place.

   Was nine copies of `checkLocalSessions` plus nine of `setupLocalNostrMock`, and
   hashing them showed THREE separate behaviours hiding behind nearly identical
   code:

     index.html         restored the key, logged the failure, and never cleared a
                        stale pubkey
     notifications.html read only the raw key (never the encrypted one), empty catch
     the other seven    restored, empty catch, AND cleared a stale pubkey

   The last one is the correct behaviour. The other two leave the page looking
   signed in while no signer exists, so every button that needs a signature fails
   for no visible reason. That divergence was invisible while the code was copied.

   The split here is deliberate, and it is the state lifting that made this
   extractable at all:

   - the MODULE decides what should happen and returns a result
   - the PAGE applies it, because `currentUserPubkey` is a page-level binding the
     module cannot reassign

   That keeps the decision testable while the state stays where it already lives.
*/
(function (global) {
    'use strict';

    var TOOLS_URL = 'https://cdn.jsdelivr.net/npm/nostr-tools@2.24.1/+esm';

    /* Turn a hex secret into bytes. Returns null for anything that is not hex,
       rather than producing a silently wrong key. */
    function hexToBytes(hex) {
        if (typeof hex !== 'string' || !hex.length) return null;
        if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
        if (hex.length % 2 !== 0) return null;
        var out = new Uint8Array(hex.length / 2);
        for (var i = 0; i < out.length; i++) {
            out[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        return out;
    }

    /* Install the in-page signer. Kept separate from the restore logic so it can be
       used on its own, and so the object it builds is assertable. */
    function installLocalSigner(pubkeyHex, secretKeyBytes, nostrTools) {
        if (!pubkeyHex || !secretKeyBytes || !nostrTools || typeof nostrTools.finalizeEvent !== 'function') {
            return false;
        }
        global.nostr = {
            getPublicKey: function () { return Promise.resolve(pubkeyHex); },
            signEvent: function (eventTemplate) {
                return Promise.resolve(nostrTools.finalizeEvent(eventTemplate, secretKeyBytes));
            }
        };
        return true;
    }

    /* What the page should do, given what is in storage.

       Reading keys is injected so this can be tested without a browser, and because
       sessionStorage/localStorage throw in some privacy modes and must not crash a
       page load.

         read(key)          -> string|null
         hasExtensionSigner -> boolean, whether a signer already exists
         pubkey             -> the pubkey the page currently believes it has
         loadTools()        -> Promise of nostrTools (defaults to the CDN import)
         log                -> optional, receives the failure

       Resolves to:
         { action: 'restore' }                  signer installed
         { action: 'none' }                     nothing to do
         { action: 'clear-pubkey' }             stale: the page must forget the pubkey
         { action: 'restore-failed', error }    key present but unusable
         { action: 'no-tools', error }          the module could not be loaded
    */
    function restoreLocalSession(opts) {
        opts = opts || {};
        var read = opts.read;
        if (typeof read !== 'function') return Promise.resolve({ action: 'none' });

        var rawHex = null, savedNcryptsec = null;
        try {
            rawHex = read('phosphor_privkey_temp');
            if (!rawHex) rawHex = read('phosphor_privkey');
            savedNcryptsec = read('phosphor_ncryptsec');
        } catch (e) {
            /* Unreadable storage is not a crash: treat it as "nothing saved". */
            rawHex = null;
            savedNcryptsec = null;
        }

        var pubkey = opts.pubkey || null;
        var hasSigner = !!opts.hasExtensionSigner;

        if (rawHex && pubkey) {
            var bytes = hexToBytes(rawHex);
            if (!bytes) return Promise.resolve({ action: 'restore-failed', error: 'bad-key-hex' });
            var load = opts.loadTools || function () { return import(TOOLS_URL); };
            return Promise.resolve().then(load).then(function (tools) {
                var installed = installLocalSigner(pubkey, bytes, tools);
                if (!installed) return { action: 'restore-failed', error: 'tools-incomplete' };
                return { action: 'restore' };
            }).catch(function (e) {
                if (typeof opts.log === 'function') opts.log(e);
                return { action: 'no-tools', error: String(e) };
            });
        }

        /* A saved encrypted key with no raw key and no signer means the page cannot
           sign anything. Showing a signed-in UI in that state is the bug this
           branch exists to prevent. */
        if (savedNcryptsec && !hasSigner && !rawHex) {
            return Promise.resolve({ action: 'clear-pubkey' });
        }

        return Promise.resolve({ action: 'none' });
    }

    /* The four login tabs. Was byte-identical in all nine pages, which is the only
       part of the login form that could be lifted safely (see the note in this
       file's header about the handlers). */
    var LOGIN_TABS = ['ext', 'bunker', 'nsec', 'ncryptsec'];

    function loginViewId(tab) { return 'view' + tab.charAt(0).toUpperCase() + tab.slice(1); }
    function loginTabId(tab) { return 'tab' + tab.charAt(0).toUpperCase() + tab.slice(1); }

    /* Show one tab and hide the rest. Returns false when the page does not have the
       elements, so a page without a login form cannot throw on a stray call. */
    function switchLoginTab(tab, root) {
        var doc = (root && root.ownerDocument) || root || global.document;
        if (!doc || typeof doc.getElementById !== 'function') return false;
        if (LOGIN_TABS.indexOf(tab) === -1) return false;

        var i, el;
        for (i = 0; i < LOGIN_TABS.length; i++) {
            el = doc.getElementById(loginViewId(LOGIN_TABS[i]));
            if (el && el.classList) el.classList.add('hidden');
            el = doc.getElementById(loginTabId(LOGIN_TABS[i]));
            if (el && el.classList) el.classList.add('ghost');
        }
        /* The page must actually HAVE this form. Reporting success on a page with no
           login form would hide the fact that nothing was switched. */
        var view = doc.getElementById(loginViewId(tab));
        if (!view) return false;
        if (view.classList) view.classList.remove('hidden');
        el = doc.getElementById(loginTabId(tab));
        if (el && el.classList) el.classList.remove('ghost');
        return true;
    }

    /* What a logout must clear.

       index.html keeps one extra key (`phosphor_following`, a cached follow list
       only that page reads), which is why its logoutFully differed. Rather than
       fork the function, the standard list lives here and a page passes its extras:
       one definition of "what a logout clears", and no page can forget the list.
       Leaving the follow cache behind on a shared machine is the kind of leak this
       prevents. */
    var LOGOUT_KEYS = [
        'phosphor_pubkey',
        'phosphor_privkey',
        'phosphor_ncryptsec',
        'phosphor_bunker_uri',
        /* Not a credential, and that is exactly why it was being missed. It maps
           "local@domain|pubkey" to valid/invalid, so after a logout it still lists
           which NIP-05 identities were verified from this browser. Written by the
           shared nostr-nip05 module, used by seven pages, so it belongs in the
           standard list rather than in a page's extras. */
        'phosphor_nip05_cache_v1'
    ];
    var LOGOUT_SESSION_KEYS = ['phosphor_privkey_temp'];

    function logoutKeys(extra) {
        var out = LOGOUT_KEYS.slice();
        (extra || []).forEach(function (k) {
            if (out.indexOf(k) === -1) out.push(k);
        });
        return out;
    }

    /* Clears everything a logout should, then reports what actually changed so a
       page can tell "nothing to clear" from "clearing failed". */
    function clearSession(storage, session, extra, reload) {
        var cleared = [];
        var failed = [];
        logoutKeys(extra).forEach(function (k) {
            try {
                if (storage) storage.removeItem(k);
                cleared.push(k);
            } catch (e) { failed.push(k); }
        });
        (LOGOUT_SESSION_KEYS || []).forEach(function (k) {
            try {
                if (session) session.removeItem(k);
                cleared.push(k);
            } catch (e) { failed.push(k); }
        });
        if (typeof reload === 'function') {
            try { reload(); } catch (e) { /* reload is best effort */ }
        }
        return { cleared: cleared, failed: failed };
    }

    var api = {
        TOOLS_URL: TOOLS_URL,
        LOGIN_TABS: LOGIN_TABS,
        switchLoginTab: switchLoginTab,
        LOGOUT_KEYS: LOGOUT_KEYS,
        logoutKeys: logoutKeys,
        clearSession: clearSession,
        hexToBytes: hexToBytes,
        installLocalSigner: installLocalSigner,
        restoreLocalSession: restoreLocalSession
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrSession = api;
})(typeof window !== 'undefined' ? window : globalThis);
