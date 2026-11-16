/* Tests for assets/nostr-util.js, and for the pages that now delegate to it.
   Run: node tests/nostr-util.test.mjs */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const util = require('../assets/nostr-util.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}

// --------------------------------------------------------------- escapeHtml
eq('angle brackets are escaped', util.escapeHtml('<b>'), '&lt;b&gt;');
eq('quotes are escaped', util.escapeHtml('a"b\'c'), 'a&quot;b&#39;c');
eq('ampersand first, so entities are not double escaped', util.escapeHtml('&lt;'), '&amp;lt;');
eq('a script tag cannot survive', util.escapeHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
eq('numbers become strings', util.escapeHtml(42), '42');
eq('null becomes empty', util.escapeHtml(null), '');
eq('undefined becomes empty', util.escapeHtml(undefined), '');
eq('plain text is untouched', util.escapeHtml('hello world'), 'hello world');

// ------------------------------------------------------------------ timeAgo
/* now is injected so these assertions never depend on the wall clock. */
const NOW = 1800000000;
eq('under a minute is Just now', util.timeAgo(NOW - 30, NOW), 'Just now');
eq('exactly now is Just now', util.timeAgo(NOW, NOW), 'Just now');
eq('one minute is singular', util.timeAgo(NOW - 60, NOW), '1 minute ago');
eq('two minutes is plural', util.timeAgo(NOW - 120, NOW), '2 minutes ago');
eq('one hour', util.timeAgo(NOW - 3600, NOW), '1 hour ago');
eq('three hours', util.timeAgo(NOW - 3 * 3600, NOW), '3 hours ago');
eq('one day', util.timeAgo(NOW - 86400, NOW), '1 day ago');
eq('two days', util.timeAgo(NOW - 2 * 86400, NOW), '2 days ago');
eq('one month', util.timeAgo(NOW - 2592000, NOW), '1 month ago');
eq('a year', util.timeAgo(NOW - 31536000, NOW), '1 year ago');
/* Clock skew: a relay timestamp slightly in the future must not read
   "in -3 seconds" or "-1 minutes ago". */
eq('a future timestamp reads as Just now', util.timeAgo(NOW + 30, NOW), 'Just now');
eq('a non-numeric timestamp does not throw', util.timeAgo('not a number', NOW), 'Just now');
ok('a live call without now still works', /ago|Just now/.test(util.timeAgo(Math.floor(Date.now() / 1000) - 7200)));

// ------------------------------------------------------------------ shortHex
eq('shortens to eight by default', util.shortHex('3bf0c63fcb934634'), '3bf0c63f');
eq('shortens to a custom length', util.shortHex('3bf0c63f', 4), '3bf0');
eq('shorter input is returned as-is', util.shortHex('ab', 8), 'ab');
eq('null is empty', util.shortHex(null), '');

// ------------------------------------------------------- pages delegate
/* The point of the extraction is that no page keeps its own copy of the rules.
   If a page regains a full implementation, these fail. */
const PAGES = ['index.html', 'profile.html', 'thread.html', 'notes.html',
    'bookmark.html', 'relay.html', 'notifications.html', 'activity.html', 'compose.html'];
for (const name of PAGES) {
    const src = readFileSync(join(root, name), 'utf8');
    ok(name + ': loads the util module', /<script src="\/assets\/nostr-util\.js\?v=[^"]+"><\/script>/.test(src));
    /* Delegation, not implementation: the page's escapeHtml must not contain the
       replacement chain itself. */
    ok(name + ': escapeHtml delegates instead of re-implementing',
        /function escapeHtml\(str\) \{ return window\.NostrUtil\.escapeHtml\(str\); \}/.test(src));
    ok(name + ': the escaping chain is gone from the page',
        !/\.replace\(\/&\/g, '&amp;'\)/.test(src));
}
for (const name of ['index.html', 'profile.html', 'thread.html', 'notes.html',
    'bookmark.html', 'relay.html', 'notifications.html']) {
    const src = readFileSync(join(root, name), 'utf8');
    ok(name + ': timeAgo delegates',
        /function timeAgo\(unixTimestamp\) \{ return window\.NostrUtil\.timeAgo\(unixTimestamp\); \}/.test(src));
    ok(name + ': the interval table is gone from the page',
        !/year: 31536000, month: 2592000/.test(src));
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
