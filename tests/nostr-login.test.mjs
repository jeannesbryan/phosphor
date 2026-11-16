/* Tests for assets/nostr-login.js.
   Run: node tests/nostr-login.test.mjs
   No browser, no key, no CDN: storage, the signing tools and the reload are injected.

   The three bugs this module removes are each asserted directly, because all three
   were invisible while the code was copied across nine pages. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const login = require('../assets/nostr-login.js');
const nip27 = require('../assets/nostr-nip27.js');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}

// ------------------------------------------------------------- fakes
function fakeStore(init) {
    const m = new Map(Object.entries(init || {}));
    const removed = [];
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, v),
        removeItem: (k) => { removed.push(k); m.delete(k); },
        __map: m, __removed: removed,
        keys: () => [...m.keys()]
    };
}
const SECRET_HEX = '67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa';
const PUB = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
const NPUB = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6';

/* Minimal nostr-tools stand-in. getPublicKey returns a fixed key so assertions are
   about flow control, not cryptography, which has its own tests upstream. */
const fakeTools = {
    /* The real nip19.decode THROWS on invalid bech32, so the fake must too:
       returning null would exercise a path the library never takes. */
    nip19: { decode: (s) => { const d = nip27.bech32Decode(s);
        if (!d) throw new Error('invalid bech32');
        return { type: d.hrp, data: new Uint8Array(d.bytes) }; } },
    getPublicKey: () => PUB
};
const fakeNip49 = {
    encrypt: (bytes, pass) => 'ncryptsec1:' + pass,
    decrypt: (nc, pass) => {
        if (pass !== 'right') throw new Error('bad password');
        return new Uint8Array(32).fill(7);
    }
};
const loadOk = () => Promise.resolve({ nostrTools: fakeTools, nip49: fakeNip49 });

// ------------------------------------------------- parseSecretInput
{
    const r = login.parseSecretInput('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5', fakeTools.nip19);
    ok('a real nsec is accepted', r.ok);
    eq('and yields 32 bytes', r.bytes.length, 32);
}
{
    const r = login.parseSecretInput(SECRET_HEX, fakeTools.nip19);
    ok('64 hex characters are accepted', r.ok);
    eq('and yield 32 bytes', r.bytes.length, 32);
}
{
    /* BUG 1: an npub is 32 bytes too, so a missing type check lets it through and
       signs as a different identity than the reader asked for. */
    const r = login.parseSecretInput(NPUB, fakeTools.nip19);
    eq('an npub is REFUSED', r.ok, false);
    eq('with a reason the page can name', r.reason, 'not-an-nsec');
}
eq('a note id is refused',
    login.parseSecretInput('note1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', fakeTools.nip19).reason,
    'not-an-nsec');
eq('empty input is refused', login.parseSecretInput('', fakeTools.nip19).reason, 'empty');
eq('a half hex string is refused', login.parseSecretInput('abcdef', fakeTools.nip19).reason, 'not-hex');
eq('hex of the wrong length is refused', login.parseSecretInput('aa'.repeat(31), fakeTools.nip19).reason, 'not-hex');
eq('broken bech32 is refused', login.parseSecretInput('nsec1zzzzzzzzzzzzzz', fakeTools.nip19).reason, 'bad-bech32');
eq('a null input is refused', login.parseSecretInput(null, fakeTools.nip19).reason, 'empty');

// -------------------------------------------------------- writeSession
{
    /* BUG 3: a stale phosphor_privkey is a fallback in restoreLocalSession, so it
       could sign with a different key than the stored pubkey and the relay would
       reject every event. It must always be removed. */
    const store = fakeStore({ phosphor_privkey: 'stale', phosphor_bunker_uri: 'bunker://x' });
    const sess = fakeStore({ phosphor_privkey_temp: 'old' });
    login.writeSession(store, sess, { write: { phosphor_pubkey: PUB }, keep: ['phosphor_pubkey'], dropSession: true });
    eq('the stale legacy key is removed', store.getItem('phosphor_privkey'), null);
    eq('the stale bunker uri is removed', store.getItem('phosphor_bunker_uri'), null);
    eq('the pubkey was written', store.getItem('phosphor_pubkey'), PUB);
    eq('the session temp key is removed for extension login', sess.getItem('phosphor_privkey_temp'), null);
}
{
    const store = fakeStore();
    const sess = fakeStore();
    login.writeSession(store, sess, {
        write: { phosphor_pubkey: PUB, phosphor_ncryptsec: 'n', phosphor_privkey_temp: 'aa' },
        keep: ['phosphor_pubkey', 'phosphor_ncryptsec']
    });
    eq('a key login keeps the encrypted key', store.getItem('phosphor_ncryptsec'), 'n');
    eq('a key login keeps the temp key', sess.getItem('phosphor_privkey_temp'), 'aa');
    ok('and does not remove what it just wrote', store.__removed.indexOf('phosphor_ncryptsec') === -1);
}

// ----------------------------------------------------------- flows
function flows(over) {
    const store = fakeStore((over && over.store) || {});
    const sess = fakeStore((over && over.session) || {});
    const installed = [];
    const f = login.createFlows(Object.assign({
        storage: store, session: sess, loadTools: loadOk,
        installSigner: (pk, sk, tools) => { installed.push({ pk, skLen: sk.length }); return true; }
    }, over || {}));
    return { f, store, sess, installed };
}

{
    const h = login.createFlows({ storage: fakeStore(), session: fakeStore(), getExtension: () => null });
    const r = await h.extension();
    eq('a missing extension is reported, not thrown', r.ok, false);
    ok('and the message names NIP-07', r.message.indexOf('NIP-07') !== -1);
}
{
    // extension with a working signer
    const store = fakeStore({ phosphor_privkey: 'stale' });
    const sess = fakeStore({ phosphor_privkey_temp: 'old' });
    const f = login.createFlows({
        storage: store, session: sess,
        getExtension: () => ({ getPublicKey: () => Promise.resolve(PUB) })
    });
    const r = await f.extension();
    eq('extension login succeeds', r.ok, true);
    eq('and the pubkey is stored', store.getItem('phosphor_pubkey'), PUB);
    eq('and the stale legacy key is gone', store.getItem('phosphor_privkey'), null);
    eq('and the session temp key is cleared', sess.getItem('phosphor_privkey_temp'), null);
}
{
    // bunker
    const h = flows();
    const r = await h.f.bunker('bunker://' + PUB + '?relay=wss%3A%2F%2Fr.example');
    eq('a bunker uri logs in', r.ok, true);
    eq('the pubkey comes from the uri', r.pubkey, PUB);
    eq('the uri is stored', h.store.getItem('phosphor_bunker_uri').indexOf('bunker://') === 0, true);
}
{
    const h = flows();
    eq('a uri without the scheme is refused', (await h.f.bunker('https://x')).ok, false);
    eq('an empty uri is refused', (await h.f.bunker('')).ok, false);
}
{
    // nsec login
    const h = flows();
    const r = await h.f.nsec(SECRET_HEX, 'pass');
    eq('an nsec login succeeds', r.ok, true);
    eq('the pubkey is stored', h.store.getItem('phosphor_pubkey'), PUB);
    eq('the key is stored encrypted, never raw', h.store.getItem('phosphor_ncryptsec'), 'ncryptsec1:pass');
    eq('the raw key is NOT in localStorage', h.store.getItem('phosphor_privkey'), null);
    ok('the temp key is in sessionStorage', (h.sess.getItem('phosphor_privkey_temp') || '').length === 64);
    eq('the signer was installed once', h.installed.length, 1);
}
{
    /* BUG 1 again, now through the flow: an npub must not log anyone in. */
    const h = flows();
    const r = await h.f.nsec(NPUB, 'pass');
    eq('an npub cannot log in', r.ok, false);
    ok('and the message says it is the wrong kind of key',
        r.message.indexOf('npub') !== -1 || r.message.indexOf('public key') !== -1);
    eq('nothing was written', h.store.getItem('phosphor_pubkey'), null);
    eq('no signer was installed', h.installed.length, 0);
}
{
    const h = flows();
    eq('a missing password is refused', (await h.f.nsec(SECRET_HEX, '')).ok, false);
    eq('a missing key is refused', (await h.f.nsec('', 'pass')).ok, false);
}
{
    // nsec login also clears a leftover bunker uri
    const h = flows({ store: { phosphor_bunker_uri: 'bunker://old' } });
    await h.f.nsec(SECRET_HEX, 'pass');
    eq('a leftover bunker uri is removed', h.store.getItem('phosphor_bunker_uri'), null);
}
{
    // ncryptsec login
    const h = flows();
    const r = await h.f.ncryptsec('ncryptsec1:right', 'right');
    eq('an ncryptsec login succeeds', r.ok, true);
    eq('the encrypted key is kept as given', h.store.getItem('phosphor_ncryptsec'), 'ncryptsec1:right');
    eq('the pubkey is derived from it', h.store.getItem('phosphor_pubkey'), PUB);
}
{
    const h = flows();
    eq('a wrong password fails', (await h.f.ncryptsec('ncryptsec1:x', 'wrong')).ok, false);
    eq('and installs no signer', h.installed.length, 0);
}
{
    /* BUG 2: notifications' unlock never set the pubkey, so the session restore
       (which needs rawKey AND pubkey) could never install a signer there. */
    const h = flows({ store: { phosphor_ncryptsec: 'ncryptsec1:right' } });
    const r = await h.f.unlock('right');
    eq('unlocking succeeds', r.ok, true);
    eq('and it SETS THE PUBKEY', h.store.getItem('phosphor_pubkey'), PUB);
    ok('and writes the temp key', (h.sess.getItem('phosphor_privkey_temp') || '').length === 64);
    eq('the encrypted key is kept', h.store.getItem('phosphor_ncryptsec'), 'ncryptsec1:right');
    eq('the signer was installed', h.installed.length, 1);
}
{
    const h = flows({ store: { phosphor_ncryptsec: 'ncryptsec1:right' } });
    eq('a wrong unlock password fails', (await h.f.unlock('wrong')).ok, false);
    eq('nothing was written', h.store.getItem('phosphor_pubkey'), null);
}
{
    const h = flows();
    eq('unlocking with no stored key is refused', (await h.f.unlock('right')).ok, false);
    eq('and says so', (await h.f.unlock('right')).message.indexOf('No encrypted key') !== -1, true);
}
{
    // a failing tools import is reported, not thrown
    const h = flows({ loadTools: () => Promise.reject(new Error('offline')) });
    const r = await h.f.nsec(SECRET_HEX, 'pass');
    eq('a failed import is a friendly failure', r.ok, false);
}

// ------------------------------------------------------- wireLoginUI
/* The wiring is exercised with a fake document, because "one call per page" is the
   whole point: if it silently wired nothing, the pages would look fine and no flow
   would ever run. */
function fakeDoc(ids) {
    const els = {};
    for (const id of ids) {
        els[id] = { value: '', textContent: '', style: {}, handlers: [],
            addEventListener(ev, fn) { if (ev === 'click') this.handlers.push(fn); } };
    }
    return {
        els,
        getElementById: (id) => els[id] || null,
        click: async (id) => { for (const h of (els[id] ? els[id].handlers : [])) await h(); }
    };
}
const BUTTONS = ['extLoginBtn', 'bunkerLoginBtn', 'nsecLoginBtn', 'ncryptsecLoginBtn', 'unlockBtn',
    'bunkerInput', 'nsecInput', 'nsecPassword', 'ncryptsecInput', 'ncryptsecPassword',
    'unlockPassword', 'loginModal', 'unlockModal'];

{
    const doc = fakeDoc(BUTTONS);
    const store = fakeStore();
    const sess = fakeStore();
    const alerts = [];
    const reloads = [];
    let pubkeySet = null;
    const n = login.wireLoginUI({
        document: doc, storage: store, session: sess, loadTools: loadOk,
        alert: (m) => alerts.push(m),
        reload: () => reloads.push(1),
        delay: (fn) => fn(),
        setPubkey: (pk) => { pubkeySet = pk; },
        getExtension: () => ({ getPublicKey: () => Promise.resolve(PUB) })
    });
    eq('all five buttons are wired', n, 5);

    await doc.click('extLoginBtn');
    eq('an extension login sets the page binding', pubkeySet, PUB);
    eq('the login modal is closed', doc.els.loginModal.style.display, 'none');
    eq('the page reloads', reloads.length, 1);
    ok('and the reader is told', alerts.length === 1);
}
{
    // a failed flow must report and must NOT reload
    const doc = fakeDoc(BUTTONS);
    const alerts = [];
    const reloads = [];
    login.wireLoginUI({
        document: doc, storage: fakeStore(), session: fakeStore(), loadTools: loadOk,
        alert: (m) => alerts.push(m), reload: () => reloads.push(1), delay: (fn) => fn(),
        getExtension: () => null
    });
    await doc.click('extLoginBtn');
    eq('a failure does not reload', reloads.length, 0);
    ok('but is reported', alerts.length === 1);
    eq('and the button label is restored', doc.els.extLoginBtn.textContent, '> AUTHORIZE_EXTENSION');
}
{
    /* BUG 1 through the UI: pasting an npub must fail visibly, write nothing, and not
       reload. */
    const doc = fakeDoc(BUTTONS);
    const store = fakeStore();
    const alerts = [];
    const reloads = [];
    login.wireLoginUI({
        document: doc, storage: store, session: fakeStore(), loadTools: loadOk,
        alert: (m) => alerts.push(m), reload: () => reloads.push(1), delay: (fn) => fn(),
        setPubkey: () => { throw new Error('must not be called'); }
    });
    doc.els.nsecInput.value = NPUB;
    doc.els.nsecPassword.value = 'pass';
    await doc.click('nsecLoginBtn');
    eq('an npub login does not reload', reloads.length, 0);
    eq('and stores no pubkey', store.getItem('phosphor_pubkey'), null);
    ok('and the message explains why', alerts[0].indexOf('public key') !== -1 || alerts[0].indexOf('npub') !== -1);
}
{
    /* BUG 2 through the UI: unlocking must set the pubkey, or the next page load
       cannot install a signer. */
    const doc = fakeDoc(BUTTONS);
    const store = fakeStore({ phosphor_ncryptsec: 'ncryptsec1:right' });
    let pubkeySet = null;
    const reloads = [];
    login.wireLoginUI({
        document: doc, storage: store, session: fakeStore(), loadTools: loadOk,
        alert: () => {}, reload: () => reloads.push(1), delay: (fn) => fn(),
        setPubkey: (pk) => { pubkeySet = pk; }
    });
    doc.els.unlockPassword.value = 'right';
    await doc.click('unlockBtn');
    eq('unlock sets the page binding', pubkeySet, PUB);
    eq('unlock persists the pubkey', store.getItem('phosphor_pubkey'), PUB);
    eq('and reloads', reloads.length, 1);
    eq('the unlock modal is closed', doc.els.unlockModal.style.display, 'none');
}
{
    // a page with no login form wires nothing and does not throw
    const bare = { getElementById: () => null };
    eq('a page with no buttons wires zero', login.wireLoginUI({ document: bare }), 0);
    eq('no document wires zero', login.wireLoginUI({}), 0);
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
    ok(name + ': loads the login module',
        /<script src="\/assets\/nostr-login\.js\?v=[^"]+"><\/script>/.test(src));
    ok(name + ': wires the login UI through the module',
        /NostrLogin\.wireLoginUI\(\{/.test(src));
    ok(name + ': the copied handlers are gone',
        !/getElementById\('nsecLoginBtn'\)\.addEventListener/.test(src));
    ok(name + ': the page still owns its pubkey binding',
        /setPubkey:/.test(src) && /let currentUserPubkey/.test(src));
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
