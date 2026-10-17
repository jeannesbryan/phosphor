/* Tests for assets/nostr-media-event.js — run: node tests/nostr-media-event.test.mjs
   Pure (no browser, no network).

   Most of these exist because the code this module replaced picked the LAST
   `url` it saw in the whole event. A NIP-71 video commonly lists several
   resolutions plus a separate audio track, so "last one wins" could hand an
   mp3 to a <video> element. Those cases are written out in full below. */
import media from '../assets/nostr-media-event.js';
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

const PK = 'a'.repeat(64);

// ---------- 1. kind classification ----------
ok('isPicture: kind 20', media.isPicture({ kind: 20 }));
ok('isPicture: kind 1 is not a picture', !media.isPicture({ kind: 1 }));
ok('isVideo: 21', media.isVideo({ kind: 21 }));
ok('isVideo: 22', media.isVideo({ kind: 22 }));
ok('isVideo: 34235 addressable', media.isVideo({ kind: 34235 }));
ok('isVideo: 34236 addressable short', media.isVideo({ kind: 34236 }));
ok('isVideo: 30023 article is not video', !media.isVideo({ kind: 30023 }));
ok('isAddressable: 34235', media.isAddressable({ kind: 34235 }));
ok('isAddressable: 34236', media.isAddressable({ kind: 34236 }));
ok('isAddressable: 21 is not addressable', !media.isAddressable({ kind: 21 }));
ok('isMedia: union', media.isMedia({ kind: 20 }) && media.isMedia({ kind: 22 }) && !media.isMedia({ kind: 1 }));
ok('badge: picture', media.badge({ kind: 20 }) === 'PICTURE');
ok('badge: video', media.badge({ kind: 21 }) === 'VIDEO');
ok('badge: short video regular', media.badge({ kind: 22 }) === 'SHORT_VIDEO');
ok('badge: short video addressable', media.badge({ kind: 34236 }) === 'SHORT_VIDEO');
eq('eventType: picture', media.eventType({ kind: 20 }), 'picture_event');
eq('eventType: video', media.eventType({ kind: 21 }), 'video_stream');
eq('eventType: short addressable', media.eventType({ kind: 34236 }), 'short_video');

// ---------- 2. kind 20 gallery ----------
const PIC = {
    kind: 20, pubkey: PK, created_at: 1,
    content: 'Tiga foto dari pantai',
    tags: [
        ['title', 'Pantai Bali'],
        ['imeta', 'url https://cdn.example/1.jpg', 'm image/jpeg',
         'dim 3024x4032', 'alt Ombak di sore hari',
         'fallback https://mirror.example/1.jpg'],
        ['imeta', 'url https://cdn.example/2.jpg', 'm image/png', 'alt Batu karang'],
        ['imeta', 'url https://cdn.example/3.webp', 'm image/webp', 'dim 800x600']
    ]
};

const pics = media.pictures(PIC);
eq('pictures: three images', pics.length, 3);
eq('pictures: order follows the tags', pics[0].url, 'https://cdn.example/1.jpg');
eq('pictures: alt kept', pics[0].alt, 'Ombak di sore hari');
eq('pictures: dim kept', pics[0].dim.w + 'x' + pics[0].dim.h, '3024x4032');
eq('pictures: fallback kept', pics[0].fallbacks[0], 'https://mirror.example/1.jpg');
eq('pictures: third from extension when m present', pics[2].url, 'https://cdn.example/3.webp');
eq('title: from tag', media.title(PIC), 'Pantai Bali');

const picHtml = media.pictureHtml(PIC, {});
eq('pictureHtml: three tiles', (picHtml.match(/t-media-item/g) || []).length, 3);
ok('pictureHtml: first image in the grid', picHtml.indexOf('src="https://cdn.example/1.jpg"') !== -1);
ok('pictureHtml: alt escaped into the attribute', picHtml.indexOf('alt="Ombak di sore hari"') !== -1);
ok('pictureHtml: wrapper class', picHtml.indexOf('t-media-grid') !== -1);

// A note whose images only live in content still shows them (not compliant,
// but real, and better than an empty card).
const contentOnly = media.pictureHtml(
    { kind: 20, content: 'https://cdn.example/solo.jpg', tags: [] },
    { contentFallback: () => 'FALLBACK' }
);
eq('pictureHtml: content fallback used', contentOnly, 'FALLBACK');
eq('pictureHtml: nothing at all -> empty string',
    media.pictureHtml({ kind: 20, content: 'no media here', tags: [] }, {}), '');

// ---------- 3. THE OLD BUG: variant ranking ----------
const MULTI = {
    kind: 21, pubkey: PK, created_at: 1, content: 'video',
    tags: [
        ['title', 'Demo'],
        ['imeta', 'url https://v.example/1080.mp4', 'm video/mp4', 'dim 1920x1080',
         'image https://v.example/1080.jpg', 'duration 29.2'],
        ['imeta', 'url https://v.example/720.mp4', 'm video/mp4', 'dim 1280x720',
         'image https://v.example/720.jpg'],
        ['imeta', 'url https://v.example/720.m3u8', 'm application/x-mpegURL', 'dim 1280x720'],
        // An audio track listed LAST is exactly what the old code would have
        // grabbed and then handed to <video>.
        ['imeta', 'url https://v.example/audio.mp3', 'm audio/mp3']
    ]
};

const chosen = media.video(MULTI);
eq('video: highest resolution wins', chosen.url, 'https://v.example/1080.mp4');
eq('video: mime declared', chosen.mime, 'video/mp4');
eq('video: poster from image', chosen.poster, 'https://v.example/1080.jpg');
eq('video: duration read', chosen.duration, 29.2);
ok('video: never picks the audio track', chosen.url.indexOf('.mp3') === -1);

// HLS is last resort: only Safari plays it natively.
const HLS_ONLY = {
    kind: 21, tags: [
        ['imeta', 'url https://v.example/a.m3u8', 'm application/x-mpegURL'],
        ['imeta', 'url https://v.example/b.mp4', 'm video/mp4']
    ]
};
eq('video: native mp4 beats HLS', media.video(HLS_ONLY).url, 'https://v.example/b.mp4');

const HLS_ALONE = { kind: 21, tags: [['imeta', 'url https://v.example/a.m3u8', 'm application/x-mpegURL']] };
eq('video: HLS used when it is all there is', media.video(HLS_ALONE).url, 'https://v.example/a.m3u8');

// No mime: judge by extension, still never audio.
const NO_MIME = {
    kind: 21, tags: [
        ['imeta', 'url https://v.example/song.mp3', 'alt a song'],
        ['imeta', 'url https://v.example/clip.webm', 'alt a clip']
    ]
};
eq('video: extension decides without m', media.video(NO_MIME).url, 'https://v.example/clip.webm');

/* NIP-92: `url` plus at least one OTHER field. A tag carrying nothing but a
   URL describes nothing, so it is dropped rather than rendered as bare media. */
eq('entries: url-only tag dropped', media.entries({ tags: [['imeta', 'url https://v/a.mp4']] }).length, 0);
eq('video: url-only tag yields nothing', media.video({ kind: 21, tags: [['imeta', 'url https://v/a.mp4']] }), null);
eq('pictures: url-only tag dropped', media.pictures({ kind: 20, tags: [['imeta', 'url https://c/a.jpg']] }).length, 0);
eq('entries: unknown key does not count as a field',
    media.entries({ tags: [['imeta', 'url https://v/a.mp4', 'zzz hello']] }).length, 0);

// Audio-only event -> no video element at all.
const AUDIO_ONLY = { kind: 21, tags: [['imeta', 'url https://v.example/a.mp3', 'm audio/mp3']] };
eq('video: audio-only yields null', media.video(AUDIO_ONLY), null);
eq('videoHtml: audio-only renders nothing', media.videoHtml(AUDIO_ONLY, {}), '');

/* Real event on nostr.download declares `video/mp4; codecs="avc1"`. The bare
   type must still be recognised as native, or that file loses to a plainer
   variant. */
const CODECS = {
    kind: 34235, tags: [
        ['d', 'x'],
        ['imeta', 'url https://v.example/codecs.mp4', 'm video/mp4; codecs="avc1"', 'dim 800x600'],
        ['imeta', 'url https://v.example/small.mp4', 'm video/mp4', 'dim 320x240']
    ]
};
eq('video: parameterised mime ranks as native', media.video(CODECS).url, 'https://v.example/codecs.mp4');

// Real event: fallback URLs carrying a space and quotes are malformed, so they
// are dropped instead of being injected into the page.
const BAD_FALLBACK = {
    kind: 34235, tags: [
        ['d', 'x'],
        ['imeta', 'url https://v.example/a.mp4', 'm video/mp4',
         'fallback https://v.example/a.mp4; codecs="avc1"']
    ]
};
eq('video: fallback with spaces/quotes dropped', media.video(BAD_FALLBACK).fallbacks.length, 0);

// ---------- 3b. caption / event-level alt ----------
eq('caption: content wins', media.caption({ content: 'hello', tags: [['alt', 'pic']] }), 'hello');
eq('caption: alt used when content empty', media.caption({ content: '', tags: [['alt', 'List of pictures']] }), 'List of pictures');
eq('caption: whitespace-only content falls back', media.caption({ content: '   ', tags: [['alt', 'x']] }), 'x');
eq('caption: nothing at all', media.caption({ content: '', tags: [] }), '');
eq('caption: null event', media.caption(null), '');

// Event-level alt is the alt text of the gallery images when imeta has none.
const galleryAlt = media.pictureHtml({
    kind: 20, content: '', tags: [
        ['alt', 'List of pictures'],
        ['imeta', 'url https://c/1.jpg', 'm image/jpeg']
    ]
}, {});
ok('pictureHtml: event alt used for tiles', galleryAlt.indexOf('alt="List of pictures"') !== -1);

// The imeta alt wins over the event-level one.
const bothAlt = media.pictureHtml({
    kind: 20, tags: [
        ['alt', 'gallery'],
        ['imeta', 'url https://c/1.jpg', 'm image/jpeg', 'alt per-picture']
    ]
}, {});
ok('pictureHtml: per-picture alt wins', bothAlt.indexOf('alt="per-picture"') !== -1 && bothAlt.indexOf('alt="gallery"') === -1);

/* Real kind-21 events on nos.lol are YouTube videos: the imeta url IS a
   YouTube link and the only declared media is a jpeg thumbnail. With no file
   to play they used to render as a badge and an empty box. */
const YT = {
    kind: 21, pubkey: PK, created_at: 1,
    content: 'Join Thomas on a wild adventure through the animal park',
    tags: [
        ['title', 'Thomas & Friends | 70 Min'],
        ['alt', 'Video: Thomas & Friends'],
        ['i', 'https://www.youtube.com/watch?v=wHvOqF3HTzA', 'https://www.youtube.com/watch?v=wHvOqF3HTzA'],
        ['k', 'web'],
        ['r', 'https://www.youtube.com/watch?v=wHvOqF3HTzA'],
        ['imeta', 'url https://www.youtube.com/watch?v=wHvOqF3HTzA',
         'image https://i.ytimg.com/vi/wHvOqF3HTzA/hqdefault.jpg', 'm image/jpeg']
    ]
};
import embed from '../assets/nostr-embed.js';
eq('video: YouTube event has no playable file', media.video(YT), null);
eq('externalVideo: finds the YouTube id', media.externalVideo(YT, embed), 'wHvOqF3HTzA');
const ytHtml = media.videoHtml(YT, { embed });
ok('videoHtml: YouTube player reused', ytHtml.indexOf('youtube-nocookie') !== -1 || ytHtml.indexOf('yt-play') !== -1 || ytHtml.indexOf('maxresdefault') !== -1);
ok('videoHtml: no iframe before a click', ytHtml.indexOf('<iframe') === -1);
eq('videoHtml: without the embed module, nothing is invented', media.videoHtml(YT, {}), '');

// A self-hosted video must NOT be hijacked by a YouTube link elsewhere in the event.
const SELF_HOSTED = {
    kind: 21, tags: [
        ['r', 'https://www.youtube.com/watch?v=aaaaaaaaaaa'],
        ['imeta', 'url https://v.example/real.mp4', 'm video/mp4']
    ]
};
ok('videoHtml: real file wins over a stray YouTube link',
    media.videoHtml(SELF_HOSTED, { embed }).indexOf('https://v.example/real.mp4') !== -1);

// ---------- 4. videoHtml markup ----------
const vHtml = media.videoHtml(MULTI, {});
ok('videoHtml: has video element', vHtml.indexOf('<video') !== -1);
ok('videoHtml: source url', vHtml.indexOf('src="https://v.example/1080.mp4"') !== -1);
ok('videoHtml: declared type', vHtml.indexOf('type="video/mp4"') !== -1);
ok('videoHtml: poster attribute', vHtml.indexOf('poster="https://v.example/1080.jpg"') !== -1);
ok('videoHtml: controls present', vHtml.indexOf('controls') !== -1);
ok('videoHtml: preload metadata', vHtml.indexOf('preload="metadata"') !== -1);
ok('videoHtml: no autoplay', vHtml.indexOf('autoplay') === -1);

const withMirror = media.videoHtml({
    kind: 21, tags: [['imeta', 'url https://v.example/a.mp4', 'm video/mp4',
                      'fallback https://mirror.example/a.mp4',
                      'fallback https://mirror2.example/a.mp4']]
}, {});
ok('videoHtml: mirrors stored for retry', withMirror.indexOf('data-vfb=') !== -1);
ok('videoHtml: retry handler wired', withMirror.indexOf('NostrMediaEvent.retryVideo') !== -1);

// ---------- 5. retryVideo ----------
function fakeVideo() {
    const attrs = { 'data-vfb': JSON.stringify(['https://m1/a.mp4', 'https://m2/a.mp4']) };
    const source = { src: 'https://v.example/a.mp4', setAttribute(k, v) { if (k === 'src') this.src = v; }, getAttribute(k) { return k === 'src' ? this.src : null; } };
    let onerror = function () {};
    let loads = 0;
    return {
        getAttribute: (k) => (k in attrs ? attrs[k] : null),
        setAttribute: (k, v) => { attrs[k] = v; },
        removeAttribute: (k) => { delete attrs[k]; },
        querySelector: (sel) => (sel === 'source' ? source : null),
        load() { loads++; },
        get source() { return source; },
        get loads() { return loads; },
        get onerror() { return onerror; },
        set onerror(fn) { onerror = fn; }
    };
}
const fv = fakeVideo();
ok('retryVideo: first call true', media.retryVideo(fv) === true);
eq('retryVideo: first mirror used', fv.source.src, 'https://m1/a.mp4');
ok('retryVideo: calls load()', fv.loads === 1);
ok('retryVideo: second call true', media.retryVideo(fv) === true);
eq('retryVideo: second mirror used', fv.source.src, 'https://m2/a.mp4');
ok('retryVideo: exhausted returns false', media.retryVideo(fv) === false);
eq('retryVideo: handler cleared (no loop)', fv.onerror, null);
ok('retryVideo: null is safe', media.retryVideo(null) === false);

// ---------- 6. addressable dedupe ----------
const older = { kind: 34235, pubkey: PK, created_at: 100, id: 'old',
                tags: [['d', 'my-video']] };
const newer = { kind: 34235, pubkey: PK, created_at: 200, id: 'new',
                tags: [['d', 'my-video']] };
const otherAuthor = { kind: 34235, pubkey: 'b'.repeat(64), created_at: 300, id: 'other',
                      tags: [['d', 'my-video']] };
const noD = { kind: 34235, pubkey: PK, created_at: 400, id: 'nod', tags: [] };
const plain = { kind: 21, pubkey: PK, created_at: 500, id: 'plain', tags: [] };

const deduped = media.dedupeAddressable([older, newer, otherAuthor, noD, plain]);
eq('dedupe: newest version of the address kept', deduped.filter(e => e.id === 'new' || e.id === 'old').length, 1);
ok('dedupe: the newer one survived', deduped.some(e => e.id === 'new'));
ok('dedupe: older version dropped', !deduped.some(e => e.id === 'old'));
ok('dedupe: same d from another author kept', deduped.some(e => e.id === 'other'));
ok('dedupe: missing d tag is kept', deduped.some(e => e.id === 'nod'));
ok('dedupe: non-addressable untouched', deduped.some(e => e.id === 'plain'));

// newer arriving first must still win over an older arriving later
const rev = media.dedupeAddressable([newer, older]);
ok('dedupe: order-independent', rev.length === 1 && rev[0].id === 'new');
eq('dedupe: non-array is safe', media.dedupeAddressable(null).length, 0);

// ---------- 6b. addressOf (used by streaming pages) ----------
eq('addressOf: pubkey + d', media.addressOf(older), PK + ':my-video');
eq('addressOf: different d -> different address',
    media.addressOf({ kind: 34235, pubkey: PK, tags: [['d', 'other']] }), PK + ':other');
eq('addressOf: non-addressable kind -> null', media.addressOf({ kind: 21, pubkey: PK, tags: [['d', 'x']] }), null);
eq('addressOf: missing d -> null', media.addressOf({ kind: 34235, pubkey: PK, tags: [] }), null);
eq('addressOf: null -> null', media.addressOf(null), null);

// ---------- 7. SECURITY ----------
const evilAlt = media.pictureHtml({
    kind: 20, tags: [['imeta', 'url https://cdn/x.jpg', 'm image/jpeg',
                      'alt "><img src=x onerror=alert(1)>']]
}, {});
/* Inspect the attribute VALUE, not the raw string: `"><img` legitimately
   appears in any serialised HTML as the end of an attribute followed by a
   tag, so searching for it is a false positive waiting to happen. */
const altValue = (evilAlt.match(/alt="([^"]*)"/) || [])[1] || '';
ok('xss: alt value is escaped', altValue.indexOf('&quot;') !== -1);
ok('xss: alt value holds no raw angle bracket', altValue.indexOf('<') === -1);
ok('xss: alt value cannot close the attribute', altValue.indexOf('"') === -1);
ok('xss: no injected <img src=x tag', evilAlt.indexOf('<img src=x') === -1);
ok('xss: no live onerror from alt', !/alt="[^"]*"\s*onerror/.test(evilAlt));

const jsUrl = media.pictureHtml({
    kind: 20, tags: [['imeta', 'url javascript:alert(1)', 'm image/jpeg', 'alt x']]
}, {});
eq('xss: javascript: url yields no tile', jsUrl, '');

const jsMirror = media.videoHtml({
    kind: 21, tags: [['imeta', 'url https://v/a.mp4', 'm video/mp4',
                      'fallback javascript:alert(1)']]
}, {});
ok('xss: javascript: mirror dropped', jsMirror.indexOf('javascript:') === -1);

const evilTitle = media.videoHtml({
    kind: 21, tags: [['imeta', 'url https://v/a.mp4', 'm video/mp4',
                      'alt "><script>alert(1)</script>']]
}, {});
ok('xss: video alt escaped', evilTitle.indexOf('<script>') === -1 && evilTitle.indexOf('&lt;script&gt;') !== -1);

// ---------- 8. duration formatting ----------
eq('fmt: 29.2 -> 0:29', media.fmtDuration(29.2), '0:29');
eq('fmt: 65 -> 1:05', media.fmtDuration(65), '1:05');
eq('fmt: 3725 -> 1:02:05', media.fmtDuration(3725), '1:02:05');
eq('fmt: null', media.fmtDuration(null), null);

// ---------- 9. pages ----------
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PAGES = ['index.html', 'thread.html', 'notes.html', 'notifications.html',
               'bookmark.html', 'relay.html', 'profile.html'];
const src = {};
for (const p of PAGES) src[p] = readFileSync(join(root, p), 'utf8');

for (const p of PAGES) {
    ok(`${p}: loads nostr-media-event.js`, src[p].includes('/assets/nostr-media-event.js'));
    ok(`${p}: versioned module reference`, /nostr-media-event\.js\?v=\d{8}[a-z]/.test(src[p]));
}

/* The eight hand-written imeta parsers must be gone. This is the whole point
   of the module: that block had two bugs and eight copies. */
let legacyParsers = 0;
for (const p of PAGES) legacyParsers += (src[p].match(/val\.startsWith\("url "\)/g) || []).length;
eq('pages: no hand-written imeta parser left', legacyParsers, 0);

let legacyVideoBuilds = 0;
for (const p of PAGES) legacyVideoBuilds += (src[p].match(/<video controls playsinline preload="metadata"/g) || []).length;
eq('pages: no inline <video> template left', legacyVideoBuilds, 0);

// every page that can show these kinds must ask the module for the markup
for (const p of PAGES) {
    ok(`${p}: asks the module for media markup`,
        /NostrMediaEvent\.(mediaHtml|videoHtml|pictureHtml)\(/.test(src[p]));
}

/* A republished addressable video must not appear twice. index renders on
   arrival (so it tracks addresses), profile re-renders a list (so it dedupes). */
ok('index.html: tracks addressable video addresses', src['index.html'].includes('NostrMediaEvent.addressOf('));
ok('index.html: declares the address map', /let addressCards = \{\}/.test(src['index.html']));
ok('profile.html: dedupes addressable versions', src['profile.html'].includes('NostrMediaEvent.dedupeAddressable('));

/* The footer under a card used to print "video_stream" as a literal, so a
   picture card still claimed to be a video stream. It must come from the
   module now. (Found in a browser screenshot, not by a unit test.) */
let literalFooter = 0;
for (const p of PAGES) literalFooter += (src[p].match(/> video_stream \/ via/g) || []).length;
eq('pages: no hardcoded video_stream footer', literalFooter, 0);
ok('index.html: footer type comes from the module',
    src['index.html'].includes('window.NostrMediaEvent.eventType(ev)'));
ok('profile.html: footer type comes from the module',
    src['profile.html'].includes('window.NostrMediaEvent.eventType(targetEv)'));

/* Kind 20 must never be described as a video stream anywhere. */
ok('module: picture eventType is picture_event', media.eventType({ kind: 20 }) === 'picture_event');

/* Guard against a regression in the filter arrays: the new kinds belong only
   in feed subscriptions, never in profile/contact/bookmark lookups. */
for (const p of PAGES) {
    const arrays = [...src[p].matchAll(/"kinds":\s*\[([^\]]*)\]/g)].map(m => m[1]);
    const bad = arrays.filter(a => {
        const hasNew = /\b(20|34235|34236)\b/.test(a);
        if (!hasNew) return false;
        return !(/\b21\b/.test(a) && /\b22\b/.test(a));
    });
    ok(`${p}: new kinds only in feed filters`, bad.length === 0, JSON.stringify(bad));
}

// kind 20 and the addressable video kinds must be subscribed to, otherwise
// the renderer never receives anything to draw.
for (const p of PAGES) {
    const hasReq = /"kinds":\s*\[[^\]]*21[^\]]*22/.test(src[p]);
    if (!hasReq) continue;
    ok(`${p}: filter includes kind 20`, /"kinds":\s*\[[^\]]*\b20\b/.test(src[p]));
    ok(`${p}: filter includes 34235`, /"kinds":\s*\[[^\]]*34235/.test(src[p]));
    ok(`${p}: filter includes 34236`, /"kinds":\s*\[[^\]]*34236/.test(src[p]));
}

report();
