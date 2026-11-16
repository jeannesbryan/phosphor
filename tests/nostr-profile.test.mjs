/* Tests for assets/nostr-profile.js and the notifications page that uses it.
   Run: node tests/nostr-profile.test.mjs
   No browser, no network: sockets and timers are fakes.

   Guards two measured faults (bos, 2026-11-16): a liker showed as "Node_3B4A"
   instead of their name because the profile request was sent once, only to the
   sockets open at that instant, and because the purpose-built profile indexes
   were never asked at all.
*/
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const prof = require('../assets/nostr-profile.js');
const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');
const page = readFileSync(join(root, 'notifications.html'), 'utf8');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}

// ------------------------------------------------------------- makeProfile
{
    const p = prof.makeProfile({ display_name: 'Chris', name: 'hipnonster', nip05: 'Hipnonster@NostrAddress.com' }, '8d8be383aa');
    eq('display_name wins for the name', p.name, 'Chris');
    /* Two shapes: `handle` is plain (textContent pages) and `handleLine` is
       escaped (innerHTML pages). Both must carry the domain, because every page
       showed the domain before this module existed. */
    eq('plain handle carries the domain', p.handle, '@hipnonster NostrAddress.com');
    eq('escaped handle line carries the domain', p.handleLine, '@hipnonster NostrAddress.com');
    ok('plain handle is not HTML escaped', prof.makeProfile({ name: "O'Brien" }, 'aa').handle === "@o'brien");
    eq('profile is marked resolved', p.resolved, true);
}
{
    const p = prof.makeProfile({ name: 'Zed' }, '3b4a00cdff');
    eq('no nip05 falls back to the name', p.handle, '@zed');
    eq('no domain means no trailing space', p.handleLine, '@zed');
}
{
    const p = prof.makeProfile({ name: 'Two Words' }, 'aa');
    eq('spaces are removed from the name handle', p.handle, '@twowords');
}
{
    const p = prof.makeProfile({ picture: 'https://x/y.png' }, 'aabbccdd');
    eq('missing name falls back to the pubkey prefix', p.name, 'aabbcc');
    eq('picture carried through', p.picture, 'https://x/y.png');
}
{
    const p = prof.makeProfile({ name: '<img src=x onerror=alert(1)>' }, 'aa');
    ok('handle line is HTML escaped', p.handleLine.indexOf('<') === -1 && p.handleLine.indexOf('&lt;') !== -1);
}
/* Zap buttons read these; dropping them would silently disable zapping. */
{
    const p = prof.makeProfile({ name: 'z', lud16: 'z@getalby.com', lud06: 'lnurl1xyz' }, 'aa');
    eq('lud16 is carried through', p.lud16, 'z@getalby.com');
    eq('lud06 is carried through', p.lud06, 'lnurl1xyz');
    const q = prof.makeProfile({ name: 'z' }, 'aa');
    eq('missing lud16 is null, not undefined', q.lud16, null);
    eq('missing lud06 is null, not undefined', q.lud06, null);
}

// --------------------------------------------------------- displayProfile
/* A pending placeholder is truthy but has no name. `cache[x] || fallback`
   therefore printed the literal string "undefined" into a card, which was seen
   on relay.html during the rollout. */
{
    eq('a real profile passes through untouched',
        prof.displayProfile({ name: 'Zed', handle: '@zed' }, 'aa').name, 'Zed');
    eq('a pending placeholder becomes the fallback name',
        prof.displayProfile({ pending: true }, '3b4a00cdff').name, 'Node_3B4A');
    eq('a missing profile becomes the fallback name',
        prof.displayProfile(undefined, '3b4a00cdff').name, 'Node_3B4A');
    eq('a resolved profile with no name also falls back',
        prof.displayProfile({ pending: false, name: undefined }, '3b4a00cdff').name, 'Node_3B4A');
    const d = prof.displayProfile({ pending: true }, '3b4a00cdff');
    ok('the fallback never carries the string undefined',
        String(d.name).indexOf('undefined') === -1 && String(d.handleLine).indexOf('undefined') === -1);
    eq('the fallback is not marked resolved', d.resolved, false);
}

// ------------------------------------------------------- normalizeCached
/* Records in IndexedDB were written by different page versions: some stored a
   plain `handle`, others an escaped `handleLine`. Reading the wrong shape is what
   makes a handle render as "undefined" or show a literal entity. */
{
    const fromHandle = prof.normalizeCached({ name: 'Zed', handle: '@zed zaps.lol', nip05: 'zed@zaps.lol' }, 'aa');
    eq('a record with only `handle` gains a handleLine', fromHandle.handleLine, '@zed zaps.lol');
    eq('plain handle is preserved', fromHandle.handle, '@zed zaps.lol');

    const fromLine = prof.normalizeCached({ name: 'Zed', handleLine: '@zed zaps.lol' }, 'aa');
    eq('a record with only `handleLine` gains a plain handle', fromLine.handle, '@zed zaps.lol');
    eq('handleLine stays escaped', fromLine.handleLine, '@zed zaps.lol');

    const quoted = prof.normalizeCached({ name: 'x', handleLine: '&#39;quoted&#39; name' }, 'aa');
    eq('entities are decoded for the plain shape', quoted.handle, "'quoted' name");
    eq('and re-encoded for the html shape', quoted.handleLine, '&#39;quoted&#39; name');

    eq('a missing record stays null', prof.normalizeCached(null, 'aa'), null);
    eq('a record with no handle at all yields empty strings',
        [prof.normalizeCached({ name: 'n' }, 'aa').handle, prof.normalizeCached({ name: 'n' }, 'aa').handleLine], ['', '']);
    eq('lud16 survives normalisation', prof.normalizeCached({ name: 'n', lud16: 'a@b' }, 'aa').lud16, 'a@b');
}

eq('fallback name is Node_ plus four uppercase chars', prof.fallbackName('3b4a00cdff'), 'Node_3B4A');
eq('fallback handle is eight chars', prof.fallbackHandle('3b4a00cdff'), '@3b4a00cd');
eq('fallback profile is not resolved', prof.fallbackProfile('3b4a00cdff').resolved, false);

// ------------------------------------------------------------- resolver
function harness(extra) {
    const sockets = [];
    const timers = [];
    const calls = { openProfileRelays: 0, resolved: {}, gaveUp: [] };
    const r = prof.createResolver(Object.assign({
        getSockets: () => sockets,
        openProfileRelays: () => { calls.openProfileRelays++; },
        onResolve: (pk, p) => { calls.resolved[pk] = p; },
        onGiveUp: (pk) => { calls.gaveUp.push(pk); },
        schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
        cancel: () => {}
    }, extra || {}));
    return { r, sockets, timers, calls };
}
function sock(state) { return { readyState: state, sent: [], send(d) { this.sent.push(d); } }; }

// fault 1: a request made while a socket is still connecting must reach it later
{
    const h = harness();
    const open = sock(1), connecting = sock(0);
    h.sockets.push(open, connecting);
    h.r.lookup('b6f2d38bffff');
    eq('sent to the open socket', open.sent.length, 1);
    eq('not sent to a socket that is still connecting', connecting.sent.length, 0);
    connecting.readyState = 1;
    h.r.flush();
    eq('flush delivers the pending request to the newly opened socket', connecting.sent.length, 1);
    /* Guarded: an empty .sent must FAIL, not throw. A test that crashes reports a
       red suite for the wrong reason and hides whether the rule was checked. */
    const flushed = connecting.sent[0] || '';
    ok('the flushed request asks for kind 0', flushed.indexOf('"kinds":[0]') !== -1);
    ok('the flushed request names the pubkey', flushed.indexOf('b6f2d38bffff') !== -1);
}
// a lookup must not start twice for the same pubkey
{
    const h = harness();
    const s = sock(1);
    h.sockets.push(s);
    h.r.lookup('dup');
    h.r.lookup('dup');
    eq('second lookup for the same pubkey sends nothing extra', s.sent.length, 1);
}
// retries: the second attempt brings in the profile indexes, once only
{
    const h = harness();
    h.sockets.push(sock(1));
    h.r.lookup('a90bad52bb');
    eq('profile relays are not opened on the first attempt', h.calls.openProfileRelays, 0);
    eq('two retries are scheduled', h.timers.length, 2);
    (h.timers[0] || { fn: () => {} }).fn(); // retry 1
    eq('profile relays open on the second attempt', h.calls.openProfileRelays, 1);
    (h.timers[1] || { fn: () => {} }).fn(); // retry 2
    eq('profile relays are opened once, not per retry', h.calls.openProfileRelays, 1);
    eq('exhausted retries report give-up so the page can stop waiting', h.calls.gaveUp, ['a90bad52bb']);
}
// a slow page: retries still fire even when no socket is open at first
{
    const h = harness();
    h.r.lookup('slowpub');
    h.timers.forEach(t => t.fn());
    eq('no socket open means no send, but the lookup still ends', h.calls.gaveUp, ['slowpub']);
}
// absorb resolves, stops the retries, and reports the parsed profile
{
    const h = harness();
    h.sockets.push(sock(1));
    h.r.lookup('9249b02daa');
    const body = JSON.stringify({ name: 'imad in gaza', display_name: 'imad in gaza' });
    const consumed = h.r.absorb({ kind: 0, pubkey: '9249b02daa', content: body });
    eq('absorb consumed the profile event', consumed, true);
    eq('resolved profile name', h.calls.resolved['9249b02daa'].name, 'imad in gaza');
    h.timers.forEach(t => t.fn());
    eq('no give-up after the profile was found', h.calls.gaveUp, []);
    eq('profile relays never opened once the answer arrived', h.calls.openProfileRelays, 0);
}
// absorb is defensive
{
    const h = harness();
    eq('ignores a non kind 0 event', h.r.absorb({ kind: 1, pubkey: 'x', content: '{}' }), false);
    eq('ignores broken JSON', h.r.absorb({ kind: 0, pubkey: 'x', content: 'not json' }), false);
    eq('ignores a null content object', h.r.absorb({ kind: 0, pubkey: 'x', content: 'null' }), false);
    eq('ignores a missing event', h.r.absorb(null), false);
}
// stats are honest about what is still pending
{
    const h = harness();
    h.sockets.push(sock(1));
    h.r.lookup('p1');
    eq('one lookup pending', h.r.stats().pending.length, 1);
    h.r.absorb({ kind: 0, pubkey: 'p1', content: '{"name":"n"}' });
    eq('nothing pending after the answer', h.r.stats().pending.length, 0);
    eq('one resolved', h.r.stats().done.length, 1);
}

// --------------------------------------------- connectProfileRelays plumbing
/* Node's WebSocket is replaced for the duration of this block, so the socket
   plumbing is exercised for real instead of being trusted. */
{
    const made = [];
    class FakeWS {
        constructor(url) { this.url = url; this.readyState = 0; made.push(this); }
        send() {}
        close() {}
        emit(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
        open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    }
    const realWS = globalThis.WebSocket;
    globalThis.WebSocket = FakeWS;

    const events = [];
    let opens = 0;
    const sockets = prof.connectProfileRelays(
        ['wss://purplepag.es', 'http://not-a-ws-relay', 'wss://relay.nostr.net'],
        { onOpen: () => { opens++; }, onEvent: (ev) => events.push(ev) }
    );
    eq('one socket per valid relay, invalid scheme skipped', sockets.length, 2);
    eq('sockets kept the given order', sockets.map(s => s.url), ['wss://purplepag.es', 'wss://relay.nostr.net']);

    sockets[0].open();
    eq('onOpen fires per socket', opens, 1);

    sockets[0].emit(['EVENT', 'sub', { kind: 0, pubkey: 'aa', content: '{"name":"n"}' }]);
    eq('onEvent receives the event', events.length, 1);
    sockets[0].emit(['EOSE', 'sub']);
    eq('non EVENT frames are ignored', events.length, 1);
    sockets[0].emit(['EVENT', 'sub', null]);
    eq('an EVENT with no payload is ignored', events.length, 1);

    /* A malformed frame must not throw out of the handler. */
    let threw = false;
    try { if (sockets[0].onmessage) sockets[0].onmessage({ data: 'not json' }); } catch (e) { threw = true; }
    ok('a malformed frame does not throw', threw === false);

    globalThis.WebSocket = realWS;
    eq('connectProfileRelays returns an empty list for no relays', prof.connectProfileRelays([], {}).length, 0);
    eq('and tolerates a missing relay list', prof.connectProfileRelays(undefined, {}).length, 0);
}

// --------------------------------------------------- the page uses the module
ok('page loads the profile module', /<script src="\/assets\/nostr-profile\.js/.test(page));

ok('page builds its resolver from the module',
    /NostrProfile\s*\.\s*createResolver\s*\(/.test(page));

/* Both checks below are anchored to the specific site, because a bare
   "does this text appear anywhere" check matched the PROFILE socket's own
   handler instead of the timeline socket's, letting the mutation through. */
ok('the kind 0 branch on the timeline socket feeds the resolver',
    /if \(ev\.kind === 0\) \{[\s\S]{0,400}if \(profileResolver\) \{ profileResolver\.absorb\(ev\); \}/.test(page));

ok('the timeline socket flushes pending lookups when it opens',
    /socket\.onopen = function\(\) \{[\s\S]{0,220}profileResolver\.flush\(\);/.test(page));

/* The profile sockets used to wire their own onopen in the page. That wiring now
   lives in connectProfileRelays(), so the page only has to pass onOpen. */
ok('profile sockets get their flush from the shared helper',
    /connectProfileRelays\(PROFILE_RELAYS, \{[\s\S]{0,200}onOpen: \(\) => \{ if \(profileResolver\) profileResolver\.flush\(\); \}/.test(page));

ok('page asks the profile indexes lazily, not on every load',
    /openProfileRelays\s*:/.test(page));

ok('profile relay list is read from config', /profile_relays|PROFILE_RELAYS/.test(page));

ok('page no longer fires the profile request only once',
    !/activeSockets\.forEach\(sock => \{ if \(sock && sock\.readyState === WebSocket\.OPEN\) sock\.send\(req\); \}\);\s*\}\s*\}/.test(page));

// ------------------------------------- every page is wired the same way
/* Six pages were wired in one pass on 2026-11-16 after notifications.html. They
   must all use the one module: a page that keeps its own single-shot request, or
   forgets to flush on open, silently brings the Node_XXXX bug back. */
const WIRED = ['index.html', 'profile.html', 'thread.html', 'notes.html', 'bookmark.html', 'relay.html', 'notifications.html'];
const pages = {};
for (const name of WIRED) pages[name] = readFileSync(join(root, name), 'utf8');

for (const name of WIRED) {
    const src = pages[name];
    ok(name + ': loads the profile module',
        /<script src="\/assets\/nostr-profile\.js\?v=[^"]+"><\/script>/.test(src));
    ok(name + ': builds a resolver from it',
        /window\.NostrProfile\s*\?\s*window\.NostrProfile\.createResolver\(/.test(src));
    ok(name + ': opens the profile indexes lazily',
        /openProfileRelays:\s*\(\)\s*=>/.test(src));
    ok(name + ': uses the shared socket helper',
        /NostrProfile\.connectProfileRelays\(/.test(src));
    ok(name + ': feeds kind 0 to the resolver',
        /if \(profileResolver\) \{ profileResolver\.absorb\(ev\); \}/.test(src));
    ok(name + ': flushes when a relay opens',
        /profileResolver\) profileResolver\.flush\(\);\s*\n\s*onlineCount\+\+/.test(src)
        || /socket\.onopen = function\(\) \{\s*\n[\s\S]{0,200}profileResolver\.flush\(\)/.test(src));
    ok(name + ': reads profile_relays from config',
        /config\.profile_relays/.test(src));
    ok(name + ': normalises a cached record before reading it',
        /if \(cached && window\.NostrProfile\) cached = window\.NostrProfile\.normalizeCached\(cached, pubkey\);/.test(src));
    /* `if (!info || info.pending) info = {...}` is the correct guard. The broken
       idiom is `cache[x] || { name: ... }` with no pending check, which prints the
       literal "undefined" once the placeholder is set. */
    ok(name + ': no unguarded profile fallback in render paths',
        !/let info = profileCache\[[^\]]+\] \|\| \{/.test(src) && !/let rpInfo = profileCache\[/.test(src));
    ok(name + ': routes the request through the resolver',
        /if \(profileResolver\) \{ profileResolver\.lookup\(pubkey\); \}/.test(src));
}

/* Those five render sites must hand the CACHE ENTRY to displayProfile, not a
   constant. Asserting only that the call exists let "always pass null" survive. */
ok('relay.html passes the cached entry for the note author',
    /displayProfile\(profileCache\[targetEv\.pubkey\], targetEv\.pubkey\)/.test(pages['relay.html']));
ok('relay.html passes the cached entry for the reposter',
    /displayProfile\(profileCache\[ev\.pubkey\], ev\.pubkey\)/.test(pages['relay.html']));
ok('notes.html passes the cached entry (both render paths)',
    (pages['notes.html'].match(/displayProfile\(profileCache\[ev\.pubkey\], ev\.pubkey\)/g) || []).length === 2);
ok('index.html passes the cached entry for the reposter',
    /displayProfile\(profileCache\[repostEv\.pubkey\], repostEv\.pubkey\)/.test(pages['index.html']));
/* Reading the cache without ever requesting the profile leaves the reposter as
   Node_XXXX forever, even when the profile exists on an index relay. */
ok('index.html requests the reposter profile before rendering it',
    /requestProfileInfo\(repostEv\.pubkey\);\s*\n\s*let rpInfo/.test(pages['index.html']));


/* profile.html must keep its own guard: the page's own profile is rendered by the
   header block below, not cached as a following. Dropping it was a real
   regression during this rollout. */
ok('profile.html keeps the target-pubkey guard on the kind 0 branch',
    /if \(ev\.kind === 0 && ev\.pubkey !== targetPubkey\) \{[\s\S]{0,300}profileResolver\.absorb\(ev\)/.test(pages['profile.html']));

/* No page may still parse a profile inline on the feed socket: the seven copies
   are what let the same bug live in four places at once. Counted across all
   pages, only the two "fetch my own avatar" one-shot sockets may remain, and they
   must use makeProfile. */
{
    /* Fingerprint of a hand-built profile object from `meta` (as opposed to
       reading the cache, which is fine): both of the field expressions below only
       appear when a page assembles the handle itself. */
    const manual = WIRED.map(n => (pages[n].match(/handle: domainPart \?|handleLine: handleLineStr|handleLine: domainPart \?/g) || []).length)
        .reduce((a, b) => a + b, 0);
    eq('no page builds a handle from NIP-05 by hand any more', manual, 0);

    const usesMakeProfile = WIRED.map(n => (pages[n].match(/NostrProfile\.makeProfile\(/g) || []).length)
        .reduce((a, b) => a + b, 0);
    ok('own-profile sockets use makeProfile', usesMakeProfile >= 2);
    ok('index.html own-profile socket uses it', (pages['index.html'].match(/NostrProfile\.makeProfile\(/g) || []).length === 1);
    ok('thread.html own-profile socket uses it', (pages['thread.html'].match(/NostrProfile\.makeProfile\(/g) || []).length === 1);
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
