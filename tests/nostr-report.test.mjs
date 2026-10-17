/* Tests for assets/nostr-report.js — run: node tests/nostr-report.test.mjs
   Pure (no browser, no network).

   NIP-56 is a moderation feature, so most of this file is about restraint:
   a report must be well-formed (a bad one still lands in other clients), it
   must never be filed on the user's behalf, and reports read from the network
   must never be used to hide anyone's content. */
import report from '../assets/nostr-report.js';
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
function report_() {
    results.forEach(r => console.log(r));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

const EV_ID = 'a'.repeat(64);
const PK = 'b'.repeat(64);
const BLOB = 'c'.repeat(64);

// ---------- 1. the type list ----------
eq('types: the seven the spec names', report.TYPES.join(','),
   'nudity,malware,profanity,illegal,spam,impersonation,other');
ok('type: spam is valid', report.isValidType('spam'));
ok('type: invented type rejected', !report.isValidType('ugly'));
ok('type: empty rejected', !report.isValidType(''));
ok('type: null rejected', !report.isValidType(null));
eq('picker: one option per type', report.typeOptions().length, 7);
ok('picker: each option has a label',
   report.typeOptions().every(o => typeof o.label === 'string' && o.label.length > 0));
// the returned list must be a copy, not the module's own array
const opts = report.typeOptions();
opts[0].value = 'HACKED';
ok('picker: caller cannot mutate the module', report.typeOptions()[0].value === 'nudity');

// ---------- 2. buildTags — reporting a note ----------
const noteTags = report.buildTags({ type: 'spam', eventId: EV_ID, pubkey: PK });
eq('note: two tags', noteTags.length, 2);
eq('note: e tag', noteTags[0][0], 'e');
eq('note: e carries the id', noteTags[0][1], EV_ID);
eq('note: the TYPE is the 3rd entry', noteTags[0][2], 'spam');
eq('note: p tag for the author', noteTags[1][0], 'p');
eq('note: p value', noteTags[1][1], PK);
eq('note: p carries no type (the note is what is reported)', noteTags[1].length, 2);

// ---------- 3. buildTags — reporting a profile ----------
const profTags = report.buildTags({ type: 'impersonation', pubkey: PK });
eq('profile: one tag', profTags.length, 1);
eq('profile: p is the target', profTags[0][0], 'p');
eq('profile: p carries the type', profTags[0][2], 'impersonation');

// ---------- 4. buildTags — reporting a blob ----------
const blobTags = report.buildTags({ type: 'malware', blobHash: BLOB, eventId: EV_ID, pubkey: PK,
                                    server: 'https://blossom.example/blob.jpg' });
eq('blob: x tag', blobTags.find(t => t[0] === 'x')[1], BLOB);
eq('blob: x carries the type', blobTags.find(t => t[0] === 'x')[2], 'malware');
ok('blob: e names the carrying event', blobTags.some(t => t[0] === 'e' && t[1] === EV_ID));
ok('blob: server tag kept', blobTags.some(t => t[0] === 'server'));
// a server URL that could break out of context is dropped, not emitted
const badServer = report.buildTags({ type: 'malware', blobHash: BLOB, eventId: EV_ID,
                                     pubkey: PK, server: 'javascript:alert(1)' });
ok('blob: non-http server dropped', !badServer.some(t => t[0] === 'server'));

// ---------- 5. buildTags — strict about the spec's MUSTs ----------
let threw = false;
try { report.buildTags({ type: 'spam', eventId: EV_ID }); } catch (e) { threw = true; }
ok('strict: note report without an author throws', threw);

threw = false;
try { report.buildTags({ type: 'spam', blobHash: BLOB }); } catch (e) { threw = true; }
ok('strict: blob report without its event throws', threw);

threw = false;
try { report.buildTags({ type: 'ugly', eventId: EV_ID, pubkey: PK }); } catch (e) { threw = true; }
ok('strict: unknown type throws', threw);

threw = false;
try { report.buildTags({ eventId: EV_ID, pubkey: PK }); } catch (e) { threw = true; }
ok('strict: missing type throws', threw);

threw = false;
try { report.buildTags({ type: 'spam' }); } catch (e) { threw = true; }
ok('strict: nothing to report throws', threw);

// ---------- 6. parse ----------
const realNoteReport = {
    kind: 1984, pubkey: 'd'.repeat(64), created_at: 100,
    content: "He's insulting the king!",
    tags: [['e', EV_ID, 'illegal'], ['p', PK]]
};
const pn = report.parse(realNoteReport);
ok('parse: recognised', pn !== null);
eq('parse: primary type', report.primaryType(realNoteReport), 'illegal');
eq('parse: targets', pn.targets.length, 2);
eq('parse: note kept', pn.note, "He's insulting the king!");
eq('parse: no issues', pn.issues.length, 0);
eq('parse: ok', pn.ok, true);

const realProfile = {
    kind: 1984, content: 'Profile is impersonating nostr:',
    tags: [['p', PK, 'impersonation']]
};
const pp = report.parse(realProfile);
eq('parse profile: type', pp.types[0], 'impersonation');
eq('parse profile: ok', pp.ok, true);

/* The spec's own blob example omits the `p` tag, even though its prose says the
   p tag MUST be present. Rather than silently choosing a side, parsing reports
   the contradiction: the example is readable, and it is flagged as unsound. */
const realBlob = {
    kind: 1984, content: 'This file contains malware software in it.',
    tags: [['x', BLOB, 'malware'], ['e', EV_ID, 'malware'],
           ['server', 'https://you-may-find-the-blob-here.com/path.ext']]
};
const pb = report.parse(realBlob);
eq('parse blob: server kept', pb.server, 'https://you-may-find-the-blob-here.com/path.ext');
eq('parse blob: x type read', pb.types[0], 'malware');
ok('parse blob: the spec example is flagged for the missing p tag',
   pb.issues.some(x => x.indexOf('missing p') !== -1));

// With the author present it is fully sound — and that is what we publish.
const soundBlob = { kind: 1984, content: '', tags: report.buildTags({
    type: 'malware', blobHash: BLOB, eventId: EV_ID, pubkey: PK,
    server: 'https://blossom.example/x.bin' }) };
const psb = report.parse(soundBlob);
eq('parse sound blob: ok', psb.ok, true);
eq('parse sound blob: server kept', psb.server, 'https://blossom.example/x.bin');

eq('parse: not a report -> null', report.parse({ kind: 1, tags: [] }), null);
eq('parse: null -> null', report.parse(null), null);
ok('isReport: kind 1984', report.isReport(realNoteReport));
ok('isReport: kind 7 is not', !report.isReport({ kind: 7 }));

// ---------- 7. parse — spotting unsound reports ----------
const noP = report.parse({ kind: 1984, tags: [['e', EV_ID, 'spam']] });
ok('unsound: missing p flagged', noP.issues.some(x => x.indexOf('missing p') !== -1));
eq('unsound: not ok', noP.ok, false);

const noType = report.parse({ kind: 1984, tags: [['e', EV_ID], ['p', PK]] });
ok('unsound: no type flagged', noType.issues.some(x => x.indexOf('no report type') !== -1));

const badType = report.parse({ kind: 1984, tags: [['e', EV_ID, 'ugly'], ['p', PK]] });
ok('unsound: unknown type flagged', badType.issues.some(x => x.indexOf('unknown report type') !== -1));
eq('unsound: unknown type produces no clean type', badType.types.length, 0);

const xNoE = report.parse({ kind: 1984, tags: [['x', BLOB, 'malware'], ['p', PK]] });
ok('unsound: x without e flagged', xNoE.issues.some(x => x.indexOf('x blob without an e tag') !== -1));

const empty = report.parse({ kind: 1984, tags: [] });
ok('unsound: no target flagged', empty.issues.some(x => x.indexOf('no e/p/x target') !== -1));

// a built event must read back cleanly
const rt = report.parse({ kind: 1984, content: 'x',
                          tags: report.buildTags({ type: 'spam', eventId: EV_ID, pubkey: PK }) });
ok('round trip: built tags parse without issues', rt.ok, JSON.stringify(rt.issues));

// ---------- 8. remembering what the user reported ----------
report.forgetAll();
eq('memory: nothing reported yet', report.hasReported({ eventId: EV_ID }), null);

report.markReported({ eventId: EV_ID }, 'spam', 12345);
const hit = report.hasReported({ eventId: EV_ID });
ok('memory: reported state kept', !!hit);
eq('memory: type remembered', hit.type, 'spam');
eq('memory: timestamp remembered', hit.at, 12345);

eq('memory: a different note is unaffected', report.hasReported({ eventId: 'f'.repeat(64) }), null);
eq('memory: unknown key -> null', report.hasReported({}), null);
eq('memory: invalid type not recorded', report.markReported({ eventId: EV_ID }, 'ugly'), null);

// keys are per target kind
report.markReported({ pubkey: PK }, 'impersonation');
ok('memory: profile key separate from note key', !!report.hasReported({ pubkey: PK }));
eq('memory: profile report does not mark the note', report.hasReported({ eventId: PK }), null);

// ---------- 9. own reports absorbed from a relay ----------
report.forgetAll();
const own = [
    { kind: 1984, created_at: 500, tags: [['e', EV_ID, 'illegal'], ['p', PK]] },
    { kind: 1984, created_at: 600, tags: [['p', 'e'.repeat(64), 'spam']] },
    { kind: 1, created_at: 700, tags: [] },                        // not a report
    { kind: 1984, created_at: 800, tags: [['e', 'f'.repeat(64)]] } // unsound -> ignored
];
const added = report.absorbOwn(own);
eq('absorb: two good reports recorded', added, 2);
ok('absorb: note report remembered', !!report.hasReported({ eventId: EV_ID }));
eq('absorb: its type', report.hasReported({ eventId: EV_ID }).type, 'illegal');
ok('absorb: profile report remembered', !!report.hasReported({ pubkey: 'e'.repeat(64) }));
eq('absorb: unsound report ignored', report.hasReported({ eventId: 'f'.repeat(64) }), null);
eq('absorb: duplicate does not double count', report.absorbOwn(own), 0);
eq('absorb: non-array is safe', report.absorbOwn(null), 0);

/* Cross-device consistency: the same lesson as the like button. A local Set
   forgets on another machine; reading back the user's own kind 1984 events is
   what makes "you already reported this" true everywhere. */
const ME = '7'.repeat(64);
report.forgetAll();
report.absorbOwn([{ kind: 1984, pubkey: ME, created_at: 900, tags: [['e', EV_ID, 'spam'], ['p', PK]] }]);
ok('cross-device: a fresh device knows after absorbing own reports',
   !!report.hasReported({ eventId: EV_ID }));

/* absorbOwn must be safe on its own, without relying on the caller having
   filtered by author: a stranger's report is not "mine", and recording it would
   wrongly stop the user from filing their own. */
report.forgetAll();
const stranger = { kind: 1984, pubkey: '9'.repeat(64), created_at: 1000,
                   tags: [['e', 'f'.repeat(64), 'spam'], ['p', PK]] };
eq('absorb: stranger report ignored when myPubkey is given',
   report.absorbOwn([stranger], ME), 0);
eq('absorb: stranger report not remembered',
   report.hasReported({ eventId: 'f'.repeat(64) }), null);
eq('absorb: own report still accepted', report.absorbOwn([
    { kind: 1984, pubkey: ME, created_at: 1100, tags: [['e', EV_ID, 'spam'], ['p', PK]] }
], ME), 1);
ok('absorb: own report remembered', !!report.hasReported({ eventId: EV_ID }));

// ---------- 10. persistence ----------
function fakeStorage() {
    const data = {};
    return {
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        _data: data
    };
}
report.forgetAll();
const st = fakeStorage();
report.markReported({ eventId: EV_ID }, 'malware', 42);
ok('storage: save succeeds', report.save(st) === true);
ok('storage: stored under myReports', 'myReports' in st._data);

report.forgetAll();
eq('storage: nothing after forget', report.hasReported({ eventId: EV_ID }), null);
const loaded = report.load(st);
eq('storage: one entry loaded', loaded, 1);
eq('storage: type restored', report.hasReported({ eventId: EV_ID }).type, 'malware');

// a corrupt store must not throw or poison the state
const broken = { getItem: () => 'not json', setItem: () => {} };
report.forgetAll();
eq('storage: corrupt data loads as nothing', report.load(broken), 0);
eq('storage: no throw on missing storage', report.load(null), 0);
eq('storage: save without storage returns false', report.save(null), false);
const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
eq('storage: a throwing store is survivable', report.load(throwing), 0);
ok('storage: save that throws returns false', report.save(throwing) === false);

// ---------- 11. blob hashes from NIP-92 ----------
const withImeta = {
    kind: 1,
    tags: [['imeta', 'url https://cdn.example/a.jpg', 'm image/jpeg', 'x ' + BLOB]]
};
eq('blobHashOf: read from imeta', report.blobHashOf(withImeta), BLOB);
eq('blobHashOf: no imeta -> null', report.blobHashOf({ kind: 1, tags: [] }), null);
eq('blobHashOf: malformed hash rejected',
   report.blobHashOf({ tags: [['imeta', 'url https://x/a.jpg', 'x nothex']] }), null);
eq('blobHashOf: null event', report.blobHashOf(null), null);

// ---------- 12. THE RESTRAINT GUARDS ----------
/* This module must never be able to publish on its own. It has no network
   call of any kind: a page decides to sign and send, after the person clicked.
   Without this, a "report" could be filed in a stranger's name by a bug. */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const moduleSrc = readFileSync(join(root, 'assets/nostr-report.js'), 'utf8');

ok('restraint: the module never calls fetch', !/\bfetch\s*\(/.test(moduleSrc));
ok('restraint: the module never opens a WebSocket', !/new\s+WebSocket/.test(moduleSrc));
ok('restraint: the module never signs anything', !/signEvent/.test(moduleSrc));
ok('restraint: the module never sends an EVENT frame', !/"EVENT"/.test(moduleSrc));
ok('restraint: no auto-generated report timer', !/setTimeout|setInterval/.test(moduleSrc));

/* And the pages must not turn reports into moderation. A client that hides
   content because strangers filed reports hands a griefing tool to whoever is
   most motivated; the spec says as much about relays. */
const PAGES = ['index.html', 'thread.html', 'notes.html', 'notifications.html',
               'bookmark.html', 'relay.html', 'profile.html'];
const src = {};
for (const p of PAGES) src[p] = readFileSync(join(root, p), 'utf8');

for (const p of PAGES) {
    ok(`${p}: does not hide content based on reports`,
        !/NostrReport[^\n]*(hide|blur|remove|display\s*=\s*['"]none)/i.test(src[p]));
}

// the pages that offer reporting must load the module and wire a button
const REPORTING = PAGES.filter(p => src[p].includes('NostrReport'));
ok('reporting is wired somewhere', REPORTING.length > 0);
for (const p of REPORTING) {
    ok(`${p}: loads nostr-report.js`, src[p].includes('/assets/nostr-report.js'));
    ok(`${p}: versioned module reference`, /nostr-report\.js\?v=\d{8}[a-z]/.test(src[p]));
    ok(`${p}: has a report entry point`, src[p].includes('openReportModal('));
    ok(`${p}: asks the module for the tags`, src[p].includes('NostrReport.buildTags('));
    /* A report is only filed after an explicit confirmation by the user, and
       that confirmation must live INSIDE submitReport — checking for the
       function name alone would pass even if the confirm() were deleted. */
    const submitBody = (() => {
        const i = src[p].indexOf('function submitReport');
        if (i === -1) return '';
        // slice to the end of the function by brace counting
        let depth = 0, started = false, out = '';
        for (let j = i; j < src[p].length; j++) {
            const c = src[p][j];
            out += c;
            if (c === '{') { depth++; started = true; }
            else if (c === '}') { depth--; if (started && depth === 0) break; }
        }
        return out;
    })();
    ok(`${p}: submitReport asks for confirmation`, /confirm\s*\(/.test(submitBody));
    ok(`${p}: submitReport exists`, submitBody.length > 0);
    /* No reason may be preselected: the first item in the list is "nudity",
       and an accidental send must not file that. */
    ok(`${p}: submitReport refuses an empty reason`,
       /if\s*\(\s*!type\s*\)/.test(submitBody));
    ok(`${p}: the reason picker starts on a placeholder`,
       src[p].includes('choose a reason'));
}

report_();
