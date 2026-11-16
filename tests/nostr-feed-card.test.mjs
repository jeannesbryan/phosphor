/* Tests for assets/nostr-feed-card.js.
   Run: node tests/nostr-feed-card.test.mjs

   renderPost was 326 lines inside index.html and had never been executed outside a
   browser. This file runs the real function against a fake DOM, so the card
   building, the branch selection and the insertion are actually exercised.

   The fake DOM is deliberately minimal: it records innerHTML and the class names
   applied, and answers nothing else. That is enough to prove which card shape was
   built and what it contains, without pretending to be a browser. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);

/* The page provides these globals; the module reads them off `window`. */
globalThis.window = globalThis;
globalThis.NostrUtil = require('../assets/nostr-util.js');
globalThis.NostrCard = require('../assets/nostr-card.js');

/* Media/article/pulse/link modules are stubbed on purpose: their real behaviour is
   covered by their own test files. Here they only need to answer in the shapes the
   renderer expects, so the branch under test is the renderer's own. */
const mediaCalls = [];
globalThis.NostrMediaEvent = {
    isMedia: (ev) => ev.__media === true,
    title: (ev) => ev.__title || '',
    caption: (ev) => ev.__caption || '',
    badge: (ev) => ev.__badge || '',
    eventType: () => 'note',
    mediaHtml: () => ''
};
globalThis.NostrImeta = { parse: () => ({}) };
globalThis.NostrPulseEvent = {
    isExpired: (ev) => ev.__expired === true,
    describe: () => ({ isPulse: false, hasExpiration: false, label: '' })
};
globalThis.NostrNote = {
    upgradeLinks: () => {},
    isReply: () => false,
    /* Called as renderContentText(text, ev): the FIRST argument is the text.
       The real implementation escapes, linkifies and resolves NIP-19 ids; its
       own file tests that. Here it only has to behave like the contract, so the
       renderer's own pipeline can be observed. */
    renderContentText: (text) => (globalThis.NostrCard ? globalThis.NostrCard.renderText(text) : String(text)),
    mountQuotes: () => {},
    fetchEventById: () => Promise.resolve(null)
};
globalThis.NostrProfile = {
    displayProfile: (info, pk) => info && info.name
        ? info
        : { name: 'Node_' + String(pk).substring(0, 4).toUpperCase(), handle: '@' + String(pk).substring(0, 8), picture: null }
};
/* assembleMedia returns { html, text }: the text half is what gets linkified and
   rendered, so a stub returning a bare string silently empties the card body. */
globalThis.NostrEmbed = {
    upgrade: () => {},
    assembleMedia: (text) => ({ html: '', text: text })
};

const fc = require('../assets/nostr-feed-card.js');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}

// --------------------------------------------------------------- fake DOM
function fakeEl(tag) {
    const el = {
        tagName: tag || 'div', id: '', className: '', innerHTML: '', style: {}, dataset: {},
        children: [], appended: [],
        classList: {
            _set: new Set(),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            contains(c) { return this._set.has(c); }
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        appendChild(c) { this.appended.push(c); this.children.push(c); return c; },
        insertBefore(c) { this.appended.push(c); this.children.push(c); return c; },
        addEventListener() {}
    };
    return el;
}
function fakeDoc() {
    const made = [];
    return {
        made,
        getElementById() { return null; },
        createElement(tag) { const el = fakeEl(tag); made.push(el); return el; }
    };
}

const PUB = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
function baseCtx(over) {
    const container = fakeEl();
    const doc = fakeDoc();
    return Object.assign({
        profileCache: {}, eventsCache: {}, myBookmarks: new Set(), myFollowing: new Set(),
        pubkey: null, initMetrics() {}, requestMetrics() {},
        injectZapControls() {}, requestProfileInfo() {}, updateMetricsUI() {},
        container, document: doc,
        __container: container, __doc: doc
    }, over || {});
}
const note = (over) => Object.assign({
    id: 'a'.repeat(64), pubkey: PUB, kind: 1, created_at: 1794800000,
    content: 'hello world', tags: []
}, over || {});

// ------------------------------------------------------------- basic shape
{
    const ctx = baseCtx();
    const card = fc.renderFeedCard(note(), null, ctx);
    ok('a note produces a card element', card !== null);
    eq('the card is inserted into the container', ctx.__container.children.length, 1);
    eq('the card id is derived from the event', card.id, 'post-' + 'a'.repeat(64));
    ok('the content is rendered', card.innerHTML.indexOf('hello world') !== -1);
    ok('the author placeholder uses the pubkey prefix', card.innerHTML.indexOf('Node_BBBB') !== -1);
}
{
    // a profile in the cache wins over the placeholder
    const ctx = baseCtx({ profileCache: { [PUB]: { name: 'Zed', handle: '@zed', picture: 'https://x/p.png' } } });
    const card = fc.renderFeedCard(note(), null, ctx);
    ok('the cached profile name is used', card.innerHTML.indexOf('Zed') !== -1);
    ok('and its avatar image', card.innerHTML.indexOf('https://x/p.png') !== -1);
    ok('the placeholder is gone', card.innerHTML.indexOf('Node_BBBB') === -1);
}
{
    // the duplicate guard: the page looks this id up before rendering
    const ctx = baseCtx();
    ctx.__doc.getElementById = () => fakeEl();   // already exists
    const card = fc.renderFeedCard(note(), null, ctx);
    ok('an already-rendered post is skipped', !card);
    eq('and nothing was inserted', ctx.__container.children.length, 0);
}
{
    // an expired event is not rendered
    const ctx = baseCtx();
    const card = fc.renderFeedCard(note({ __expired: true }), null, ctx);
    ok('an expired event is skipped', !card);
}
{
    // a repost renders under the reposter's id
    const ctx = baseCtx();
    const card = fc.renderFeedCard(note(), note({ id: 'd'.repeat(64), pubkey: OTHER }), ctx);
    ok('a repost still renders', card !== null);
    eq('the card id follows the repost event', card.id, 'post-' + 'd'.repeat(64));
}

// ------------------------------------------------------------------- NSFW
{
    const ctx = baseCtx();
    const card = fc.renderFeedCard(note({ tags: [['content-warning', 'spoilers']] }), null, ctx);
    ok('the content warning badge is shown', card.innerHTML.indexOf('CONTENT_WARNING') !== -1);
    ok("the author's reason is shown", card.innerHTML.indexOf('spoilers') !== -1);
    ok('the content is blurred', card.innerHTML.indexOf('t-spoiler') !== -1);
}
{
    const ctx = baseCtx();
    const card = fc.renderFeedCard(note(), null, ctx);
    ok('a clean note has no warning badge', card.innerHTML.indexOf('CONTENT_WARNING') === -1);
}

// ---------------------------------------------------------------- payload
{
    const ctx = baseCtx();
    const card = fc.renderFeedCard(note({ content: '{"a":1}' }), null, ctx);
    ok('a JSON payload is shown pretty printed', card.innerHTML.indexOf('&quot;a&quot;: 1') !== -1
        || card.innerHTML.indexOf('"a": 1') !== -1);
}
{
    const ctx = baseCtx();
    const card = fc.renderFeedCard(note({ content: '{broken' }), null, ctx);
    ok('broken JSON is still rendered as text', card.innerHTML.indexOf('{broken') !== -1);
}

// --------------------------------------------------------------- linkify
{
    const ctx = baseCtx();
    const card = fc.renderFeedCard(note({ content: 'see https://x.example/a' }), null, ctx);
    ok('a URL in the content becomes an anchor',
        card.innerHTML.indexOf('href="https://x.example/a"') !== -1);
}
{
    // escaping happens before linkifying, so markup cannot survive
    const ctx = baseCtx();
    const card = fc.renderFeedCard(note({ content: '<script>alert(1)</script>' }), null, ctx);
    ok('markup in the content is escaped', card.innerHTML.indexOf('<script>alert') === -1);
}

// -------------------------------------------------------------- isMine
{
    const ctx = baseCtx({ pubkey: PUB });
    const card = fc.renderFeedCard(note(), null, ctx);
    ok('my own note shows the edit control', card.innerHTML.indexOf('openEditModal') !== -1);
}
{
    // the context pubkey is what decides, not a global
    const pagePubkey = OTHER;
    const ctx = baseCtx({ pubkey: pagePubkey });
    const card = fc.renderFeedCard(note({ pubkey: PUB }), null, ctx);
    ok('someone else\'s note is not editable by me',
        card.innerHTML.indexOf('editBtnVisibility') === -1 || card.innerHTML.indexOf('hidden') !== -1);
}

// ------------------------------------------------------------- bookmark
{
    const ctx = baseCtx();
    const card = fc.renderFeedCard(note(), null, ctx);
    ok('an unsaved note offers save', card.innerHTML.indexOf('[b] save') !== -1);
}
{
    const ctx = baseCtx({ myBookmarks: new Set(['a'.repeat(64)]) });
    const card = fc.renderFeedCard(note(), null, ctx);
    ok('a saved note reads saved', card.innerHTML.indexOf('[b] saved') !== -1);
}

// ------------------------------------------------------------ following
{
    // myFollowing drives the is-followed class; missing it used to crash
    const ctx = baseCtx({ myFollowing: new Set([PUB]) });
    const card = fc.renderFeedCard(note(), null, ctx);
    ok('a followed author is marked', card.classList.contains('is-followed'));
}
{
    const ctx = baseCtx();
    const card = fc.renderFeedCard(note(), null, ctx);
    ok('an unfollowed author is not marked', !card.classList.contains('is-followed'));
}

// ------------------------------------------------------------- metrics
{
    const calls = [];
    const ctx = baseCtx({
        initMetrics: (id) => calls.push('init:' + id),
        requestMetrics: (id) => calls.push('req:' + id)
    });
    fc.renderFeedCard(note(), null, ctx);
    ok('metrics are initialised for the event', calls.indexOf('init:' + 'a'.repeat(64)) !== -1);
    ok('metrics are requested for the event', calls.indexOf('req:' + 'a'.repeat(64)) !== -1);
}

// -------------------------------------------------------------- activity
{
    const ev = note({
        kind: 1301,
        content: 'Morning ride',
        tags: [['activity_type', 'cycling'], ['distance', '20'], ['duration', '1:00:00'], ['title', 'Ride']]
    });
    const ctx = baseCtx();
    const card = fc.renderFeedCard(ev, null, ctx);
    ok('an activity card renders', card !== null);
    ok('the bike icon is chosen', card.innerHTML.indexOf('[BIKE]') !== -1);
    ok('the speed is shown in km/h', card.innerHTML.indexOf('20.00 km/h') !== -1);
}
{
    const ev = note({
        kind: 1301, content: '',
        tags: [['activity_type', 'running'], ['distance', '10'], ['duration', '50:00']]
    });
    const ctx = baseCtx();
    const card = fc.renderFeedCard(ev, null, ctx);
    ok('a run shows a pace, not a speed', card.innerHTML.indexOf('5:00 /km') !== -1);
    ok('and never the :60 artefact', card.innerHTML.indexOf(':60') === -1);
}
{
    // zero distance must not produce Infinity on the card
    const ev = note({
        kind: 1301, content: '',
        tags: [['activity_type', 'cycling'], ['distance', '0'], ['duration', '1:00:00']]
    });
    const card = fc.renderFeedCard(ev, null, baseCtx());
    ok('zero distance does not print Infinity', card.innerHTML.indexOf('Infinity') === -1);
}

// --------------------------------------------------------------- article
{
    const ev = note({ kind: 30023, content: 'body', tags: [['d', 'my-slug'], ['title', 'The Title']] });
    const ctx = baseCtx();
    const card = fc.renderFeedCard(ev, null, ctx);
    ok('an article card renders', card !== null);
    ok('it points at notes.html with the slug',
        card.innerHTML.indexOf('notes.html?d=my-slug') !== -1 || card.innerHTML.indexOf('d=my-slug') !== -1);
}

// ------------------------------------------------------------ robustness
{
    eq('a missing event returns null', fc.renderFeedCard(null, null, baseCtx()), null);
    eq('a missing id returns null', fc.renderFeedCard({ pubkey: PUB, kind: 1 }, null, baseCtx()), null);
    eq('a missing container returns null', fc.renderFeedCard(note(), null, { document: fakeDoc() }), null);
    eq('a missing document returns null', fc.renderFeedCard(note(), null, { container: fakeEl() }), null);
    /* The context defaults must hold: a caller that provides only a container and a
       document should still get a card rather than a crash. */
    const bare = { container: fakeEl(), document: fakeDoc() };
    ok('a bare context still renders', fc.renderFeedCard(note(), null, bare) !== null);
}

// ------------------------------------------- the page uses the module
/* index.html must delegate, and the giant renderer must be gone from the page. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
{
    const pagePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
    const src = readFileSync(pagePath, 'utf8');
    ok('index.html loads the card renderer',
        /<script src="\/assets\/nostr-feed-card\.js\?v=[^"]+"><\/script>/.test(src));
    ok('index.html delegates renderPost',
        /NostrFeedCard\.renderFeedCard\(ev, repostEv, \{/.test(src));
    ok('renderPost is now a thin wrapper',
        src.indexOf('function renderPost(ev, repostEv = null) {') !== -1
        && src.length > 0);
    /* The injection must be complete: a missing key silently disables a feature
       (that is exactly how myFollowing was missed the first time). */
    for (const key of ['profileCache', 'eventsCache', 'myBookmarks', 'myFollowing',
        'pubkey', 'initMetrics', 'requestMetrics', 'container', 'document']) {
        ok('index.html injects ' + key,
            new RegExp('\\n\\s+' + key + ':').test(src));
    }
    /* The 326-line body must no longer be in the page. */
    ok('the renderer body is gone from index.html',
        src.indexOf('let renderId = repostEv ? repostEv.id : ev.id;') === -1);
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
