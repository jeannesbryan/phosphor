/* Tests for assets/nostr-relay-info.js
   Run: node tests/nostr-relay-info.test.mjs
   Pure — no browser, no network (fetch is stubbed).

   Why this test exists (2026-10-11)
   ---------------------------------
   NIP-11 gives relay.html a description of the relay it is exploring. The
   document is written by a THIRD PARTY and is therefore untrusted: a hostile
   relay could put markup in its name, or type the fields wrongly. These tests
   guard two things: the WebSocket -> HTTP URL conversion, and the rule that
   nothing from the document reaches the page unescaped.
*/
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const relayInfo = require('../assets/nostr-relay-info.js');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
    if (cond) { pass++; results.push('  ok   ' + name); }
    else { fail++; results.push(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
}
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; results.push('  ok   ' + name); }
    else { fail++; results.push(`  FAIL ${name}\n         got: ${g}\n         want: ${w}`); }
}

// ------------------------------------------------------------- 1. URL mapping
console.log('--- 1. WebSocket URL -> NIP-11 URL ---');
eq('wss becomes https', relayInfo.infoUrl('wss://relay.damus.io'), 'https://relay.damus.io');
eq('ws becomes http', relayInfo.infoUrl('ws://127.0.0.1:7777'), 'http://127.0.0.1:7777');
eq('a port is kept', relayInfo.infoUrl('wss://relay.example:8443'), 'https://relay.example:8443');
eq('a path is kept', relayInfo.infoUrl('wss://relay.example/nostr'), 'https://relay.example/nostr');
eq('surrounding whitespace is trimmed', relayInfo.infoUrl('  wss://relay.example  '), 'https://relay.example');
eq('https is accepted as-is', relayInfo.infoUrl('https://relay.example'), 'https://relay.example');
eq('a scheme-less string is rejected', relayInfo.infoUrl('relay.example'), null);
eq('a strange scheme is rejected', relayInfo.infoUrl('ftp://relay.example'), null);
eq('null is safe', relayInfo.infoUrl(null), null);
eq('a number is safe', relayInfo.infoUrl(42), null);

// ------------------------------------------------------------- 2. summarize
console.log('--- 2. summarize ---');
eq('null -> null', relayInfo.summarize(null), null);
eq('an array -> null', relayInfo.summarize([]), null);
eq('a string -> null', relayInfo.summarize('hello'), null);
eq('an empty object is still a summary', typeof relayInfo.summarize({}), 'object');

const real = relayInfo.summarize({
    name: 'Damus',
    description: 'A relay run by damus.io',
    pubkey: 'a'.repeat(64),
    contact: 'admin@damus.io',
    supported_nips: [1, 2, 11, 42],
    software: 'git+https://github.com/hoytech/strfry.git',
    version: '0.9.6',
    limitation: { auth_required: false, payment_required: true, max_message_length: 131072, max_limit: 500 }
});
eq('name is read', real.name, 'Damus');
eq('the NIP list is read', real.nips, [1, 2, 11, 42]);
eq('payment_required is read', real.limitation.paymentRequired, true);
eq('auth_required false stays false', real.limitation.authRequired, false);
eq('max_message_length is read', real.limitation.maxMessageLength, 131072);

// Malformed data must not crash and must not leak through.
const weird = relayInfo.summarize({
    name: { evil: 'object' },
    description: ['not', 'a', 'string'],
    supported_nips: ['1', 'two', null, 11, -5, 99999, 42.5],
    limitation: 'not an object',
    version: 12345
});
eq('a non-string name becomes empty', weird.name, '');
eq('an array description becomes empty', weird.description, '');
eq('only real NIP integers survive (fractions and strings dropped)', weird.nips, [11]);
eq('a non-object limitation is treated as empty', weird.limitation.authRequired, false);
eq('a numeric version is dropped', weird.version, '');
eq('max message length stays null when absent', weird.limitation.maxMessageLength, null);

// Huge strings are truncated, so a hostile document cannot blow up the DOM.
const huge = relayInfo.summarize({ description: 'x'.repeat(5000), name: 'y'.repeat(500) });
ok('a long description is truncated', huge.description.length <= 801, String(huge.description.length));
ok('the description gets an ellipsis', huge.description.endsWith('\u2026'));
ok('a long name is truncated', huge.name.length <= 121);

// ------------------------------------------------------------- 3. escaping
console.log('--- 3. untrusted document -> HTML is escaped ---');
const hostile = relayInfo.summarize({
    name: '<script>alert(1)</script>',
    description: '<img src=x onerror=alert(2)>',
    contact: '"><b>bold',
    software: '<svg onload=alert(3)>',
    posting_policy: 'https://evil.example/policy?x=<script>',
    limitation: {}
});
const html = relayInfo.renderHtml(hostile, 'relay.example');
ok('no raw <script> survives', html.indexOf('<script>') === -1);
ok('the injected script tag is escaped', html.indexOf('&lt;script&gt;') !== -1);
ok('no <img onerror> survives', html.indexOf('<img src=x') === -1);
ok('no <svg onload> survives', html.indexOf('<svg') === -1);
ok('the description is escaped', html.indexOf('&lt;img') !== -1);
ok('quotes in a field are escaped', html.indexOf('&quot;') !== -1);
ok('the hostile closing tag is escaped', html.indexOf('&lt;/script&gt;') !== -1);

// The NIP number list must not be injectable either: it is built from numbers.
const nipInject = relayInfo.renderHtml(relayInfo.summarize({ supported_nips: [1, 11] }), 'r');
ok('NIP links point at the official repo', nipInject.indexOf('github.com/nostr-protocol/nips') !== -1);
ok('NIP-1 is zero-padded to 01.md', nipInject.indexOf('master/01.md') !== -1);
ok('NIP-11 uses 11.md', nipInject.indexOf('master/11.md') !== -1);

// ------------------------------------------------------------- 4. render
console.log('--- 4. rendering the panel ---');
eq('no summary -> no HTML', relayInfo.renderHtml(null, 'r'), '');
const empty = relayInfo.renderHtml(relayInfo.summarize({}), 'relay.example');
ok('an empty document still shows the header', empty.indexOf('RELAY_INFO') !== -1);
ok('an empty document falls back to the host name', empty.indexOf('relay.example') !== -1);
ok('an empty document says the NIPs were not listed', empty.indexOf('did not list its NIPs') !== -1);
ok('an empty document renders no NIP links',
    empty.indexOf('github.com/nostr-protocol') === -1);

const authDoc = relayInfo.renderHtml(relayInfo.summarize({ limitation: { auth_required: true } }), 'r');
ok('auth_required shows a badge', authDoc.indexOf('AUTH REQUIRED') !== -1);
const payDoc = relayInfo.renderHtml(relayInfo.summarize({ limitation: { payment_required: true } }), 'r');
ok('payment_required shows a badge', payDoc.indexOf('PAYMENT REQUIRED') !== -1);
const readOnly = relayInfo.renderHtml(relayInfo.summarize({ limitation: { restricted_writes: true } }), 'r');
ok('restricted_writes shows a badge', readOnly.indexOf('READ-ONLY') !== -1);

const withLimits = relayInfo.renderHtml(relayInfo.summarize({ limitation: { max_limit: 500, max_message_length: 131072 } }), 'r');
ok('limits are shown', withLimits.indexOf('max limit 500') !== -1);
ok('message length is shown in bytes', withLimits.indexOf('max message 131072 B') !== -1);

const withPubkey = relayInfo.renderHtml(relayInfo.summarize({ pubkey: 'b'.repeat(64) }), 'r');
ok('the relay pubkey links to its profile', withPubkey.indexOf('profile.html?pubkey=' + 'b'.repeat(64)) !== -1);

// ------------------------------------------------------------- 5. fetchInfo
console.log('--- 5. fetchInfo ---');
function fetchOk(body) {
    return () => Promise.resolve({ status: 200, json: () => Promise.resolve(body) });
}
eq('a good document comes back summarized',
    (await relayInfo.fetchInfo('wss://relay.example', fetchOk({ name: 'R', supported_nips: [1] }))).name, 'R');
eq('the URL is recorded on the result',
    (await relayInfo.fetchInfo('wss://relay.example', fetchOk({ name: 'R' }))).url, 'https://relay.example');
ok('a non-2xx answer -> null',
    (await relayInfo.fetchInfo('wss://relay.example', () => Promise.resolve({ status: 404, json: () => Promise.resolve({}) }))) === null);
ok('a 500 -> null',
    (await relayInfo.fetchInfo('wss://relay.example', () => Promise.resolve({ status: 500, json: () => Promise.resolve({}) }))) === null);
ok('a network error -> null (no reject)',
    (await relayInfo.fetchInfo('wss://relay.example', () => Promise.reject(new Error('CORS')))) === null);
ok('broken JSON -> null',
    (await relayInfo.fetchInfo('wss://relay.example', () => Promise.resolve({ status: 200, json: () => Promise.reject(new Error('bad json')) }))) === null);
ok('a bad ws url -> null without fetching',
    (await relayInfo.fetchInfo('not-a-url', () => { throw new Error('must not be called'); })) === null);

// The Accept header is what makes a NIP-11 request.
let seenOpts = null;
await relayInfo.fetchInfo('wss://relay.example', (url, opts) => { seenOpts = opts; return Promise.resolve({ status: 200, json: () => Promise.resolve({}) }); });
eq('the Accept header requests the NIP-11 document', seenOpts.headers.Accept, 'application/nostr+json');

// ------------------------------------------------------------- 6. load
console.log('--- 6. load(panel) ---');
function fakePanel() {
    const p = { html: '' };
    Object.defineProperty(p, 'innerHTML', { get() { return this.html; }, set(v) { this.html = v; } });
    return p;
}
let panel = fakePanel();
let sum = await relayInfo.load('wss://relay.example', panel, { fetchImpl: fetchOk({ name: 'R', supported_nips: [1, 11] }) });
eq('load returns the summary', sum && sum.name, 'R');
ok('load renders into the panel', panel.innerHTML.indexOf('RELAY_INFO') !== -1);

panel = fakePanel();
sum = await relayInfo.load('wss://relay.example', panel, { fetchImpl: () => Promise.reject(new Error('CORS')) });
eq('a failed load returns null', sum, null);
ok('a failed load explains itself', panel.innerHTML.indexOf('did not answer with a NIP-11') !== -1);
ok('a failed load promises the explorer still works', panel.innerHTML.indexOf('still works normally') !== -1);
eq('load without a panel is safe', await relayInfo.load('wss://relay.example', null), null);

// ------------------------------------------------------------- 7. page wiring
console.log('--- 7. page wiring ---');
const { readFileSync } = await import('node:fs');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const relayHtml = readFileSync(join(root, 'relay.html'), 'utf8');
ok('relay.html loads the module', relayHtml.includes('/assets/nostr-relay-info.js'));
ok('relay.html has a panel to render into', relayHtml.includes('id="relayInfoPanel"'));
ok('relay.html calls NostrRelayInfo.load', relayHtml.includes('NostrRelayInfo.load'));

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
