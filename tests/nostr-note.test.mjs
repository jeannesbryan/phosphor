/* Tests for assets/nostr-note.js
   Run: node tests/nostr-note.test.mjs
   Pure — no browser, no network. The test data is three REAL notes that bos
   reported on 2026-10-04, exactly as they came from the relay. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const note = require('../assets/nostr-note.js');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond) { if (cond) { pass++; results.push('  ok   ' + name); } else { fail++; results.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; results.push('  ok   ' + name); }
    else { fail++; results.push(`  FAIL ${name}\n         got: ${g}\n         want: ${w}`); }
}

// ===================== real data from the relay (2026-10-04) =====================

// The reply "Yes 100%" — it showed in the timeline even though it should not.
const REPLY = {
    id: '884b51a879b8541f7dc766bf53ad3e943e9b96008697e752c7fc4d509b66ac64',
    pubkey: '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d',
    kind: 1,
    content: 'Yes 100%',
    tags: [
        ['e', '4a63646d83035656a88bdc2a9f90b2c48e3cff5a4fce7f8fb8d5a039f4c9a157', 'wss://relay.damus.io/', 'root', '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d'],
        ['e', '000006882e3d422be9529a22001b1e1999780d4ac8e5150f9712553e172b546a', 'wss://relay.primal.net/', 'reply', 'bc4b52cda9a2c8a17d1d03754475aa752ccc74da9041b3da7b844b0e47ed8389'],
        ['p', '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d', 'wss://relay.damus.io/'],
        ['client', 'Amethyst']
    ]
};

// A quote — its quote marker is in the "q" tag, not "e".
const QUOTE = {
    id: '00000083b134049c3d847ccb90287985c76909c5a238592e910ed374c9bf5f0f',
    pubkey: '460c25e682fda7832b52d1f22d3d22b3176d972f60dcdc3212ed8c92ef85065c',
    kind: 1,
    content: 'ZapStore will have 3 re-writes before iOS allows a non-Apple App Store.\nnostr:nevent1qqsy5cmydkpsx4jk4z9ac25ljzevfr3uladylnnl37udtgpe7ny6z4cpz4mhxue69uhhyetvv9ujuerpd46hxtnfduhsygrceeh65u3xgwrjsnny0wnf8zv4wd0v3374ckn9wdl92yc0qf3s05psgqqqqqqs99p39m',
    tags: [
        ['p', '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d', 'wss://relay.damus.io/'],
        ['q', '4a63646d83035656a88bdc2a9f90b2c48e3cff5a4fce7f8fb8d5a039f4c9a157', 'wss://relay.damus.io/', '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d'],
        ['zap', '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d', 'wss://relay.damus.io/', '0.9'],
        ['client', 'Amethyst']
    ]
};

// A note with a GitHub link — it only has a "p" tag, no "e".
const GITHUB_POST = {
    id: '6a039dfccc328781de65e00e3a1334039bfdfd67c0fb0839bd35aa9efa1be376',
    pubkey: '7999814161743f22',
    kind: 1,
    content: 'We build everything completely in the open.\n\nhttps://github.com/Conduit-BTC/conduit-mono/blob/main/docs/OPEN_MARKETS.md\n',
    tags: [['p', '9d92077c5e35af76f7b1cd84738000b7bafb43d20b0a26c18fe29fa838d27146'], ['client', 'Ditto']]
};

console.log('--- 1. NIP-10: detecting replies ---');
eq('a real reply (e tag marked reply) is detected', note.isReply(REPLY), true);
eq('an ordinary note (no e tag) is not a reply', note.isReply(GITHUB_POST), false);
eq('a quote (q tag, no e) is not a reply', note.isReply(QUOTE), false);
eq('a note without tags does not error', note.isReply({ content: 'x' }), false);
eq('null tags does not error', note.isReply({ tags: null }), false);
eq('a null event does not error', note.isReply(null), false);

// An "e" tag marked root only -> still a reply (it points at the parent).
eq('a root marker alone is still a reply',
    note.isReply({ tags: [['e', 'a'.repeat(64), 'wss://r', 'root']] }), true);
// Old style with no marker at all -> it points at the parent, so a reply.
eq('an e tag with no marker (old style) -> a reply',
    note.isReply({ tags: [['e', 'a'.repeat(64)]] }), true);
// Every "e" tag marked mention -> just a mention, not a reply.
eq('e tags marked mention only -> NOT a reply',
    note.isReply({ tags: [['e', 'a'.repeat(64), 'wss://r', 'mention']] }), false);
// Mixed: one mention + one reply -> still a reply.
eq('mixed mention + reply -> a reply',
    note.isReply({ tags: [['e', 'a'.repeat(64), 'wss://r', 'mention'], ['e', 'b'.repeat(64), 'wss://r', 'reply']] }), true);
// An "e" tag without an id must be ignored, not treated as a reply.
eq('an e tag without an id is ignored', note.isReply({ tags: [['e']] }), false);
// A note linking to a REPO (not a note) must not cause a wrong guess.
eq('only a p tag -> not a reply', note.isReply({ tags: [['p', 'c'.repeat(64)]] }), false);

console.log('--- 2. NIP-18: quote targets ---');
const targets = note.quoteTargets(QUOTE);
eq('a real quote: one target', targets.length, 1);
eq('the target id is correct', targets[0].id, '4a63646d83035656a88bdc2a9f90b2c48e3cff5a4fce7f8fb8d5a039f4c9a157');
eq('the target relay is read', targets[0].relay, 'wss://relay.damus.io/');
eq('the target pubkey is read', targets[0].pubkey, '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d');
eq('a reply without a q tag -> no target', note.quoteTargets(REPLY).length, 0);
eq('without tags -> no target', note.quoteTargets({}).length, 0);
eq('a q tag id that is not 64-hex -> rejected',
    note.quoteTargets({ tags: [['q', 'not-hex']] }).length, 0);
eq('a q tag id that is too short -> rejected',
    note.quoteTargets({ tags: [['q', 'a'.repeat(63)]] }).length, 0);
eq('two q tags -> two targets',
    note.quoteTargets({ tags: [['q', 'a'.repeat(64)], ['q', 'b'.repeat(64)]] }).length, 2);
eq('an uppercase id is normalised to lowercase',
    note.quoteTargets({ tags: [['q', 'A'.repeat(64)]] })[0].id, 'a'.repeat(64));

console.log('--- 3. GitHub links: parsing ---');
const gh = note.githubRepo('https://github.com/Conduit-BTC/conduit-mono/blob/main/docs/OPEN_MARKETS.md');
eq('a real file link: owner', gh.owner, 'Conduit-BTC');
eq('a real file link: repo', gh.repo, 'conduit-mono');
eq('a real file link: path', gh.path, 'blob/main/docs/OPEN_MARKETS.md');
eq('the dashboard url is cleaned', gh.url, 'https://github.com/Conduit-BTC/conduit-mono');

const plain = note.githubRepo('https://github.com/honojs/hono');
eq('a plain repo link: owner', plain.owner, 'honojs');
eq('a plain repo link: repo', plain.repo, 'hono');
eq('a plain repo link: empty path', plain.path, '');
eq('the .git suffix is dropped', note.githubRepo('https://github.com/honojs/hono.git').repo, 'hono');
eq('www is accepted', note.githubRepo('https://www.github.com/honojs/hono').repo, 'hono');

eq('github.com without a repo -> null', note.githubRepo('https://github.com/honojs'), null);
eq('the settings page is not a repo', note.githubRepo('https://github.com/settings/profile'), null);
eq('the topics page is not a repo', note.githubRepo('https://github.com/topics/javascript'), null);
eq('a fake host is rejected', note.githubRepo('https://github.com.evil.example/honojs/hono'), null);
eq('the gist subdomain is rejected', note.githubRepo('https://gist.github.com/user/abc123'), null);
eq('another domain is rejected', note.githubRepo('https://gitlab.com/honojs/hono'), null);
eq('a non-url is rejected', note.githubRepo('not a url'), null);
eq('a non-string is rejected', note.githubRepo(null), null);
eq('a javascript: scheme is rejected', note.githubRepo('javascript:alert(1)'), null);
eq('a file: scheme is rejected', note.githubRepo('file:///etc/passwd'), null);

console.log('--- 4. star counts ---');
eq('below 1000 as-is', note.formatCount(0), '0');
eq('999 as-is', note.formatCount(999), '999');
eq('1000 becomes 1k', note.formatCount(1000), '1k');
eq('1234 becomes 1.2k', note.formatCount(1234), '1.2k');
eq('12345 becomes 12.3k', note.formatCount(12345), '12.3k');
eq('not rounded up', note.formatCount(1999), '1.9k');

console.log('--- 5. repo card: rendering ---');
const card = note.repoCardHtml(
    { owner: 'Conduit-BTC', repo: 'conduit-mono', path: 'blob/main/docs/OPEN_MARKETS.md', url: 'https://github.com/Conduit-BTC/conduit-mono' },
    { full_name: 'Conduit-BTC/conduit-mono', description: 'A Bitcoin <script> relay', stargazers_count: 1234, language: 'Rust', owner_avatar: 'https://avatars.githubusercontent.com/u/1?v=4' }
);
ok('the card has an outbound link', card.includes('href="https://github.com/Conduit-BTC/conduit-mono"'));
ok('the outbound link is safe (noopener)', card.includes('rel="noopener noreferrer"'));
ok('the repo name shows', card.includes('Conduit-BTC/conduit-mono'));
ok('the description shows', card.includes('A Bitcoin'));
ok('the stars show', card.includes('\u2605 1.2k'));
ok('the language shows', card.includes('Rust'));
ok('the file path shows', card.includes('blob/main/docs/OPEN_MARKETS.md'));
ok('a description with <script> is escaped', !note.repoCardHtml(
    { owner: 'a', repo: 'b', path: '', url: 'https://github.com/a/b' },
    { full_name: 'a/b', description: '<script>alert(1)</script>', stargazers_count: 1, language: '', owner_avatar: '' }
).includes('<script>alert'));
ok('without a description there is no description block', !note.repoCardHtml(
    { owner: 'a', repo: 'b', path: '', url: 'https://github.com/a/b' },
    { full_name: 'a/b', description: '', stargazers_count: null, language: '', owner_avatar: '' }
).includes('gh-card-desc'));
eq('empty data -> no markup', note.repoCardHtml(null, null), '');

console.log('--- 6. quote card ---');
const qc = note.quoteCardHtml(REPLY);
ok('the quote card carries the note content', qc.includes('Yes 100%'));
ok('the author- class is used (so the profile fills in automatically)', qc.includes('class="author-78ce6faa'));
ok('the avatar- class is used', qc.includes('class="avatar-78ce6faa'));
ok('content with <script> is escaped', !note.quoteCardHtml({ pubkey: 'a'.repeat(64), content: '<script>alert(1)</script>' }).includes('<script>alert'));
eq('a null event -> no markup', note.quoteCardHtml(null), '');

const longText = 'x'.repeat(400);
const ql = note.quoteCardHtml({ pubkey: 'a'.repeat(64), content: longText });
ok('long content is truncated', ql.includes('\u2026'));
ok('long content stays under the limit + marker', ql.length < 400 + 400);

const withImg = note.quoteCardHtml({ pubkey: 'a'.repeat(64), content: 'see https://example.com/foto.png here' });
eq('the first image is detected', note.firstImageUrl({ content: 'see https://example.com/foto.png here' }), 'https://example.com/foto.png');
eq('without an image -> null', note.firstImageUrl({ content: 'no image' }), null);
ok('the image is used in the quote card', withImg.includes('t-quote-media'));

console.log('--- 7. mounting quote cards (no relay) ---');
const holder = { children: [], appendChild(el) { this.children.push(el); } };

// Without a real document, appendQuoteCard stops safely (null), but the number
// of targets used can still be checked.
eq('a note without a q tag -> 0 targets mounted', note.mountQuotes(holder, REPLY, {}), 0);

// With a get() returning a cached note, the synchronous path is used.
let cache = { [targets[0].id]: QUOTE };
const before = holder.children.length;
note.mountQuotes(holder, QUOTE, { get: (id) => cache[id] || null });
eq('the holder is unchanged without document (safe in Node)', holder.children.length, before);
eq('get is called with the correct target id', (() => {
    let seen = null;
    note.mountQuotes(holder, QUOTE, { get: (id) => { seen = id; return null; }, load: () => Promise.resolve(null) });
    return seen;
})(), targets[0].id);

// load() fails -> nothing is mounted, no error.
let loadCalled = 0;
note.mountQuotes(holder, QUOTE, { load: () => { loadCalled++; return Promise.resolve(null); } });
eq('load is called once per target', loadCalled, 1);

// onEvent/after are not called when the note is not found.
let afterCalled = 0;
note.mountQuotes(holder, QUOTE, { load: () => Promise.resolve(null), after: () => { afterCalled++; } });
await new Promise(r => setTimeout(r, 10));
eq('after is not called on failure', afterCalled, 0);

console.log('--- 8. fetch a note by id (guard) ---');
eq('a non-hex id -> null without opening a socket', await note.fetchEventById('not-an-id'), null);
eq('a null id -> null', await note.fetchEventById(null), null);
note.setRelays([]);
eq('an empty relay list -> null', await note.fetchEventById('a'.repeat(64)), null);
note.setRelays('not an array');
eq('a relay list that is not an array -> null', await note.fetchEventById('a'.repeat(64)), null);

// ============ 9. machine notes (JSON presence/telemetry) ============
// REAL samples from bos's relay, 2026-10-11.
console.log('--- 9. machine notes ---');
const MACHINE = [
    { kind: 1, content: '{"type":"presence","payload":"online"}', tags: [["t", "type"]] },
    { kind: 1, content: '{"v":1,"online":true,"ts":1791657534}', tags: [["t", "presence"]] },
    { kind: 1, content: '{"type":"PresenceHeartbeat","senderKey":"74cc6f02","senderName":"test999","timestamp":1791657554377}', tags: [["t", "t"]] },
    { kind: 1, content: '  {"type":"presence"}  ', tags: [["t", "presence"]] }, // whitespace + machine tag
];
for (const ev of MACHINE) ok('machine: ' + ev.content.slice(0, 40), note.isMachineNote(ev) === true);

// A Gaspool sport activity is ALSO JSON — it MUST keep showing.
const SPORT = {
    kind: 1, content: '{"sport":"cycling","title":"Jumat Gaul","distance":28.6,"duration":"01:41:04"}',
    tags: [["t", "activity"]]
};
ok('a Gaspool activity is NOT treated as machine', note.isMachineNote(SPORT) === false);

// Things that clearly are not machine.
ok('ordinary writing is not machine', note.isMachineNote({ kind: 1, content: 'Hello world', tags: [] }) === false);
ok('JSON that is not an object (an array) is not machine', note.isMachineNote({ kind: 1, content: '[1,2,3]', tags: [] }) === false);
ok('a single-key JSON without tags is not machine', note.isMachineNote({ kind: 1, content: '{"foo":"bar"}', tags: [] }) === false);
ok('text starting with { but not JSON is not machine', note.isMachineNote({ kind: 1, content: '{ hello }', tags: [] }) === false);
ok('another kind is not machine', note.isMachineNote({ kind: 7, content: '{"type":"presence","payload":"online"}', tags: [] }) === false);
ok('an empty note is not machine', note.isMachineNote({ kind: 1, content: '', tags: [] }) === false);
ok('without a content field it is safe', note.isMachineNote({ kind: 1, tags: [] }) === false);
ok('a null event is safe', note.isMachineNote(null) === false);

// ======== 9b. SECOND-WAVE machine samples (bos report 2026-10-11) ========
console.log('--- 9b. machine notes, second wave ---');
const MACHINE2 = [
    // payamresan: unexpected keys, "d" tag = presence
    { kind: 1, content: '{"id":"p1791659484990230","n":"Abolfazll","t":"","ts":1791659484990,"ty":"p"}', tags: [['t', 'payamresan-general'], ['d', 'presence']] },
    // a proxy list broadcast
    { kind: 1, content: '{"proxies": [], "updated": 1791659463}', tags: [] },
];
for (const ev of MACHINE2) ok('machine2: ' + ev.content.slice(0, 42), note.isMachineNote(ev) === true);
// guard: a Gaspool activity still shows even with many keys
ok('machine2: a Gaspool activity still shows',
    note.isMachineNote({ kind: 1, content: '{"sport":"cycling","distance":28.6,"duration":6064,"title":"Jumat Gaul"}', tags: [] }) === false);

// ============ 9c. empty notes ============
console.log('--- 9c. empty notes ---');
ok('empty 20000 without tags = empty', note.isEmptyNote({ kind: 20000, content: '', tags: [] }) === true);
ok('kind 1 with whitespace-only content = empty', note.isEmptyNote({ kind: 1, content: '   \n  ', tags: [] }) === true);
ok('kind 1 with imeta is not empty', note.isEmptyNote({ kind: 1, content: '', tags: [['imeta', 'url https://x/y.jpg']] }) === false);
ok('kind 1 with text is not empty', note.isEmptyNote({ kind: 1, content: 'hello', tags: [] }) === false);
ok('kind 3 (following) is not our concern', note.isEmptyNote({ kind: 3, content: '', tags: [] }) === false);
ok('shouldHideNote combines both',
    note.shouldHideNote({ kind: 20000, content: '', tags: [] }) === true &&
    note.shouldHideNote({ kind: 1, content: '{"type":"presence","payload":"online"}', tags: [] }) === true &&
    note.shouldHideNote({ kind: 1, content: 'plain writing', tags: [] }) === false);

// ============ 9d. level-one replies (NIP-10) ============
console.log('--- 9d. level-one replies ---');
const ROOT = 'r'.repeat(64), MID = 'm'.repeat(64), OTHER = 'o'.repeat(64);
// Amethyst/primal style: root + reply markers
const L1mark = { kind: 1, tags: [['e', ROOT, '', 'root']] };
const L1mark2 = { kind: 1, tags: [['e', ROOT, '', 'root'], ['p', 'x'], ['e', ROOT, '', 'reply']] };
const L2mark = { kind: 1, tags: [['e', ROOT, '', 'root'], ['e', MID, '', 'reply']] };
eq('root only -> parent = root', note.replyParent(L1mark), ROOT);
eq('root+reply to root -> parent = root', note.replyParent(L1mark2), ROOT);
eq('root+reply to the middle -> parent = middle', note.replyParent(L2mark), MID);
ok('a direct L1: yes', note.isDirectReply(L1mark, ROOT) === true);
ok('L1 (root+reply to root): yes', note.isDirectReply(L1mark2, ROOT) === true);
ok('L2 (a reply to a reply): NOT', note.isDirectReply(L2mark, ROOT) === false);
// old style with no markers
eq('old style, one e tag -> that is the parent', note.replyParent({ kind: 1, tags: [['e', ROOT]] }), ROOT);
eq('old style, many e tags -> the last one is the parent', note.replyParent({ kind: 1, tags: [['e', ROOT], ['e', MID]] }), MID);
ok('old style reply-to-a-reply is not L1',
    note.isDirectReply({ kind: 1, tags: [['e', ROOT], ['e', MID]] }, ROOT) === false);
// mention only
eq('mention only -> no parent', note.replyParent({ kind: 1, tags: [['e', MID, '', 'mention']] }), null);
ok('mention only is not L1', note.isDirectReply({ kind: 1, tags: [['e', MID, '', 'mention']] }, ROOT) === false);
ok('without an e tag it is not L1', note.isDirectReply({ kind: 1, tags: [['p', OTHER]] }, ROOT) === false);
ok('an empty rootId is not L1', note.isDirectReply(L1mark, '') === false);
ok('a null note is safe', note.replyParent(null) === null);

// ============ 10. NIP-19 -> in-page links + quote cards ============
// REAL data: bos's note 0000004893… quotes 5850f17f… through the "q" tag while
// also embedding nostr:nevent1… inside its content (Amethyst style).
console.log('--- 10. NIP-19 and quote cards ---');
const NEVENT = 'nevent1qqs9s58307yckh6tk2c6xvftmhkjmaad0asqfcp4cv7gpjmg0fw4atspz9mhxue69uhkummnw3ezuamfdejj7q3qgcxzte5zlkncx26j68ez60fzkvtkm9e0vrwdcvsjakxf9mu9qewqxpqqqqqqzwgzuaz';
const NOTE1 = 'note1tpg0zluf3d05hv435vcjhh0d9hm66lmqqnsrtseusr9ks7jat6hqsp6f3f';
const NPUB = 'npub1gcxzte5zlkncx26j68ez60fzkvtkm9e0vrwdcvsjakxf9mu9qewqlfnj5z';
const QUOTED_ID = '5850f17f898b5f4bb2b1a3312bdded2df7ad7f6004e035c33c80cb687a5d5eae';
const MAIN_ID = '0000004893b8e8f09e316e721dff65a1b087e4bb949c86e470429473213c0c63';
const MAIN_PK = '460c25e682fda7832b52d1f22d3d22b3176d972f60dcdc3212ed8c92ef85065c';
const MAIN_EV = {
    id: MAIN_ID, kind: 1, pubkey: MAIN_PK, created_at: 1,
    content: 'I should have done this desktop version a long time ago. Agents have so much trouble testing.\nnostr:' + NEVENT,
    tags: [['p', MAIN_PK, 'wss://vitor.nostr1.com/'], ['q', QUOTED_ID, 'wss://nostr.wine/', MAIN_PK], ['client', 'Amethyst']]
};

const dN = note.nip19Decode(NEVENT);
ok('nevent: the id is correct', dN && dN.id === QUOTED_ID);
eq('nevent: relays are read', dN && dN.relays, ['wss://nostr.wine/']);
ok('nevent: the author is read', dN && dN.author === MAIN_PK);
eq('nevent: the kind is read', dN && dN.kind, 1);
ok('note1: the id is correct', note.nip19Decode(NOTE1).id === QUOTED_ID);
ok('npub: the pubkey is correct', note.nip19Decode(NPUB).pubkey === MAIN_PK);
ok('broken bech32 -> null', note.nip19Decode('nevent1qqsqqqqqqqqqqqqqqqqqqqqqqqqqqqq') === null);
ok('not nip19 -> null', note.nip19Decode('hello world') === null);
ok('mixed case -> null', note.nip19Decode('NeVent1qqs9s58307') === null);
ok('not text -> null', note.nip19Decode(null) === null);

eq('nevent -> the thread page', note.nip19PageUrl(NEVENT), 'thread.html?id=' + QUOTED_ID);
eq('note -> the thread page', note.nip19PageUrl(NOTE1), 'thread.html?id=' + QUOTED_ID);
eq('npub -> the profile page', note.nip19PageUrl(NPUB), 'profile.html?pubkey=' + MAIN_PK);
eq('an unknown id -> null', note.nip19PageUrl('nevent1qqsxx'), null);
eq('a kind 1 event -> thread', note.notePageUrl(MAIN_EV), 'thread.html?id=' + MAIN_ID);
ok('a kind 30023 article -> notes',
    /^notes\.html\?d=abc&author=/.test(note.notePageUrl({ id: 'x', kind: 30023, pubkey: MAIN_PK, tags: [['d', 'abc']] })));

// --- linkify: an id that is the quote target is dropped (no double display) ---
const linked = note.linkifyNostrUris(MAIN_EV.content, MAIN_EV);
ok('a duplicate nevent is dropped from the content', linked.indexOf('NOSTR') === -1);
ok('duplicate nevent: no nostr: href', linked.indexOf('nostr:') === -1);
ok('the original text stays intact', linked.indexOf('I should have done this desktop version') === 0);
ok('the leftover empty line is cleaned too', !/\n\s*$/.test(linked));

// --- linkify: other ids (not quote targets) become IN-PAGE links ---
const otherLinks = note.linkifyNostrUris(MAIN_EV.content, { tags: [['q', 'f'.repeat(64)]] });
ok('another nevent -> an in-page link', otherLinks.indexOf('href="thread.html?id=' + QUOTED_ID + '"') !== -1);
ok('another nevent is not a protocol link', otherLinks.indexOf('href="nostr:') === -1);
ok('another nevent: stopPropagation is attached', otherLinks.indexOf('event.stopPropagation()') !== -1);

const withNpub = note.linkifyNostrUris('hi nostr:' + NPUB, null);
ok('npub -> an in-page profile link', withNpub.indexOf('href="profile.html?pubkey=' + MAIN_PK + '"') !== -1);
ok('npub: the label is shortened', withNpub.indexOf('[NOSTR: npub1gcxzt...') !== -1);
ok('without an id: the text is unchanged', note.linkifyNostrUris('just plain text', MAIN_EV) === 'just plain text');
ok('non-string text is safe', note.linkifyNostrUris(null, MAIN_EV) === null);

// --- quote card: links to the QUOTED note, not the quoting one ---
const quotedEv = { id: QUOTED_ID, kind: 1, pubkey: MAIN_PK, created_at: 1, content: "It's finally getting ready. Full Amethyst running on the Desktop.", tags: [] };
const quoteCard = note.quoteCardHtml(quotedEv);
ok('the quote card is a link', quoteCard.indexOf('<a class="t-quote-card"') === 0);
ok('the quote card -> the quoted note id', quoteCard.indexOf('href="thread.html?id=' + QUOTED_ID + '"') !== -1);
ok('the quote card does NOT -> the quoting note id', quoteCard.indexOf(MAIN_ID) === -1);
ok('the card has the author- class', quoteCard.indexOf('class="author-' + MAIN_PK) !== -1);
ok('the card has the avatar- class', quoteCard.indexOf('class="avatar-' + MAIN_PK) !== -1);
ok('the card has the handle- class', quoteCard.indexOf('class="handle-' + MAIN_PK) !== -1);
ok('an article quote card -> notes',
    note.quoteCardHtml({ id: 'x', kind: 30023, pubkey: MAIN_PK, content: 'a', tags: [['d', 'art']] }).indexOf('notes.html?d=art') !== -1);

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
