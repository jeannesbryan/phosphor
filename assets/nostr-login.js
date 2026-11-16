/* The five login flows, in one place.

   Five handlers (extension, bunker, nsec, ncryptsec, unlock) existed in all nine
   pages with up to six variants each. Measuring the differences turned up three real
   bugs, all of which survive only because the code is copied:

   1. Six pages did not check that a pasted key really is an nsec:
          let decoded = nostrTools.nip19.decode(input);
          skBytes = decoded.data;              // no type check
      An npub decodes to 32 bytes, the same length as a secret key, so it is accepted
      and getPublicKey() succeeds with a DIFFERENT identity than the reader asked
      for. Only index, profile and relay checked. Now every flow does.

   2. notifications.html's unlock button never set phosphor_pubkey. The session
      restore requires rawKey AND pubkey, and the locked state has already cleared
      the pubkey, so unlocking on that page could never install a signer. Measured
      with the real session module: it returned 'none' instead of 'restore'.

   3. notifications.html did not remove the legacy phosphor_privkey on a key login
      (3 places, where the other pages had 5). A stale key is a fallback in
      restoreLocalSession, so signing could use a different key than the stored
      pubkey and every event would be rejected by the relay.

   Everything here is plain logic with the storage, the signing tools and the reload
   injected, so all five flows are testable without a browser, a key or a CDN.
*/
(function (global) {
    'use strict';

    var TOOLS = 'https://cdn.jsdelivr.net/npm/nostr-tools@2.24.1/+esm';
    var NIP49 = 'https://cdn.jsdelivr.net/npm/nostr-tools@2.24.1/nip49/+esm';

    function hexFromBytes(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        return s;
    }

    /* Turn what was pasted into secret-key bytes.

       Accepts an nsec (and REFUSES any other bech32 prefix) or 64 hex characters.
       Returning a reason instead of throwing keeps the caller's message honest: the
       reader is told the key is the wrong kind, not "invalid format". */
    function parseSecretInput(input, nip19) {
        var raw = typeof input === 'string' ? input.trim() : '';
        if (!raw) return { ok: false, reason: 'empty' };

        if (raw.indexOf('nsec1') === 0) {
            if (!nip19 || typeof nip19.decode !== 'function') return { ok: false, reason: 'no-nip19' };
            var decoded;
            try { decoded = nip19.decode(raw); } catch (e) { return { ok: false, reason: 'bad-bech32' }; }
            /* THE guard. An npub is also 32 bytes and would otherwise be accepted. */
            if (!decoded || decoded.type !== 'nsec') return { ok: false, reason: 'not-an-nsec' };
            if (!decoded.data || decoded.data.length !== 32) return { ok: false, reason: 'bad-length' };
            return { ok: true, bytes: decoded.data };
        }

        /* Bare bech32 of another kind (npub1..., note1...) is a mistake worth naming. */
        if (/^(npub|note|nprofile|nevent|naddr)1/.test(raw)) return { ok: false, reason: 'not-an-nsec' };

        if (!/^[0-9a-fA-F]{64}$/.test(raw)) return { ok: false, reason: 'not-hex' };
        var bytes = new Uint8Array(32);
        for (var i = 0; i < 32; i++) bytes[i] = parseInt(raw.substr(i * 2, 2), 16);
        return { ok: true, bytes: bytes };
    }

    /* Write the key set for a flow and remove everything that does not belong to it.

       This is the fix for bug 3: the removal list is not optional and not repeated per
       page. `keep` names the storage keys this flow legitimately keeps. */
    var LEGACY_KEY = 'phosphor_privkey';
    var ALL_KEYS = ['phosphor_pubkey', 'phosphor_ncryptsec', 'phosphor_bunker_uri', LEGACY_KEY];
    var SESSION_KEYS = ['phosphor_privkey_temp'];

    function writeSession(storage, session, opts) {
        var write = opts.write || {};
        var keep = opts.keep || [];
        var dropSession = opts.dropSession === true;

        /* The temporary key is SESSION-scoped, so it must never be written to
           localStorage: that would leave a usable secret on disk after the tab
           closes, which is the whole thing sessionStorage exists to avoid. */
        Object.keys(write).forEach(function (k) {
            if (SESSION_KEYS.indexOf(k) !== -1) return;
            storage.setItem(k, write[k]);
        });
        SESSION_KEYS.forEach(function (k) {
            if (dropSession) { session.removeItem(k); return; }
            if (Object.prototype.hasOwnProperty.call(write, k)) { session.setItem(k, write[k]); return; }
            session.removeItem(k);
        });
        ALL_KEYS.forEach(function (k) {
            if (keep.indexOf(k) !== -1) return;
            if (Object.prototype.hasOwnProperty.call(write, k)) return;
            storage.removeItem(k);
        });
    }

    function defaultLoadTools() {
        return Promise.all([import(TOOLS), import(NIP49)]).then(function (m) {
            return { nostrTools: m[0], nip49: m[1] };
        });
    }

    /* The five flows. Each resolves to { ok, pubkey, message } or { ok:false, message }.
       No DOM, no alert, no reload: those belong to the caller. */
    function createFlows(deps) {
        deps = deps || {};
        var storage = deps.storage;
        var session = deps.session;
        var loadTools = deps.loadTools || defaultLoadTools;
        var signer = deps.installSigner || function () { return true; };

        function fail(message) { return { ok: false, message: message }; }

        return {
            /* NIP-07: the extension already holds the key, we only learn the pubkey. */
            extension: function () {
                var ext = deps.getExtension ? deps.getExtension() : global.nostr;
                if (!ext || typeof ext.getPublicKey !== 'function') {
                    return Promise.resolve(fail('> WARNING: NIP-07 extension not found.'));
                }
                return Promise.resolve().then(function () { return ext.getPublicKey(); }).then(function (pubkey) {
                    if (!pubkey) return fail('> ERROR: The extension returned no public key.');
                    writeSession(storage, session, { write: { 'phosphor_pubkey': pubkey }, keep: ['phosphor_pubkey'], dropSession: true });
                    return { ok: true, pubkey: pubkey, message: '> CONNECTION SUCCESSFUL. RELOADING CONFIG...' };
                }).catch(function () {
                    return fail('> ERROR: Login failed.');
                });
            },

            /* NIP-46 bunker: the URI carries the remote signer's pubkey. */
            bunker: function (input) {
                var uri = typeof input === 'string' ? input.trim() : '';
                if (uri.indexOf('bunker://') !== 0) {
                    return Promise.resolve(fail('> ERROR: Invalid Bunker URI format. Must start with bunker://'));
                }
                var pubkey;
                try {
                    var url = new URL(uri);
                    pubkey = url.hostname || url.pathname.replace('//', '');
                } catch (e) {
                    return Promise.resolve(fail('> ERROR: Failed to parse Bunker URI.'));
                }
                if (!pubkey) return Promise.resolve(fail('> ERROR: Failed to parse Bunker URI.'));
                writeSession(storage, session, {
                    write: { 'phosphor_pubkey': pubkey, 'phosphor_bunker_uri': uri },
                    keep: ['phosphor_pubkey', 'phosphor_bunker_uri'],
                    dropSession: true
                });
                return Promise.resolve({ ok: true, pubkey: pubkey, message: '> BUNKER CONNECTED.' });
            },

            /* A pasted secret key, encrypted with a password before it is stored. */
            nsec: function (input, password) {
                if (!input || !password) return Promise.resolve(fail('> ERROR: Both NSEC and Password are required.'));
                return Promise.resolve().then(loadTools).then(function (m) {
                    var parsed = parseSecretInput(input, m.nostrTools && m.nostrTools.nip19);
                    if (!parsed.ok) {
                        return fail(parsed.reason === 'not-an-nsec'
                            ? '> ERROR: That is not a secret key. A public key (npub) cannot be used to log in.'
                            : '> ERROR: Invalid key format.');
                    }
                    var skBytes = parsed.bytes;
                    var pubkey = m.nostrTools.getPublicKey(skBytes);
                    var ncryptsec = m.nip49.encrypt(skBytes, password);
                    signer(pubkey, skBytes, m.nostrTools);
                    writeSession(storage, session, {
                        write: {
                            'phosphor_pubkey': pubkey,
                            'phosphor_ncryptsec': ncryptsec,
                            'phosphor_privkey_temp': hexFromBytes(skBytes)
                        },
                        keep: ['phosphor_pubkey', 'phosphor_ncryptsec'],
                        dropSession: false
                    });
                    return { ok: true, pubkey: pubkey, message: '> LOCAL SIGNER ENCRYPTED. RELOADING CONFIG...' };
                }).catch(function () {
                    return fail('> ERROR: Invalid key format or processing failed.');
                });
            },

            /* An already-encrypted key plus its password. */
            ncryptsec: function (input, password) {
                if (!input || !password) return Promise.resolve(fail('> ERROR: Key and password required.'));
                return Promise.resolve().then(loadTools).then(function (m) {
                    var skBytes = m.nip49.decrypt(input, password);
                    var pubkey = m.nostrTools.getPublicKey(skBytes);
                    signer(pubkey, skBytes, m.nostrTools);
                    writeSession(storage, session, {
                        write: {
                            'phosphor_pubkey': pubkey,
                            'phosphor_ncryptsec': input,
                            'phosphor_privkey_temp': hexFromBytes(skBytes)
                        },
                        keep: ['phosphor_pubkey', 'phosphor_ncryptsec'],
                        dropSession: false
                    });
                    return { ok: true, pubkey: pubkey, message: '> DECRYPTION SUCCESSFUL. RELOADING...' };
                }).catch(function () {
                    return fail('> ERROR: Decryption failed. Incorrect password?');
                });
            },

            /* Reopen a stored encrypted key for this session.

               Sets the pubkey as well as the temporary key. Bug 2 was exactly the
               omission of that line on one page: without it the restore cannot
               install a signer, so unlocking silently did nothing. */
            unlock: function (password) {
                var stored = storage ? storage.getItem('phosphor_ncryptsec') : null;
                if (!password) return Promise.resolve(fail('> ERROR: Password required.'));
                if (!stored) return Promise.resolve(fail('> ERROR: No encrypted key stored.'));
                return Promise.resolve().then(loadTools).then(function (m) {
                    var skBytes = m.nip49.decrypt(stored, password);
                    var pubkey = m.nostrTools.getPublicKey(skBytes);
                    signer(pubkey, skBytes, m.nostrTools);
                    writeSession(storage, session, {
                        write: {
                            'phosphor_pubkey': pubkey,
                            'phosphor_privkey_temp': hexFromBytes(skBytes)
                        },
                        keep: ['phosphor_pubkey', 'phosphor_ncryptsec'],
                        dropSession: false
                    });
                    return { ok: true, pubkey: pubkey, message: '> SESSION UNLOCKED.' };
                }).catch(function () {
                    return fail('> ERROR: Decryption failed. Incorrect password?');
                });
            }
        };
    }

    /* Attach all five buttons, with the same UI around each flow.

       One call per page instead of five copied handlers. A page provides only what
       it alone owns: how to read and write its `currentUserPubkey` binding, and an
       optional onSuccess for extra work it used to do before the reload.
       Buttons the page does not have are skipped. */
    function wireLoginUI(opts) {
        opts = opts || {};
        var doc = opts.document || global.document;
        if (!doc || typeof doc.getElementById !== 'function') return 0;
        var notify = opts.alert || function (m) { if (global.alert) global.alert(m); };
        var reload = opts.reload || function () { if (global.location) global.location.reload(); };
        var after = opts.delay || function (fn, ms) { setTimeout(fn, ms); };
        var setPubkey = opts.setPubkey || function () {};
        var onSuccess = opts.onSuccess;

        var flows = createFlows({
            storage: opts.storage || global.localStorage,
            session: opts.session || global.sessionStorage,
            loadTools: opts.loadTools,
            installSigner: opts.installSigner,
            getExtension: opts.getExtension
        });

        function value(id) {
            var el = doc.getElementById(id);
            return el && typeof el.value === 'string' ? el.value.trim() : '';
        }
        function label(id, text) {
            var el = doc.getElementById(id);
            if (el) el.textContent = text;
        }
        function closeModal(id) {
            var el = doc.getElementById(id);
            if (el && el.style) el.style.display = 'none';
        }

        /* One shape for every flow: busy label, run, report, reload on success. */
        function run(buttonId, busyText, idleText, work) {
            var btn = doc.getElementById(buttonId);
            if (!btn) return;
            /* The promise is RETURNED from the listener: it costs nothing in a
               browser and makes the flow's completion observable, which is the only
               way a test can wait for it instead of guessing a timeout. */
            btn.addEventListener('click', function () {
                label(buttonId, busyText);
                return Promise.resolve().then(work).then(function (result) {
                    if (!result || !result.ok) {
                        notify((result && result.message) || '> ERROR: Login failed.');
                        return;
                    }
                    if (result.pubkey) setPubkey(result.pubkey);
                    if (typeof onSuccess === 'function') {
                        try { onSuccess(result); } catch (e) { /* the page's own failure */ }
                    }
                    closeModal('loginModal');
                    closeModal('unlockModal');
                    notify(result.message);
                    after(reload, 500);
                }).catch(function () {
                    notify('> ERROR: Login failed.');
                }).then(function () {
                    /* finally: the label must go back even when the flow failed. */
                    label(buttonId, idleText);
                });
            });
        }

        var wired = 0;
        function count(id) { if (doc.getElementById(id)) wired++; }

        run('extLoginBtn', '> AUTHORIZING...', '> AUTHORIZE_EXTENSION', function () { return flows.extension(); });
        count('extLoginBtn');

        run('bunkerLoginBtn', '> CONNECTING...', '> CONNECT_BUNKER', function () {
            return flows.bunker(value('bunkerInput'));
        });
        count('bunkerLoginBtn');

        run('nsecLoginBtn', '> PROCESSING...', '> ENCRYPT & LOGIN', function () {
            return flows.nsec(value('nsecInput'), value('nsecPassword'));
        });
        count('nsecLoginBtn');

        run('ncryptsecLoginBtn', '> DECRYPTING...', '> DECRYPT & LOGIN', function () {
            return flows.ncryptsec(value('ncryptsecInput'), value('ncryptsecPassword'));
        });
        count('ncryptsecLoginBtn');

        run('unlockBtn', '> DECRYPTING...', '> DECRYPT', function () {
            return flows.unlock(value('unlockPassword'));
        });
        count('unlockBtn');

        return wired;
    }

    var api = {
        TOOLS_URL: TOOLS,
        NIP49_URL: NIP49,
        parseSecretInput: parseSecretInput,
        hexFromBytes: hexFromBytes,
        writeSession: writeSession,
        createFlows: createFlows,
        wireLoginUI: wireLoginUI,
        ALL_KEYS: ALL_KEYS
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrLogin = api;
})(typeof window !== 'undefined' ? window : globalThis);
