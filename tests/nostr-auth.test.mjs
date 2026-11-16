/* Tests for assets/nostr-auth.js (NIP-42).
   Run: node tests/nostr-auth.test.mjs
   No browser, no network, no key: signing is injected. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const auth = require('../assets/nostr-auth.js');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}

// ------------------------------------------------------------ URL handling
eq('trailing slash is dropped', auth.normalizeRelayUrl('wss://strfry.jeannesbryan.my.id/'), 'wss://strfry.jeannesbryan.my.id');
eq('host is lowercased', auth.normalizeRelayUrl('wss://Relay.Damus.IO'), 'wss://relay.damus.io');
/* Only the slash of an EMPTY path is dropped. A slash that is part of a real
   path stays, because wss://h/relay/ and wss://h/relay can be different
   endpoints, and the relay tag has to match the URL the relay expects. */
eq('a real path keeps its own trailing slash', auth.normalizeRelayUrl('wss://host.example/relay/'), 'wss://host.example/relay/');
eq('a path without a slash is untouched', auth.normalizeRelayUrl('wss://host.example/relay'), 'wss://host.example/relay');
eq('a port is preserved', auth.normalizeRelayUrl('wss://host.example:7777'), 'wss://host.example:7777');
eq('query and fragment are dropped', auth.normalizeRelayUrl('wss://host.example/relay?x=1#y'), 'wss://host.example/relay');
eq('https is not a relay url', auth.normalizeRelayUrl('https://host.example'), null);
eq('a bare host is not a relay url', auth.normalizeRelayUrl('host.example'), null);
eq('null is refused', auth.normalizeRelayUrl(null), null);

// --------------------------------------------------------- parseAuthRequest
eq('a normal AUTH frame is understood', auth.parseAuthRequest(['AUTH', 'ch4ll3ng3']), { challenge: 'ch4ll3ng3' });
eq('lowercase auth is also accepted', auth.parseAuthRequest(['auth', 'c']), { challenge: 'c' });
eq('an empty challenge is refused', auth.parseAuthRequest(['AUTH', '']), null);
eq('a non-string challenge is refused', auth.parseAuthRequest(['AUTH', 123]), null);
eq('a frame without a challenge is refused', auth.parseAuthRequest(['AUTH']), null);
eq('an EVENT frame is not an AUTH', auth.parseAuthRequest(['EVENT', 'sub', {}]), null);
eq('a string is not a frame', auth.parseAuthRequest('AUTH'), null);
eq('null is refused', auth.parseAuthRequest(null), null);

// ---------------------------------------------------------- buildAuthEvent
{
    const ev = auth.buildAuthEvent('wss://strfry.jeannesbryan.my.id/', 'abc123', 1700000000);
    eq('kind is 22242', ev.kind, 22242);
    eq('created_at is the injected clock', ev.created_at, 1700000000);
    eq('content is empty', ev.content, '');
    eq('the relay tag is normalised', ev.tags[0], ['relay', 'wss://strfry.jeannesbryan.my.id']);
    eq('the challenge tag carries it verbatim', ev.tags[1], ['challenge', 'abc123']);
    eq('exactly two tags', ev.tags.length, 2);
}
eq('an invalid relay url builds nothing', auth.buildAuthEvent('https://x', 'c', 1), null);
eq('an empty challenge builds nothing', auth.buildAuthEvent('wss://x.example', '', 1), null);
{
    const ev = auth.buildAuthEvent('wss://x.example', 'c');
    ok('without a clock argument created_at is still a number', typeof ev.created_at === 'number' && ev.created_at > 1600000000);
}

// -------------------------------------------------------- isUsableAuthEvent
const PUB = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
const SIG = 'a'.repeat(128);
function signed(over) {
    return Object.assign({
        kind: 22242, pubkey: PUB, sig: SIG, created_at: 1700000000, content: '',
        tags: [['relay', 'wss://r.example'], ['challenge', 'ch']]
    }, over || {});
}
ok('a well formed signed event is usable', auth.isUsableAuthEvent(signed(), 'wss://r.example', 'ch'));
ok('a trailing slash on the relay does not break the match',
    auth.isUsableAuthEvent(signed(), 'wss://r.example/', 'ch'));
eq('the wrong kind is refused', auth.isUsableAuthEvent(signed({ kind: 1 }), 'wss://r.example', 'ch'), false);
eq('a missing signature is refused', auth.isUsableAuthEvent(signed({ sig: undefined }), 'wss://r.example', 'ch'), false);
eq('a short signature is refused', auth.isUsableAuthEvent(signed({ sig: 'abc' }), 'wss://r.example', 'ch'), false);
eq('a missing pubkey is refused', auth.isUsableAuthEvent(signed({ pubkey: undefined }), 'wss://r.example', 'ch'), false);
eq('a mismatched relay tag is refused', auth.isUsableAuthEvent(signed(), 'wss://other.example', 'ch'), false);
eq('a mismatched challenge is refused', auth.isUsableAuthEvent(signed(), 'wss://r.example', 'other'), false);
eq('missing tags are refused', auth.isUsableAuthEvent(signed({ tags: [] }), 'wss://r.example', 'ch'), false);
eq('null is refused', auth.isUsableAuthEvent(null, 'wss://r.example', 'ch'), false);

// -------------------------------------------------------- isAuthRequired
eq('CLOSED with auth-required is recognised',
    auth.isAuthRequired(['CLOSED', 'sub1', 'auth-required: we can only serve you if you auth']).subscription, 'sub1');
eq('CLOSED with another reason is not auth', auth.isAuthRequired(['CLOSED', 'sub1', 'error: nope']), null);
eq('OK false with auth-required is recognised',
    auth.isAuthRequired(['OK', 'id1', false, 'auth-required: please authenticate']).id, 'id1');
eq('OK true is never auth-required', auth.isAuthRequired(['OK', 'id1', true, '']), null);
eq('an EVENT frame is not auth-required', auth.isAuthRequired(['EVENT', 's', {}]), null);

// --------------------------------------------------------- respondToAuth
const send = () => {
    const box = { frames: [] };
    box.fn = (s) => box.frames.push(s);
    return box;
};

{
    // nobody can sign: this must be reported, not silently swallowed
    const r = await auth.respondToAuth(['AUTH', 'ch'], { relayUrl: 'wss://r.example', send: send().fn });
    eq('no signer is reported as no-signer', r.reason, 'no-signer');
    eq('and nothing was sent', r.sent, false);
}
{
    const box = send();
    const r = await auth.respondToAuth(['AUTH', 'ch'], { relayUrl: 'wss://r.example', send: box.fn, sign: () => signed() });
    eq('a valid signed event is sent', r.sent, true);
    eq('exactly one frame was written', box.frames.length, 1);
    const frame = JSON.parse(box.frames[0]);
    eq('the frame is an AUTH frame', frame[0], 'AUTH');
    eq('carrying the signed event', frame[1].kind, 22242);
}
{
    // signer throws synchronously
    const r = await auth.respondToAuth(['AUTH', 'ch'], {
        relayUrl: 'wss://r.example', send: send().fn, sign: () => { throw new Error('user rejected'); }
    });
    eq('a throwing signer is reported as sign-failed', r.reason, 'sign-failed');
    ok('the error message is kept', r.error.indexOf('user rejected') !== -1);
}
{
    // signer rejects
    const r = await auth.respondToAuth(['AUTH', 'ch'], {
        relayUrl: 'wss://r.example', send: send().fn, sign: () => Promise.reject(new Error('extension is locked'))
    });
    eq('a rejecting signer is reported as sign-failed', r.reason, 'sign-failed');
}
{
    // signer returns garbage
    const box = send();
    const r = await auth.respondToAuth(['AUTH', 'ch'], {
        relayUrl: 'wss://r.example', send: box.fn, sign: () => ({ kind: 22242 })
    });
    eq('an invalid event is not sent', r.reason, 'invalid-event');
    eq('nothing reached the socket', box.frames.length, 0);
}
{
    // wrong relay in the tag: caught before sending
    const box = send();
    const r = await auth.respondToAuth(['AUTH', 'ch'], {
        relayUrl: 'wss://r.example', send: box.fn,
        sign: () => signed({ tags: [['relay', 'wss://evil.example'], ['challenge', 'ch']] })
    });
    eq('an event for another relay is refused', r.reason, 'invalid-event');
    eq('and not written', box.frames.length, 0);
}
{
    const r = await auth.respondToAuth(['EVENT', 's', {}], { relayUrl: 'wss://r.example', send: send().fn, sign: () => signed() });
    eq('a non-AUTH frame is ignored', r.reason, 'not-an-auth-request');
}
{
    const r = await auth.respondToAuth(['AUTH', 'ch'], { relayUrl: 'https://bad', send: send().fn, sign: () => signed() });
    eq('a bad relay url is refused before signing', r.reason, 'bad-relay-url');
}
{
    // async signer is awaited
    const box = send();
    const r = await auth.respondToAuth(['AUTH', 'ch'], {
        relayUrl: 'wss://r.example', send: box.fn,
        sign: (tpl) => Promise.resolve(signed({ created_at: tpl.created_at }))
    });
    eq('an async signer works', r.sent, true);
}

// ------------------------------------------------------------- wrapSocket
/* The pages already had their own onmessage handlers, which ignored AUTH frames.
   wrapSocket is what puts the answer in without rewriting each handler, so it has
   to be tested as a wrapper: the previous handler must still receive everything
   that is not an AUTH. */
function fakeSocket() {
    return { sent: [], send(s) { this.sent.push(s); }, onmessage: null };
}
{
    const sock = fakeSocket();
    const seen = [];
    sock.onmessage = (e) => seen.push(e.data);          // the page's own handler
    eq('wrapping succeeds', auth.wrapSocket(sock, 'wss://r.example', { sign: () => signed() }), true);

    sock.onmessage({ data: JSON.stringify(['EVENT', 'sub', { kind: 1 }]) });
    eq('a normal frame still reaches the page handler', seen.length, 1);
    eq('and nothing was sent for it', sock.sent.length, 0);

    sock.onmessage({ data: JSON.stringify(['AUTH', 'ch']) });
    eq('an AUTH frame is NOT passed to the page handler', seen.length, 1);
}
{
    const sock = fakeSocket();
    const results = [];
    auth.wrapSocket(sock, 'wss://r.example', { sign: () => signed(), onResult: (r) => results.push(r) });
    sock.onmessage({ data: JSON.stringify(['AUTH', 'ch']) });
    await new Promise(r => setTimeout(r, 10));
    eq('the AUTH answer was written to the socket', sock.sent.length, 1);
    eq('and the result was reported', results.length, 1);
    eq('reported as sent', results[0].sent, true);
}
{
    // no signer: must report, never pretend it worked
    const sock = fakeSocket();
    const results = [];
    auth.wrapSocket(sock, 'wss://r.example', { onResult: (r) => results.push(r) });
    sock.onmessage({ data: JSON.stringify(['AUTH', 'ch']) });
    await new Promise(r => setTimeout(r, 10));
    eq('no signer sends nothing', sock.sent.length, 0);
    eq('and is reported as no-signer', results[0].reason, 'no-signer');
}
{
    // a malformed frame must not kill the page handler
    const sock = fakeSocket();
    let handled = 0;
    sock.onmessage = () => { handled++; };
    auth.wrapSocket(sock, 'wss://r.example', { sign: () => signed() });
    let threw = false;
    try { sock.onmessage({ data: 'not json' }); } catch (e) { threw = true; }
    eq('invalid JSON does not throw', threw, false);
    eq('and is forwarded to the page handler as-is', handled, 1);
}
{
    // a socket with no send() is refused rather than half-wrapped
    eq('a socket without send is refused', auth.wrapSocket({}, 'wss://r.example', {}), false);
    eq('null is refused', auth.wrapSocket(null, 'wss://r.example', {}), false);
}
{
    // wrapping twice must not double-answer
    const sock = fakeSocket();
    auth.wrapSocket(sock, 'wss://r.example', { sign: () => signed() });
    sock.onmessage({ data: JSON.stringify(['AUTH', 'ch']) });
    await new Promise(r => setTimeout(r, 10));
    eq('one AUTH frame produces exactly one answer', sock.sent.length, 1);
}

// ---------------------------------------------------------------- tracker
{
    const t = auth.createAuthTracker();
    t.observe('wss://a', { sent: true });
    t.observe('wss://b', { sent: false, reason: 'no-signer' });
    const s = t.stats();
    eq('requests are counted', s.requested, 2);
    eq('sends are counted', s.sent, 1);
    eq('failures are counted', s.failed, 1);
    eq('per relay breakdown exists', s.byRelay['wss://b'].failed, 1);
}

// --------------------------------------------------- all pages are wired
/* A page that loads the module but never wraps its socket still drops every AUTH
   request, which is the exact bug this closes. Both halves are asserted. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIRED = ['index.html', 'profile.html', 'thread.html', 'notes.html', 'bookmark.html', 'relay.html', 'notifications.html'];
for (const name of WIRED) {
    const src = readFileSync(join(root, name), 'utf8');
    ok(name + ': loads the auth module',
        /<script src="\/assets\/nostr-auth\.js\?v=[^"]+"><\/script>/.test(src));
    /* Either the page wraps its socket itself, or it hands the socket to
       NostrRelay.connectRelay, which wraps it inside the module. Both keep NIP-42
       alive; a page doing neither would silently drop AUTH again. */
    ok(name + ': the relay socket gets AUTH-wrapped',
        /NostrAuth\.wrapSocket\(socket, url, \{/.test(src)
        || /NostrRelay\.connectRelay\(\{/.test(src));
    ok(name + ': signs through window.nostr',
        /sign: \(window\.nostr && window\.nostr\.signEvent\)/.test(src));
    /* The wrap must come AFTER the page's own onmessage, or there is nothing to
       wrap and the AUTH frame is still dropped. */
    if (/NostrAuth\.wrapSocket\(socket, url/.test(src)) {
        const wrapAt = src.indexOf('NostrAuth.wrapSocket(socket, url');
        const msgAt = src.lastIndexOf('socket.onmessage = function', wrapAt);
        ok(name + ': wraps after the page handler is installed', msgAt !== -1 && msgAt < wrapAt);
    } else {
        /* connectRelay installs the page handler first and wraps afterwards. */
        ok(name + ': connectRelay installs the handler before wrapping',
            /socket\.onmessage = opts\.onMessage/.test(
                (await import('node:fs')).readFileSync(
                    new URL('../assets/nostr-relay.js', import.meta.url), 'utf8')));
    }
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
