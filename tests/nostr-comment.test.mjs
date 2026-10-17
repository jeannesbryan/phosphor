/* Tests for assets/nostr-comment.js — run: node tests/nostr-comment.test.mjs
   Pure (no browser, no network).

   The event shapes below are copied from real kind 1111 events on
   relay.primal.net (2026-10-17), not invented: 40 real comments showed 24
   top-level, 13 replies-to-comments and 1 external scope, all carrying K/k. */
import comment from '../assets/nostr-comment.js';
import note from '../assets/nostr-note.js';
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
function report() {
    results.forEach(r => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

const ROOT = '2e3314af929948d83b8ebc21d72b0a9e6feb19778ea12801be4ea6fdeb89532c';
const ROOT_PK = 'ba18b6545357cff8e531accfe1d609a41ef3023fba071db1cbf5a67448c19046';
const PARENT_COMMENT = '2e1e326c1f36bc15aa0eaa46195d649ef66811d6b9c296f477b06f5a7beca244';
const PARENT_PK = '713fc3bf6c1c5cc593736c2b1375ba165e173b05d31787ed3b0591796a489a3f';

// ---------- real event shapes ----------

/* Top-level comment on a kind-1 note. Note e == E: the parent IS the root. */
const TOP = {
    kind: 1111, pubkey: 'c'.repeat(64), created_at: 100,
    content: "She's a beauty.",
    tags: [
        ['E', ROOT, 'wss://spatia-arcana.com/', ROOT_PK],
        ['K', '1'],
        ['P', ROOT_PK, 'wss://nostr.wine/'],
        ['e', ROOT, 'wss://spatia-arcana.com/', ROOT_PK],
        ['k', '1'],
        ['p', ROOT_PK, 'wss://nostr.wine/']
    ]
};

/* Reply to a comment. Root stays the kind-34236 video; e points at the comment. */
const REPLY = {
    kind: 1111, pubkey: 'd'.repeat(64), created_at: 200,
    content: 'shoutout to all the epileptics out there',
    tags: [
        ['E', '6702a63aee2e3a88ef9943a3e9d747ee12dd4de108fae36e9a86aabe86cce763', '', '530c324b51c939690624c34ac30856864e86a883423c2eba38f5bc9232dd9689'],
        ['A', '34236:530c324b51c939690624c34ac30856864e86a883423c2eba38f5bc9232dd9689:8e0b47bd6c6eb2b72e079ec587afd869a6504b75150606eaa22bb2a7f5ed6456', ''],
        ['K', '34236'],
        ['P', '530c324b51c939690624c34ac30856864e86a883423c2eba38f5bc9232dd9689'],
        ['e', PARENT_COMMENT, '', PARENT_PK],
        ['k', '1111'],
        ['p', PARENT_PK]
    ]
};

/* Comment on a website URL: root is not an event at all. */
const WEB = {
    kind: 1111, pubkey: 'e'.repeat(64), created_at: 300,
    content: 'Okay, so I have been trying to wrap my head around this',
    tags: [
        ['I', 'https://clawstr.com/c/agent-economy'],
        ['K', 'web'],
        ['e', PARENT_COMMENT, 'wss://relay.ditto.pub', PARENT_PK],
        ['k', '1111'],
        ['p', PARENT_PK]
    ]
};

// ---------- 1. kind detection ----------
ok('isComment: kind 1111', comment.isComment({ kind: 1111 }));
ok('isComment: kind 1 is not a comment', !comment.isComment({ kind: 1 }));
ok('isComment: null', !comment.isComment(null));
eq('parse: non-comment -> null', comment.parse({ kind: 1, tags: [] }), null);
eq('KIND constant', comment.KIND, 1111);

// ---------- 2. parse a top-level comment ----------
const topScope = comment.parse(TOP);
eq('top: root id', topScope.root.id, ROOT);
eq('top: root kind', topScope.root.kind, 1);
eq('top: root pubkey', topScope.root.pubkey, ROOT_PK);
eq('top: parent id', topScope.parent.id, ROOT);
eq('top: parent kind', topScope.parent.kind, 1);
eq('top: is top level', topScope.topLevel, true);
eq('top: no issues', topScope.issues.length, 0);
eq('top: ok', topScope.ok, true);
eq('top: describe', comment.describe(TOP), 'COMMENT');

// ---------- 3. parse a reply to a comment ----------
const repScope = comment.parse(REPLY);
eq('reply: root is the video', repScope.root.kind, 34236);
eq('reply: parent is a comment', repScope.parent.kind, 1111);
eq('reply: parent id is the comment', repScope.parent.id, PARENT_COMMENT);
ok('reply: not top level', repScope.topLevel === false);
eq('reply: describe', comment.describe(REPLY), 'COMMENT_REPLY');
eq('reply: addressable root address kept', repScope.root.address.slice(0, 6), '34236:');

// ---------- 4. external scope ----------
const webScope = comment.parse(WEB);
eq('web: I tag', webScope.external.I, 'https://clawstr.com/c/agent-economy');
eq('web: K is not a number', webScope.root.kind, null);
ok('web: reported as an issue, not silently accepted',
   webScope.issues.some(x => x.indexOf('K is not a kind number') !== -1));
eq('web: still has a parent', webScope.parent.id, PARENT_COMMENT);

// ---------- 5. the marker trap ----------
/* NIP-10 marker logic reads tag[3]. A real NIP-22 e tag is
   ["e", id, relay, pubkey] — tag[3] is a pubkey, truthy, and matches neither
   "root" nor "reply", so replyParent() returns null and the comment is
   dropped. This assertion pins the reason this module exists. */
eq('trap: NIP-10 replyParent cannot read a comment', note.replyParent(TOP), null);
eq('trap: NIP-10 isDirectReply therefore fails', note.isDirectReply(TOP, ROOT), false);
eq('trap: NIP-22 reads it correctly', comment.parentId(TOP), ROOT);
ok('trap: NIP-22 recognises a direct comment', comment.isDirectComment(TOP, ROOT));

// A reply to a comment must NOT count as a direct comment on the root.
eq('trap: reply-to-comment is not direct on root', comment.isDirectComment(REPLY, ROOT), false);
ok('trap: reply-to-comment is direct on that comment',
   comment.isDirectComment(REPLY, PARENT_COMMENT));

// ---------- 6. isDirectComment edge cases ----------
ok('direct: null id is false', comment.isDirectComment(TOP, null) === false);
ok('direct: non-comment is false', comment.isDirectComment({ kind: 1, tags: [] }, ROOT) === false);
ok('direct: wrong id is false', comment.isDirectComment(TOP, 'ffff') === false);

// address-only root: no E tag, only A
const ADDR_ONLY = {
    kind: 1111, content: 'x',
    tags: [['A', '30023:pk:slug'], ['K', '30023'], ['a', '30023:pk:slug'], ['k', '30023']]
};
const addrScope = comment.parse(ADDR_ONLY);
ok('address-only: parsed', addrScope !== null);
eq('address-only: root address', addrScope.root.address, '30023:pk:slug');
eq('address-only: top level', addrScope.topLevel, true);

// ---------- 7. spec compliance flags ----------
const NO_K = { kind: 1111, tags: [['E', ROOT], ['e', ROOT]] };
const noK = comment.parse(NO_K);
ok('spec: missing K flagged', noK.issues.some(x => x.indexOf('missing K') !== -1));
ok('spec: missing k flagged', noK.issues.some(x => x.indexOf('missing k') !== -1));
eq('spec: not ok', noK.ok, false);
/* Rendering stays lenient: a comment with a missing K is still worth showing,
   so the ids are still parsed. */
eq('spec: ids still parsed when not ok', noK.root.id, ROOT);

const BAD_K = { kind: 1111, tags: [['E', ROOT], ['K', 'not-a-kind'], ['e', ROOT], ['k', '1']] };
ok('spec: K that is not a number flagged',
   comment.parse(BAD_K).issues.some(x => x.indexOf('K is not a kind number') !== -1));

const NO_REFS = { kind: 1111, tags: [['K', '1'], ['k', '1']] };
ok('spec: no root reference flagged',
   comment.parse(NO_REFS).issues.some(x => x.indexOf('no root reference') !== -1));

eq('kindOf: leading zeros parsed sanely', comment.rootKind({ kind: 1111, tags: [['K', '0001']] }), 1);
eq('kindOf: huge value rejected', comment.rootKind({ kind: 1111, tags: [['K', '999999']] }), null);

// ---------- 8. buildTags (publishing) ----------
const topTags = comment.buildTags({ rootId: ROOT, rootKind: 1, rootPubkey: ROOT_PK, rootRelay: 'wss://r.example' });
const names = topTags.map(t => t[0]);
ok('build: uppercase root E', names.includes('E'));
ok('build: uppercase root K', names.includes('K'));
ok('build: uppercase root P', names.includes('P'));
ok('build: lowercase parent e', names.includes('e'));
ok('build: lowercase parent k', names.includes('k'));
ok('build: lowercase parent p', names.includes('p'));
eq('build: K carries the root kind', topTags.find(t => t[0] === 'K')[1], '1');
eq('build: k carries the parent kind (copied for top level)', topTags.find(t => t[0] === 'k')[1], '1');
eq('build: e equals E for a top-level comment',
   topTags.find(t => t[0] === 'e')[1], topTags.find(t => t[0] === 'E')[1]);
ok('build: relay hint carried', topTags.find(t => t[0] === 'E')[2] === 'wss://r.example');

const replyTags = comment.buildTags({
    rootId: ROOT, rootKind: 1, rootPubkey: ROOT_PK,
    parentId: PARENT_COMMENT, parentKind: 1111, parentPubkey: PARENT_PK
});
eq('build reply: K is the root kind', replyTags.find(t => t[0] === 'K')[1], '1');
eq('build reply: k is 1111', replyTags.find(t => t[0] === 'k')[1], '1111');
eq('build reply: E is the root', replyTags.find(t => t[0] === 'E')[1], ROOT);
eq('build reply: e is the comment', replyTags.find(t => t[0] === 'e')[1], PARENT_COMMENT);
eq('build reply: P is the root author', replyTags.find(t => t[0] === 'P')[1], ROOT_PK);
eq('build reply: p is the comment author', replyTags.find(t => t[0] === 'p')[1], PARENT_PK);

// strict: refuse to build something that violates the MUST rules
let threw = false;
try { comment.buildTags({ rootId: ROOT }); } catch (e) { threw = true; }
ok('build: throws without rootKind', threw);

threw = false;
try { comment.buildTags({ rootKind: 1 }); } catch (e) { threw = true; }
ok('build: throws without any root reference', threw);

threw = false;
try { comment.buildTags({ rootId: ROOT, rootKind: 1, parentId: 'x' }); } catch (e) { threw = true; }
ok('build: throws when the parent has no kind', threw);

// a built event must parse back cleanly — round trip
const rt = comment.parse({ kind: 1111, content: 'hi', tags: comment.buildTags({ rootId: ROOT, rootKind: 1, rootPubkey: ROOT_PK }) });
ok('round trip: built tags parse without issues', rt.ok, JSON.stringify(rt.issues));
eq('round trip: top level', rt.topLevel, true);
eq('round trip: root kind', rt.root.kind, 1);

// ---------- 9. scope labels ----------
eq('label: video', comment.scopeLabel(34236), 'short_video');
eq('label: article', comment.scopeLabel(30023), 'long_form_article');
eq('label: comment', comment.scopeLabel(1111), 'comment');
eq('label: unknown addressable', comment.scopeLabel(39999), 'addressable');
eq('label: unknown', comment.scopeLabel(4242), 'kind_4242');
eq('label: null', comment.scopeLabel(null), null);

// ---------- 10. pages ----------
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PAGES = ['index.html', 'thread.html', 'notes.html', 'notifications.html',
               'bookmark.html', 'relay.html', 'profile.html'];
const src = {};
for (const p of PAGES) src[p] = readFileSync(join(root, p), 'utf8');

// thread.html is where comments belong, so it must load the module
ok('thread.html: loads nostr-comment.js', src['thread.html'].includes('/assets/nostr-comment.js'));
ok('thread.html: versioned reference', /nostr-comment\.js\?v=\d{8}[a-z]/.test(src['thread.html']));

/* The reply subscription must ask for kind 1111, otherwise the events never
   arrive no matter how good the renderer is. */
const threadReqs = [...src['thread.html'].matchAll(/"kinds":\s*\[([^\]]*)\]/g)].map(m => m[1]);
ok('thread.html: some subscription asks for 1111',
   threadReqs.some(x => /\b1111\b/.test(x)));

// notifications must include 1111 so a comment mentioning the user shows up
const notifReqs = [...src['notifications.html'].matchAll(/"kinds":\s*\[([^\]]*)\]/g)].map(m => m[1]);
ok('notifications.html: asks for 1111',
   notifReqs.some(x => /\b1111\b/.test(x)));

/* Comments are replies, not standalone posts: the main timeline and the
   profile feed must not show them as if someone published them. */
ok('index.html: filters kind 1111 out of the timeline',
   /NostrComment/.test(src['index.html']));
ok('profile.html: filters kind 1111 out of the feed',
   /NostrComment/.test(src['profile.html']));

/* Two defects were found by watching a real thread in a browser, not by any
   unit test. Both would have shipped a feature that never shows anything. */
/* 1. thread.html routes events by `isPostKind`. Kind 1111 was not in that
      list, so comments arrived from the relay and were dropped one line
      before the renderer. */
ok('thread.html: routes kind 1111 to the renderer',
   /isPostKind\s*=.*NostrComment/.test(src['thread.html']));
/* 2. The card footer printed "text_note" under a comment. */
ok('thread.html: comment footer says comment',
   src['thread.html'].includes("'comment'"));
ok('thread.html: footer does not fall through to text_note for comments',
   /NostrComment\.isComment\(ev\)\)\s*\?\s*'comment'/.test(src['thread.html']));

// Level-one only: a reply to a comment must not appear under the root note.
ok('thread.html: hidden replies still filtered by the comment module',
   src['thread.html'].includes('NostrComment.isDirectComment('));

report();
