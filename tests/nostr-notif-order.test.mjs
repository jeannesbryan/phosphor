/* Tests for assets/nostr-notif-order.js and the notifications page that uses it.
   Run: node tests/nostr-notif-order.test.mjs
   Pure: no browser, no network.

   Promise guarded here (bos, 2026-11-16): "likes show in Amethyst but not in
   Phosphor". The likes were in the relay and were rendered; the page simply put
   them wherever a relay replied first, so the newest like ended up at the
   bottom under a month-old one. These assertions fail if the page goes back to
   `prepend`, and they fail if a reaction card stops saying WHICH note was liked.
*/
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const order = require('../assets/nostr-notif-order.js');
const like = require('../assets/nostr-like.js');
const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond) { if (cond) { pass++; results.push('  ok   ' + name); } else { fail++; results.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; results.push('  ok   ' + name); }
    else { fail++; results.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}

const page = readFileSync(join(root, 'notifications.html'), 'utf8');

// ---------------------------------------------------------------- insertIndex
eq('empty list -> 0', order.insertIndex([], 100), 0);

eq('newer than everything -> 0', order.insertIndex([50, 40, 30], 99), 0);

eq('older than everything -> end', order.insertIndex([50, 40, 30], 10), 3);

eq('middle -> before the older neighbour', order.insertIndex([50, 40, 30], 35), 2);

eq('exactly equal stays after the existing one', order.insertIndex([50, 40, 30], 40), 2);

eq('equal to the head stays at index 1', order.insertIndex([50], 50), 1);

eq('non-numeric timestamp goes to the end', order.insertIndex([50, 40], 'abc'), 2);

eq('numeric string works like a number', order.insertIndex([50, 40], '45'), 1);

/* The real sequence measured from the live page: cards arrived oldest-first in
   the DOM, so the loop below rebuilds the list the way the page must. */
{
    const arrivals = [1794967380, 1789000000, 1792000000, 1794500000, 1788000000];
    const keys = [];
    const placed = [];
    for (const t of arrivals) {
        const i = order.insertIndex(keys, t);
        keys.splice(i, 0, t);
        placed.splice(i, 0, t);
    }
    eq('streaming arrivals end up newest-first', keys, [1794967380, 1794500000, 1792000000, 1789000000, 1788000000]);
    eq('placement list matches the key list', placed, keys);
}

eq('newestFirst sorts descending', order.newestFirst([{ created_at: 10 }, { created_at: 30 }, { created_at: 20 }]).map(e => e.created_at), [30, 20, 10]);

eq('newestFirst does not mutate the input', (() => { const a = [{ created_at: 1 }, { created_at: 2 }]; order.newestFirst(a); return a.map(e => e.created_at); })(), [1, 2]);

eq('newestFirst tolerates missing timestamps', order.newestFirst([{ created_at: 5 }, {}, { created_at: 9 }]).map(e => e.created_at), [9, 5, undefined]);

// --------------------------------------- the page must use the shared rules
ok('page loads the order module', /<script src="\/assets\/nostr-notif-order\.js[^"]*"><\/script>/.test(page));

ok('page calls NostrNotifOrder.insertIndex', /NostrNotifOrder\s*\.\s*insertIndex\s*\(/.test(page));

ok('page no longer prepends notification cards',
    !/notifsContainer\s*\.\s*prepend\s*\(/.test(page));

/* The card must be handed to the ordering helper. Asserting only that
   `insertBefore` exists somewhere was too weak: it also exists INSIDE the helper,
   so replacing the call with appendChild() survived that weaker check. */
ok('card is handed to the ordering helper',
    /placeNotificationCard\s*\(\s*card\s*,\s*ev\s*\)/.test(page));

/* prepend() must be gone entirely: that was the bug. appendChild() is allowed in
   exactly one place, the helper's own fallback for "module failed to load",
   so the test locates that one occurrence instead of banning the string. */
ok('prepend is gone entirely', !/\.prepend\s*\(\s*card\s*\)/.test(page));
{
    const helperStart = page.indexOf('function placeNotificationCard');
    const renderStart = page.indexOf('function renderNotification');
    const sites = [];
    const re = /notifsContainer\s*\.\s*(prepend|appendChild)\s*\(\s*card\s*\)/g;
    let m;
    while ((m = re.exec(page)) !== null) sites.push(m.index);
    eq('exactly one direct append, and it is the helper fallback', sites.length, 1);
    ok('that append sits inside the ordering helper only',
        sites.length === 1 && sites[0] > helperStart && sites[0] < renderStart);
}

/* NIP-25: when a reaction carries several `e` tags, the LAST one is the target.
   The page used to take the first, which can point at a different note. */
ok('like module exposes reactionTarget', typeof like.reactionTarget === 'function');

ok('page uses the shared reactionTarget rule', /NostrLike\s*\.\s*reactionTarget\s*\(/.test(page));

ok('page no longer hand-rolls the first e tag for reactions',
    !/if\s*\(\s*t\[0\]\s*===\s*'e'\s*&&\s*!targetEventId\s*\)/.test(page));

/* The local fallback (used only if nostr-like.js fails to load) must follow the
   same NIP-25 rule, otherwise a module outage silently brings the old bug back.
   Two branches need it: kind 7 and kind 6/16. */
const lastTagFallbacks = (page.match(/\.filter\(t => t\[0\] === 'e'\)\.pop\(\)/g) || []).length;
eq('both reaction and repost fallbacks take the LAST e tag', lastTagFallbacks, 2);
ok('no fallback takes the first e tag',
    !/\.filter\(t => t\[0\] === 'e'\)\[0\]/.test(page));

// ------------------------------------------ a like must say WHICH note it hit
/* The link is built once in noteTargetHtml() and used by both the reaction and
   the repost branch, so both halves are asserted: a builder with no caller, or a
   caller with no href, would each be a dead end. */
ok('noteTargetHtml builds a thread link for the target',
    /function noteTargetHtml\(targetId\)[\s\S]{0,400}thread\.html\?id=\$\{id\}/.test(page));

/* Anchored to the kind-7 branch itself (it ends where kind 6/16 begins), so this
   cannot be satisfied by the repost branch further down the file. */
ok('reaction card renders that link for the liked note',
    /else if \(ev\.kind === 7\)[\s\S]*?noteTargetHtml\(targetEventId\)[\s\S]*?else if \(ev\.kind === 6/.test(page));

ok('repost card renders that link for the reposted note',
    /SIGNAL_AMPLIFIED[\s\S]{0,700}noteTargetHtml\(targetEventId\)/.test(page));

ok('reaction card keeps a fallback when the note cannot be fetched',
    /notif-target-\$\{/.test(page) || /targetEventId\.substring\(\s*0\s*,\s*8\s*\)/.test(page));

// ------------------------------------------------------------------- report
console.log(results.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
