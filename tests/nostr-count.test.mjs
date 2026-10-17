/* Tests for assets/nostr-count.js — run: node tests/nostr-count.test.mjs
   Pure (no browser, no network).

   This file guards two rules that decide whether a number on screen is true:
     - counts from different relays are never summed (they overlap);
     - a number is never counted twice, once by COUNT and again by events. */
import count from '../assets/nostr-count.js';
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

// ---------- 1. isValidCount ----------
ok('count: 0 is valid', count.isValidCount(0));
ok('count: 76 is valid', count.isValidCount(76));
ok('count: negative rejected', !count.isValidCount(-1));
ok('count: float rejected', !count.isValidCount(1.5));
ok('count: NaN rejected', !count.isValidCount(NaN));
ok('count: Infinity rejected', !count.isValidCount(Infinity));
ok('count: string rejected', !count.isValidCount('76'));
ok('count: null rejected', !count.isValidCount(null));
ok('count: beyond MAX_SAFE_INTEGER rejected', !count.isValidCount(Number.MAX_SAFE_INTEGER + 10));

// ---------- 2. parse ----------
const okMsg = count.parse(['COUNT', 'c1', { count: 76 }]);
eq('parse: id', okMsg.id, 'c1');
eq('parse: count', okMsg.count, 76);
eq('parse: not approximate by default', okMsg.approximate, false);
eq('parse: no hll', okMsg.hll, null);

eq('parse: approximate flag honoured',
   count.parse(['COUNT', 'c1', { count: 93412452, approximate: true }]).approximate, true);
eq('parse: approximate string is not truthy',
   count.parse(['COUNT', 'c1', { count: 5, approximate: 'yes' }]).approximate, false);

// malformed / hostile payloads
eq('parse: missing payload -> null', count.parse(['COUNT', 'c1']), null);
eq('parse: no count -> null', count.parse(['COUNT', 'c1', {}]), null);
eq('parse: negative count -> null', count.parse(['COUNT', 'c1', { count: -5 }]), null);
eq('parse: float count -> null', count.parse(['COUNT', 'c1', { count: 2.7 }]), null);
eq('parse: string count -> null', count.parse(['COUNT', 'c1', { count: '76' }]), null);
eq('parse: wrong verb -> null', count.parse(['EVENT', 'c1', {}]), null);
eq('parse: not an array -> null', count.parse('COUNT'), null);

// hll: accepted only when it is a real 256-register value (512 hex chars)
const goodHll = 'ab'.repeat(256);
eq('hll: 512 hex accepted', count.parse(['COUNT', 'c1', { count: 5, hll: goodHll }]).hll, goodHll);
eq('hll: too short rejected', count.parse(['COUNT', 'c1', { count: 5, hll: 'ab'.repeat(10) }]).hll, null);
eq('hll: non-hex rejected', count.parse(['COUNT', 'c1', { count: 5, hll: 'zz'.repeat(256) }]).hll, null);

// ---------- 3. parseRefusal ----------
const ref = count.parseRefusal(['CLOSED', 'c1', 'auth-required: cannot count']);
eq('refusal: id', ref.id, 'c1');
eq('refusal: reason kept', ref.reason, 'auth-required: cannot count');
eq('refusal: not a CLOSED -> null', count.parseRefusal(['COUNT', 'c1', {}]), null);

// ---------- 4. frames ----------
const frame = count.buildFrame('c9', [{ '#e': ['abc'], kinds: [7] }]);
eq('frame: verb', frame[0], 'COUNT');
eq('frame: id', frame[1], 'c9');
eq('frame: filter carried', JSON.stringify(frame[2]), '{"#e":["abc"],"kinds":[7]}');

eq('filterFor: likes are kind 7', JSON.stringify(count.filterFor('likes', ['x'])), '{"#e":["x"],"kinds":[7]}');
eq('filterFor: replies are kind 1', JSON.stringify(count.filterFor('replies', ['x'])), '{"#e":["x"],"kinds":[1]}');
eq('filterFor: reposts cover 6 and 16', JSON.stringify(count.filterFor('reposts', ['x'])), '{"#e":["x"],"kinds":[6,16]}');

// the filter must not mutate the caller's id list
const ids = ['a', 'b'];
count.filterFor('likes', ids);
eq('filterFor: caller array untouched', ids.length, 2);

// ---------- 5. mergeCounts — NEVER SUM ----------
/* Observation from real relays: one pubkey's follower count came back as 3,324
   from nos.lol and 6,692 from primal.net. Summing gives 10,016 people who do
   not exist. */
const merged = count.mergeCounts([{ count: 3324 }, { count: 6692 }]);
eq('merge: takes the maximum, not the sum', merged.count, 6692);
eq('merge: disagreement marks approximate', merged.approximate, true);
eq('merge: disagreement means not agreed', merged.agreed, false);
eq('merge: source count', merged.sources, 2);

const same = count.mergeCounts([{ count: 76 }, { count: 76 }]);
eq('merge: equal values agree', same.agreed, true);
eq('merge: equal values not approximate', same.approximate, false);

eq('merge: single value', count.mergeCounts([{ count: 5 }]).count, 5);
eq('merge: empty -> null', count.mergeCounts([]), null);
eq('merge: junk filtered out', count.mergeCounts([{ count: 5 }, { count: -1 }, null]).count, 5);

// ---------- 6. the flow ----------
function fakeSockets(n) {
    const made = [];
    for (let i = 0; i < n; i++) made.push({ readyState: 1, sent: [], send(f) { this.sent.push(JSON.parse(f)); } });
    return made;
}

function setup(opts = {}) {
    const cache = {};
    const sockets = fakeSockets(opts.sockets === undefined ? 1 : opts.sockets);
    const updates = [];
    count.init({
        sockets: () => sockets,
        cache,
        ensure: (id) => { if (!cache[id]) cache[id] = { replies: 0, reposts: 0, likes: 0, zapSats: 0, processed: new Set() }; },
        update: (id) => updates.push(id),
        debounceMs: 0,
        refusalWindowMs: opts.refusalWindowMs === undefined ? 50 : opts.refusalWindowMs
    });
    return { cache, sockets, updates };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- a COUNT answer fills the counter and blocks event-based tallies ---
{
    const { cache, sockets } = setup();
    count.requestMetrics('note1');
    await sleep(5);
    const sent = sockets[0].sent;
    const counts = sent.filter(f => f[0] === 'COUNT');
    eq('flow: three COUNT frames per target', counts.length, 3);
    ok('flow: one REQ remains for zaps', sent.some(f => f[0] === 'REQ' && f[2].kinds.includes(9735)));
    ok('flow: the zap REQ does not ask for countable kinds',
       !sent.find(f => f[0] === 'REQ' && f[2].kinds.includes(9735)).join(',').includes(',7,'));

    const likeSub = counts.find(f => f[2].kinds[0] === 7)[1];
    const replySub = counts.find(f => f[2].kinds[0] === 1)[1];
    const repostSub = counts.find(f => f[2].kinds[0] === 6)[1];

    count.handleMessage(['COUNT', likeSub, { count: 76 }]);
    count.handleMessage(['COUNT', replySub, { count: 29 }]);
    count.handleMessage(['COUNT', repostSub, { count: 9 }]);

    eq('flow: likes written', cache.note1.likes, 76);
    eq('flow: replies written', cache.note1.replies, 29);
    eq('flow: reposts written', cache.note1.reposts, 9);

    // rule 2: events for these kinds must now be ignored
    ok('flow: likes are COUNT-sourced', count.isCountSourced('note1', 'likes'));
    ok('flow: replies are COUNT-sourced', count.isCountSourced('note1', 'replies'));
    ok('flow: reposts are COUNT-sourced', count.isCountSourced('note1', 'reposts'));
    ok('flow: zaps are NOT COUNT-sourced', !count.isCountSourced('note1', 'zapSats'));
    eq('flow: zap counter untouched by COUNT', cache.note1.zapSats, 0);
}

// --- two relays disagreeing: max wins and the value is flagged ---
{
    const { cache, sockets } = setup({ sockets: 2 });
    count.requestMetrics('note2');
    await sleep(5);
    const likeSub2 = sockets[0].sent.filter(f => f[0] === 'COUNT' && f[2].kinds[0] === 7)[0][1];
    count.handleMessage(['COUNT', likeSub2, { count: 5 }]);
    eq('merge flow: first relay sets the value', cache.note2.likes, 5);
    count.handleMessage(['COUNT', likeSub2, { count: 8 }]);
    eq('merge flow: higher relay raises it', cache.note2.likes, 8);
    count.handleMessage(['COUNT', likeSub2, { count: 6 }]);
    eq('merge flow: a lower relay never lowers it', cache.note2.likes, 8);
    eq('merge flow: disagreement flagged', cache.note2.approximate.likes, true);
}

// --- a relay that refuses COUNT triggers the old REQ fallback ---
{
    const { sockets } = setup({ refusalWindowMs: 30 });
    count.requestMetrics('note3');
    await sleep(5);
    const likeSub3 = sockets[0].sent.filter(f => f[0] === 'COUNT' && f[2].kinds[0] === 7)[0][1];
    const consumed = count.handleMessage(['CLOSED', likeSub3, 'unsupported: unknown verb']);
    ok('refusal: CLOSED consumed', consumed === true);

    await sleep(60);
    const fb = sockets[0].sent.filter(f => f[0] === 'REQ' && f[1].startsWith('metrics-fb'));
    ok('refusal: fallback REQ sent', fb.length >= 1);
    ok('refusal: fallback asks for countable kinds', fb.length && fb[0][2].kinds.includes(7));
}

// --- when nothing comes back at all, the fallback still fires ---
{
    const { sockets } = setup({ refusalWindowMs: 30 });
    count.requestMetrics('note4');
    await sleep(70);
    const fb = sockets[0].sent.filter(f => f[0] === 'REQ' && f[1].startsWith('metrics-fb'));
    ok('silence: fallback REQ sent after the window', fb.length >= 1);
}

// --- when COUNT answered, no fallback is sent ---
{
    const { sockets } = setup({ refusalWindowMs: 30 });
    count.requestMetrics('note5');
    await sleep(5);
    const subs = sockets[0].sent.filter(f => f[0] === 'COUNT');
    subs.forEach(f => count.handleMessage(['COUNT', f[1], { count: 1 }]));
    await sleep(70);
    const fb = sockets[0].sent.filter(f => f[0] === 'REQ' && f[1].startsWith('metrics-fb'));
    eq('answered: no pointless fallback', fb.length, 0);
}

/* A busy feed calls requestMetrics once per incoming card. If each call resets
   the timer, the window is pushed back forever and nothing is ever sent — the
   counters simply never fill in. Found in a real browser where 190 ids had
   piled up and one manual flush fired 760 frames at once. */
{
    const cache = {};
    const sockets = fakeSockets(1);
    count.init({
        sockets: () => sockets,
        cache,
        ensure: (id) => { if (!cache[id]) cache[id] = { replies: 0, reposts: 0, likes: 0, zapSats: 0, processed: new Set() }; },
        update: () => {},
        debounceMs: 40,
        refusalWindowMs: 5000
    });
    /* Nudge faster than the debounce and check WHILE the stream is still
       running. Checking after a pause proves nothing: a reset-on-every-call
       timer also fires then, just later. The defect is that nothing is sent at
       all while cards keep arriving. */
    const seenDuringStream = () => sockets[0].sent.filter(f => f[0] === 'COUNT').length;
    for (let i = 0; i < 15; i++) {
        count.requestMetrics('live' + i);
        await sleep(10);
    }
    const duringStream = seenDuringStream();
    ok('starvation: frames are sent while the stream is still running',
       duringStream > 0, `only ${duringStream} COUNT frames mid-stream`);

    await sleep(80);
    const counts = seenDuringStream();
    eq('starvation: every target is eventually counted', counts, 15 * 3);
}

// --- batching: many cards in one flush ---
{
    const { sockets } = setup({ refusalWindowMs: 5000 });
    ['a', 'b', 'c'].forEach(id => count.requestMetrics(id));
    await sleep(5);
    const counts = sockets[0].sent.filter(f => f[0] === 'COUNT');
    eq('batch: 3 targets x 3 kinds', counts.length, 9);
    const reqs = sockets[0].sent.filter(f => f[0] === 'REQ');
    eq('batch: one zap REQ for the whole batch', reqs.length, 1);
    eq('batch: zap REQ carries all ids', reqs[0][2]['#e'].length, 3);
}

// --- unknown / foreign messages are not consumed ---
{
    setup();
    ok('foreign: EVENT not consumed', count.handleMessage(['EVENT', 'x', {}]) === false);
    ok('foreign: EOSE not consumed', count.handleMessage(['EOSE', 'x']) === false);
    ok('foreign: NOTICE not consumed', count.handleMessage(['NOTICE', 'hi']) === false);
    ok('foreign: unknown COUNT id consumed', count.handleMessage(['COUNT', 'somebody-else', { count: 1 }]) === true);
    ok('foreign: non-array not consumed', count.handleMessage('hello') === false);
}

// --- a malformed COUNT must never write a number ---
{
    const { cache, sockets } = setup();
    count.requestMetrics('note6');
    await sleep(5);
    const sub = sockets[0].sent.filter(f => f[0] === 'COUNT' && f[2].kinds[0] === 7)[0][1];
    count.handleMessage(['COUNT', sub, { count: -3 }]);
    count.handleMessage(['COUNT', sub, { count: 'lots' }]);
    count.handleMessage(['COUNT', sub, {}]);
    ok('malformed: counter stays 0', !cache.note6 || cache.note6.likes === 0);
    ok('malformed: not marked COUNT-sourced', !count.isCountSourced('note6', 'likes'));
}

// ---------- 6b. the honesty marker on disagreeing relays ----------
/* Relays routinely disagree because one of them simply lacks the events. The
   number then is the highest view, not the true total, and the UI says so in a
   tooltip rather than pretending to know. */
{
    const nodes = {};
    globalThis.document = {
        getElementById: (id) => nodes[id] || (nodes[id] = { title: undefined, removeAttribute(k) { if (k === 'title') this.title = undefined; } })
    };

    const cache = {};
    const sockets = fakeSockets(1);
    count.init({
        sockets: () => sockets,
        cache,
        ensure: (id) => { if (!cache[id]) cache[id] = { replies: 0, reposts: 0, likes: 0, zapSats: 0, processed: new Set() }; },
        update: () => {},
        debounceMs: 0,
        refusalWindowMs: 5000
    });
    count.requestMetrics('note7');
    await sleep(5);
    const likeSub = sockets[0].sent.filter(f => f[0] === 'COUNT' && f[2].kinds[0] === 7)[0][1];

    count.handleMessage(['COUNT', likeSub, { count: 3 }]);     // relay A
    count.handleMessage(['COUNT', likeSub, { count: 0 }]);     // relay B lacks the data
    eq('annotate: disagreement recorded', cache.note7.approximate.likes, true);
    ok('annotate: tooltip explains the number', typeof nodes['metric-likes-note7'].title === 'string' &&
       nodes['metric-likes-note7'].title.length > 0);

    /* The marker does NOT clear when later replies happen to agree. One relay
       already showed it lacks part of the picture, so the highest number stays a
       lower bound for as long as we are merging several relays. */
    count.handleMessage(['COUNT', likeSub, { count: 3 }]);
    count.handleMessage(['COUNT', likeSub, { count: 3 }]);
    ok('annotate: marker persists after an earlier disagreement',
       typeof nodes['metric-likes-note7'].title === 'string');

    // a target whose relays always agree carries no marker at all
    count.requestMetrics('note8');
    await sleep(5);
    const likeSub8 = sockets[0].sent.filter(f => f[0] === 'COUNT' && f[2].kinds[0] === 7).pop()[1];
    count.handleMessage(['COUNT', likeSub8, { count: 4 }]);
    count.handleMessage(['COUNT', likeSub8, { count: 4 }]);
    eq('annotate: no tooltip when relays agree', nodes['metric-likes-note8'].title, undefined);

    delete globalThis.document;
    ok('annotate: safe when there is no DOM', (() => { try { count.annotate('note7'); return true; } catch (e) { return false; } })());
}

// ---------- 7. pages ----------
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// Pages that render metric counters.
const PAGES = ['index.html', 'thread.html', 'notes.html', 'notifications.html',
               'bookmark.html', 'relay.html', 'profile.html'];
const src = {};
for (const p of PAGES) src[p] = readFileSync(join(root, p), 'utf8');

const METRIC_PAGES = PAGES.filter(p => src[p].includes('requestMetrics'));

for (const p of METRIC_PAGES) {
    ok(`${p}: loads nostr-count.js`, src[p].includes('/assets/nostr-count.js'));
    ok(`${p}: versioned module reference`, /nostr-count\.js\?v=\d{8}[a-z]/.test(src[p]));
    ok(`${p}: forwards messages to the module`, src[p].includes('NostrCount.handleMessage('));
    ok(`${p}: initialises the module`, src[p].includes('NostrCount.init('));
    ok(`${p}: counts are requested through the module`, src[p].includes('NostrCount.requestMetrics('));
}

/* The old blanket REQ for every metric kind must be gone from the pages: it is
   exactly the query that downloaded 176 KB to produce four integers. */
let blanketReqs = 0;
for (const p of PAGES) {
    const hits = src[p].match(/"kinds":\s*\[1,\s*6,\s*7,\s*16,\s*9735\]/g) || [];
    blanketReqs += hits.length;
}
eq('pages: no blanket metrics REQ left', blanketReqs, 0);

/* Event-based tallies must check whether COUNT already owns the number. */
for (const p of METRIC_PAGES) {
    ok(`${p}: event tallies respect COUNT`, src[p].includes('NostrCount.isCountSourced('));
}

report();
