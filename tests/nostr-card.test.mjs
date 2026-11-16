/* Tests for assets/nostr-card.js.
   Run: node tests/nostr-card.test.mjs
   Pure: no DOM, no network, no page state.

   The pace/speed arithmetic gets the most attention here, because it was previously
   only reachable by rendering a card in a browser, and it divides by numbers that
   come straight from user-supplied tags. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const card = require('../assets/nostr-card.js');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}
const ev = (tags, extra) => Object.assign({ kind: 1, content: '', tags: tags || [] }, extra || {});

// --------------------------------------------------------- contentWarning
eq('no content-warning tag means not NSFW', card.contentWarning(ev([])).isNSFW, false);
eq('the default reason is NSFW', card.contentWarning(ev([])).reason, 'NSFW');
eq('a content-warning tag marks it NSFW', card.contentWarning(ev([['content-warning']])).isNSFW, true);
eq("the author's own reason is kept", card.contentWarning(ev([['content-warning', 'spoilers']])).reason, 'spoilers');
eq('an empty reason falls back to NSFW', card.contentWarning(ev([['content-warning', '']])).reason, 'NSFW');
eq('a missing event does not throw', card.contentWarning(null).isNSFW, false);
eq('a malformed tag is skipped', card.contentWarning(ev(['not-an-array'])).isNSFW, false);

// -------------------------------------------------------------- eventMeta
eq('the default client is unknown', card.eventMeta(ev([])).clientName, 'unknown');
eq('the client tag is read', card.eventMeta(ev([['client', 'Amethyst']])).clientName, 'Amethyst');
eq('the d tag is read', card.eventMeta(ev([['d', 'my-article']])).dTag, 'my-article');
{
    // later tags win, matching the original forEach order
    const r = card.eventMeta(ev([['client', 'A'], ['client', 'B']]));
    eq('the last client tag wins', r.clientName, 'B');
}
eq('a missing event is safe', card.eventMeta(null).clientName, 'unknown');

// ------------------------------------------------------------ jsonPayload
ok('a bare JSON object is detected', card.jsonPayload(ev([], { content: '{"a":1}' })).isJson);
eq('and pretty printed', card.jsonPayload(ev([], { content: '{"a":1}' })).pretty, '{\n  "a": 1\n}');
eq('surrounding whitespace is tolerated', card.jsonPayload(ev([], { content: '  {"a":1}  ' })).isJson, true);
eq('plain prose is not JSON', card.jsonPayload(ev([], { content: 'hello' })).isJson, false);
eq('broken JSON stays prose', card.jsonPayload(ev([], { content: '{broken' })).isJson, false);
eq('an array is not treated as a payload', card.jsonPayload(ev([], { content: '[1,2]' })).isJson, false);
eq('a non-kind-1 event is never a payload', card.jsonPayload({ kind: 30023, content: '{"a":1}', tags: [] }).isJson, false);
eq('an empty content is not a payload', card.jsonPayload(ev([], { content: '   ' })).isJson, false);

// ------------------------------------------------------------ linkifyHtml
{
    const html = card.linkifyHtml('see https://x.example/a ok');
    ok('a URL becomes an anchor', html.indexOf('<a href="https://x.example/a"') !== -1);
    ok('it opens in a new tab safely', html.indexOf('rel="noopener noreferrer"') !== -1);
    ok('the visible text is the URL', html.indexOf('>https://x.example/a</a>') !== -1);
}
{
    /* Escaped text carries &amp; but a href needs the raw &. Replacing the display
       text instead of the href would break query strings. */
    const html = card.linkifyHtml('https://x.example/?a=1&amp;b=2');
    ok('the href gets the raw ampersand back', html.indexOf('href="https://x.example/?a=1&b=2"') !== -1);
    ok('the visible text keeps the escaped form', html.indexOf('>https://x.example/?a=1&amp;b=2</a>') !== -1);
}
{
    const html = card.linkifyHtml('two https://a.example and https://b.example');
    eq('two URLs both become anchors', (html.match(/<a /g) || []).length, 2);
}
eq('text with no URL is unchanged', card.linkifyHtml('nothing here'), 'nothing here');
eq('null is an empty string', card.linkifyHtml(null), '');

// -------------------------------------------------------------- renderText
/* Escape THEN linkify. The reverse order would let a crafted URL inject markup. */
{
    const html = card.renderText('<script>alert(1)</script>');
    ok('a script tag is escaped', html.indexOf('<script') === -1);
    ok('and survives as text', html.indexOf('&lt;script&gt;') !== -1);
}
{
    const html = card.renderText('go to https://x.example/a?b=<c>');
    ok('a URL with markup in it cannot inject', html.indexOf('<c>') === -1);
    ok('but is still linkified', html.indexOf('rel="noopener noreferrer"') !== -1);
}
eq('surrounding whitespace is trimmed', card.renderText('  hi  '), 'hi');

// ----------------------------------------------------------- activityIcon
eq('cycling gets the bike icon', card.activityIcon('cycling'), '[BIKE]');
eq('an e-bike gets the bike icon', card.activityIcon('E-Bike Ride'), '[BIKE]');
eq('running gets the walk icon', card.activityIcon('running'), '[WALK]');
eq('walking gets the walk icon', card.activityIcon('Walking'), '[WALK]');
eq('an unknown sport gets the generic icon', card.activityIcon('kayaking'), '[A]');
eq('an empty sport is safe', card.activityIcon(''), '[A]');
eq('a missing sport is safe', card.activityIcon(null), '[A]');

// ---------------------------------------------------------- parseDuration
eq('h:mm:ss parses', card.parseDuration('1:02:03'), 3723);
eq('m:ss parses', card.parseDuration('12:34'), 754);
eq('zero parses to zero', card.parseDuration('0:00'), 0);
eq('one part is refused', card.parseDuration('123'), null);
eq('four parts are refused', card.parseDuration('1:2:3:4'), null);
eq('non-numeric parts are refused', card.parseDuration('a:b'), null);
eq('a non-string is refused', card.parseDuration(null), null);
eq('an empty string is refused', card.parseDuration(''), null);

// ------------------------------------------------------------- paceSpeed
/* Cycling reports km/h. 20 km in 1 hour is 20 km/h. */
eq('cycling reports km/h', card.paceSpeed({ activityType: 'cycling', distance: '20', duration: '1:00:00' }),
    { value: '20.00 km/h', label: 'Avg Speed' });
eq('driving reports km/h', card.paceSpeed({ activityType: 'driving', distance: '60', duration: '0:30:00' }).label, 'Avg Speed');
eq('motorcycling counts as a speed sport',
    card.paceSpeed({ activityType: 'motorcycling', distance: '100', duration: '1:00:00' }).value, '100.00 km/h');
/* Running reports min/km. 10 km in 50 minutes is 5:00 /km. */
eq('running reports min/km', card.paceSpeed({ activityType: 'running', distance: '10', duration: '50:00' }),
    { value: '5:00 /km', label: 'Avg Pace' });
eq('walking reports min/km', card.paceSpeed({ activityType: 'walking', distance: '5', duration: '1:00:00' }).label, 'Avg Pace');
/* Swimming reports min/100m. 1 km in 20 minutes is 2:00 /100m. */
eq('swimming reports min/100m', card.paceSpeed({ activityType: 'swimming', distance: '1', duration: '20:00' }),
    { value: '2:00 /100m', label: 'Avg Pace' });
/* The guards that keep Infinity off the card. */
eq('zero distance is refused', card.paceSpeed({ activityType: 'cycling', distance: '0', duration: '1:00:00' }), null);
eq('a missing distance is refused', card.paceSpeed({ activityType: 'cycling', duration: '1:00:00' }), null);
eq('a negative distance is refused', card.paceSpeed({ activityType: 'running', distance: '-5', duration: '10:00' }), null);
eq('zero duration is refused', card.paceSpeed({ activityType: 'cycling', distance: '10', duration: '0:00' }), null);
eq('a missing duration is refused', card.paceSpeed({ activityType: 'cycling', distance: '10' }), null);
eq('a badly shaped duration is refused', card.paceSpeed({ activityType: 'cycling', distance: '10', duration: 'soon' }), null);
eq('no options at all is null', card.paceSpeed(), null);
eq('no activity type still computes a pace',
    card.paceSpeed({ distance: '10', duration: '50:00' }).value, '5:00 /km');

// ------------------------------------------------------- clockFromMinutes
eq('a whole minute reads as :00', card.clockFromMinutes(5), '5:00');
eq('a half minute reads as :30', card.clockFromMinutes(5.5), '5:30');
eq('single digit seconds are padded', card.clockFromMinutes(5.05), '5:03');
/* 59.6 seconds must roll over, not print ":60". */
eq('seconds roll over instead of printing :60', card.clockFromMinutes(4.9933), '5:00');
eq('a long pace still formats', card.clockFromMinutes(125.5), '125:30');

// --------------------------------------------------- pages use the module
/* renderPost itself stays in index.html: it reads three page-level variables and
   calls fifteen page functions, so lifting it means lifting that state first. What
   must NOT come back is the pure logic duplicated inline. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/* index.html's card renderer now lives in assets/nostr-feed-card.js, so these
   page-level guards scan both: a move must not look like a deletion. */
const idx = readFileSync(join(root, 'index.html'), 'utf8') + readFileSync(join(root, 'assets', 'nostr-feed-card.js'), 'utf8');
const prof = readFileSync(join(root, 'profile.html'), 'utf8');

for (const [name, src] of [['index.html', idx], ['profile.html', prof]]) {
    ok(name + ': loads the card module',
        /<script src="\/assets\/nostr-card\.js\?v=[^"]+"><\/script>/.test(src));
    ok(name + ': text is escaped and linkified through the module',
        /NostrCard\.renderText\(/.test(src));
    ok(name + ': no hand-written linkify chain left',
        !/rel="noopener noreferrer" style="color: var\(--t-green\)/.test(src));
}

/* The inline implementations inside renderPost must be gone. */
ok('index.html reads the content warning through the module',
    /NostrCard\.contentWarning\(ev\)/.test(idx) && !/t\[0\] === "content-warning"/.test(idx));
ok('index.html reads client/d tags through the module',
    /NostrCard\.eventMeta\(ev\)/.test(idx));
ok('index.html detects the JSON payload through the module',
    /NostrCard\.jsonPayload\(ev\)/.test(idx));
ok('index.html picks the activity icon through the module',
    /NostrCard\.activityIcon\(actType\)/.test(idx));
ok('index.html computes pace through the module',
    /NostrCard\.paceSpeed\(\{ activityType: actType, distance: actDist, duration: actDur \}\)/.test(idx));
/* The arithmetic block itself must be gone, or two copies of the rounding rule
   exist and only one of them has the :60 fix. */
ok('the inline pace arithmetic is gone',
    !/const speedSports = \['cycling', 'biking', 'ebike', 'driving', 'motorcycling'\]/.test(idx));
ok('the inline icon selection is gone',
    !/tLower\.includes\("cycl"\)/.test(idx));

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
