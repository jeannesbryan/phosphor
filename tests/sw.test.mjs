/* Tests for sw.js.
   Run: node tests/sw.test.mjs

   sw.js behaves as a plain module when loaded outside a worker, so the decision
   rules are tested for real instead of being read off the file. The worker
   registration itself is asserted statically. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const sw = require('../sw.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}

const ORIGIN = 'https://phosphor-nostr.pages.dev';
const req = (over) => Object.assign({ method: 'GET', url: ORIGIN + '/index.html', mode: 'navigate' }, over || {});

// ------------------------------------------------------------- shouldHandle
eq('a GET is handled', sw.shouldHandle(req()), true);
eq('a POST is never handled (blossom uploads)', sw.shouldHandle(req({ method: 'POST' })), false);
eq('a PUT is never handled', sw.shouldHandle(req({ method: 'PUT' })), false);
eq('a DELETE is never handled', sw.shouldHandle(req({ method: 'DELETE' })), false);
eq('a non-http url is ignored', sw.shouldHandle(req({ url: 'chrome-extension://abc/x' })), false);
eq('null is ignored', sw.shouldHandle(null), false);

// ------------------------------------------------------------- same origin
eq('same origin is accepted', sw.isSameOrigin(req(), ORIGIN), true);
eq('another origin is refused', sw.isSameOrigin(req({ url: 'https://cdn.jsdelivr.net/x.js' }), ORIGIN), false);
eq('a relay websocket url is refused', sw.isSameOrigin(req({ url: 'wss://relay.damus.io/' }), ORIGIN), false);

// ---------------------------------------------------------------- strategies
/* The rule that matters most: a page is network-first so a deploy is seen at
   once, while an asset is cache-first so a repeat visit is instant. Getting these
   the wrong way round means either stale pages or a slow app. */
eq('a navigation is network-first', sw.strategyFor(req(), ORIGIN), 'network-first');
eq('a js asset is cache-first', sw.strategyFor(req({ url: ORIGIN + '/assets/terminal.js', mode: 'no-cors' }), ORIGIN), 'cache-first');
eq('a css asset is cache-first', sw.strategyFor(req({ url: ORIGIN + '/assets/terminal.css', mode: 'no-cors' }), ORIGIN), 'cache-first');
eq('a png is cache-first', sw.strategyFor(req({ url: ORIGIN + '/assets/favicon.ico', mode: 'no-cors' }), ORIGIN), 'cache-first');
eq('config.json is network-first so settings are never stale',
    sw.strategyFor(req({ url: ORIGIN + '/config.json', mode: 'no-cors' }), ORIGIN), 'network-first');
eq('a POST is ignored entirely', sw.strategyFor(req({ method: 'POST' }), ORIGIN), 'ignore');
eq('another origin is ignored', sw.strategyFor(req({ url: 'https://cdn.jsdelivr.net/x.js' }), ORIGIN), 'ignore');

// ------------------------------------------------------------- cache hygiene
eq('the old cache is deleted on activate', sw.olderCaches(['a', 'b'], 'b'), ['a']);
eq('the current cache is kept', sw.olderCaches(['b'], 'b'), []);
eq('no caches means nothing to delete', sw.olderCaches([], 'b'), []);
ok('the cache name carries a version', /-v\d+$/.test(sw.CACHE_NAME));

/* Every page must be precached, or it cannot open offline. */
{
    const pages = ['index.html', 'compose.html', 'notifications.html', 'notes.html',
        'profile.html', 'thread.html', 'bookmark.html', 'relay.html'];
    const missing = pages.filter(p => !sw.PRECACHE.some(e => e.endsWith('/' + p)));
    eq('all eight pages are precached', missing, []);
}
/* Files that do not exist would be a silent gap; check each precached asset name
   against the disk so a rename cannot quietly break offline mode. */
{
    const assetEntries = sw.PRECACHE.filter(e => e.indexOf('/assets/') !== -1);
    const missing = assetEntries.filter(e => {
        try { readFileSync(join(root, e.replace('./', ''))); return false; } catch (err) { return true; }
    });
    eq('every precached asset exists on disk', missing, []);
}

// ------------------------------------------------------------ worker wiring
{
    const src = readFileSync(join(root, 'sw.js'), 'utf8');
    ok('install is handled', /addEventListener\('install'/.test(src));
    ok('activate is handled', /addEventListener\('activate'/.test(src));
    ok('fetch is handled', /addEventListener\('fetch'/.test(src));
    ok('the worker only wires itself when running inside a worker',
        /typeof global\.registration === 'object'/.test(src));
    /* addAll would fail the whole install on one bad path. */
    ok('precache does not use addAll', !/cache\.addAll\(/.test(src));
    ok('each precache entry can fail on its own', /cache\.add\(new Request\(url/.test(src));
}

/* Every page must register the worker, or none of this runs. */
{
    const PAGES = ['index.html', 'compose.html', 'notifications.html', 'notes.html', 'profile.html', 'thread.html', 'bookmark.html', 'relay.html'];
    for (const p of PAGES) {
        const src = readFileSync(join(root, p), 'utf8');
        ok(p + ': registers the service worker', /serviceWorker\s*\.\s*register\('\/sw\.js'\)/.test(src));
        ok(p + ': only registers on a secure context',
            /isSecureContext/.test(src));
    }
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
