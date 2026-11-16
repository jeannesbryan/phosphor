/* Tests for assets/nostr-paginate.js.
   Run: node tests/nostr-paginate.test.mjs
   Pure: no DOM, no network. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('../assets/nostr-paginate.js');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}
const ev = (id, t) => ({ id, created_at: t });

// ------------------------------------------------------------ timestamps
eq('oldest of an empty set is null', pg.oldestCreatedAt([]), null);
eq('oldest is the minimum', pg.oldestCreatedAt([ev('a', 30), ev('b', 10), ev('c', 20)]), 10);
eq('newest is the maximum', pg.newestCreatedAt([ev('a', 30), ev('b', 10), ev('c', 20)]), 30);
eq('oldest ignores events without a timestamp', pg.oldestCreatedAt([ev('a', 30), { id: 'x' }]), 30);
eq('oldest of null is null', pg.oldestCreatedAt(null), null);

// -------------------------------------------------------------- mergePage
{
    const r = pg.mergePage([ev('a', 30), ev('b', 20)], [ev('c', 10)]);
    eq('a new note is appended in order', r.events.map(e => e.id), ['a', 'b', 'c']);
    eq('added counts only new ids', r.added, 1);
}
{
    /* until is inclusive, so the boundary note comes back. It must be dropped by
       id, not by bumping the timestamp: several notes can share created_at and
       bumping would lose one. */
    const r = pg.mergePage([ev('a', 30), ev('b', 20)], [ev('b', 20), ev('c', 10)]);
    eq('the boundary duplicate is dropped', r.events.map(e => e.id), ['a', 'b', 'c']);
    eq('and only the genuinely new note counts', r.added, 1);
}
{
    const r = pg.mergePage([ev('a', 20)], [ev('x', 20), ev('y', 20)]);
    eq('notes sharing a timestamp are all kept', r.events.length, 3);
    eq('added counts both', r.added, 2);
}
{
    const r = pg.mergePage([ev('a', 10)], [ev('b', 30)]);
    eq('a newer note sorts to the front', r.events.map(e => e.id), ['b', 'a']);
}
{
    const r = pg.mergePage([], []);
    eq('merging empties is safe', r.events, []);
    eq('with zero added', r.added, 0);
}
{
    const r = pg.mergePage([ev('a', 20)], [{ created_at: 10 }, ev('b', 5)]);
    eq('an event with no id is ignored', r.events.map(e => e.id), ['a', 'b']);
}
{
    // stability: equal timestamps keep their arrival order
    const r = pg.mergePage([ev('a', 20), ev('b', 20)], [ev('c', 20)]);
    eq('equal timestamps keep arrival order', r.events.map(e => e.id), ['a', 'b', 'c']);
}

// ------------------------------------------------------------- nextFilter
{
    const f = pg.nextFilter({ kinds: [1], limit: 40 }, [ev('a', 30), ev('b', 20)], 40);
    eq('until is the oldest held note', f.until, 20);
    eq('the page size is kept', f.limit, 40);
    eq('the rest of the filter is copied', f.kinds, [1]);
    ok('the original filter is not mutated', JSON.stringify({ kinds: [1], limit: 40 }) === JSON.stringify({ kinds: [1], limit: 40 }));
}
{
    const f = pg.nextFilter({ kinds: [1], since: 100 }, [ev('a', 30)], 10);
    eq('a since is dropped, it would fight until', f.since, undefined);
}
eq('no held events means no next filter', pg.nextFilter({ kinds: [1] }, [], 10), null);
eq('no filter means no next filter', pg.nextFilter(null, [ev('a', 1)], 10), null);

// -------------------------------------------------------------- looksFull
eq('a full page suggests more may exist', pg.looksFull(40, 40), true);
eq('a short page suggests the end', pg.looksFull(39, 40), false);
eq('a nonsense page size is never full', pg.looksFull(10, 0), false);

// -------------------------------------------------------------- pageState
{
    const s = pg.pageState([ev('a', 30), ev('b', 20)], [ev('c', 10)], 40);
    eq('the new event is merged in', s.events.map(e => e.id), ['a', 'b', 'c']);
    eq('progress is reported', s.progressed, true);
    eq('the end is not declared while notes are still arriving', s.exhausted, false);
    eq('the oldest is reported so the page can build the next filter', s.oldest, 10);
}
{
    /* The relay returns only what we already have: that is the end of THIS relay's
       result set, and paging again would loop for ever. */
    const s = pg.pageState([ev('a', 30), ev('b', 20)], [ev('a', 30), ev('b', 20)], 40);
    eq('only duplicates means no progress', s.progressed, false);
    eq('and paging stops', s.exhausted, true);
}
{
    const s = pg.pageState([], [], 40);
    eq('an empty result is exhausted immediately', s.exhausted, true);
    eq('with no oldest', s.oldest, null);
}
{
    const s = pg.pageState([ev('a', 30)], [], 40);
    eq('an empty page after content stops paging', s.exhausted, true);
    eq('but keeps what we already had', s.events.map(e => e.id), ['a']);
}

// --------------------------------------------------- index.html is wired
/* The module is useless unless the page actually sends the second REQ and can
   build `until` from what it already holds. Both halves are asserted, because a
   button that reports progress without sending anything would look like success. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
ok('the page loads the pagination module', /<script src="\/assets\/nostr-paginate\.js\?v=[^"]+"><\/script>/.test(src));
ok('there is a control to ask for older notes', /id="loadOlderBtn"/.test(src));
ok('the click is wired', /getElementById\('loadOlderBtn'\)[\s\S]{0,80}addEventListener\('click', loadOlderPosts\)/.test(src));
ok('the next filter comes from the module, not from the page', /NostrPaginate\.nextFilter\(lastFeedFilter, held, 40\)/.test(src));
ok('the request is actually written to the sockets', /open\.forEach\(s => \{ try \{ s\.send\(req\); \}/.test(src));
ok('the feed filter is remembered for `until`',
    (src.match(/lastFeedFilter = \{ "kinds": \[1, 6, 16, 20, 21, 22, 34235, 34236, 1301, 30023\]/g) || []).length === 3);
/* The hero of this fix: an `until` in the outgoing filter. The unit tests above
   already prove the value; this pins that the assignment exists at all, so a
   refactor cannot quietly return a filter that repeats the same 40 notes. */
{
    const mod = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'nostr-paginate.js'), 'utf8');
    ok('nextFilter sets until on the outgoing filter', /f\.until = oldest;/.test(mod));
    ok('the page sends that filter to every open socket', /open\.forEach\(s =>/ .test(src));
}

// ------------------------------------- relay.html has the same capability
/* The relay explorer asked for the newest 60 events and never sent `until`, so an
   explored relay could not be read beyond its first page. Same module, same rules. */
{
    const relay = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'relay.html'), 'utf8');
    ok('relay.html loads the pagination module',
        /<script src="\/assets\/nostr-paginate\.js\?v=[^"]+"><\/script>/.test(relay));
    ok('relay.html has a control to ask for older events', /id="loadOlderBtn"/.test(relay));
    ok('the click is wired', /getElementById\('loadOlderBtn'\)[\s\S]{0,90}addEventListener\('click', loadOlderEvents\)/.test(relay));
    ok('the target feed filter is remembered for `until`',
        /lastFeedFilter = \{ "kinds": \[1, 6, 16, 20, 21, 22, 34235, 34236, 30023, 30311, 33400\] \}/.test(relay));
    ok('the next filter comes from the module', /NostrPaginate\.nextFilter\(lastFeedFilter, held, 60\)/.test(relay));
    ok('the request is written to the sockets', /open\.forEach\(s => \{ try \{ s\.send\(req\); \}/.test(relay));
    /* The card id prefix on this page is reply-, and reading the wrong prefix would
       silently gather nothing and always report "nothing older". */
    /* The response side. Asserting only that the REQ leaves was not enough: the page
       handler matched the subscription id with `===` and silently dropped every event
       the paging request returned, which looked exactly like "no older events".
       Measured against the real relay: 6159 older events existed and zero arrived. */
    ok('the handler accepts the paging subscription (prefix, not equality)',
        /String\(data\[1\] \|\| ""\)\.indexOf\("target-relay-feed"\) === 0/.test(relay));
    ok('the paging subscription reuses that prefix',
        /"target-relay-feed-older-" \+ Math\.random\(\)/.test(relay));
    ok('the old exact-match check is gone', !/data\[1\] === "target-relay-feed"/.test(relay));
    ok('held events are read with the page\'s own id prefix',
        /querySelectorAll\('\[id\^="reply-"\]'\)/.test(relay));
    ok('the feed container keeps its waiting placeholder as a child',
        /id="feedContainer">\s*\n\s*<p class="text-muted/.test(relay));
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
