/* Tests for assets/nostr-like.js
   Run: node tests/nostr-like.test.mjs
   Pure — no browser, no network (WebSocket is deliberately absent so the module
   takes the `send` path the page provides).

   What this test guards is the promise made to bos (2026-10-11): a like must be
   UNDOABLE, the "already liked" mark must appear, and the state must be built
   from the relay (not from per-device memory) so the phone and the laptop agree.
*/
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const like = require('../assets/nostr-like.js');
const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond) { if (cond) { pass++; results.push('  ok   ' + name); } else { fail++; results.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; results.push('  ok   ' + name); }
    else { fail++; results.push(`  FAIL ${name}\n         got: ${g}\n         want: ${w}`); }
}

const ME = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);

globalThis.alert = () => { globalThis.__alerts = (globalThis.__alerts || 0) + 1; };

let sent, counts, signSeq;
function setup(opts) {
    sent = []; counts = []; signSeq = 0;
    globalThis.nostr = {
        signEvent: async (tpl) => { signSeq++; return Object.assign({}, tpl, { id: 'sig' + signSeq }); }
    };
    like.reset();
    like.init(Object.assign({
        pubkey: ME,
        relays: [],
        send: (ev) => sent.push(ev),
        onCount: (id, d) => counts.push([id, d]),
        historyMs: 0
    }, opts || {}));
}

// ===================== 1. like =====================
setup();
ok('not liked at first', like.isLiked('t1') === false);
const liked = await like.toggle('t1', OTHER);
eq('first toggle -> true', liked, true);
ok('isLiked is now true', like.isLiked('t1') === true);
eq('one event sent', sent.length, 1);
eq('its kind is 7', sent[0].kind, 7);
eq('tag e points at the note', sent[0].tags[0], ['e', 't1', '']);
eq('tag p points at the author', sent[0].tags[1], ['p', OTHER, '']);
eq('content "+"', sent[0].content, '+');
eq('the counter goes up once', counts, [['t1', 1]]);
ok('the like event id is recorded', like.reactionFor('t1') === 'sig1');

// ===================== 2. undo (the part that did not exist before) =====================
const after = await like.toggle('t1', OTHER);
eq('second toggle -> false', after, false);
ok('isLiked is false again', like.isLiked('t1') === false);
eq('two events sent', sent.length, 2);
eq('the second is kind 5 (NIP-09)', sent[1].kind, 5);
eq('points at the like event id', sent[1].tags[0], ['e', 'sig1']);
eq('names the deleted kind', sent[1].tags[1], ['k', '7']);
eq('the counter goes down once', counts, [['t1', 1], ['t1', -1]]);
eq('the like trace is cleared', like.reactionFor('t1'), null);
ok('no alert (no longer a dead end)', (globalThis.__alerts || 0) === 0);

// ===================== 3. state built from the relay =====================
setup();
like.absorb({ id: 'r1', pubkey: ME, kind: 7, created_at: 100, tags: [['e', 't9']] });
ok('a like from another device is read', like.isLiked('t9') === true);
eq('the counter goes up too', counts, [['t9', 1]]);
like.absorb({ id: 'r1', pubkey: ME, kind: 7, created_at: 100, tags: [['e', 't9']] });
eq('the same event is not counted twice', counts, [['t9', 1]]);

setup();
like.absorb({ id: 'r2', pubkey: ME, kind: 7, created_at: 100, tags: [['e', 't9']] });
like.absorb({ id: 'd1', pubkey: ME, kind: 5, created_at: 101, tags: [['e', 'r2']] });
ok('an undo from another device is read', like.isLiked('t9') === false);
eq('the counter goes down', counts, [['t9', 1], ['t9', -1]]);

// another person's events are ignored
setup();
ok("another person's kind 7 is ignored", like.absorb({ id: 'x', pubkey: OTHER, kind: 7, created_at: 1, tags: [['e', 't3']] }) === false);
ok('it does not become liked', like.isLiked('t3') === false);

// the target comes from the LAST "e" tag (NIP-25)
setup();
like.absorb({ id: 'r3', pubkey: ME, kind: 7, created_at: 1, tags: [['e', 'root'], ['e', 'last']] });
ok('the last e tag is the target', like.isLiked('last') === true && like.isLiked('root') === false);

// ===================== 4. the history phase must not change the counter =====================
setup();
like.absorb({ id: 'r4', pubkey: ME, kind: 7, created_at: 1, tags: [['e', 't7']] });
// setup() uses historyMs: 0 -> the history phase is already over. Now test the
// opposite: an ACTIVE history phase (large historyMs) must NOT add to the
// number, because the card counter was already computed from the page's metrics
// request.
like.reset();
like.init({ pubkey: ME, relays: [], send: () => {}, onCount: (id, d) => counts.push([id, d]), historyMs: 60000 });
counts.length = 0;
like.absorb({ id: 'r5', pubkey: ME, kind: 7, created_at: 1, tags: [['e', 't8']] });
ok('the like mark appears even in the history phase', like.isLiked('t8') === true);
eq('the counter does NOT change during history', counts, []);

// ========== 4b. ARRIVAL ORDER (bos's original bug, 2026-10-11) ==========
/* Bos had FOUR reactions for one note; one of them was deleted, but another
   relay still serves that stale one. The old version ("last reaction wins")
   made the like mark VANISH when the stale reaction plus its deletion notice
   arrived last — that is why the index was green while the profile was red. */
const T = 'bf967208bdd68c098b51c166bad31029bc2ed0c7a830cf3caada81fc60214e2e';
const LIVE_A = { id: 'a1', pubkey: ME, kind: 7, created_at: 100, tags: [['e', T]] };
const LIVE_B = { id: 'a2', pubkey: ME, kind: 7, created_at: 150, tags: [['e', T]] };
const LIVE_C = { id: 'a3', pubkey: ME, kind: 7, created_at: 120, tags: [['e', T]] };
const STALE_D = { id: 'a4', pubkey: ME, kind: 7, created_at: 175, tags: [['e', T]] };
const DEL_D = { id: 'd4', pubkey: ME, kind: 5, created_at: 900, tags: [['e', 'a4']] };

// (i) live reactions first, then the stale one, and the deletion notice last
setup();
[LIVE_A, LIVE_B, LIVE_C, STALE_D, DEL_D].forEach(e => like.absorb(e));
ok('order: live->stale->delete stays liked', like.isLiked(T) === true);
eq('order: the newest live reaction is used', like.reactionFor(T), 'a2');

// (ii) the deletion notice arrives BEFORE its stale reaction
setup();
[DEL_D, LIVE_A, STALE_D].forEach(e => like.absorb(e));
ok('order: delete->stale stays liked', like.isLiked(T) === true);
ok('a stale reaction is not counted even when it arrives late', like.reactionFor(T) === 'a1');

// (iii) only a stale reaction plus its deletion -> genuinely not liked
setup();
[STALE_D, DEL_D].forEach(e => like.absorb(e));
ok('only a deleted reaction -> not liked', like.isLiked(T) === false);
eq('no live reaction left', like.reactionFor(T), null);

// (iv) the counter moves only once even with many reactions for the same note
setup();
[LIVE_A, LIVE_B, LIVE_C].forEach(e => like.absorb(e));
eq('three reactions, only one increase', counts, [[T, 1]]);

// (v) an unlike only cancels the one that is ours; the rest stay
setup();
[LIVE_A, LIVE_B].forEach(e => like.absorb(e));
like.absorb({ id: 'd1', pubkey: ME, kind: 5, created_at: 1000, tags: [['e', like.reactionFor(T)]] });
ok('unlike one reaction: still liked by another', like.isLiked(T) === true);
eq('the one left is the older reaction', like.reactionFor(T), 'a1');

// ===================== 5. not logged in =====================
like.reset();
sent = [];
like.init({ pubkey: null, relays: [], send: (ev) => sent.push(ev) });
globalThis.__alerts = 0;
const r = await like.toggle('t5', OTHER);
eq('toggle without a pubkey -> false', r, false);
eq('without a pubkey nothing is sent', sent.length, 0);
ok('without a pubkey the user is told', (globalThis.__alerts || 0) === 1);

// ===================== 6. page structure =====================
const PAGES = ['index.html', 'thread.html', 'notes.html', 'bookmark.html', 'relay.html', 'profile.html'];
const ALL_PAGES = PAGES.concat(['activity.html', 'compose.html']);
for (const p of ALL_PAGES) {
    const html = readFileSync(join(root, p), 'utf8');
    const src = readFileSync(join(root, 'assets', 'form-utils.js'), 'utf8');
    ok(`${p}: loads form-utils.js`, html.includes('/assets/form-utils.js'));
    if (!html.includes('type="password"')) continue;
    const ids = [...html.matchAll(/<input[^>]*type="password"[^>]*id="([^"]+)"/g)].map(m => m[1]);
    for (const id of ids) {
        ok(`${p}: password field ${id} is registered for Enter`, src.includes(`'${id}'`));
    }
}
for (const p of PAGES) {
    const html = readFileSync(join(root, p), 'utf8');
    ok(`${p}: loads nostr-like.js`, html.includes('/assets/nostr-like.js'));
    ok(`${p}: calls initLikeModule()`, html.includes('initLikeModule();'));
    ok(`${p}: likeEvent forwards to the module`, html.includes('NostrLike.toggle'));
    ok(`${p}: no longer keeps its own likedEvents`, !html.includes('likedEvents'));
    ok(`${p}: no longer keeps its own kind 7 rule`, !html.includes('kind: 7'));
}

// ===================== 7. replies are hidden (index + profile) =====================
for (const p of ['index.html', 'profile.html']) {
    const html = readFileSync(join(root, p), 'utf8');
    ok(`${p}: uses NostrNote.isReply to filter replies`, html.includes('NostrNote.isReply'));
}

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
