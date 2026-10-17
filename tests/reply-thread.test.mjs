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

/* ---------------------------------------------------------------------------
   Regression guard: every function a page CALLS must exist in that page.

   Why this exists: during the 2026-10-11 English sweep a helper was renamed
   pasangCatatanTambahan -> attachNoteExtras. The definition and one call site
   were renamed; a second call site at the bottom of renderReply was missed. A
   single undefined reference there throws on every reply, so thread.html
   silently rendered ZERO replies for six days. Nothing caught it because the
   scripts still parse — a ReferenceError only happens when the line runs.

   The check is deliberately shallow: collect `function NAME(` definitions plus
   the shared-module and browser globals a page is allowed to use, then look for
   `NAME(` calls that are neither. It cannot prove correctness, but it does
   catch a stale identifier, which is the failure that actually happened.
   --------------------------------------------------------------------------- */
const PAGES = ['index.html', 'thread.html', 'notes.html', 'notifications.html',
               'bookmark.html', 'relay.html', 'profile.html', 'activity.html', 'compose.html'];

// Names provided by the shared modules loaded via <script src>.
const MODULE_GLOBALS = new Set([
    'NostrEmbed', 'NostrNote', 'NostrLike', 'NostrNip05', 'NostrRelayInfo',
    'NostrImeta', 'NostrMediaEvent', 'NostrCount', 'NostrComment',
    'BlossomAuth', 'FormUtils'
]);

// ECMAScript + DOM + common library calls that are not defined in the page.
const BUILTINS = new Set(`
    if for while switch catch function return typeof new delete void await
    Array Object String Number Boolean Math JSON Date Promise Set Map WeakMap
    RegExp Error TypeError RangeError parseInt parseFloat isNaN isFinite
    encodeURIComponent decodeURIComponent btoa atob setTimeout setInterval
    clearTimeout clearInterval requestAnimationFrame queueMicrotask fetch
    WebSocket Event CustomEvent URL URLSearchParams FormData Blob File FileReader
    Image Audio Notification alert confirm prompt localStorage sessionStorage
    document window console navigator location history crypto performance
    structuredClone reportError getComputedStyle matchMedia
    lit render css html markdown marked
`.trim().split(/\s+/));

const STALE_NAMES = ['pasangCatatanTambahan', 'balasanProfil', 'badgeVideo'];

for (const page of PAGES) {
    const html = readFileSync(join(root, page), 'utf8');

    // Names this page defines (function declarations and const/let/var arrows).
    const defined = new Set();
    for (const m of html.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
    for (const m of html.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) defined.add(m[1]);
    // Parameters, destructuring and catch bindings give plenty of local names;
    // rather than parse them, ignore any callee that also appears as a
    // declaration of any kind in the file.
    for (const m of html.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
        m[1].split(',').forEach(p => {
            const name = p.trim().split(/[=:\s]/)[0];
            if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
        });
    }

    /* Only calls in STATEMENT position (start of a line) are looked at. That
       is where the bug was — `pasangCatatanTambahan(card, ev);` on its own line
       — and it keeps prose inside comments and strings out of the report. */
    const missing = new Set();
    for (const m of html.matchAll(/(?:^|\n)[ \t]*([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = m[1];
        if (defined.has(name) || BUILTINS.has(name) || MODULE_GLOBALS.has(name)) continue;
        if (/^(if|for|while|switch|catch|function|return|typeof|new|delete|void|await|else)$/.test(name)) continue;
        missing.add(name);
    }

    // Known-stale names must never come back, whatever else the scan says.
    for (const stale of STALE_NAMES) {
        ok(`${page}: no stale identifier ${stale}`, !html.includes(stale));
    }

    /* Only assert on the stale-name check. A full "every call is defined"
       assertion would need a real parser; listing what the scan found keeps the
       information visible without pretending to be exhaustive. */
    if (missing.size) {
        console.log(`  note ${page}: calls not resolved by the shallow scan -> ${[...missing].join(', ')}`);
    }
}

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
