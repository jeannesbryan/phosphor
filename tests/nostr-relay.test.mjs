/* Tests for assets/nostr-relay.js.
   Run: node tests/nostr-relay.test.mjs
   Fake sockets and a fake button: no network, no DOM. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const relay = require('../assets/nostr-relay.js');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}
const btn = () => ({ textContent: '[RELAYS: CONNECTING...]' });

// ----------------------------------------------------------------- label
/* One format, matching the "CONNECTING..." label the pages start with. Eight pages
   used to switch to "[ RELAYS: ... ]" (inner spaces) on the first update. */
eq('the label is the same style as the connecting one',
    relay.relayLabel(2, 4), '[RELAYS: 2/4 ONLINE]');
eq('zero online is honest', relay.relayLabel(0, 4), '[RELAYS: 0/4 ONLINE]');
eq('a nonsense total does not print NaN', relay.relayLabel(1, undefined), '[RELAYS: 1/0 ONLINE]');
eq('the connecting label is unchanged', relay.connectingLabel(), '[RELAYS: CONNECTING...]');
{
    /* The two labels must not differ in the spacing inside the brackets, which is
       exactly the inconsistency that existed between pages. */
    const inner = (s) => s.slice(1, s.indexOf(':'));
    eq('both labels use the same bracket spacing', inner(relay.relayLabel(1, 2)), inner(relay.connectingLabel()));
}

// ------------------------------------------------------------------ pool
{
    const b = btn();
    const pool = relay.createPool({ button: b, total: 4 });
    eq('nothing online at first', pool.onlineCount(), 0);
    pool.markOnline('wss://a');
    eq('one relay online', pool.onlineCount(), 1);
    eq('the button reflects it', b.textContent, '[RELAYS: 1/4 ONLINE]');
    pool.markOnline('wss://b');
    eq('two online', pool.onlineCount(), 2);
    ok('isOnline reports per relay', pool.isOnline('wss://b') === true && pool.isOnline('wss://c') === false);
}
{
    /* THE BUG: the old counter was only ever incremented, so the button kept saying
       4/4 after a relay went down while the modal (reading the map) said OFFLINE.
       The count is derived now, so the two cannot disagree. */
    const b = btn();
    const pool = relay.createPool({ button: b, total: 2 });
    pool.markOnline('wss://a');
    pool.markOnline('wss://b');
    eq('both online reads 2/2', b.textContent, '[RELAYS: 2/2 ONLINE]');
    pool.markOffline('wss://b');
    eq('after one drops the label says 1/2, not 2/2', b.textContent, '[RELAYS: 1/2 ONLINE]');
    eq('and the map agrees', pool.isOnline('wss://b'), false);
}
{
    // marking the same relay online twice must not double count
    const pool = relay.createPool({ total: 4 });
    pool.markOnline('wss://a');
    pool.markOnline('wss://a');
    eq('double marking counts once', pool.onlineCount(), 1);
}
{
    // a relay that opens, dies, and reopens must not drift upward
    const pool = relay.createPool({ total: 1 });
    pool.markOnline('wss://a');
    pool.markOffline('wss://a');
    pool.markOnline('wss://a');
    eq('a flapping relay ends at 1 of 1', pool.onlineCount(), 1);
}
{
    const pool = relay.createPool({ total: 3 });
    pool.markOnline('wss://a');
    pool.markOnline('wss://b');
    eq('the map is exposed for the modal that reads it directly',
        pool.status['wss://a'], true);
    eq('and it matches isOnline', pool.status['wss://b'], pool.isOnline('wss://b'));
}
{
    // no button must not throw
    const pool = relay.createPool({ total: 2 });
    pool.markOnline('wss://a');
    eq('a pool without a button still counts', pool.onlineCount(), 1);
    pool.render();
    ok('render without a button is a no-op', true);
}
{
    // a custom label builder is honoured
    const pool = relay.createPool({ button: btn(), total: 1, label: (o, t) => o + '/' + t });
    pool.markOnline('wss://a');
    eq('a custom label builder is used', pool.label(), '1/1');
}
eq('the status map starts empty', Object.keys(relay.createPool({}).status).length, 0);
{
    /* The pool must ADOPT the page's map, not replace it: the relay modal holds a
       reference and would otherwise keep reading a stale object. */
    const existing = { 'wss://a': true };
    const pool = relay.createPool({ total: 1, status: existing });
    ok('the page map is adopted, not replaced', pool.status === existing);
    eq('and its contents are honoured', pool.onlineCount(), 1);
    pool.markOffline('wss://a');
    eq('marking offline writes through to the page map', existing['wss://a'], false);
}

// ---------------------------------------------------------- connectRelay
class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.readyState = 0; FakeWS.last = this; }
    send(d) { this.sent.push(d); }
    close() {}
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    fail() { if (this.onerror) this.onerror(); }
    shut() { if (this.onclose) this.onclose(); }
    message(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
}
const realWS = globalThis.WebSocket;
globalThis.WebSocket = FakeWS;

{
    const b = btn();
    const pool = relay.createPool({ button: b, total: 1 });
    let opened = 0;
    const sock = relay.connectRelay({
        url: 'wss://a', pool,
        onOpen: () => { opened++; }
    });
    ok('a socket is returned', sock instanceof FakeWS);
    eq('the relay starts as offline', pool.isOnline('wss://a'), false);
    sock.open();
    eq('opening marks it online', pool.isOnline('wss://a'), true);
    eq('the page callback ran once', opened, 1);
    eq('the button updated', b.textContent, '[RELAYS: 1/1 ONLINE]');
    sock.shut();
    eq('closing marks it offline again', pool.isOnline('wss://a'), false);
    eq('and the button says so', b.textContent, '[RELAYS: 0/1 ONLINE]');
}
{
    // a socket that errors marks offline
    const pool = relay.createPool({ total: 1 });
    const sock = relay.connectRelay({ url: 'wss://a', pool });
    sock.open();
    sock.fail();
    eq('an error marks the relay offline', pool.isOnline('wss://a'), false);
}
{
    // the page's message handler is installed and receives frames
    const pool = relay.createPool({ total: 1 });
    const seen = [];
    const sock = relay.connectRelay({ url: 'wss://a', pool, onMessage: (e) => seen.push(e.data) });
    sock.message(['EVENT', 's', { kind: 1 }]);
    eq('the page handler received the frame', seen.length, 1);
}
{
    // NIP-42 wrapping still happens, so auth is not lost by this refactor
    const pool = relay.createPool({ total: 1 });
    let authWrapped = 0;
    const realAuth = globalThis.NostrAuth;
    globalThis.NostrAuth = { wrapSocket: () => { authWrapped++; return true; } };
    relay.connectRelay({ url: 'wss://a', pool });
    eq('NostrAuth.wrapSocket was called once', authWrapped, 1);
    globalThis.NostrAuth = realAuth;
}
{
    // a bad URL must not abort the page's loop
    const pool = relay.createPool({ total: 2 });
    const bad = relay.connectRelay({ url: '', pool });
    eq('an empty url returns null', bad, null);
    // connectRelay must not throw even when WebSocket does
    const throwingWS = globalThis.WebSocket;
    globalThis.WebSocket = function () { throw new Error('bad url'); };
    let threw = false;
    try { relay.connectRelay({ url: 'wss://x', pool }); } catch (e) { threw = true; }
    eq('a throwing constructor does not throw out', threw, false);
    globalThis.WebSocket = throwingWS;
}
{
    // no pool at all must still work
    const sock = relay.connectRelay({ url: 'wss://a' });
    ok('a relay can be wired without a pool', sock instanceof FakeWS);
    let threw = false;
    try { sock.open(); sock.shut(); } catch (e) { threw = true; }
    eq('and opening it without a pool does not throw', threw, false);
}

globalThis.WebSocket = realWS;

// --------------------------------------------------- all pages are wired
/* Every page must build its pool and route status through it. The bookkeeping is
   the part that drifted: a page keeping its own counter would keep lying after a
   relay dropped. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIRED = ['index.html', 'profile.html', 'thread.html', 'notes.html', 'bookmark.html',
    'relay.html', 'notifications.html', 'compose.html', 'activity.html'];
for (const name of WIRED) {
    const src = readFileSync(join(root, name), 'utf8');
    ok(name + ': loads the relay module',
        /<script src="\/assets\/nostr-relay\.js\?v=[^"]+"><\/script>/.test(src));
    ok(name + ': builds a pool with its own map',
        /NostrRelay\.createPool\(\{[^}]*status: relayStatusMap/.test(src));
    /* The old inline triad must be gone, or the count drifts again. */
    ok(name + ': no page increments its own online counter',
        !/onlineCount\+\+;\s*relayStatusMap\[url\]\s*=\s*true/.test(src));
    /* Either the page marks offline itself, or it hands the whole socket to
       connectRelay which does it inside the module. Both are valid; a page doing
       NEITHER would leave the label stuck. */
    ok(name + ': offline is tracked through the pool',
        /relayPool\.markOffline\(url\)/.test(src) || /NostrRelay\.connectRelay\(\{/.test(src));
}
/* index.html routes the whole socket through connectRelay, so it marks online
   inside the module rather than in the page. */
{
    const idx = readFileSync(join(root, 'index.html'), 'utf8');
    ok('index.html wires sockets through connectRelay',
        /NostrRelay\.connectRelay\(\{/.test(idx));
    ok('index.html hands its map to the pool so the relay modal keeps working',
        /status: relayStatusMap/.test(idx));
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
