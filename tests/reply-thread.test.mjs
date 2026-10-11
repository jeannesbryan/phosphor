/* Structural test for the reply button behaviour on thread.html and notes.html.
   Run: node tests/reply-thread.test.mjs
   Pure — no browser, no network.

   Rule under test:
   - The reply button on the MAIN post/article keeps focusing the inline
     composer (you are already on that note's page).
   - The reply button on a level-1 REPLY card must open that reply's own thread
     (thread.html?id=<reply>), because replies are shown one level deep only:
     the replies to a reply can only be read on that reply's own thread page.
*/
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond) {
    if (cond) { pass++; results.push('  ok   ' + name); }
    else { fail++; results.push('  FAIL ' + name); }
}

// The actions bar of the reply card carries "mt-3"; the main post uses "mt-4".
// Both markers are unique per page, so we can slice each bar and inspect it.
const MAIN_MARKER = 't-feed-actions d-flex flex-wrap gap-2 mt-4';
const REPLY_MARKER = 't-feed-actions d-flex flex-wrap gap-2 mt-3';
function bar(html, marker) {
    const i = html.indexOf(marker);
    return i === -1 ? '' : html.slice(i, i + 900);
}

const FOCUS = "document.getElementById('replyContentInput').focus()";

for (const page of ['thread.html', 'notes.html']) {
    const html = readFileSync(join(root, page), 'utf8');

    // --- main post / article: still focuses the composer -------------------
    const mainBar = bar(html, MAIN_MARKER);
    ok(`${page}: main post has an mt-4 actions bar`, mainBar !== '');
    ok(`${page}: main post reply focuses the composer`, mainBar.indexOf(FOCUS) !== -1);
    ok(`${page}: main post reply is NOT a navigation`, mainBar.indexOf('openReplyThread(') === -1);

    // --- reply card: opens the reply's own thread --------------------------
    const replyBar = bar(html, REPLY_MARKER);
    ok(`${page}: reply card has an mt-3 actions bar`, replyBar !== '');
    ok(`${page}: reply card button calls openReplyThread`,
        replyBar.indexOf("openReplyThread('${ev.id}')") !== -1);
    ok(`${page}: reply card button no longer steals focus`,
        replyBar.indexOf(FOCUS) === -1);
    ok(`${page}: reply card button is labelled "Open thread"`,
        replyBar.indexOf('title="Open thread"') !== -1);

    // --- the helper itself -------------------------------------------------
    ok(`${page}: openReplyThread defined exactly once`,
        (html.match(/function openReplyThread\s*\(/g) || []).length === 1);
    const fnIdx = html.indexOf('function openReplyThread');
    const fnBody = fnIdx === -1 ? '' : html.slice(fnIdx, fnIdx + 260);
    ok(`${page}: openReplyThread points at thread.html?id=`,
        fnBody.indexOf("'thread.html?id=' + id") !== -1);

    // --- only the main post keeps the focus call ---------------------------
    const focusCount = (html.match(/replyContentInput'\)\.focus\(\)/g) || []).length;
    ok(`${page}: exactly one focus() call on replyContentInput (the main post)`,
        focusCount === 1);
}

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
