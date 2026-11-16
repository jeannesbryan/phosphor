/* Tests for assets/nostr-nip27.js.
   Run: node tests/nostr-nip27.test.mjs

   The bech32 vectors below are copied from NIP-19's Examples section, NOT
   produced by this module's own encoder. That matters: if the encoder and the
   decoder shared a mistake, a self-generated round trip would still pass and the
   bug would ship. The nprofile vector is what proves the TLV reader. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nip27 = require('../assets/nostr-nip27.js');

let pass = 0, fail = 0;
const out = [];
function ok(name, cond) { if (cond) { pass++; out.push('  ok   ' + name); } else { fail++; out.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; out.push('  ok   ' + name); }
    else { fail++; out.push('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}

// ------------------------------------------------ NIP-19 published vectors
const NPUB_A = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6';
const HEX_A = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
const NPUB_B = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const HEX_B = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
const NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const NSEC_HEX = '67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa';
const NPROFILE = 'nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhhytnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34kytnrdaksjlyr9p';

eq('npub A decodes to its published hex', nip27.bech32Decode(NPUB_A).hex, HEX_A);
eq('npub B decodes to its published hex', nip27.bech32Decode(NPUB_B).hex, HEX_B);
eq('nsec decodes (the decoder is not the guard)', nip27.bech32Decode(NSEC).hex, NSEC_HEX);
eq('hrp is reported', nip27.bech32Decode(NPUB_A).hrp, 'npub');

// a corrupted checksum must be refused, not half-accepted
const corrupt = NPUB_A.slice(0, -1) + (NPUB_A.slice(-1) === 'q' ? 'p' : 'q');
eq('a bad checksum returns null', nip27.bech32Decode(corrupt), null);
eq('mixed case returns null', nip27.bech32Decode(NPUB_A.slice(0, 10).toUpperCase() + NPUB_A.slice(10)), null);
eq('garbage returns null', nip27.bech32Decode('not-a-bech32'), null);
eq('null returns null', nip27.bech32Decode(null), null);
eq('uppercase is accepted (spec allows it)', nip27.bech32Decode(NPUB_A.toUpperCase()).hex, HEX_A);

/* A small bech32 encoder, needed to build MALFORMED nprofile values for the TLV
   tests below. It is not trusted blindly: it is checked against the published
   vectors first, so a broken encoder cannot make a "must be null" assertion pass
   for the wrong reason. */
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values) {
    let chk = 1;
    for (const v of values) {
        const top = chk >>> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
    }
    return chk >>> 0;
}
function hrpExpand(hrp) {
    const out = [];
    for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
    out.push(0);
    for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
    return out;
}
function convert(data, from, to, pad) {
    let acc = 0, bits = 0; const out = []; const maxv = (1 << to) - 1;
    for (const v of data) {
        acc = (acc << from) | v; bits += from;
        while (bits >= to) { bits -= to; out.push((acc >>> bits) & maxv); }
    }
    if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
    return out;
}
function bech32Encode(hrp, bytes) {
    const data = convert(bytes, 8, 5, true);
    const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
    const mod = polymod(values) ^ 1;
    const checksum = [];
    for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31);
    return hrp + '1' + data.concat(checksum).map(v => CHARSET[v]).join('');
}
/* Validate the encoder against the spec's own vectors before using it. */
eq('encoder reproduces the published npub (A)', bech32Encode('npub', nip27.fromHex(HEX_A)), NPUB_A);
eq('encoder reproduces the published npub (B)', bech32Encode('npub', nip27.fromHex(HEX_B)), NPUB_B);

// ------------------------------------------------------------- parseRef
eq('npub becomes a profile ref', nip27.parseRef('nostr:' + NPUB_A).pubkey, HEX_A);
eq('npub ref has the profile type', nip27.parseRef('nostr:' + NPUB_A).type, 'profile');

/* The most important test in this file: a private key must NEVER come back as
   something renderable. Rendering it would put a key on screen and in a link. */
eq('nsec is refused outright', nip27.parseRef('nostr:' + NSEC), null);
/* Today the guard is belt and braces: no branch below it accepts the `nsec` hrp,
   so deleting it changes no behaviour (an equivalent mutant, which mutation
   testing cannot kill). It still earns its place, because the day somebody adds a
   generic "accept any 32-byte payload" branch, this is what stops a private key
   becoming a link. That intent is asserted directly. */
ok('the nsec refusal is explicit in the source, with a reason',
    /if \(hrp === 'nsec'\) return null;/.test(
        (await import('node:fs')).readFileSync(
            new URL('../assets/nostr-nip27.js', import.meta.url), 'utf8')));
eq('nsec never appears in splitText',
    nip27.splitText('my key nostr:' + NSEC + ' ok').filter(p => p.ref).length, 0);
ok('nsec text stays visible as plain text',
    nip27.splitText('key nostr:' + NSEC).map(p => p.text || p.raw).join('').indexOf(NSEC) !== -1);

{
    const p = nip27.parseRef('nostr:' + NPROFILE);
    eq('nprofile yields the published pubkey', p.pubkey, HEX_A);
    eq('nprofile yields both published relays', p.relays, ['wss://r.x.com', 'wss://djbas.sadkb.com']);
}

/* Malformed TLV must be refused. A length field that runs past the buffer is the
   classic way a hand-written parser reads out of bounds, so it gets its own
   assertions built from the validated encoder above. */
{
    const pk = nip27.fromHex(HEX_A);
    const truncated = [0, 32].concat(pk.slice(0, 10));        // claims 32 bytes, supplies 10
    eq('a TLV whose length runs past the buffer is refused',
        nip27.parseRef('nostr:' + bech32Encode('nprofile', truncated)), null);

    const noHeader = [0];                                     // type with no length byte
    eq('a TLV with a dangling type byte is refused',
        nip27.parseRef('nostr:' + bech32Encode('nprofile', noHeader)), null);

    const emptyPayload = [];
    eq('an nprofile with no TLV at all is refused',
        nip27.parseRef('nostr:' + bech32Encode('nprofile', emptyPayload)), null);

    const wrongSize = [0, 5].concat([1, 2, 3, 4, 5]);         // payload is not a 32-byte key
    eq('an nprofile whose payload is not 32 bytes is refused',
        nip27.parseRef('nostr:' + bech32Encode('nprofile', wrongSize)), null);

    /* The off-by-one case: the last TLV claims ONE byte more than is left. A
       bounds check written as `> len + 1` lets this through and then slices a
       value that is one byte short. nevent is used because its extra relay item
       makes the difference visible in the parsed result, not just in null-ness. */
    const neventTooLong = [0, 32].concat(pk).concat([1, 2, 0x77]);  // relay claims 2, has 1
    eq('the final TLV claiming one byte too many is refused',
        nip27.parseRef('nostr:' + bech32Encode('nevent', neventTooLong)), null);
}

eq('a note without the nostr prefix is not a reference', nip27.parseRef(NPUB_A), null);
eq('an unknown hrp is ignored', nip27.parseRef('nostr:abc1qqqqqqqq'), null);
eq('trailing garbage is rejected', nip27.parseRef('nostr:' + NPUB_A + 'zzz'), null);

// ------------------------------------------------------------ splitText
{
    const parts = nip27.splitText('halo nostr:' + NPUB_A + ' apa kabar');
    eq('three segments: text, ref, text', parts.length, 3);
    eq('first segment keeps the leading text', parts[0].text, 'halo ');
    eq('middle segment is the reference', parts[1].ref.pubkey, HEX_A);
    eq('last segment keeps the trailing text', parts[2].text, ' apa kabar');
}
{
    const parts = nip27.splitText('no references here at all');
    eq('plain text yields one segment', parts.length, 1);
    eq('and it has no ref', parts[0].ref, undefined);
}
{
    const parts = nip27.splitText('nostr:' + NPUB_A + ' and nostr:' + NPUB_B);
    eq('two references are both found', parts.filter(p => p.ref).length, 2);
    const refsOnly = parts.filter(p => p.ref).map(p => p.ref.pubkey);
    eq('references keep their order', refsOnly, [HEX_A, HEX_B]);
}
{
    /* A bare npub in prose is NOT linkified by default: any stray bech32 string
       would otherwise become a link. Opt in explicitly if ever needed. */
    eq('bare npub is not linkified by default',
        nip27.splitText('see ' + NPUB_A).filter(p => p.ref).length, 0);
    eq('bare npub is linkified when asked',
        nip27.splitText('see ' + NPUB_A, { includeBare: true }).filter(p => p.ref).length, 1);
}
{
    const parts = nip27.splitText('bad checksum nostr:' + corrupt + ' end');
    eq('invalid bech32 stays as text', parts.filter(p => p.ref).length, 0);
    ok('and the original text survives', parts.map(p => p.text || p.raw).join('').indexOf(corrupt) !== -1);
}

// ------------------------------------------------------------- rendering
eq('profile href points at profile.html',
    nip27.hrefFor(nip27.parseRef('nostr:' + NPUB_A)), 'profile.html?pubkey=' + HEX_A);
{
    const p = nip27.parseRef('nostr:' + NPROFILE);
    eq('nprofile href uses the pubkey, not the raw value',
        nip27.hrefFor(p), 'profile.html?pubkey=' + HEX_A);
}
eq('an naddr href carries kind, d and author',
    /notes\.html\?kind=30023&d=abc&author=/.test(nip27.hrefFor({
        type: 'article', identifier: 'abc', pubkey: HEX_A, kind: 30023
    })), true);
ok('linkHtml escapes the label and never injects attributes',
    nip27.linkHtml({ type: 'article', identifier: '<img src=x>', pubkey: HEX_A, kind: 30023, raw: 'x' })
        .indexOf('<img') === -1);
ok('the visible label is short, not the whole bech32',
    nip27.shortLabel(nip27.parseRef('nostr:' + NPUB_A)).length <= 12);

// --------------------------------------------------------------- upgrade
/* A minimal DOM stand-in: the walker is the only browser API used, so faking
   just that keeps the real traversal-and-replace logic under test. */
{
    function makeEl(tag, children) {
        const el = { nodeName: tag.toUpperCase(), childNodes: [], parentNode: null, ownerDocument: null,
            className: '', attrs: {}, closest() { return null; } };
        /* Real DOM semantics: replacing an element with a DocumentFragment
           inserts the fragment's CHILDREN, not the fragment itself. Modelling it
           loosely here would make the assertions measure the wrong tree. */
        el.replaceChild = function (newNode, oldNode) {
            const i = this.childNodes.indexOf(oldNode);
            if (i === -1) throw new Error('replaceChild: not a child');
            if (newNode.nodeName === '#FRAGMENT') {
                newNode.childNodes.forEach(c => { c.parentNode = this; });
                this.childNodes.splice(i, 1, ...newNode.childNodes);
            } else {
                newNode.parentNode = this;
                this.childNodes[i] = newNode;
            }
            return oldNode;
        };
        if (children) children.forEach(c => { c.parentNode = el; el.childNodes.push(c); });
        return el;
    }
    function makeText(v) { return { nodeName: '#text', nodeValue: v, parentNode: null }; }
    function makeDoc() {
        return {
            createTreeWalker(root) {
                const flat = [];
                (function walk(n) {
                    if (n.nodeName === '#text') { flat.push(n); return; }
                    (n.childNodes || []).forEach(walk);
                })(root);
                let i = -1;
                return { nextNode: () => (++i < flat.length ? flat[i] : null) };
            },
            createDocumentFragment() {
                const f = makeEl('#fragment');
                f.appendChild = function (c) { c.parentNode = f; this.childNodes.push(c); return c; };
                return f;
            },
            createElement(tag) {
                const el = makeEl(tag);
                Object.defineProperty(el, 'textContent', { set(v) { this._text = v; }, get() { return this._text; } });
                el.setAttribute = function (k, v) { this.attrs[k] = v; };
                el.ownerDocument = doc;
                return el;
            },
            createTextNode(v) { const t = makeText(v); t.ownerDocument = doc; return t; }
        };
    }
    var doc = makeDoc();

    // text node -> replaced with fragment containing an <a>
    const textNode = makeText('hi nostr:' + NPUB_A + ' bye');
    const host = makeEl('DIV', [textNode]);
    host.ownerDocument = doc;
    const changed = nip27.upgrade(host);
    eq('upgrade reports the node it changed', changed, 1);
    eq('host now has three children', host.childNodes.length, 3);
    eq('the middle child is an anchor', host.childNodes[1].attrs['data-nostr-ref'], 'nostr:' + NPUB_A);

    // a node already inside an <a> is skipped
    const inside = makeText('nostr:' + NPUB_A);
    const anchor = makeEl('A', [inside]);
    const host2 = makeEl('DIV', [anchor]);
    host2.ownerDocument = doc;
    eq('text inside an anchor is not touched', nip27.upgrade(host2), 0);

    // code samples stay literal
    const codeText = makeText('nostr:' + NPUB_A);
    const pre = makeEl('PRE', [makeEl('CODE', [codeText])]);
    const host3 = makeEl('DIV', [pre]);
    host3.ownerDocument = doc;
    eq('code inside pre is not linkified', nip27.upgrade(host3), 0);
}

// --------------------------------------------------- all pages are wired
/* A mention that renders as dead text is the bug this module exists to fix, so
   every page that shows user content must load it and call upgrade(). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIRED = ['index.html', 'profile.html', 'thread.html', 'notes.html', 'bookmark.html', 'relay.html', 'notifications.html'];
for (const name of WIRED) {
    let src = readFileSync(join(root, name), 'utf8');
    if (name === 'index.html') src += readFileSync(join(root, 'assets', 'nostr-feed-card.js'), 'utf8');   // card renderer moved there
    ok(name + ': loads the NIP-27 module',
        /<script src="\/assets\/nostr-nip27\.js\?v=[^"]+"><\/script>/.test(src));
    ok(name + ': calls upgrade after inserting a card',
        /window\.NostrNip27\.upgrade\(card\)/.test(src));
}

console.log(out.join('\n'));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
