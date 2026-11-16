/* Link preview metadata, and the image it points at.
   Run: node tests/og-image.test.mjs

   The bug this closes was visible on a real shared link: the card showed a title and
   a description with no picture, because og:image did not exist anywhere.
*/
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const out = [];
const ok = (n, c) => { if (c) { pass++; out.push('  ok   ' + n); } else { fail++; out.push('  FAIL ' + n); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w));

// ------------------------------------------------------- the image itself
const imgPath = join(root, 'og-image.png');
ok('og-image.png exists', existsSync(imgPath));
if (existsSync(imgPath)) {
    const size = statSync(imgPath).size;
    ok('the image is not empty', size > 5000);
    ok('the image is under the 5 MB limit platforms impose', size < 5 * 1024 * 1024);
    /* PNG header: width and height are big-endian at bytes 16..24. Read directly so
       this does not depend on any image library. */
    const buf = readFileSync(imgPath);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    eq('the image is the 1200x630 OG size', [w, h], [1200, 630]);
    ok('it is a PNG', buf.slice(1, 4).toString() === 'PNG');
}

// ------------------------------------------------------- the metadata
const SITE = 'https://phosphor-nostr.pages.dev';
const PAGES = ['index.html', 'profile.html', 'thread.html', 'notes.html', 'bookmark.html',
    'relay.html', 'notifications.html', 'compose.html', 'activity.html'];

for (const name of PAGES) {
    const src = readFileSync(join(root, name), 'utf8');
    ok(name + ': declares og:image', /<meta property="og:image" content="[^"]+">/.test(src));
    ok(name + ': declares og:title', /<meta property="og:title" content="[^"]+">/.test(src));
    ok(name + ': declares og:description', /<meta property="og:description" content="[^"]+">/.test(src));
    ok(name + ': asks for a large Twitter card', /twitter:card" content="summary_large_image"/.test(src));
    ok(name + ': declares twitter:image', /<meta name="twitter:image" content="[^"]+">/.test(src));
    /* A relative og:image is silently ignored by the crawlers, which is exactly the
       failure mode that produced a picture-less card. */
    const m = /<meta property="og:image" content="([^"]+)">/.exec(src);
    ok(name + ': og:image is an ABSOLUTE url', !!m && /^https?:\/\//.test(m[1]));
    ok(name + ': og:image points at the shipped file', !!m && m[1] === SITE + '/og-image.png');
    const wm = /<meta property="og:image:width" content="(\d+)">/.exec(src);
    const hm = /<meta property="og:image:height" content="(\d+)">/.exec(src);
    eq(name + ': the declared dimensions match the file', [wm && wm[1], hm && hm[1]], ['1200', '630']);
}
{
    const src = readFileSync(join(root, 'index.html'), 'utf8');
    ok('index.html declares og:url',
        new RegExp('<meta property="og:url" content="' + SITE + '/">').test(src));
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
