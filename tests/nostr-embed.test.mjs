/* Tests for assets/nostr-embed.js — run: node tests/nostr-embed.test.mjs
   Pure (no browser, no network) for the URL rules, the player markup and the
   shared media assembler. Part 9 also inspects the REAL page files, because the
   whole point of assembleMedia() is that the rules are NOT copied into them. */
import embed from '../assets/nostr-embed.js';
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
    ok(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// ---------- 1. real URL from bos's note 29 Sep 2026 (kind 1, via Jumble) ----------
const REAL_URL = 'https://youtu.be/hop_rtjHI8g?si=ChcCBqqkIngFi-bH';
eq('bos real note: youtu.be + ?si= -> id', embed.youTubeId(REAL_URL), 'hop_rtjHI8g');

// ---------- 2. common YouTube URL shapes ----------
const shouldMatch = {
    'plain watch': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'watch without www': 'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'watch http': 'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'watch mobile (m.)': 'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'watch music': 'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'watch with extra parameters': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&feature=share',
    'watch with a parameter before v': 'https://www.youtube.com/watch?si=abc&v=dQw4w9WgXcQ',
    'shorts': 'https://www.youtube.com/shorts/abcdefghijk',
    'live': 'https://www.youtube.com/live/abcdefghijk?feature=share',
    'embed': 'https://www.youtube.com/embed/abcdefghijk',
    'nocookie embed': 'https://www.youtube-nocookie.com/embed/abcdefghijk',
    'youtu.be without parameters': 'https://youtu.be/abcdefghijk',
    'youtu.be with a timestamp': 'https://youtu.be/abcdefghijk?t=90'
};

for (const [label, url] of Object.entries(shouldMatch)) {
    const expected = url.includes('dQw4w9WgXcQ') ? 'dQw4w9WgXcQ' : 'abcdefghijk';
    eq(label, embed.youTubeId(url), expected);
}

// ---------- 3. punctuation swallowed by the link regex ----------
eq('inside parentheses', embed.youTubeId('(https://youtu.be/hop_rtjHI8g)'), 'hop_rtjHI8g');
eq('followed by a period and comma', embed.youTubeId('https://youtu.be/hop_rtjHI8g.,'), 'hop_rtjHI8g');
eq('followed by a quote mark', embed.youTubeId('https://youtu.be/hop_rtjHI8g"'), 'hop_rtjHI8g');
eq('&amp; from escapeHtml', embed.youTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=10s'), 'dQw4w9WgXcQ');

// ---------- 4. things that are NOT YouTube must stay plain links ----------
const shouldNotMatch = [
    'a blossom image from bos',
    'https://blossom.jeannesbryan.my.id/df00e25e7400d1cfcb49b8cb25ac8c07227885e3e3a0b2d6854eea3ffc2c70f4.png',
    'manually uploaded video (mp4)',
    'https://blossom.jeannesbryan.my.id/abc123.mp4',
    'another site', 'https://vimeo.com/123456789',
    'a look-alike domain', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'a malicious subdomain', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'id too short', 'https://youtu.be/abc',
    'id too long', 'https://youtu.be/abcdefghijkl',
    'watch without v', 'https://www.youtube.com/watch?list=PL123',
    'a strange scheme', 'javascript:alert(1)//youtu.be/abcdefghijk',
    'not a url', 'just plain words'
];
for (let i = 0; i < shouldNotMatch.length; i += 2) {
    eq('not a video: ' + shouldNotMatch[i], embed.youTubeId(shouldNotMatch[i + 1]), null);
}
eq('null', embed.youTubeId(null), null);
eq('empty string', embed.youTubeId(''), null);

// ---------- 5. player markup ----------
const html = embed.playerHtml('hop_rtjHI8g');
ok('carries data-yt-id', html.includes('data-yt-id="hop_rtjHI8g"'));
ok('maxresdefault thumbnail', html.includes('https://i.ytimg.com/vi/hop_rtjHI8g/maxresdefault.jpg'));
ok('hqdefault fallback is prepared', html.includes('data-yt-fallback="https://i.ytimg.com/vi/hop_rtjHI8g/hqdefault.jpg"'));
ok('thumbnail is lazily loaded', html.includes('loading="lazy"'));
ok('no iframe before the click', !html.includes('<iframe'));
ok('no third-party script', !html.includes('<script'));
ok('has a play button', html.includes('yt-play'));
eq('invalid id rejected', embed.playerHtml('bukanid'), '');
eq('empty id rejected', embed.playerHtml(''), '');

// ---------- 6. parity with images & old video (must not change) ----------
ok('mp4 is still not youtube', embed.youTubeId('https://blossom.jeannesbryan.my.id/abc.webm') === null);

// ---------- 7. media assembler: what joins the grid, what stays full ----------
const imgA = { full: false, html: '<div class="t-media-item"><img src="a.png" alt="A"></div>' };
const imgB = { full: false, html: '<div class="t-media-item"><img src="b.png" alt="B"></div>' };
const ytA = { full: true, html: embed.playerHtml('hop_rtjHI8g') };
const ytB = { full: true, html: embed.playerHtml('dQw4w9WgXcQ') };

eq('empty list -> no markup', embed.buildMediaHtml([], 't-media-grid', 'mt-3'), '');
eq('null is safe', embed.buildMediaHtml(null, 't-media-grid', 'mt-3'), '');

let single = embed.buildMediaHtml([imgA], 't-media-grid', 'mt-3');
ok('one image: wrapped, not a grid', single.startsWith('<div class="mt-3">') && !single.includes('t-media-grid'));

let pair = embed.buildMediaHtml([imgA, imgB], 't-media-grid', 'mt-3');
ok('two images: packed into one grid', (pair.match(/t-media-grid/g) || []).length === 1);
ok('two images: both are inside the grid', pair.includes('a.png') && pair.includes('b.png'));

// Bos's case: image first, YouTube link after.
let imageThenVideo = embed.buildMediaHtml([imgA, ytA], 't-media-grid', 'mt-3');
ok('image then video: the grid comes first', imageThenVideo.indexOf('t-media-grid') < imageThenVideo.indexOf('yt-embed'));
ok('the video does NOT join the grid', imageThenVideo.indexOf('yt-embed') > imageThenVideo.indexOf('</div><div class="mt-3">'));
ok('the video is wrapped in its own block', imageThenVideo.includes('<div class="mt-3"><div class="yt-embed"'));
ok('the grid here holds one image only (1 mt-3 wrapper)',
    (imageThenVideo.match(/<div class="mt-3">/g) || []).length === 2);

// The reverse: video first, image after. The order must stay as written — that
// is exactly why they are collected in one pass, not two.
let videoThenImage = embed.buildMediaHtml([ytA, imgA], 't-media-grid', 'mt-3');
ok('video then image: the video stays first', videoThenImage.indexOf('yt-embed') < videoThenImage.indexOf('a.png'));
ok('video then image: the image still shows', videoThenImage.includes('a.png'));

// Two videos in a row: both full blocks, no grid at all.
let twoVideos = embed.buildMediaHtml([ytA, ytB], 't-media-grid', 'mt-3');
ok('two videos: no grid', !twoVideos.includes('t-media-grid'));
ok('two videos: both are full blocks', (twoVideos.match(/<div class="mt-3">/g) || []).length === 2);

// An image on each side of a video. The two images must NOT be packed into one
// grid, because that would move the video from its position in the note. So the
// correct result: three blocks in a row, no grid at all.
let interleaved = embed.buildMediaHtml([imgA, ytA, imgB], 't-media-grid', 'mt-3');
eq('image-video-image: no grid (the two images must not be merged)',
    (interleaved.match(/t-media-grid/g) || []).length, 0);
eq('image-video-image: three blocks in a row', (interleaved.match(/<div class="mt-3">/g) || []).length, 3);
ok('image-video-image: the video stays between the two images',
    interleaved.indexOf('a.png') < interleaved.indexOf('yt-embed') && interleaved.indexOf('yt-embed') < interleaved.indexOf('b.png'));

ok('the grid class can be overridden by the caller', embed.buildMediaHtml([imgA, imgB], 'grid-x', 'w-1').includes('class="grid-x"'));
ok('the wrapper class can be overridden by the caller', embed.buildMediaHtml([ytA], 'grid-x', 'w-1').includes('<div class="w-1">'));
ok('the default class name stays the default', embed.buildMediaHtml([imgA, imgB]).includes('class="media-grid"'));

// ---------- 8. extraAttrs: used by the index for NSFW spoilers ----------
// The attribute must sit on the SAME element as its class, not on a new
// wrapper — otherwise the t-spoiler check inside the image will not find it.
const ATTR = 'onclick="this.classList.remove(\'t-spoiler\');"';
let spoiler1 = embed.buildMediaHtml([imgA], 't-media-grid t-spoiler', 't-spoiler', ATTR);
ok('extraAttrs lands on the single wrapper', spoiler1.includes('<div class="t-spoiler" ' + ATTR + '>'));
let spoiler2 = embed.buildMediaHtml([imgA, imgB], 't-media-grid t-spoiler', 't-spoiler', ATTR);
ok('extraAttrs lands on the grid', spoiler2.includes('<div class="t-media-grid t-spoiler" ' + ATTR + '>'));
let spoiler3 = embed.buildMediaHtml([ytA], 't-media-grid t-spoiler', 't-spoiler', ATTR);
ok('extraAttrs lands on the full-width video block', spoiler3.includes('<div class="t-spoiler" ' + ATTR + '>'));
ok('without extraAttrs there is no stray attribute', !embed.buildMediaHtml([imgA], 'g', 'w').includes('onclick'));
ok('an empty extraAttrs is safe', embed.buildMediaHtml([imgA], 'g', 'w', '').includes('<div class="w">'));

// ---------- 9. assembleMedia: one rule, used by ten places ----------
// Bos approved unifying the ten copies (2026-10-11). Before this, the same
// classifier was pasted into seven pages and had already drifted: three
// different "video not supported" texts, and one page used a different alt.
const asm = embed.assembleMedia;

console.log('\n--- 9. shared assembler ---');
let r = asm('see https://a.example/x.png and https://youtu.be/hop_rtjHI8g end', {});
ok('an image becomes a block', r.html.includes('t-media-item') && r.html.includes('https://a.example/x.png'));
ok('the YouTube link becomes a player', r.html.includes('yt-embed'));
ok('the media URLs are removed from the text', !r.text.includes('a.example/x.png') && !r.text.includes('youtu.be'));
ok('the words around them stay', r.text.includes('see') && r.text.includes('end'));

// Order: a video before an image must stay before it (single pass, not two).
r = asm('https://youtu.be/hop_rtjHI8g then https://a.example/x.png', {});
ok('a video before an image stays before it', r.html.indexOf('yt-embed') < r.html.indexOf('x.png'));

// Options must reach the layout.
r = asm('https://a.example/x.png', { wrap: 'mt-9', grid: 'my-grid' });
ok('the wrap option is honoured', r.html.includes('<div class="mt-9">'), r.html);
r = asm('https://a.example/x.png and https://b.example/y.png', { grid: 'my-grid' });
ok('the grid option is honoured', r.html.includes('class="my-grid"'), r.html);
r = asm('https://a.example/x.png', { imgAlt: 'Pulse Media' });
ok('the imgAlt option is honoured', r.html.includes('alt="Pulse Media"'));
r = asm('https://a.example/x.png', { imgGuard: 'GUARD;' });
ok('the imgGuard option is honoured', r.html.includes('onclick="GUARD;openLightbox('));
r = asm('https://a.example/x.png', { extraAttrs: 'data-x="1"' });
ok('the extraAttrs option is honoured', r.html.includes('data-x="1"'));
eq('the default video fallback is stable', embed.videoFallback, 'Video format not supported.');
r = asm('https://a.example/v.mp4', {});
ok('a video file becomes a <video> block', r.html.includes('<video controls') && r.html.includes('a.example/v.mp4'));
eq('a video URL is removed from the text', r.text.trim(), '');

// Safety: a URL that could break out of an HTML attribute is NOT embedded.
const attacks = [
    'https://x.example/"><img src=y>.png',
    'https://x.example/a"b.png',
    "https://x.example/a'b.png",
    'https://x.example/a<b>.png'
];
for (const bad of attacks) {
    const out = asm('q ' + bad + ' z', {});
    ok('a URL that is unsafe for HTML is not embedded: ' + bad.slice(0, 26),
        !out.html.includes('<img') && !out.html.includes("openLightbox('"), out.html);
}
eq('nothing is lost when a URL is rejected', asm('q https://x.example/a"b.png z', {}).text, 'q https://x.example/a"b.png z');
eq('empty content is safe', asm('', {}).html, '');
eq('null content is safe', asm(null, {}).html, '');
eq('a plain sentence yields no media', asm('just words', { html: 1 }).html, '');

console.log('\n--- 10. the ten copies are gone ---');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'profile.html', 'thread.html', 'notes.html',
               'notifications.html', 'bookmark.html', 'relay.html'];
let calls = 0;
for (const p of PAGES) {
    const html = readFileSync(join(root, p), 'utf8');
    ok(`${p}: calls the shared assembler`, html.includes('assembleMedia('));
    ok(`${p}: no inline media classifier (mediaElements.push)`, !html.includes('mediaElements.push'),
        'the classifier was copied back into this page');
    ok(`${p}: no inline buildMediaHtml call`, !html.includes('buildMediaHtml(mediaElements'));
    ok(`${p}: does not call youTubeId directly`, !html.includes('youTubeId(url)'));
    calls += (html.match(/assembleMedia\(/g) || []).length;
}
eq('ten media sites use the one shared assembler', calls, 10);

/* Every option a page passes must be a literal or a variable that really exists
   in that page. This catches a real slip made while unifying: index.html used
   spoilerAttrs, whose declaration had lived inside the block that was deleted —
   the page parsed fine but threw at runtime for any note with media. */
for (const p of PAGES) {
    const html = readFileSync(join(root, p), 'utf8');
    // Each call is written on one line (profile, thread and bookmark have two:
    // a pulse branch and a normal branch).
    const calls = html.split('\n').filter((l) => l.includes('assembleMedia(contentText,'));
    ok(`${p}: has at least one assembler call on a single line`, calls.length >= 1);
    const bad = [];
    for (const line of calls) {
        // Take the options object: from its "{" to the last "}" on the line. Doing
        // it this way (instead of a regex up to the first "}") matters, because an
        // option value can itself contain a brace — grid: `t-media-grid ${blurClass}`.
        const body = line.slice(line.indexOf('{', line.indexOf('assembleMedia(contentText,')) + 1,
                                line.lastIndexOf('}'));
        // Capture the whole dotted chain and skip property access: `imeta:
        // window.NostrImeta` names a global, not a page-local variable, so
        // there is nothing to declare. (A lookahead is not enough here: the
        // regex backtracks `window` down to `windo` and slips through.)
        for (const m of body.matchAll(/(\w+)\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)) {
            const name = m[2];
            if (name.includes('.')) continue;
            if (['true', 'false', 'null', 'undefined', 'window', 'document'].includes(name)) continue;
            const declared = new RegExp('(?:let|const|var|function)\\s+' + name + '\\b').test(html);
            if (!declared) bad.push(m[1] + ' -> ' + name);
        }
    }
    ok(`${p}: every option identifier is declared in the page`,
        bad.length === 0, 'undeclared: ' + bad.join(', '));
}
// The rules must live in the module, and only there.
const mod = readFileSync(join(root, 'assets', 'nostr-embed.js'), 'utf8');
ok('the module defines assembleMedia', /function assembleMedia\(/.test(mod));
ok('the module builds the file-media blocks', /t-media-item/.test(mod) && /t-video-item/.test(mod));

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
