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

    var api = {
        TOOLS_URL: TOOLS_URL,
        hexToBytes: hexToBytes,
        installLocalSigner: installLocalSigner,
        restoreLocalSession: restoreLocalSession
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrSession = api;
})(typeof window !== 'undefined' ? window : globalThis);
