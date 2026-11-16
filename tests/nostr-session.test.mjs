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
