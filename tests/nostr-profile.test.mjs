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
    eq('NIP-05 local part drives the handle', p.handle, '@hipnonster');
    eq('handle line shows the domain', p.handleLine, '@hipnonster NostrAddress.com');
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
    /my-network-prefs-[\s\S]{0,300}profileResolver\s*\.\s*flush\s*\(/.test(page));

ok('profile sockets also flush on open',
    /sock\.onopen = function \(\) \{ if \(profileResolver\) profileResolver\.flush\(\); \}/.test(page));

ok('page asks the profile indexes lazily, not on every load',
    /openProfileRelays\s*:/.test(page));

ok('profile relay list is read from config', /profile_relays|PROFILE_RELAYS/.test(page));

ok('page no longer fires the profile request only once',
    !/activeSockets\.forEach\(sock => \{ if \(sock && sock\.readyState === WebSocket\.OPEN\) sock\.send\(req\); \}\);\s*\}\s*\}/.test(page));

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
