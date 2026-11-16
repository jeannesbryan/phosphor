/* Which session state the page is in, and what the shared navigation must look like.

   updateAuthState existed nine times with THREE different behaviours hiding behind
   nearly identical code. Measured on 2026-11-16:

     index, profile, thread, notes, bookmark, relay   all three states handled
     compose, activity                                logged-out case forgot to hide
                                                      the UNLOCK button
     notifications                                    had NO logged-out branch at all

   The last two are bugs, not choices. In notifications the navigation kept whatever
   was rendered before, so after a logout the UNLOCK button could stay visible with
   nothing to unlock. In compose and activity the same thing happened on the button
   specifically. Both are fixed by making the three states mandatory here.

   Scope, deliberately narrow: only the six navigation elements that exist on ALL
   nine pages with identical semantics. Everything else differs by page (the composer
   on index, the reply box on thread and notes, the profile action buttons, the
   editor container) and stays with the page through callbacks. A single declarative
   table for all nine would have meant touching every page at once for no gain.
*/
(function (global) {
    'use strict';

    var LOCKED = 'locked';
    var IN = 'in';
    var OUT = 'out';

    /* The state from storage. Reading is injected so this can be tested without a
       browser, and because storage throws in some privacy modes.

       'locked' means an encrypted key is stored but the session has not been
       unlocked, which is a real third state: the reader is known but cannot sign. */
    function sessionState(opts) {
        opts = opts || {};
        var read = opts.read;
        if (typeof read !== 'function') return OUT;
        var ncryptsec = null, temp = null;
        try {
            ncryptsec = read('phosphor_ncryptsec');
            temp = read('phosphor_privkey_temp');
        } catch (e) {
            return OUT;
        }
        if (ncryptsec && !temp) return LOCKED;
        if (opts.pubkey) return IN;
        return OUT;
    }

    /* Apply the shared navigation for a state.

       Every one of the six elements is set in every branch. That is the point: the
       bug in compose/activity was a branch that set some of them, and the bug in
       notifications was a branch that did not exist. Here a state either sets all six
       or fails loudly, there is no third option.

         opts.document   defaults to the global document
         opts.state      LOCKED / IN / OUT, already computed
         opts.onLocked() / onLoggedIn() / onLoggedOut()   page extras

       Returns the state applied, so a caller can branch on it without recomputing. */
    function apply(opts) {
        opts = opts || {};
        var doc = opts.document || global.document;
        if (!doc || typeof doc.getElementById !== 'function') return null;

        var state = opts.state;
        if (state !== LOCKED && state !== IN && state !== OUT) return null;

        /* [login, unlock, logout, bookmark, notif, modal] per state. */
        var plan = {};
        plan[LOCKED] = { login: false, unlock: true, logout: false, bookmark: false, notif: false, modal: true };
        plan[IN] = { login: false, unlock: false, logout: true, bookmark: true, notif: true, modal: false };
        plan[OUT] = { login: true, unlock: false, logout: false, bookmark: false, notif: false, modal: false };
        var p = plan[state];

        function show(id, visible) {
            var el = doc.getElementById(id);
            if (!el || !el.classList) return;
            if (visible) el.classList.remove('hidden');
            else el.classList.add('hidden');
        }

        show('navLoginBtn', p.login);
        show('navUnlockBtn', p.unlock);
        show('logoutBtn', p.logout);
        show('navBookmarkBtn', p.bookmark);
        show('navNotifBtn', p.notif);

        var modal = doc.getElementById('unlockModal');
        if (modal && modal.style) modal.style.display = p.modal ? 'flex' : 'none';

        var cb = state === LOCKED ? opts.onLocked
            : state === IN ? opts.onLoggedIn
                : opts.onLoggedOut;
        if (typeof cb === 'function') {
            try { cb(); } catch (e) { /* a page's own failure must not stop the nav */ }
        }
        return state;
    }

    /* Convenience: compute the state and apply it in one call. */
    function refresh(opts) {
        opts = opts || {};
        var state = opts.state || sessionState(opts);
        return apply({ document: opts.document, state: state, onLocked: opts.onLocked,
            onLoggedIn: opts.onLoggedIn, onLoggedOut: opts.onLoggedOut });
    }

    var api = {
        LOCKED: LOCKED,
        IN: IN,
        OUT: OUT,
        sessionState: sessionState,
        apply: apply,
        refresh: refresh
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrAuthState = api;
})(typeof window !== 'undefined' ? window : globalThis);
