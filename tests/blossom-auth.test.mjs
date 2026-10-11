/* Tests for assets/blossom-auth.js — run: node tests/blossom-auth.test.mjs
   Pure for parts 1 & 2 (no browser, no network, fetch is stubbed).
   Part 3 inspects the REAL page files.

   Why this test exists
   --------------------
   2026-10-07: blossom-server 6.4.1 tightened BUD-11 — the `x` tag (sha256 of
   the blob) became MANDATORY for upload/delete. Phosphor at the time sent a
   `payload` tag that had been copied into SEVEN pages, so once the server was
   upgraded every upload was rejected with
   `403 Auth token does not authorize operation on blob <hash>`.
   Proven directly against a 6.4.1 server: `payload` -> HTTP 403, `x` -> 201.

   2026-10-09: those rules moved into a single module,
   assets/blossom-auth.js, with bos's approval. This test guards two things:
     (a) the module really produces an `x` tag matching the file content —
         proven by attacking a fake `fetch` and inspecting the
         `Authorization` header that is actually sent;
     (b) the pages no longer keep a copy of those rules themselves — if
         someone copies them back, the test fails before the copy becomes a
         problem.
*/
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import auth from '../assets/blossom-auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
    if (cond) { pass++; results.push(`  ok   ${name}`); }
    else { fail++; results.push(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
}
function eq(name, actual, expected) {
    ok(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function okAsync(name, p, check) {
    return p.then((v) => { const r = check(v); ok(name, r.ok, r.extra); }, (e) => ok(name, false, 'threw: ' + e));
}

/* ---------------------------------------------------------------- 1. CONTRACT */
eq('authorization event kind = 24242', auth.AUTH_KIND, 24242);
eq('file limit per note = 4', auth.MAX_FILES, 4);
eq('token lifetime = 60 seconds', auth.AUTH_TTL_SECONDS, 60);

const ev = auth.buildAuthEvent({
    uploadEndpoint: 'https://blossom.example/upload',
    hashHex: 'a1'.repeat(32),
    pubkey: 'b2'.repeat(32),
    now: 1791000000
});
eq('created_at = now', ev.created_at, 1791000000);
eq('content is constant', ev.content, auth.AUTH_CONTENT);
eq('kind = 24242', ev.kind, 24242);
const tag = (k) => (ev.tags.find((t) => t[0] === k) || [])[1];
eq('tag u = upload URL', tag('u'), 'https://blossom.example/upload');
eq('tag method = PUT', tag('method'), 'PUT');
eq('tag x = blob hash', tag('x'), 'a1'.repeat(32));
eq('tag t = upload', tag('t'), 'upload');
eq('expiration = created_at + 60', tag('expiration'), '1791000060');
ok('does NOT use a payload tag (rejected by blossom >= 6.4.1)',
    !ev.tags.some((t) => t[0] === 'payload'));
eq('exactly one x tag', ev.tags.filter((t) => t[0] === 'x').length, 1);

/* Server address from config. */
eq('bare domain -> https + /upload',
    auth.uploadEndpointFor('blossom.jeannesbryan.my.id'), 'https://blossom.jeannesbryan.my.id/upload');
eq('already https + trailing slash',
    auth.uploadEndpointFor('https://blossom.example/'), 'https://blossom.example/upload');
eq('http is left as-is',
    auth.uploadEndpointFor('http://127.0.0.1:3099'), 'http://127.0.0.1:3099/upload');
eq('empty -> page fallback',
    auth.uploadEndpointFor('', 'https://cadangan.example'), 'https://cadangan.example/upload');
eq('empty without fallback -> module default',
    auth.uploadEndpointFor(undefined), auth.DEFAULT_SERVER + '/upload');

/* sha256: the standard test vector for "abc". */
const abc = new TextEncoder().encode('abc').buffer;
await okAsync('sha256("abc") matches the standard vector', auth.sha256Hex(abc), (h) => ({
    ok: h === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', extra: h
}));

/* Header = "Nostr " + base64(JSON of the signed event). */
const tagVal = (tags, name) => {
    const t = (tags || []).find((x) => x[0] === name);
    return t ? t[1] : undefined;
};
const signed = { ...ev, id: 'c3'.repeat(32), sig: 'd4'.repeat(64) };
const header = auth.encodeAuthHeader(signed, (s) => Buffer.from(s, 'binary').toString('base64'));
ok('header starts with "Nostr "', header.startsWith('Nostr '));
const decoded = JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'));
eq('header carries the signed event', decoded.sig, 'd4'.repeat(64));
eq('the x tag is sent in the header too', tagVal(decoded.tags, 'x'), 'a1'.repeat(32));

/* ------------------------------------------------- 2. UI FLOW (fetch stubbed) */
function fakeFile(name, text) {
    return { name, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer) };
}

// Fake fetch that records the request; pretends the server answered 201.
let seen = [];
const okFetch = (url, opts) => {
    seen.push({ url, opts });
    return Promise.resolve({
        ok: true, status: 201,
        json: () => Promise.resolve({ url: 'https://blossom.example/' + 'e5'.repeat(32) + '.jpg' })
    });
};

const signer = (e) => Promise.resolve({ ...e, id: 'f6'.repeat(32), sig: 'a7'.repeat(64) });

seen = [];
const btn = { textContent: '[ MEDIA (0/4) ]' };
const ta = { value: '' };
const res1 = await auth.uploadSelectedFiles([fakeFile('foto.jpg', 'abc')], btn, ta, {
    servers: ['blossom.example'], pubkey: 'b2'.repeat(32), sign: signer,
    fetchImpl: okFetch, alertFn: (m) => results.push('  !! unexpected alert: ' + m)
});
eq('one file -> one URL collected', res1.uploaded.length, 1);
eq('URL pasted into the textarea', ta.value, 'https://blossom.example/' + 'e5'.repeat(32) + '.jpg');
eq('button restored to its original label', btn.textContent, '[ MEDIA (0/4) ]');
eq('endpoint taken from servers[0]', res1.endpoint, 'https://blossom.example/upload');
eq('fetch called once', seen.length, 1);
eq('method PUT', seen[0].opts.method, 'PUT');
eq('body = the file itself', seen[0].opts.body.name, 'foto.jpg');

const authHeader = seen[0].opts.headers.Authorization;
const sentEv = JSON.parse(Buffer.from(authHeader.slice(6), 'base64').toString('utf8'));
eq('kind in the header = 24242', sentEv.kind, 24242);
eq('tag x in the header = sha256 of the file content ("abc")',
    tagVal(sentEv.tags, 'x'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
ok('a payload tag is never sent', !sentEv.tags.some((t) => t[0] === 'payload'));
eq('tag u in the header = the PUT endpoint', tagVal(sentEv.tags, 'u'), seen[0].url);

// Two files -> two lines in the textarea.
seen = []; ta.value = ''; btn.textContent = '[ MEDIA (0/4) ]';
await auth.uploadSelectedFiles([fakeFile('a.jpg', 'x'), fakeFile('b.jpg', 'y')], btn, ta, {
    servers: ['blossom.example'], pubkey: 'b2'.repeat(32), sign: signer, fetchImpl: okFetch, alertFn: () => {}
});
eq('two files -> two URLs in the textarea', ta.value.split('\n').length, 2);
eq('button text after two files ... ?', btn.textContent, '[ MEDIA (0/4) ]');

// Server rejects with 403: the server message MUST be visible, no URL pasted.
seen = []; ta.value = '';
const alerts = [];
const errFetch = (url, opts) => Promise.resolve({
    ok: false, status: 403,
    text: () => Promise.resolve('Auth token does not authorize operation on blob 39f2...')
});
await auth.uploadSelectedFiles([fakeFile('c.jpg', 'z')], btn, ta, {
    servers: ['blossom.example'], pubkey: 'b2'.repeat(32), sign: signer,
    fetchImpl: errFetch, alertFn: (m) => alerts.push(m)
});
eq('403 -> textarea stays empty', ta.value, '');
eq('403 -> one error message', alerts.length, 1);
ok('error message carries the reason from the server', /does not authorize operation on blob/.test(alerts[0]), alerts[0]);
ok('error message carries the HTTP status', /403/.test(alerts[0]), alerts[0]);
eq('button is still restored', btn.textContent, '[ MEDIA (0/4) ]');

// More than 4 files: only 4 are processed, with a warning.
seen = []; ta.value = '';
const warn = [];
await auth.uploadSelectedFiles(
    [fakeFile('1', 'a'), fakeFile('2', 'b'), fakeFile('3', 'c'), fakeFile('4', 'd'), fakeFile('5', 'e')],
    btn, ta, { servers: ['blossom.example'], pubkey: 'b2'.repeat(32), sign: signer, fetchImpl: okFetch, alertFn: (m) => warn.push(m) }
);
eq('5 files -> only 4 uploaded', seen.length, 4);
eq('5 files -> one warning', warn.length, 1);
ok('the warning mentions the limit of 4', /4/.test(warn[0]), warn[0]);

// Not logged in: no request at all, but there is a notice.
seen = []; const notLogged = [];
await auth.uploadSelectedFiles([fakeFile('d.jpg', 'q')], btn, ta, {
    servers: ['blossom.example'], pubkey: null, sign: null, fetchImpl: okFetch, alertFn: (m) => notLogged.push(m)
});
eq('not logged in -> no fetch', seen.length, 0);
eq('not logged in -> there is a notice', notLogged.length, 1);
ok('not logged in -> the message is clear', /logged in|log ?in/i.test(notLogged[0]), notLogged[0]);

// Empty server list -> falls back to the page fallback.
seen = []; ta.value = '';
await auth.uploadSelectedFiles([fakeFile('e.jpg', 'w')], btn, ta, {
    servers: [], fallbackServer: 'https://cadangan.example',
    pubkey: 'b2'.repeat(32), sign: signer, fetchImpl: okFetch, alertFn: () => {}
});
eq('empty servers -> use the fallback', seen[0].url, 'https://cadangan.example/upload');

/* ---------------------------------------------------------------- 3. PAGES */
const PAGES = ['index.html', 'thread.html', 'notes.html', 'notifications.html',
               'bookmark.html', 'relay.html', 'profile.html'];
let wired = 0;

for (const file of PAGES) {
    const html = readFileSync(join(root, file), 'utf8');
    ok(`${file}: loads /assets/blossom-auth.js`, html.includes('/assets/blossom-auth.js'));
    ok(`${file}: has a window.BlossomAuth guard (module failure = visible)`,
        /window\.BlossomAuth/.test(html));
    ok(`${file}: calls BlossomAuth.uploadSelectedFiles`,
        /BlossomAuth\.uploadSelectedFiles\s*\(/.test(html));
    ok(`${file}: does NOT keep a copy of the rules (kind 24242)`,
        !/kind\s*:\s*24242/.test(html), 'a copy of the authorization rules was found in the page');
    ok(`${file}: does NOT build the x tag itself`,
        !/\[\s*["']x["']\s*,\s*hashHex\s*\]/.test(html),
        'a copy of the x tag was found in the page');
    ok(`${file}: does NOT use a payload tag`,
        !/\[\s*["']payload["']\s*,/.test(html));
    /* Deliberately NOT checking every `subtle.digest`: `index.html` has a
       legitimate `minePoW()` that hashes the serialized event (not the file
       content). What must be gone from the pages is the upload fingerprint:
       hashing `file.arrayBuffer()`. */
    ok(`${file}: no longer hashes the file content itself`,
        !/file\.arrayBuffer\s*\(/.test(html),
        'the upload fingerprint (file.arrayBuffer + digest) is still in the page');
    wired++;
}
eq('all seven uploader pages were checked', wired, 7);

// The module must stay the only definition of those rules in the repo.
const modSrc = readFileSync(join(root, 'assets/blossom-auth.js'), 'utf8');
ok('the module defines kind 24242', /AUTH_KIND\s*=\s*24242/.test(modSrc));
ok('the module uses the x tag', /\[\s*'x',\s*opts\.hashHex\s*\]/.test(modSrc));
ok('the module does not use a payload tag', !/'payload'/.test(modSrc));

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
