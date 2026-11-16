/* Tests for assets/nostr-draft.js (NIP-37 + local autosave).
   Run: node tests/nostr-draft.test.mjs
   No browser: storage and the clock are fakes. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const draft = require('../assets/nostr-draft.js');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}
function fakeStorage() {
    const map = new Map();
    let throwOnSet = false;
    return {
        setItem(k, v) { if (throwOnSet) throw new Error('QuotaExceededError'); map.set(k, v); },
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        removeItem(k) { map.delete(k); },
        __setThrow(v) { throwOnSet = v; },
        __size() { return map.size; }
    };
}

// -------------------------------------------------------- buildDraftEvent
{
    const ev = draft.buildDraftEvent({ title: 'T', content: 'body' }, { id: 'abc', now: 1700000000 });
    eq('kind is 31234', ev.kind, 31234);
    eq('created_at uses the injected clock', ev.created_at, 1700000000);
    eq('the d tag carries the id', ev.tags[0], ['d', 'abc']);
    eq('the k tag records the target kind', ev.tags[1], ['k', '30023']);
    eq('exactly two tags', ev.tags.length, 2);
    const parsedContent = JSON.parse(ev.content);
    eq('content is the JSON payload', parsedContent.title, 'T');
}
{
    const ev = draft.buildDraftEvent({}, { id: 'x', targetKind: 1, now: 1 });
    eq('a custom target kind is honoured', ev.tags[1], ['k', '1']);
    const p = JSON.parse(ev.content);
    eq('every field is present even when empty', Object.keys(p).sort(),
        ['content', 'cover', 'slug', 'summary', 'tags', 'title']);
    eq('and empty means empty string', p.title, '');
}
{
    const a = draft.buildDraftEvent({}, {});
    const b = draft.buildDraftEvent({}, {});
    ok('generated ids are unique', a.tags[0][1] !== b.tags[0][1]);
    ok('a generated id is not empty', a.tags[0][1].length > 5);
}
eq('an explicit id is reused (one draft, not a pile)',
    draft.buildDraftEvent({}, { id: 'stable' }).tags[0][1], 'stable');

// ------------------------------------------------------------- parseDraft
{
    const ev = draft.buildDraftEvent({ title: 'Hello', slug: 's', cover: 'c', tags: 'a,b', summary: 'sum', content: 'body' }, { id: 'd1', now: 42 });
    const back = draft.parseDraft(ev);
    eq('the title survives a round trip', back.title, 'Hello');
    eq('the slug survives', back.slug, 's');
    eq('the cover survives', back.cover, 'c');
    eq('the tags survive', back.tags, 'a,b');
    eq('the summary survives', back.summary, 'sum');
    eq('the content survives', back.content, 'body');
    eq('the id comes from the d tag', back.id, 'd1');
    eq('created_at is kept', back.created_at, 42);
}
eq('a non-draft kind is refused', draft.parseDraft({ kind: 1, tags: [['d', 'x']], content: '{}' }), null);
eq('a draft with no d tag is refused', draft.parseDraft({ kind: 31234, tags: [], content: '{}' }), null);
eq('a draft with broken content is refused', draft.parseDraft({ kind: 31234, tags: [['d', 'x']], content: 'not json' }), null);
eq('a draft whose content is null is refused', draft.parseDraft({ kind: 31234, tags: [['d', 'x']], content: 'null' }), null);
eq('null is refused', draft.parseDraft(null), null);
{
    const withExtra = { kind: 31234, tags: [['k', '30023'], ['d', 'z']], content: '{"title":"t"}' };
    eq('the d tag is found even when it is not first', draft.dTagOf(withExtra), 'z');
}

// ------------------------------------------------------ local autosave
const FIELDS = { title: 'My article', content: 'a long body', slug: 'x', cover: '', tags: 'a', summary: '' };
{
    const st = fakeStorage();
    eq('saving succeeds', draft.saveLocal(st, 'pk1', FIELDS, 1000).ok, true);
    const back = draft.loadLocal(st, 'pk1');
    eq('the title comes back', back.fields.title, 'My article');
    eq('the body comes back', back.fields.content, 'a long body');
    eq('the saved time is kept', back.savedAt, 1000);
}
{
    const st = fakeStorage();
    draft.saveLocal(st, 'pk1', { title: 'A' }, 1);
    draft.saveLocal(st, 'pk2', { title: 'B' }, 2);
    eq('two identities do not overwrite each other', draft.loadLocal(st, 'pk1').fields.title, 'A');
    eq('and the second is separate', draft.loadLocal(st, 'pk2').fields.title, 'B');
}
{
    const st = fakeStorage();
    draft.saveLocal(st, null, { title: 'anon' }, 1);
    eq('an anonymous draft is still saved', draft.loadLocal(st, null).fields.title, 'anon');
}
{
    // an empty draft must not wipe a good one
    const st = fakeStorage();
    draft.saveLocal(st, 'pk', FIELDS, 1);
    const r = draft.saveLocal(st, 'pk', { title: '', content: '' }, 2);
    eq('an empty save is refused', r.reason, 'empty');
    eq('and the previous draft is intact', draft.loadLocal(st, 'pk').fields.title, 'My article');
}
{
    // storage that throws must be reported, not swallowed
    const st = fakeStorage();
    st.__setThrow(true);
    const r = draft.saveLocal(st, 'pk', FIELDS, 1);
    eq('a failing storage is reported', r.ok, false);
    eq('with a reason the page can show', r.reason, 'write-failed');
}
eq('no storage is reported', draft.saveLocal(null, 'pk', FIELDS, 1).reason, 'no-storage');
eq('loading with no storage is null', draft.loadLocal(null, 'pk'), null);
{
    const st = fakeStorage();
    st.setItem('phosphor_draft_v1:pk', 'not json');
    eq('corrupt stored data is ignored, not thrown', draft.loadLocal(st, 'pk'), null);
}
{
    const st = fakeStorage();
    draft.saveLocal(st, 'pk', FIELDS, 1);
    eq('clearing works', draft.clearLocal(st, 'pk'), true);
    eq('and the draft is gone', draft.loadLocal(st, 'pk'), null);
}
eq('hasContent is false for whitespace only', draft.hasContent({ title: '   ', content: '\n' }), false);
eq('hasContent is true when only the body is filled', draft.hasContent({ content: 'x' }), true);

// --------------------------------------------------------- createDebouncer
{
    const timers = [];
    const calls = [];
    const d = draft.createDebouncer((v) => calls.push(v), 500, {
        schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
        cancel: () => {}
    });
    d.trigger('a'); d.trigger('b'); d.trigger('c');
    eq('typing does not save immediately', calls.length, 0);
    eq('and is reported as pending', d.isPending(), true);
    timers[timers.length - 1].fn();
    eq('one save happens', calls.length, 1);
    eq('with the LAST value, not the first', calls[0], 'c');
    eq('and nothing is pending after it fires', d.isPending(), false);
}
{
    const timers = [];
    const calls = [];
    const d = draft.createDebouncer((v) => calls.push(v), 500, {
        schedule: (fn) => { timers.push(fn); return timers.length - 1; },
        cancel: () => {}
    });
    d.trigger('x');
    eq('flush saves what is pending', d.flush(), true);
    eq('with the pending value', calls[0], 'x');
    eq('flushing twice does nothing the second time', d.flush(), false);
}
{
    const d = draft.createDebouncer(() => { throw new Error('should not run'); }, 500, {
        schedule: () => 1, cancel: () => {}
    });
    d.trigger('a');
    d.cancel();
    eq('cancel drops the pending save', d.isPending(), false);
}

{
    /* A real timer id can be 0 or -1; treating it as "nothing pending" would drop
       the save silently. This is exactly what the first version of the module did
       until this test caught it. */
    const d0 = draft.createDebouncer(() => {}, 500, { schedule: () => 0, cancel: () => {} });
    d0.trigger('a');
    eq('a handle of 0 still counts as pending', d0.isPending(), true);
    eq('and flush works with a 0 handle', d0.flush(), true);
    const dm = draft.createDebouncer(() => {}, 500, { schedule: () => -1, cancel: () => {} });
    dm.trigger('a');
    eq('a negative handle still counts as pending', dm.isPending(), true);
}

// -------------------------------------------------- compose.html is wired
/* A module nobody calls saves nothing. The page must load it, restore into an
   empty form only, autosave on input, flush on unload, and clear after publish. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
{
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'compose.html'), 'utf8');
    ok('compose loads the draft module', /<script src="\/assets\/nostr-draft\.js\?v=[^"]+"><\/script>/.test(src));
    ok('compose has a visible autosave status line', /id="draftStatus"/.test(src));
    ok('compose autosaves on input', /addEventListener\('input', function \(\) \{ draftSaver\.trigger\(\); \}\)/.test(src));
    ok('compose flushes the pending save before unload', /addEventListener\('beforeunload', function \(\) \{ draftSaver\.flush\(\); \}\)/.test(src));
    ok('compose only restores into an empty form',
        /formIsEmpty[\s\S]{0,120}writeDraftFields\(saved\.fields\)/.test(src));
    ok('compose never claims success when the save failed',
        /AUTOSAVE FAILED/.test(src));
    ok('compose clears the draft after a successful publish',
        /NostrDraft\.clearLocal\(localStorage, currentUserPubkey\)/.test(src));
    /* The six fields the autosave covers. */
    ok('all six article fields are covered',
        (src.match(/articleTitle|articleSlug|articleCover|articleTags|articleSummary|articleContent/g) || []).length >= 6);
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
