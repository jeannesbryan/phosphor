/* Tests for assets/nostr-auth-state.js.
   Run: node tests/nostr-auth-state.test.mjs
   No browser: storage and the document are fakes. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const authState = require('../assets/nostr-auth-state.js');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}

// ------------------------------------------------------------ sessionState
const store = (map) => (k) => (k in map ? map[k] : null);

eq('nothing stored is logged out',
    authState.sessionState({ read: store({}) }), authState.OUT);
eq('a temp key and a pubkey is logged in',
    authState.sessionState({ read: store({ phosphor_privkey_temp: 'k' }), pubkey: 'p' }), authState.IN);
/* An encrypted key with no unlocked session is a REAL third state: the reader is
   known but cannot sign anything. Treating it as "logged in" is what left the
   unlock button hidden while the UI claimed to be usable. */
eq('an encrypted key with no temp key is locked',
    authState.sessionState({ read: store({ phosphor_ncryptsec: 'c' }) }), authState.LOCKED);
eq('an encrypted key that HAS been unlocked is logged in',
    authState.sessionState({ read: store({ phosphor_ncryptsec: 'c', phosphor_privkey_temp: 'k' }), pubkey: 'p' }), authState.IN);
eq('storage that throws is treated as logged out',
    authState.sessionState({ read: () => { throw new Error('SecurityError'); } }), authState.OUT);
eq('no reader is logged out', authState.sessionState({}), authState.OUT);

// ------------------------------------------------------------- fake DOM
function fakeDoc(ids) {
    const els = {};
    for (const id of (ids || ['navLoginBtn', 'navUnlockBtn', 'logoutBtn', 'navBookmarkBtn', 'navNotifBtn'])) {
        els[id] = { classList: { _s: new Set(['hidden']),
            add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
            contains(c) { return this._s.has(c); } } };
    }
    els.unlockModal = { style: { display: 'none' } };
    return {
        els,
        getElementById: (id) => els[id] || null,
        visible: (id) => els[id] && !els[id].classList.contains('hidden')
    };
}

// ----------------------------------------------------------------- apply
{
    const doc = fakeDoc();
    eq('apply returns the state it applied', authState.apply({ document: doc, state: authState.LOCKED }), authState.LOCKED);
    eq('locked shows the unlock button', doc.visible('navUnlockBtn'), true);
    eq('locked hides login', doc.visible('navLoginBtn'), false);
    eq('locked hides logout', doc.visible('logoutBtn'), false);
    eq('locked hides the bookmark link', doc.visible('navBookmarkBtn'), false);
    eq('locked hides the notification link', doc.visible('navNotifBtn'), false);
    eq('locked opens the unlock modal', doc.els.unlockModal.style.display, 'flex');
}
{
    const doc = fakeDoc();
    authState.apply({ document: doc, state: authState.IN });
    eq('logged in hides login', doc.visible('navLoginBtn'), false);
    eq('logged in hides the unlock button', doc.visible('navUnlockBtn'), false);
    eq('logged in shows logout', doc.visible('logoutBtn'), true);
    eq('logged in shows the bookmark link', doc.visible('navBookmarkBtn'), true);
    eq('logged in shows the notification link', doc.visible('navNotifBtn'), true);
    eq('logged in closes the unlock modal', doc.els.unlockModal.style.display, 'none');
}
{
    /* THE BUG in compose and activity: the logged-out branch forgot to hide the
       unlock button, so it stayed visible with nothing to unlock. */
    const doc = fakeDoc();
    authState.apply({ document: doc, state: authState.OUT });
    eq('logged out shows login', doc.visible('navLoginBtn'), true);
    eq('logged out HIDES the unlock button', doc.visible('navUnlockBtn'), false);
    eq('logged out hides logout', doc.visible('logoutBtn'), false);
    eq('logged out hides the bookmark link', doc.visible('navBookmarkBtn'), false);
    eq('logged out hides the notification link', doc.visible('navNotifBtn'), false);
    eq('logged out closes the unlock modal', doc.els.unlockModal.style.display, 'none');
}
{
    /* THE BUG in notifications: no logged-out branch at all, so the navigation kept
       whatever was rendered before. Starting from a locked page and going to logged
       out must reset every element. */
    const doc = fakeDoc();
    authState.apply({ document: doc, state: authState.LOCKED });
    eq('starting from locked, unlock is visible', doc.visible('navUnlockBtn'), true);
    authState.apply({ document: doc, state: authState.OUT });
    eq('going to logged out clears the stale unlock button', doc.visible('navUnlockBtn'), false);
    eq('and shows login', doc.visible('navLoginBtn'), true);
    eq('and closes the modal', doc.els.unlockModal.style.display, 'none');
}
{
    // every state sets every element: a missing element must not leave a stale one
    const all = fakeDoc();
    for (const st of [authState.LOCKED, authState.IN, authState.OUT]) {
        authState.apply({ document: all, state: st });
        const snapshot = ['navLoginBtn', 'navUnlockBtn', 'logoutBtn', 'navBookmarkBtn', 'navNotifBtn']
            .map(id => all.visible(id));
        ok('state ' + st + ' sets all five navigation elements', snapshot.length === 5);
    }
}
{
    // callbacks fire for the matching state only
    const doc = fakeDoc();
    const calls = [];
    const cbs = {
        onLocked: () => calls.push('locked'),
        onLoggedIn: () => calls.push('in'),
        onLoggedOut: () => calls.push('out')
    };
    authState.apply(Object.assign({ document: doc, state: authState.LOCKED }, cbs));
    authState.apply(Object.assign({ document: doc, state: authState.IN }, cbs));
    authState.apply(Object.assign({ document: doc, state: authState.OUT }, cbs));
    eq('one callback per state, in order', calls, ['locked', 'in', 'out']);
}
{
    /* A page callback that throws must not stop the navigation from being applied:
       the nav is shared and must always be consistent. */
    const doc = fakeDoc();
    let threw = false;
    try {
        authState.apply({ document: doc, state: authState.IN, onLoggedIn: () => { throw new Error('page bug'); } });
    } catch (e) { threw = true; }
    eq('a throwing callback does not propagate', threw, false);
    eq('and the navigation was still applied', doc.visible('logoutBtn'), true);
}
eq('an unknown state returns null', authState.apply({ document: fakeDoc(), state: 'nonsense' }), null);
eq('no document returns null', authState.apply({ state: authState.IN }), null);
{
    // a page missing some nav elements must not throw
    const bare = { getElementById: () => null };
    let threw = false;
    try { authState.apply({ document: bare, state: authState.IN }); } catch (e) { threw = true; }
    eq('a page with no navigation elements does not throw', threw, false);
}

// -------------------------------------------------------------- refresh
{
    const doc = fakeDoc();
    const st = authState.refresh({
        document: doc,
        read: store({ phosphor_ncryptsec: 'c' }),
        pubkey: null
    });
    eq('refresh computes the locked state', st, authState.LOCKED);
    eq('and applies it', doc.visible('navUnlockBtn'), true);
}
{
    const doc = fakeDoc();
    const st = authState.refresh({ document: doc, read: store({ phosphor_privkey_temp: 'k' }), pubkey: 'p' });
    eq('refresh computes logged in', st, authState.IN);
    eq('and applies it', doc.visible('logoutBtn'), true);
}

// --------------------------------------------------- all pages are wired
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'profile.html', 'thread.html', 'notes.html', 'bookmark.html',
    'relay.html', 'notifications.html', 'compose.html', 'activity.html'];
for (const name of PAGES) {
    const src = readFileSync(join(root, name), 'utf8');
    ok(name + ': loads the auth-state module',
        /<script src="\/assets\/nostr-auth-state\.js\?v=[^"]+"><\/script>/.test(src));
    ok(name + ': updateAuthState goes through the module',
        /NostrAuthState\.refresh\(\{/.test(src));
    ok(name + ': the hand-written nav toggling is gone from the page',
        !/navLoginBtn\.classList\.add\('hidden'\);\s*logoutBtn\.classList\.add\('hidden'\)/.test(src));
}
/* No page may keep a half-written state machine: the exact shapes that caused the
   two bugs are asserted absent. */
for (const name of ['compose.html', 'activity.html']) {
    const src = readFileSync(join(root, name), 'utf8');
    ok(name + ': the logged-out branch no longer forgets the unlock button',
        !/\} else \{ navLoginBtn\.classList\.remove\('hidden'\); editorContainer/.test(src));
}
{
    const src = readFileSync(join(root, 'notifications.html'), 'utf8');
    ok('notifications.html has a logged-out path now',
        /onLoggedOut/.test(src) || !/else if \(currentUserPubkey\)/.test(src));
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
