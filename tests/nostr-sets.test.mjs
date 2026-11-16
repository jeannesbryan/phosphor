/* Tests for assets/nostr-sets.js, and for the bookmark page that uses it.
   Run: node tests/nostr-sets.test.mjs

   The bug these guard against was measured in a browser: injecting a newer
   liked-songs set made bookmark.html show "Bookmark list is empty" while the real
   bookmark set was still on the relay and untouched. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const sets = require('../assets/nostr-sets.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}
const setEv = (d, createdAt, etags) => ({
    kind: 30003, pubkey: 'p', created_at: createdAt, content: '',
    tags: (d === undefined ? [] : [['d', d]]).concat((etags || []).map(id => ['e', id]))
});

// --------------------------------------------------------------- setName
eq('the bookmark set is named', sets.setName(setEv('bookmark', 1)), 'bookmark');
eq('the liked-songs set is named', sets.setName(setEv('liked-songs', 1)), 'liked-songs');
eq('the liked-albums set is named', sets.setName(setEv('liked-albums', 1)), 'liked-albums');
/* Missing d must not be treated as "not a set": older clients omit it, and refusing
   those would hide a real list. The wrong failure is the one that loses data. */
eq('a missing d tag defaults to bookmark', sets.setName(setEv(undefined, 1)), 'bookmark');
eq('an empty d tag defaults to bookmark', sets.setName(setEv('', 1)), 'bookmark');
eq('a whitespace d tag defaults to bookmark', sets.setName(setEv('   ', 1)), 'bookmark');
eq('the d tag is trimmed', sets.setName(setEv('  bookmark  ', 1)), 'bookmark');
eq('a non-set kind has no set name', sets.setName({ kind: 1, tags: [['d', 'x']] }), null);
eq('null is not a set', sets.setName(null), null);
eq('an event with no tags array is bookmark', sets.setName({ kind: 30003 }), 'bookmark');
eq('a malformed tag is skipped', sets.setName({ kind: 30003, tags: ['junk', ['d', 'liked-songs']] }), 'liked-songs');

// ------------------------------------------------------------- belongsTo
ok('the bookmark set belongs to bookmark', sets.belongsTo(setEv('bookmark', 1), 'bookmark'));
ok('liked-songs does NOT belong to bookmark', !sets.belongsTo(setEv('liked-songs', 1), 'bookmark'));
ok('belongsTo defaults to bookmark', sets.belongsTo(setEv('bookmark', 1)));
ok('a different kind never belongs', !sets.belongsTo({ kind: 1, tags: [['d', 'bookmark']] }, 'bookmark'));

// -------------------------------------------------------------- newestOf
{
    /* THE BUG, stated as a test: a newer event from another set must not win. */
    const events = [
        setEv('bookmark', 100, ['a'.repeat(64)]),
        setEv('liked-songs', 200, []),          // newer, different set, no e-tags
        setEv('liked-albums', 150, [])
    ];
    const chosen = sets.newestOf(events, 'bookmark');
    ok('the bookmark set wins even though another set is newer', chosen !== null);
    eq('and it is the bookmark one', sets.setName(chosen), 'bookmark');
    eq('with its bookmarked id intact', sets.bookmarkedIds(chosen), ['a'.repeat(64)]);
}
{
    // between two events of the SAME set, the newest wins
    const events = [setEv('bookmark', 100, ['a'.repeat(64)]), setEv('bookmark', 300, ['b'.repeat(64)])];
    eq('the newest of the same set wins', sets.bookmarkedIds(sets.newestOf(events, 'bookmark')), ['b'.repeat(64)]);
}
{
    const events = [setEv('liked-songs', 500, [])];
    eq('no bookmark set at all yields null', sets.newestOf(events, 'bookmark'), null);
}
eq('an empty list yields null', sets.newestOf([], 'bookmark'), null);
eq('null yields null', sets.newestOf(null, 'bookmark'), null);

// ----------------------------------------------------------------- names
eq('every set name is listed', sets.names([
    setEv('bookmark', 1), setEv('liked-songs', 2), setEv('liked-albums', 3)
]), ['bookmark', 'liked-albums', 'liked-songs']);
eq('duplicates collapse', sets.names([setEv('bookmark', 1), setEv('bookmark', 2)]), ['bookmark']);
eq('no sets means no names', sets.names([]), []);
eq('non-set events are ignored', sets.names([{ kind: 1, tags: [] }]), []);

// --------------------------------------------------------- bookmarkedIds
eq('e-tags become the id list', sets.bookmarkedIds(setEv('bookmark', 1, ['x', 'y'])), ['x', 'y']);
eq('a set with no e-tags is empty', sets.bookmarkedIds(setEv('liked-songs', 1)), []);
eq('empty id strings are skipped', sets.bookmarkedIds({ kind: 30003, tags: [['e', ''], ['e', 'ok']] }), ['ok']);
eq('null yields an empty list', sets.bookmarkedIds(null), []);

// --------------------------------------------------- bookmark.html is wired
{
    const src = readFileSync(join(root, 'bookmark.html'), 'utf8');
    ok('the page loads the sets module',
        /<script src="\/assets\/nostr-sets\.js\?v=[^"]+"><\/script>/.test(src));
    /* The guard itself. Without it, whichever set arrives newest takes the page over. */
    ok('the page filters kind 30003 by set name',
        /NostrSets\.belongsTo\(ev,\s*'bookmark'\)/.test(src)
        || /NostrSets\.setName\(ev\)\s*!==\s*'bookmark'/.test(src)
        || /setName\(ev\)\s*!==\s*'bookmark'/.test(src));
    ok('the id list comes from the module, not a hand-rolled forEach',
        /NostrSets\.bookmarkedIds\(ev\)/.test(src));
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
