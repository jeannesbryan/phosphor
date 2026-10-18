/* Tests for assets/nostr-pulse-event.js — run: node tests/nostr-pulse-event.test.mjs
   Pure (no browser, no network).

   The real events below were read from four relays on 2026-10-18, the same day
   the owner posted one pulse from Phosphor and one from Amethyst so the shape
   could be confirmed instead of guessed. */
import pulse from '../assets/nostr-pulse-event.js';
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
    ok(name, actual === expected, `got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, '..', p), 'utf8');

/* ------------------------------------------------------------ real events */

// Phosphor, 2026-10-18T07:18:45Z — photo, 24h expiration
const PULSE_PHOSPHOR = {
    id: 'pp01', pubkey: 'pk', kind: 1, created_at: 1792307925,
    tags: [
        ['client', 'Phosphor'],
        ['expiration', '1792394325'],
        ['imeta', 'url https://blossom.jeannesbryan.my.id/c0f7ff7a.jpeg', 'm image/jpeg', 'size 40716', 'dim 512x512']
    ],
    content: 'https://blossom.jeannesbryan.my.id/c0f7ff7a.jpeg'
};

// Amethyst, 2026-10-18T07:20:42Z — video, 24h expiration
const PULSE_AMETHYST = {
    id: 'pp02', pubkey: 'pk', kind: 1, created_at: 1792308042,
    tags: [
        ['r', 'https://blossom.jeannesbryan.my.id/f5a3c981.mp4'],
        ['expiration', '1792394438'],
        ['imeta', 'url https://blossom.jeannesbryan.my.id/f5a3c981.mp4', 'm video/mp4', 'dim 240x432'],
        ['client', 'Amethyst']
    ],
    content: 'https://blossom.jeannesbryan.my.id/f5a3c981.mp4'
};

// kind 20001 presence from Stickerpals — 29 of these were on the relays.
// This is NOT a pulse, and the old rule flagged it as one.
const PRESENCE = {
    id: 'sp01', pubkey: 'other', kind: 20001, created_at: 1792308000,
    tags: [['t', 'a4ee7a12932113c28f50070ee516ba38b29901e51226676bdab1f32ef'], ['t', 'stickerpals_broadcast']],
    content: '{"type":"presence","payload":"online"}'
};

const EMPTY_20000 = { id: 'e00', pubkey: 'other', kind: 20000, created_at: 1792308000, tags: [], content: '' };
const PROBE_20004 = { id: 'p04', pubkey: 'other', kind: 20004, created_at: 1792308000, tags: [], content: 'probe' };

const NOTE = { id: 'n1', pubkey: 'pk', kind: 1, created_at: 1792300000, tags: [['t', 'nostr']], content: 'hello' };
const SPORT = { id: 's1', pubkey: 'pk', kind: 1301, created_at: 1792300000, tags: [['activity_type', 'cycling'], ['distance', '19.77', 'km']], content: '{}' };
const ARTICLE = { id: 'a1', pubkey: 'pk', kind: 30023, created_at: 1792300000, tags: [['d', 'x']], content: '# hi' };

const NOW = 1792310000;   // between the two pulses and their expiry

// ---------- 1. ephemeral kinds are recognised, but are not pulses ----------
ok('kind 20001 is ephemeral', pulse.isEphemeralKind(20001));
ok('kind 20000 is ephemeral', pulse.isEphemeralKind(20000));
ok('kind 29999 is ephemeral', pulse.isEphemeralKind(29999));
ok('kind 30000 is NOT ephemeral', !pulse.isEphemeralKind(30000));
ok('kind 19999 is NOT ephemeral', !pulse.isEphemeralKind(19999));
ok('kind 1 is NOT ephemeral', !pulse.isEphemeralKind(1));

// ---------- 2. expirationOf ----------
eq('expiration of Phosphor pulse', pulse.expirationOf(PULSE_PHOSPHOR), 1792394325);
eq('expiration of Amethyst pulse', pulse.expirationOf(PULSE_AMETHYST), 1792394438);
eq('expiration absent -> null', pulse.expirationOf(NOTE), null);
eq('expiration on a non-pulse note still read', pulse.expirationOf({ tags: [['expiration', '999']] }), 999);
eq('numeric string parsed', pulse.expirationOf({ tags: [['expiration', ' 1792394325 ']] }), 1792394325);
eq('numeric value accepted', pulse.expirationOf({ tags: [['expiration', 1792394325]] }), 1792394325);
eq('unreadable value -> null (not NaN)', pulse.expirationOf({ tags: [['expiration', 'soon']] }), null);
eq('missing value -> null', pulse.expirationOf({ tags: [['expiration']] }), null);
eq('null event -> null', pulse.expirationOf(null), null);
eq('event without tags -> null', pulse.expirationOf({ content: 'x' }), null);
ok('hasExpiration true for pulse', pulse.hasExpiration(PULSE_PHOSPHOR));
ok('hasExpiration false for plain note', !pulse.hasExpiration(NOTE));

// ---------- 3. isPulse: the two real clients agree ----------
ok('Phosphor pulse is a pulse', pulse.isPulse(PULSE_PHOSPHOR, NOW));
ok('Amethyst pulse is a pulse', pulse.isPulse(PULSE_AMETHYST, NOW));
ok('expired pulse is no longer a pulse',
   !pulse.isPulse(PULSE_PHOSPHOR, 1792394325));
ok('one second before expiry is still a pulse',
   pulse.isPulse(PULSE_PHOSPHOR, 1792394324));

// ---------- 4. THE BUG: ephemeral kinds are not pulses ----------
ok('kind 20001 presence is NOT a pulse', !pulse.isPulse(PRESENCE, NOW));
ok('kind 20000 empty is NOT a pulse', !pulse.isPulse(EMPTY_20000, NOW));
ok('kind 20004 probe is NOT a pulse', !pulse.isPulse(PROBE_20004, NOW));
ok('plain note is NOT a pulse', !pulse.isPulse(NOTE, NOW));
ok('sport activity is NOT a pulse', !pulse.isPulse(SPORT, NOW));
ok('article is NOT a pulse', !pulse.isPulse(ARTICLE, NOW));
ok('null is NOT a pulse', !pulse.isPulse(null, NOW));
ok('empty object is NOT a pulse', !pulse.isPulse({}, NOW));
// A kind 20001 that DOES carry an expiration tag is a pulse: the tag is the
// rule, not the kind. (Not found in the wild, but the rule must be honest.)
ok('ephemeral kind WITH expiration is a pulse',
   pulse.isPulse({ kind: 20001, tags: [['expiration', String(NOW + 3600)]] }, NOW));

// ---------- 5. isExpired ----------
ok('expired when expiration is in the past', pulse.isExpired(PULSE_PHOSPHOR, 1792394326));
ok('not expired before expiration', !pulse.isExpired(PULSE_PHOSPHOR, NOW));
ok('exactly at expiration counts as expired', pulse.isExpired(PULSE_PHOSPHOR, 1792394325));
ok('note without expiration never expires', !pulse.isExpired(NOTE, NOW));

// ---------- 6. label keeps the wording the pages already show ----------
eq('label for 23h left', pulse.expiryLabel(PULSE_PHOSPHOR, 1792307925 + 3600 * 1), 'Exp in 23h 0m');
eq('label with minutes', pulse.expiryLabel({ tags: [['expiration', '100000']] }, 100000 - 3600 * 21 - 900), 'Exp in 21h 15m');
eq('label when expired', pulse.expiryLabel(PULSE_PHOSPHOR, 1792394326), 'Expired');
eq('label without expiration -> empty', pulse.expiryLabel(NOTE, NOW), '');
eq('remaining seconds', pulse.remainingSeconds(PULSE_PHOSPHOR, 1792394325 - 3600), 3600);
eq('remaining seconds without expiration -> null', pulse.remainingSeconds(NOTE, NOW), null);

// ---------- 7. describe() ----------
const d = pulse.describe(PULSE_PHOSPHOR, NOW);
eq('describe: isPulse', d.isPulse, true);
eq('describe: hasExpiration', d.hasExpiration, true);
eq('describe: expiresAt', d.expiresAt, 1792394325);
eq('describe: expired', d.expired, false);
ok('describe: label mentions the remaining time', d.label.indexOf('Exp in ') === 0);
const dPresence = pulse.describe(PRESENCE, NOW);
eq('describe presence: not a pulse', dPresence.isPulse, false);
eq('describe presence: no expiration', dPresence.hasExpiration, false);
eq('describe presence: empty label', dPresence.label, '');

// ---------- 8. FEED_KINDS no longer asks for ephemeral events ----------
ok('FEED_KINDS has no ephemeral kind', pulse.FEED_KINDS.every(k => !pulse.isEphemeralKind(k)));
ok('FEED_KINDS still has kind 1', pulse.FEED_KINDS.indexOf(1) !== -1);
ok('FEED_KINDS still has video kinds', pulse.FEED_KINDS.indexOf(22) !== -1 && pulse.FEED_KINDS.indexOf(34236) !== -1);
ok('FEED_KINDS still has activity and article', pulse.FEED_KINDS.indexOf(1301) !== -1 && pulse.FEED_KINDS.indexOf(30023) !== -1);
ok('FEED_KINDS has no duplicates', new Set(pulse.FEED_KINDS).size === pulse.FEED_KINDS.length);

// ---------- 9. isFeedKind ----------
const isMediaKind = (k) => k === 20 || k === 21 || k === 22;
ok('kind 1 is a feed kind', pulse.isFeedKind(1, isMediaKind));
ok('kind 1301 is a feed kind', pulse.isFeedKind(1301, isMediaKind));
ok('media kind accepted through the callback', pulse.isFeedKind(22, isMediaKind));
ok('ephemeral kind is NOT a feed kind', !pulse.isFeedKind(20001, isMediaKind));
ok('kind 7 reaction is NOT a feed kind', !pulse.isFeedKind(7, isMediaKind));
ok('undefined kind rejected', !pulse.isFeedKind(undefined, isMediaKind));

/* ------------------------------------------------- structural guards */

results.push('# 10. Pages use the shared rule, not their own copy');

const PAGES = ['index.html', 'notes.html', 'profile.html', 'bookmark.html', 'relay.html', 'thread.html'];
const pageSrc = {};
for (const p of PAGES) pageSrc[p] = read(p);

// The seven hand-written copies are what drifted apart. None may come back.
for (const p of PAGES) {
    ok(`${p}: no hand-written isPulse rule`,
        !/isPulse\s*=\s*\(\s*\w+\.kind\s*>=\s*20000/.test(pageSrc[p]));
    ok(`${p}: does not treat the whole 20000-29999 range as a pulse`,
        !/kind\s*>=\s*20000\s*&&\s*\w+\.kind\s*<\s*30000/.test(pageSrc[p]));
}

// Pages that render pulses must call the shared module.
const pulsePages = ['index.html', 'notes.html', 'profile.html', 'bookmark.html', 'relay.html', 'thread.html'];
for (const p of pulsePages) {
    ok(`${p}: calls NostrPulseEvent`, /NostrPulseEvent/.test(pageSrc[p]));
}

results.push('# 11. No page asks a relay for ephemeral kinds any more');

for (const p of PAGES) {
    const reqs = pageSrc[p].match(/"kinds"\s*:\s*\[[^\]]*\]/g) || [];
    const bad = reqs.filter(r => /(^|[\[,\s])2\d{4}([,\s\]])/.test(r));
    ok(`${p}: no ephemeral kind in any REQ filter`, bad.length === 0, bad.join(' | ').slice(0, 120));
}

// The render whitelists used to let the whole range through.
for (const p of PAGES) {
    ok(`${p}: render whitelist no longer opens the 20000 range`,
        !/ev\.kind\s*>=\s*20000\s*&&\s*ev\.kind\s*<\s*3[04]000/.test(pageSrc[p]));
}

results.push('# 12. Module is loaded by the pages that need it');

const ALL_PAGES = PAGES.concat(['notifications.html']);
for (const p of ALL_PAGES) {
    const src = pageSrc[p] || read(p);
    // Must be a real <script src=...> tag. Matching the bare filename is not
    // enough: a comment mentioning the path made this assertion pass while
    // notifications.html had no tag at all, so the module silently never
    // loaded there and expired notes stopped being filtered.
    ok(`${p}: loads nostr-pulse-event.js with a script tag`,
        /<script src="\/assets\/nostr-pulse-event\.js(\?v=[\w]+)?"><\/script>/.test(src));
}

results.push('# 13. Unexpired check has one definition too');
// isExpiredEvent was copied into seven pages, and the copies disagreed with
// NIP-40 about the boundary (">" instead of ">="). Pages now delegate.
const pageWithExpiryCheck = ALL_PAGES.filter(p => {
    const src = pageSrc[p] || read(p);
    return /function isExpiredEvent\s*\(/.test(src);
});
ok('the unexpired check still exists on the pages that use it', pageWithExpiryCheck.length >= 6);
for (const p of pageWithExpiryCheck) {
    const src = pageSrc[p] || read(p);
    ok(`${p}: isExpiredEvent delegates to the module`, /NostrPulseEvent\.isExpired\(ev\)/.test(src));
    // No local copy of the rule, not even as a fallback: a second hand-written
    // copy is exactly what drifted before. Date arithmetic in this function
    // would mean the rule lives in two places again.
    ok(`${p}: isExpiredEvent contains no date arithmetic`,
        !/function isExpiredEvent\s*\([^)]*\)\s*\{[\s\S]{0,400}?\/\s*1000/.test(src));
}

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed  (total ${pass + fail} asersi)`);
if (fail > 0) process.exit(1);
