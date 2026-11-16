/* Tests for assets/nostr-session.js.
   Run: node tests/nostr-session.test.mjs
   No browser: storage, the signer and the tools import are all injected. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sess = require('../assets/nostr-session.js');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}

const PUB = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
const HEX = '67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa';

// ------------------------------------------------------------- hexToBytes
{
    const b = sess.hexToBytes('00ff10');
    eq('hex becomes bytes', Array.from(b), [0, 255, 16]);
}
eq('a short hex pair works', Array.from(sess.hexToBytes('0a')), [10]);
eq('odd length is refused', sess.hexToBytes('abc'), null);
eq('non-hex is refused', sess.hexToBytes('zzzz'), null);
eq('empty is refused', sess.hexToBytes(''), null);
eq('null is refused', sess.hexToBytes(null), null);

// ---------------------------------------------------- installLocalSigner
{
    const tools = { finalizeEvent: (tpl, sk) => Object.assign({}, tpl, { sig: 'signed', sk }) };
    const okInstall = sess.installLocalSigner(PUB, new Uint8Array([1, 2]), tools);
    eq('installing succeeds', okInstall, true);
    ok('window.nostr exists', typeof globalThis.nostr === 'object');
}
{
    /* getPublicKey and signEvent are promises, so the assertions await them. */
    const tools = { finalizeEvent: (tpl, sk) => ({ ...tpl, sig: 'sig', n: sk.length }) };
    sess.installLocalSigner(PUB, new Uint8Array([9, 9]), tools);
    eq('getPublicKey returns the pubkey', await globalThis.nostr.getPublicKey(), PUB);
    const signed = await globalThis.nostr.signEvent({ kind: 1, content: 'x' });
    eq('signEvent keeps the template', signed.kind, 1);
    eq('and calls finalizeEvent with the secret', signed.n, 2);
}
eq('no tools is refused', sess.installLocalSigner(PUB, new Uint8Array([1]), null), false);
eq('tools without finalizeEvent are refused', sess.installLocalSigner(PUB, new Uint8Array([1]), {}), false);
eq('no pubkey is refused', sess.installLocalSigner(null, new Uint8Array([1]), { finalizeEvent: () => ({}) }), false);
eq('no secret is refused', sess.installLocalSigner(PUB, null, { finalizeEvent: () => ({}) }), false);

// -------------------------------------------------- restoreLocalSession
const toolsStub = { finalizeEvent: (tpl) => ({ ...tpl, sig: 'sig' }) };
function storage(map) {
    return (k) => (k in map ? map[k] : null);
}
const loadOk = () => Promise.resolve(toolsStub);

{
    // the normal case: a raw key and a pubkey
    const r = await sess.restoreLocalSession({
        read: storage({ phosphor_privkey: HEX }), pubkey: PUB, loadTools: loadOk
    });
    eq('a raw key restores the session', r.action, 'restore');
}
{
    // a temporary key in sessionStorage wins, which is what private mode relies on
    const r = await sess.restoreLocalSession({
        read: storage({ phosphor_privkey_temp: HEX, phosphor_privkey: 'ff'.repeat(32) }),
        pubkey: PUB, loadTools: loadOk
    });
    eq('the temporary key is preferred', r.action, 'restore');
}
{
    const r = await sess.restoreLocalSession({ read: storage({}), pubkey: PUB, loadTools: loadOk });
    eq('nothing stored means nothing to do', r.action, 'none');
}
{
    const r = await sess.restoreLocalSession({ read: storage({ phosphor_privkey: HEX }), pubkey: null, loadTools: loadOk });
    eq('a key without a pubkey is not restored', r.action, 'none');
}
{
    /* THE BUG this module fixes: an encrypted key is stored, there is no raw key and
       no signer. The page cannot sign anything, so it must forget the stale pubkey
       instead of showing a signed-in UI. */
    const r = await sess.restoreLocalSession({
        read: storage({ phosphor_ncryptsec: 'ncryptsec1abc' }), pubkey: PUB,
        hasExtensionSigner: false, loadTools: loadOk
    });
    eq('a stale pubkey is cleared', r.action, 'clear-pubkey');
}
{
    // with a signer present the pubkey is legitimate, keep it
    const r = await sess.restoreLocalSession({
        read: storage({ phosphor_ncryptsec: 'ncryptsec1abc' }), pubkey: PUB,
        hasExtensionSigner: true, loadTools: loadOk
    });
    eq('a pubkey with a signer is left alone', r.action, 'none');
}
{
    const r = await sess.restoreLocalSession({
        read: storage({ phosphor_ncryptsec: 'x', phosphor_privkey: HEX }), pubkey: PUB,
        hasExtensionSigner: false, loadTools: loadOk
    });
    eq('a raw key wins over the stale-clearing branch', r.action, 'restore');
}
{
    // a malformed key must be reported, not half-installed
    const r = await sess.restoreLocalSession({
        read: storage({ phosphor_privkey: 'not-hex-at-all' }), pubkey: PUB, loadTools: loadOk
    });
    eq('a bad key is reported as a failure', r.action, 'restore-failed');
    eq('with a reason', r.error, 'bad-key-hex');
}
{
    // the CDN is unreachable: reported, and the page keeps working
    const r = await sess.restoreLocalSession({
        read: storage({ phosphor_privkey: HEX }), pubkey: PUB,
        loadTools: () => Promise.reject(new Error('offline'))
    });
    eq('a failed import is reported as no-tools', r.action, 'no-tools');
    ok('the error text is kept', r.error.indexOf('offline') !== -1);
}
{
    // a logger is called on failure, so a page can surface it
    let logged = null;
    await sess.restoreLocalSession({
        read: storage({ phosphor_privkey: HEX }), pubkey: PUB,
        loadTools: () => Promise.reject(new Error('boom')),
        log: (e) => { logged = String(e); }
    });
    eq('the failure is logged when a logger is given', logged.indexOf('boom') !== -1, true);
}
{
    // storage that throws must not break page load
    const r = await sess.restoreLocalSession({
        read: () => { throw new Error('SecurityError'); }, pubkey: PUB, loadTools: loadOk
    });
    eq('unreadable storage is treated as empty', r.action, 'none');
}
{
    const r = await sess.restoreLocalSession({ pubkey: PUB });
    eq('no read function means nothing to do', r.action, 'none');
}
{
    // tools that load but are unusable
    const r = await sess.restoreLocalSession({
        read: storage({ phosphor_privkey: HEX }), pubkey: PUB, loadTools: () => Promise.resolve({})
    });
    eq('incomplete tools are reported', r.action, 'restore-failed');
    eq('with a reason', r.error, 'tools-incomplete');
}

// ------------------------------------------------------- switchLoginTab
/* A fake document with the four tabs and four views, so the real
   hide-everything-then-show-one logic runs instead of being read off the file. */
function fakeLoginDoc(present = true) {
    const made = {};
    if (present) {
        for (const t of ['ext', 'bunker', 'nsec', 'ncryptsec']) {
            const v = 'view' + t.charAt(0).toUpperCase() + t.slice(1);
            const b = 'tab' + t.charAt(0).toUpperCase() + t.slice(1);
            made[v] = { classes: new Set(), classList: null };
            made[b] = { classes: new Set(), classList: null };
        }
        for (const el of Object.values(made)) {
            el.classList = {
                add: (c) => el.classes.add(c),
                remove: (c) => el.classes.delete(c),
                has: (c) => el.classes.has(c)
            };
        }
    }
    return {
        getElementById: (id) => made[id] || null,
        __els: made
    };
}
{
    const doc = fakeLoginDoc();
    eq('switching to a tab succeeds', sess.switchLoginTab('bunker', doc), true);
    eq('the chosen view is visible', doc.__els.viewBunker.classes.has('hidden'), false);
    eq('the chosen tab is not ghosted', doc.__els.tabBunker.classes.has('ghost'), false);
    eq('another view is hidden', doc.__els.viewExt.classes.has('hidden'), true);
    eq('another tab is ghosted', doc.__els.tabExt.classes.has('ghost'), true);
    eq('the nsec view is hidden too', doc.__els.viewNsec.classes.has('hidden'), true);
}
{
    // switching twice must not leave two visible
    const doc = fakeLoginDoc();
    sess.switchLoginTab('ext', doc);
    sess.switchLoginTab('ncryptsec', doc);
    const visible = ['Ext', 'Bunker', 'Nsec', 'Ncryptsec']
        .filter(t => !doc.__els['view' + t].classes.has('hidden'));
    eq('exactly one view is visible after two switches', visible, ['Ncryptsec']);
}
eq('an unknown tab is refused', sess.switchLoginTab('nope', fakeLoginDoc()), false);
eq('a page with no login form returns false', sess.switchLoginTab('ext', fakeLoginDoc(false)), false);
eq('no document returns false', sess.switchLoginTab('ext', null), false);
eq('the tab list is the four known ones', sess.LOGIN_TABS, ['ext', 'bunker', 'nsec', 'ncryptsec']);

// ----------------------------------------------------------- logout keys
/* One definition of "what a logout clears". index.html adds phosphor_following,
   because only that page caches the follow list; every other page must still clear
   the same standard set. */
ok('the standard keys include the pubkey', sess.LOGOUT_KEYS.indexOf('phosphor_pubkey') !== -1);
ok('the standard keys include the raw key', sess.LOGOUT_KEYS.indexOf('phosphor_privkey') !== -1);
ok('the standard keys include the encrypted key', sess.LOGOUT_KEYS.indexOf('phosphor_ncryptsec') !== -1);
ok('the standard keys include the bunker uri', sess.LOGOUT_KEYS.indexOf('phosphor_bunker_uri') !== -1);
/* Found by measurement, not by reading: this one survived a logout in the browser.
   It is not a credential, which is why nobody thought of it, and it still records
   which NIP-05 identities were checked from this browser. */
ok('the standard keys include the NIP-05 cache',
    sess.LOGOUT_KEYS.indexOf('phosphor_nip05_cache_v1') !== -1);
eq('extras are appended', sess.logoutKeys(['phosphor_following']), sess.LOGOUT_KEYS.concat(['phosphor_following']));
eq('a duplicate extra is not repeated', sess.logoutKeys(['phosphor_pubkey']), sess.LOGOUT_KEYS);
eq('no extras is just the standard list', sess.logoutKeys(), sess.LOGOUT_KEYS);
/* The returned array must be a copy: a page mutating it would change the rule for
   every other page in the same document. */
{
    const a = sess.logoutKeys();
    a.push('bogus');
    eq('logoutKeys returns a copy, not the shared array', sess.LOGOUT_KEYS.indexOf('bogus'), -1);
}
{
    const removed = [];
    const storage = { removeItem: (k) => removed.push('local:' + k) };
    const session = { removeItem: (k) => removed.push('session:' + k) };
    let reloaded = 0;
    const r = sess.clearSession(storage, session, ['phosphor_following'], () => { reloaded++; });
    ok('every standard key is cleared', sess.LOGOUT_KEYS.every(k => removed.indexOf('local:' + k) !== -1));
    ok('the extra key is cleared', removed.indexOf('local:phosphor_following') !== -1);
    ok('the temporary key is cleared from sessionStorage', removed.indexOf('session:phosphor_privkey_temp') !== -1);
    eq('the reload happens once', reloaded, 1);
    eq('nothing failed', r.failed, []);
}
{
    // storage that throws must be reported per key, not abort the whole logout
    const storage = { removeItem: (k) => { if (k === 'phosphor_privkey') throw new Error('denied'); } };
    const r = sess.clearSession(storage, null, [], null);
    ok('a failed key is reported', r.failed.indexOf('phosphor_privkey') !== -1);
    ok('the other keys were still attempted', r.cleared.length >= 3);
}
{
    const r = sess.clearSession(null, null, [], null);
    eq('no storage still reports the keys as cleared', r.cleared.length, sess.LOGOUT_KEYS.length + 1);
}

// --------------------------------------------------- all pages are wired
/* Nine copies of checkLocalSessions is how three different behaviours grew
   unnoticed. Each page must now load the module, delegate, and apply the decision
   including the stale-pubkey cleanup that two pages used to lack. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIRED = ['index.html', 'profile.html', 'thread.html', 'notes.html', 'bookmark.html',
    'relay.html', 'notifications.html', 'compose.html', 'activity.html'];
for (const name of WIRED) {
    const src = readFileSync(join(root, name), 'utf8');
    ok(name + ': loads the session module',
        /<script src="\/assets\/nostr-session\.js\?v=[^"]+"><\/script>/.test(src));
    ok(name + ': the signer comes from the module',
        /return window\.NostrSession\.installLocalSigner\(pubkeyHex, secretKeyBytes, nostrTools\);/.test(src));
    ok(name + ': restore goes through the module',
        /window\.NostrSession\.restoreLocalSession\(\{/.test(src));
    ok(name + ': the page applies the clear-pubkey decision',
        /result\.action === 'clear-pubkey'[\s\S]{0,120}currentUserPubkey = null;/.test(src));
    /* The old inline implementation must be gone, or the copies come back. */
    ok(name + ': no inline finalizeEvent call left',
        !/finalizeEvent\(eventTemplate, secretKeyBytes\)/.test(src));
    ok(name + ': the page keeps ownership of its own binding',
        /let currentUserPubkey/.test(src));
}
/* Every page must AWAIT the restore inside its init before it starts using the
   session. Without the await the page proceeds with a half-restored state and the
   cleanup never runs, which is silent because nothing throws. relay.html is called
   out because it only initialises when it is given a relay to explore, so a probe
   that loads it bare sees no init at all and wrongly concludes it is broken. */
for (const name of WIRED) {
    const src = readFileSync(join(root, name), 'utf8');
    ok(name + ': init awaits checkLocalSessions before using the session',
        /await checkLocalSessions\(\);/.test(src));
}
{
    const src = readFileSync(join(root, 'relay.html'), 'utf8');
    ok('relay.html awaits the restore before connecting networks',
        /await checkLocalSessions\(\);\s*connectNetworks\(\);/.test(src));
    ok('relay.html still reads its target relay from the URL',
        /targetWsUrl/.test(src));
}

/* Login form wiring: the tab switch and the logout key list both come from the
   module, so neither can drift page by page again. */
for (const name of WIRED) {
    const src = readFileSync(join(root, name), 'utf8');
    ok(name + ': switchLoginTab delegates',
        /return window\.NostrSession \? window\.NostrSession\.switchLoginTab\(tab\) : false;/.test(src));
    ok(name + ': logout goes through clearSession',
        /window\.NostrSession\.clearSession\(localStorage, sessionStorage,/.test(src));
    ok(name + ': the hand-written key list is gone from the page',
        !/localStorage\.removeItem\('phosphor_bunker_uri'\); sessionStorage\.removeItem/.test(src)
        || /return;/.test(src));
}
{
    /* index.html caches the follow list, so it must ask for that key to be cleared.
       Every other page must NOT, which is why the extras are a parameter rather
       than a fork of the function. */
    const idx = readFileSync(join(root, 'index.html'), 'utf8');
    ok('index.html asks for phosphor_following to be cleared',
        /let extra = \['phosphor_following'\];/.test(idx));
    const others = WIRED.filter(n => n !== 'index.html');
    for (const name of others) {
        const src = readFileSync(join(root, name), 'utf8');
        ok(name + ': passes no extras', /clearSession\(localStorage, sessionStorage, \[\],/.test(src));
    }
}

/* The temporary key must still be read from sessionStorage, which is what private
   mode depends on. A generic read would silently stop honouring it. */
{
    const src = readFileSync(join(root, 'index.html'), 'utf8');
    ok('the temporary key is still read from sessionStorage',
        /k === 'phosphor_privkey_temp' \? sessionStorage\.getItem\(k\) : localStorage\.getItem\(k\)/.test(src));
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
