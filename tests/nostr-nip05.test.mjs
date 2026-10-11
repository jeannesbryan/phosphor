/* Tests for assets/nostr-nip05.js — run: node tests/nostr-nip05.test.mjs
   Pure — no browser, no network (fetch is stubbed, localStorage may be absent).

   Why this test exists (2026-10-11)
   ---------------------------------
   Every page used to print "handle ✓ domain" the moment a profile merely
   CONTAINED a nip05 field. Nothing was fetched, so the check mark was a lie:
   anyone could claim someone else's handle. The check mark must now appear ONLY
   after https://<domain>/.well-known/nostr.json?name=<local> has confirmed the
   pubkey. These tests guard exactly that boundary.
*/
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const nip05 = require('../assets/nostr-nip05.js');

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

const PK = 'edcd7d0bbf0e8b0e5a8e0d5d2f2d0ecf'.padEnd(64, 'a');
const OTHER = 'b'.repeat(64);

// ---------------------------------------------------------------- 1. parse
console.log('--- 1. parsing identifiers ---');
eq('name@domain', nip05.parse('jack@cash.app'), { local: 'jack', domain: 'cash.app' });
eq('bare domain -> local "_"', nip05.parse('example.com'), { local: '_', domain: 'example.com' });
eq('uppercase is normalised', nip05.parse('Jack@Cash.App'), { local: 'jack', domain: 'cash.app' });
eq('a port is rejected', nip05.parse('jack@cash.app:8443'), null);
eq('a path is rejected', nip05.parse('jack@cash.app/x'), null);
eq('whitespace is rejected', nip05.parse('jack @cash.app'), null);
eq('an IP literal is rejected', nip05.parse('jack@192.168.1.1'), null);
eq('a dotless domain is rejected', nip05.parse('jack@localhost'), null);
eq('a leading dash label is rejected', nip05.parse('jack@-evil.com'), null);
eq('empty is rejected', nip05.parse(''), null);
eq('null is rejected', nip05.parse(null), null);
eq('not a string is rejected', nip05.parse(42), null);
eq('the local part may use . _ -', nip05.parse('a.b_c-d@example.com').local, 'a.b_c-d');
eq('an injection attempt in the local part is rejected', nip05.parse('a<b>@example.com'), null);

// ---------------------------------------------------------------- 2. url
console.log('--- 2. well-known URL ---');
eq('the well-known URL', nip05.wellKnownUrl('jack@cash.app'),
    'https://cash.app/.well-known/nostr.json?name=jack');
eq('the local part is URL-encoded', nip05.wellKnownUrl('a.b@example.com'),
    'https://example.com/.well-known/nostr.json?name=a.b');
eq('bare domain -> name=_', nip05.wellKnownUrl('example.com'),
    'https://example.com/.well-known/nostr.json?name=_');
eq('a bad identifier -> null', nip05.wellKnownUrl('jack@localhost'), null);

// ------------------------------------------------------- 3. plain handle
console.log('--- 3. handle text without a check mark ---');
eq('the plain handle has no check mark', nip05.plainHandle('jack@cash.app'), '@jack cash.app');
eq('bare domain -> just the domain', nip05.plainHandle('example.com'), 'example.com');
eq('a bad identifier -> null', nip05.plainHandle('nope'), null);
ok('the plain handle never contains the check mark', nip05.plainHandle('jack@cash.app').indexOf('\u2713') === -1);

// ---------------------------------------------------------------- 4. verify
console.log('--- 4. verification ---');
function fakeFetch(body, status) {
    return () => Promise.resolve({ status: status || 200, json: () => Promise.resolve(body) });
}
function rejectFetch() { return () => Promise.reject(new Error('network down')); }

nip05.reset();
nip05.setFetch(fakeFetch({ names: { jack: PK } }));
eq('a matching pubkey -> valid', await nip05.verify('jack@cash.app', PK), 'valid');

nip05.reset();
nip05.setFetch(fakeFetch({ names: { jack: OTHER } }));
eq('a different pubkey -> invalid', await nip05.verify('jack@cash.app', PK), 'invalid');

nip05.reset();
nip05.setFetch(fakeFetch({ names: {} }));
eq('the name is missing -> invalid', await nip05.verify('jack@cash.app', PK), 'invalid');

nip05.reset();
nip05.setFetch(fakeFetch({}, 404));
eq('404 -> invalid (not valid)', await nip05.verify('jack@cash.app', PK), 'invalid');

nip05.reset();
nip05.setFetch(rejectFetch());
eq('a network error -> error (not valid)', await nip05.verify('jack@cash.app', PK), 'error');

nip05.reset();
nip05.setFetch(fakeFetch({ names: { jack: PK.toUpperCase() } }));
eq('an uppercase pubkey in the answer still matches', await nip05.verify('jack@cash.app', PK), 'valid');

nip05.reset();
nip05.setFetch(fakeFetch({ names: { jack: PK } }));
eq('a non-hex pubkey -> none', await nip05.verify('jack@cash.app', 'not-hex'), 'none');
eq('an empty pubkey -> none', await nip05.verify('jack@cash.app', ''), 'none');
eq('a bad identifier -> none', await nip05.verify('jack@localhost', PK), 'none');

// Case: the local part must match, not any name in the file.
nip05.reset();
nip05.setFetch(fakeFetch({ names: { someone: PK } }));
eq('another name in the file must NOT verify us', await nip05.verify('jack@cash.app', PK), 'invalid');

// ---------------------------------------------------------------- 5. caching
console.log('--- 5. caching and de-duplication ---');
nip05.reset();
let calls = 0;
nip05.setFetch((url) => { calls++; return Promise.resolve({ status: 200, json: () => Promise.resolve({ names: { jack: PK } }) }); });
await nip05.verify('jack@cash.app', PK);
await nip05.verify('jack@cash.app', PK);
eq('the second call is served from memory cache', calls, 1);

nip05.reset();
calls = 0;
let release;
nip05.setFetch(() => { calls++; return new Promise((r) => { release = () => r({ status: 200, json: () => Promise.resolve({ names: { jack: PK } }) }); }); });
const a = nip05.verify('jack@cash.app', PK);
const b = nip05.verify('jack@cash.app', PK);
release();
eq('both in-flight calls resolve the same', await a, 'valid');
eq('both in-flight calls give the same result', await b, 'valid');
eq('two simultaneous calls -> one request', calls, 1);

// A negative result is waited for, not cached... but errors are NOT cached, so
// a transient outage does not freeze a "not verified" forever.
nip05.reset();
calls = 0;
nip05.setFetch(rejectFetch());
eq('the error result', await nip05.verify('jack@cash.app', PK), 'error');
nip05.setFetch(fakeFetch({ names: { jack: PK } }));
eq('after an error a retry can succeed', await nip05.verify('jack@cash.app', PK), 'valid');

// ---------------------------------------------------------------- 6. applyTo
console.log('--- 6. applyTo (DOM) ---');
/* A tiny element stub that behaves like the DOM for the two things applyTo
   does: setting textContent (which clears children) and appending nodes. Its
   textContent getter concatenates its own text plus its children, so the final
   rendered handle can be asserted as one string. */
function fakeEl() {
    const el = {
        children: [],
        _text: '',
        title: '',
        ownerDocument: {
            createElement: (tag) => ({ tag, className: '', style: {}, textContent: '', href: '', setAttribute() {} }),
            createTextNode: (t) => ({ nodeType: 3, textContent: t })
        },
        appendChild(c) { this.children.push(c); },
        removeAttribute(n) { if (n === 'title') this.title = ''; }
    };
    Object.defineProperty(el, 'textContent', {
        get() { return this._text + this.children.map((c) => c.textContent).join(''); },
        set(v) { this._text = String(v == null ? '' : v); this.children.length = 0; }
    });
    return el;
}

nip05.reset();
nip05.setFetch(fakeFetch({ names: { jack: PK } }));
let el = fakeEl();
await nip05.applyTo(el, 'jack@cash.app', PK);
ok('valid: the text carries the check mark', el.textContent.indexOf('\u2713') !== -1, el.textContent);
ok('valid: a link to the domain is appended', el.children.length === 2 && el.children[0].tag === 'a');
eq('valid: the link points at relay.html?domain=', el.children[0].href, 'relay.html?domain=cash.app');
eq('valid: the link label is the domain', el.children[0].textContent, 'cash.app');
eq('valid: the handle reads @jack + domain + check mark', el.textContent, '@jack cash.app \u2713');
ok('valid: a title explains the verification', /verified/.test(el.title));

// A bare domain (_@domain) must not print the domain twice.
nip05.reset();
nip05.setFetch(fakeFetch({ names: { _: PK } }));
el = fakeEl();
await nip05.applyTo(el, 'example.com', PK);
eq('valid bare domain: the domain appears once', el.textContent, 'example.com \u2713');

nip05.reset();
nip05.setFetch(fakeFetch({ names: { jack: OTHER } }));
el = fakeEl();
await nip05.applyTo(el, 'jack@cash.app', PK);
ok('invalid: NO check mark', el.textContent.indexOf('\u2713') === -1, el.textContent);
eq('invalid: no link is added', el.children.length, 0);
eq('invalid: the plain handle stays', el.textContent, '@jack cash.app');
ok('invalid: the title says it is not verified', /not verified/.test(el.title), el.title);

nip05.reset();
nip05.setFetch(rejectFetch());
el = fakeEl();
await nip05.applyTo(el, 'jack@cash.app', PK);
ok('error: NO check mark', el.textContent.indexOf('\u2713') === -1);
ok('error: the title explains the failure', /could not be verified/.test(el.title), el.title);

nip05.reset();
el = fakeEl();
await nip05.applyTo(el, '', PK);
eq('no identifier -> nothing happens', el.textContent, '');
eq('no identifier -> status none', await nip05.applyTo(el, '', PK), 'none');
eq('a null element is safe', await nip05.applyTo(null, 'jack@cash.app', PK), 'none');

// The check mark can ONLY come from an exact match — the core promise.
console.log('--- 7. the core promise: no check mark without proof ---');
nip05.reset();
let everFetched = 0;
nip05.setFetch(() => { everFetched++; return Promise.reject(new Error('down')); });
const scenarios = [
    ['jack@cash.app', PK],
    ['jack@cash.app', OTHER],
    ['example.com', PK]
];
for (const [id, pk] of scenarios) {
    const e = fakeEl();
    const st = await nip05.applyTo(e, id, pk);
    ok(`${id} (${st}): no check mark`, e.textContent.indexOf('\u2713') === -1, e.textContent);
}
ok('an attempt was actually made to verify', everFetched > 0);

// ------------------------------------------------- 8. page wiring
console.log('--- 8. page wiring ---');
const { readFileSync } = await import('node:fs');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'profile.html', 'thread.html', 'notes.html',
               'notifications.html', 'bookmark.html', 'relay.html'];
for (const page of PAGES) {
    const html = readFileSync(join(root, page), 'utf8');
    ok(`${page}: loads /assets/nostr-nip05.js`, html.includes('/assets/nostr-nip05.js'));
    ok(`${page}: calls NostrNip05.applyTo`, html.includes('NostrNip05.applyTo'));
    ok(`${page}: no check mark is hard-coded in a handle string`,
        !/\$\{[^}]*\}\s*✓/.test(html), 'a hard-coded check mark was found');
}

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
