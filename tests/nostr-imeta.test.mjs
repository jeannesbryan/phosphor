/* Tests for assets/nostr-imeta.js — run: node tests/nostr-imeta.test.mjs
   Pure (no browser, no network). Covers the NIP-92 rules in both directions:
   parsing tags from other people's events, and building tags for our own.

   The security section matters most: `alt` and `fallback` come from strangers'
   events, so an unescaped value would be a cross-site scripting hole. Those
   assertions are written to fail loudly if escaping is ever removed. */
import imeta from '../assets/nostr-imeta.js';
import embed from '../assets/nostr-embed.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const results = [];

function ok(name, cond, extra) {
    if (cond) { pass++; results.push(`  ok   ${name}`); }
    else { fail++; results.push(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
}

function eq(name, actual, expected) {
    ok(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function report() {
    results.forEach(r => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

// ---------- 1. dim ----------
eq('dim: 3024x4032', JSON.stringify(imeta.parseDim('3024x4032')), '{"w":3024,"h":4032}');
eq('dim: single digit', JSON.stringify(imeta.parseDim('1x2')), '{"w":1,"h":2}');
eq('dim: zero height rejected', imeta.parseDim('100x0'), null);
eq('dim: garbage rejected', imeta.parseDim('big'), null);
eq('dim: uppercase X rejected', imeta.parseDim('100X200'), null);
eq('dim: empty rejected', imeta.parseDim(''), null);
eq('dim: null rejected', imeta.parseDim(null), null);

// ---------- 2. parseTag ----------
const REAL = ['imeta',
    'url https://nostr.build/i/my-image.jpg',
    'm image/jpeg',
    'blurhash eVF$^OI:${M{o#*0-nNFxakD-?xVM}WEWB%iNKxvR-oetmo#R-aen$',
    'dim 3024x4032',
    'alt A scenic photo overlooking the coast of Costa Rica',
    'x 1f2e3d4c5b6a',
    'fallback https://nostrcheck.me/alt1.jpg',
    'fallback https://void.cat/alt1.jpg'];

const real = imeta.parseTag(REAL);
eq('parseTag: url', real.url, 'https://nostr.build/i/my-image.jpg');
eq('parseTag: m', real.m, 'image/jpeg');
eq('parseTag: x', real.x, '1f2e3d4c5b6a');
eq('parseTag: dim w', real.dim.w, 3024);
eq('parseTag: dim h', real.dim.h, 4032);
// The spec's own example: the alt value contains spaces, and splitting on the
// first space only is what keeps it intact.
eq('parseTag: alt keeps its spaces', real.alt, 'A scenic photo overlooking the coast of Costa Rica');
eq('parseTag: two fallbacks', real.fallback.length, 2);
eq('parseTag: fallback order', real.fallback[0], 'https://nostrcheck.me/alt1.jpg');

eq('parseTag: url only -> null (needs one more field)', imeta.parseTag(['imeta', 'url https://a/b.jpg']), null);
eq('parseTag: no url -> null', imeta.parseTag(['imeta', 'm image/png']), null);
eq('parseTag: empty tag -> null', imeta.parseTag(['imeta']), null);
eq('parseTag: not an imeta tag -> null', imeta.parseTag(['e', 'abc']), null);
eq('parseTag: non-array -> null', imeta.parseTag('imeta'), null);
eq('parseTag: unknown fields ignored', imeta.parseTag(['imeta', 'url https://a/b.jpg', 'zzz hello', 'alt x']).alt, 'x');
eq('parseTag: invalid dim dropped but url+alt survive',
    imeta.parseTag(['imeta', 'url https://a/b.jpg', 'dim nonsense', 'alt x']).dim, undefined);
/* A tag whose ONLY extra field is unusable carries no metadata at all, so the
   whole tag is dropped — the url alone does not satisfy "one other field". */
eq('parseTag: url + unusable size -> null',
    imeta.parseTag(['imeta', 'url https://a/b.jpg', 'size big']), null);
eq('parseTag: invalid size dropped, alt still kept',
    imeta.parseTag(['imeta', 'url https://a/b.jpg', 'size big', 'alt x']).size, undefined);
eq('parseTag: numeric size kept',
    imeta.parseTag(['imeta', 'url https://a/b.jpg', 'size 12345']).size, 12345);
eq('parseTag: key with no value dropped',
    imeta.parseTag(['imeta', 'url https://a/b.jpg', 'dim', 'alt x']).dim, undefined);

// ---------- 3. parse (whole event) ----------
const TAGS = [
    ['e', 'abc'],
    ['imeta', 'url https://a/1.jpg', 'm image/jpeg', 'alt one'],
    ['imeta', 'url https://a/2.png', 'm image/png'],
    ['imeta', 'url https://a/1.jpg', 'm image/jpeg', 'alt duplicate wins nothing']
];
const map = imeta.parse(TAGS);
eq('parse: two entries', Object.keys(map).length, 2);
eq('parse: first tag for a URL wins', map['https://a/1.jpg'].alt, 'one');
eq('parse: empty tags -> empty map', Object.keys(imeta.parse([])).length, 0);
eq('parse: non-array -> empty map', Object.keys(imeta.parse(null)).length, 0);

// ---------- 4. buildTag ----------
const built = imeta.buildTag({
    url: 'https://blossom.example/abc.jpg',
    m: 'image/jpeg',
    x: 'deadbeef',
    size: 98765,
    dim: { w: 800, h: 600 },
    alt: 'a cat',
    fallback: ['https://mirror/abc.jpg']
});
eq('buildTag: starts with imeta', built[0], 'imeta');
eq('buildTag: url first', built[1], 'url https://blossom.example/abc.jpg');
ok('buildTag: m present', built.indexOf('m image/jpeg') !== -1);
ok('buildTag: x present', built.indexOf('x deadbeef') !== -1);
ok('buildTag: size present', built.indexOf('size 98765') !== -1);
ok('buildTag: dim present', built.indexOf('dim 800x600') !== -1);
ok('buildTag: alt present', built.indexOf('alt a cat') !== -1);
ok('buildTag: fallback present', built.indexOf('fallback https://mirror/abc.jpg') !== -1);
eq('buildTag: url only -> null', imeta.buildTag({ url: 'https://a/b.jpg' }), null);
eq('buildTag: no url -> null', imeta.buildTag({ m: 'image/png' }), null);

// round trip: what we publish must be readable by us and by any other client
const roundTripped = imeta.parseTag(built);
eq('round trip: url', roundTripped.url, 'https://blossom.example/abc.jpg');
eq('round trip: alt', roundTripped.alt, 'a cat');
eq('round trip: dim', roundTripped.dim.w + 'x' + roundTripped.dim.h, '800x600');
eq('round trip: size', roundTripped.size, 98765);

// ---------- 5. remember + finalize (publish side) ----------
imeta.forget();
eq('finalize: nothing remembered -> untouched',
    JSON.stringify(imeta.finalize({ content: 'hi https://a/1.jpg', tags: [] }).tags), '[]');

imeta.remember([
    { url: 'https://a/1.jpg', m: 'image/jpeg', x: 'aa', alt: 'first' },
    { url: 'https://a/2.jpg', m: 'image/jpeg', x: 'bb', alt: 'second' },
    { url: '', m: 'image/jpeg' },              // no URL -> ignored
    null                                        // junk -> ignored
]);
eq('remember: two usable entries', Object.keys(imeta._registry()).length, 2);

const ev1 = imeta.finalize({ content: 'look https://a/1.jpg', tags: [['client', 'Phosphor']] });
eq('finalize: one tag added', ev1.tags.length, 2);
eq('finalize: added tag is imeta', ev1.tags[1][0], 'imeta');
ok('finalize: tag carries the alt', ev1.tags[1].indexOf('alt first') !== -1);
ok('finalize: did not lose existing tags', ev1.tags[0][0] === 'client');

// NIP-92: a tag SHOULD match a URL in the content -> the second upload must
// NOT be attached to a note that never mentions it.
const ev2 = imeta.finalize({ content: 'only https://a/1.jpg here', tags: [] });
eq('finalize: URL absent from content is skipped', ev2.tags.length, 1);

// idempotent: signing helpers may run twice
const ev3 = { content: 'https://a/1.jpg', tags: [] };
imeta.finalize(ev3);
const countAfterFirst = ev3.tags.length;
imeta.finalize(ev3);
eq('finalize: second call adds nothing', ev3.tags.length, countAfterFirst);

// an event that already declares imeta for that URL keeps its own tag
const ev4 = imeta.finalize({
    content: 'https://a/1.jpg',
    tags: [['imeta', 'url https://a/1.jpg', 'm image/webp', 'alt theirs']]
});
eq('finalize: existing tag is respected', ev4.tags.length, 1);
ok('finalize: existing tag not overwritten', ev4.tags[0].join(' ').indexOf('alt theirs') !== -1);

// safety: events without tags/content must not explode
ok('finalize: null event', imeta.finalize(null) === null);
ok('finalize: no tags array', imeta.finalize({ content: 'x' }).tags === undefined);
ok('finalize: empty content', imeta.finalize({ content: '', tags: [] }).tags.length === 0);

// ---------- 6. SECURITY: untrusted alt / fallback ----------
imeta.forget();
const evilAlt = imeta.parseTag(['imeta', 'url https://a/x.jpg',
    'alt "><img src=x onerror=alert(1)>']);
const attrs = imeta.imgAttrs(evilAlt, 'Media');
ok('xss: quote in alt is escaped', attrs.indexOf('&quot;') !== -1 && attrs.indexOf('"><img') === -1);
ok('xss: angle brackets escaped', attrs.indexOf('&lt;img') !== -1);
ok('xss: no live onerror from alt text', !/alt="[^"]*"\s*onerror/.test(attrs));

const evilFallback = imeta.parseTag(['imeta', 'url https://a/x.jpg',
    'alt ok', 'fallback javascript:alert(1)',
    'fallback https://ok/1.jpg',
    'fallback "\'><script>']);
const fbAttrs = imeta.imgAttrs(evilFallback, 'Media');
ok('xss: javascript: fallback rejected', fbAttrs.indexOf('javascript:') === -1);
ok('xss: quote-breaking fallback rejected', fbAttrs.indexOf('<script>') === -1);
ok('xss: safe fallback kept', fbAttrs.indexOf('https://ok/1.jpg') !== -1);

// ---------- 7. imgAttrs ----------
eq('imgAttrs: null -> empty string', imeta.imgAttrs(null, 'Media'), '');
eq('imgAttrs: no fields -> empty string', imeta.imgAttrs({ url: 'https://a/b.jpg' }, 'Media'), '');
const withAlt = imeta.imgAttrs({ url: 'https://a/b.jpg', alt: 'a boat' }, 'Media');
eq('imgAttrs: alt only', withAlt, ' alt="a boat"');
const withDim = imeta.imgAttrs({ url: 'https://a/b.jpg', dim: { w: 10, h: 20 } }, 'Media');
eq('imgAttrs: dim becomes width/height', withDim, ' width="10" height="20"');
const withFb = imeta.imgAttrs({ url: 'https://a/b.jpg', alt: 'x', fallback: ['https://m/b.jpg'] }, 'Media');
ok('imgAttrs: fallback stored in data attribute', withFb.indexOf("data-fb=") !== -1);
ok('imgAttrs: fallback uses retry helper', withFb.indexOf('NostrImeta.retry(this)') !== -1);
ok('imgAttrs: primary URL excluded from its own fallbacks',
    imeta.imgAttrs({ url: 'https://a/b.jpg', alt: 'x', fallback: ['https://a/b.jpg'] }, 'M').indexOf('data-fb') === -1);

// ---------- 8. retry() ----------
function fakeImg(src, fbs) {
    const attrs = { src, 'data-fb': JSON.stringify(fbs) };
    let onerror = function () {};
    return {
        getAttribute: (k) => (k in attrs ? attrs[k] : null),
        setAttribute: (k, v) => { attrs[k] = v; },
        removeAttribute: (k) => { delete attrs[k]; },
        get src() { return attrs.src; },
        get onerror() { return onerror; },
        set onerror(fn) { onerror = fn; }
    };
}
const img1 = fakeImg('https://dead/1.jpg', ['https://m1/1.jpg', 'https://m2/1.jpg']);
ok('retry: first call returns true', imeta.retry(img1) === true);
eq('retry: first fallback used', img1.src, 'https://m1/1.jpg');
ok('retry: second call returns true', imeta.retry(img1) === true);
eq('retry: second fallback used', img1.src, 'https://m2/1.jpg');
ok('retry: third call returns false (chain exhausted)', imeta.retry(img1) === false);
eq('retry: handler cleared, no infinite loop', img1.onerror, null);

const imgNone = fakeImg('https://dead/1.jpg', []);
ok('retry: empty chain returns false', imeta.retry(imgNone) === false);

const imgBad = { getAttribute: () => 'not json', setAttribute() {}, removeAttribute() {}, onerror: function () {} };
ok('retry: malformed JSON does not throw', imeta.retry(imgBad) === false);

ok('retry: null element does not throw', imeta.retry(null) === false);

// ---------- 9. poster / mime ----------
eq('poster: thumb wins over image',
    imeta.poster({ thumb: 'https://a/t.jpg', image: 'https://a/i.jpg' }), 'https://a/t.jpg');
eq('poster: falls back to image', imeta.poster({ image: 'https://a/i.jpg' }), 'https://a/i.jpg');
eq('poster: none', imeta.poster({}), null);
eq('poster: unsafe rejected', imeta.poster({ thumb: '" onerror=x' }), null);
eq('mime: valid', imeta.mime({ m: 'video/mp4' }), 'video/mp4');
eq('mime: nonsense rejected', imeta.mime({ m: 'not a mime' }), null);
eq('mime: missing', imeta.mime({}), null);

// ---------- 10. integrate with the shared media assembler ----------
const cmap = imeta.parse([
    ['imeta', 'url https://a/pic.jpg', 'm image/jpeg', 'alt A description', 'dim 100x50',
     'fallback https://mirror/pic.jpg']
]);
const assembled = embed.assembleMedia('see https://a/pic.jpg', { imeta: cmap });
ok('assembleMedia: uses imeta alt', assembled.html.indexOf('alt="A description"') !== -1);
ok('assembleMedia: uses imeta dim', assembled.html.indexOf('width="100"') !== -1);
ok('assembleMedia: uses imeta fallback', assembled.html.indexOf('https://mirror/pic.jpg') !== -1);
ok('assembleMedia: primary src unchanged', assembled.html.indexOf('src="https://a/pic.jpg"') !== -1);

// no metadata -> exactly the old behaviour (default alt, no extras)
const plain = embed.assembleMedia('see https://a/pic.jpg', {});
ok('assembleMedia: default alt without imeta', plain.html.indexOf('alt="Media"') !== -1);
ok('assembleMedia: no data-fb without imeta', plain.html.indexOf('data-fb') === -1);

// metadata for a DIFFERENT url must not leak onto this image
const other = embed.assembleMedia('see https://a/pic.jpg', {
    imeta: imeta.parse([['imeta', 'url https://elsewhere/x.jpg', 'alt Wrong']])
});
ok('assembleMedia: unrelated imeta ignored', other.html.indexOf('alt="Wrong"') === -1);

// XSS through alt must not survive into the page HTML
const bomb = embed.assembleMedia('see https://a/pic.jpg', {
    imeta: imeta.parse([['imeta', 'url https://a/pic.jpg', 'alt "><script>alert(1)</script>']])
});
ok('assembleMedia: alt is escaped', bomb.html.indexOf('<script>') === -1 && bomb.html.indexOf('&lt;script&gt;') !== -1);

/* Found by testing in a real browser, not by unit tests: safeMediaUrl in
   nostr-embed.js only rejects quotes/angle brackets/whitespace, so a
   `fallback javascript:...` — which is all of those things free — slipped
   through into data-fb. Metadata URLs now require http(s) explicitly. */
const jsFallback = embed.assembleMedia('see https://a/pic.jpg', {
    imeta: imeta.parse([['imeta', 'url https://a/pic.jpg', 'alt ok',
                         'fallback javascript:alert(1)',
                         'fallback data:text/html,<script>alert(1)</script>',
                         'fallback https://good.example/x.jpg']])
});
ok('assembleMedia: javascript: fallback rejected', jsFallback.html.indexOf('javascript:') === -1);
ok('assembleMedia: data: fallback rejected', jsFallback.html.indexOf('data:text/html') === -1);
ok('assembleMedia: http fallback kept', jsFallback.html.indexOf('https://good.example/x.jpg') !== -1);

// The same rule applies to a video poster taken from metadata.
const evilPoster = embed.assembleMedia('see https://a/clip.mp4', {
    imeta: imeta.parse([['imeta', 'url https://a/clip.mp4', 'm video/mp4',
                         'thumb javascript:alert(1)']])
});
ok('assembleMedia: javascript: poster rejected', evilPoster.html.indexOf('javascript:') === -1);
ok('assembleMedia: no poster attribute when rejected', evilPoster.html.indexOf('poster=') === -1);

// ---------- 11. real page files ----------
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PAGES = ['index.html', 'thread.html', 'notes.html', 'notifications.html',
               'bookmark.html', 'relay.html', 'profile.html'];

const src = {};
for (const p of PAGES) src[p] = readFileSync(join(root, p), 'utf8');

// every page that can upload media must load the module
for (const p of PAGES) {
    ok(`${p}: loads nostr-imeta.js`, src[p].includes('/assets/nostr-imeta.js'));
}

// canonical count: ten places attach metadata before signing a kind-1 event
let finalizeCalls = 0;
for (const p of PAGES) finalizeCalls += (src[p].match(/NostrImeta\.finalize\(/g) || []).length;
eq('pages: exactly 10 finalize() calls', finalizeCalls, 10);

// canonical count: ten places pass imeta into the media assembler
let imetaArgs = 0;
for (const p of PAGES) imetaArgs += (src[p].match(/imeta:\s*window\.NostrImeta/g) || []).length;
eq('pages: exactly 10 assembleMedia calls receive imeta', imetaArgs, 10);

// the media assembler must not fall back to reading tags itself
for (const p of PAGES) {
    ok(`${p}: no ad-hoc imeta parsing in the page`,
        !/t\[0\] === ["']imeta["']\s*\)\s*\{[^}]*startsWith\(["']alt /.test(src[p]));
}

// cache-buster must be present on the module reference
for (const p of PAGES) {
    ok(`${p}: module reference is versioned`, /nostr-imeta\.js\?v=\d{8}[a-z]/.test(src[p]));
}

report();
