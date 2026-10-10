/* Tes untuk assets/nostr-like.js
   Jalankan: node tests/nostr-like.test.mjs
   Murni — tanpa browser, tanpa jaringan (WebSocket sengaja tidak ada supaya
   modul memakai jalur `send` yang diberikan halaman).

   Yang dijaga tes ini adalah janji ke bos (2026-10-11): suka harus bisa
   DIBATALKAN, tanda "sudah suka" harus muncul, dan keadaan harus dibangun dari
   relay (bukan dari memori perangkat) supaya HP dan laptop sepakat.
*/
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const like = require('../assets/nostr-like.js');
const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond) { if (cond) { pass++; results.push('  ok   ' + name); } else { fail++; results.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; results.push('  ok   ' + name); }
    else { fail++; results.push(`  FAIL ${name}\n         dapat: ${g}\n         ingin: ${w}`); }
}

const ME = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);

globalThis.alert = () => { globalThis.__alerts = (globalThis.__alerts || 0) + 1; };

let sent, counts, signSeq;
function setup(opts) {
    sent = []; counts = []; signSeq = 0;
    globalThis.nostr = {
        signEvent: async (tpl) => { signSeq++; return Object.assign({}, tpl, { id: 'sig' + signSeq }); }
    };
    like.reset();
    like.init(Object.assign({
        pubkey: ME,
        relays: [],
        send: (ev) => sent.push(ev),
        onCount: (id, d) => counts.push([id, d]),
        historyMs: 0
    }, opts || {}));
}

// ===================== 1. suka =====================
setup();
ok('awalnya belum disukai', like.isLiked('t1') === false);
const liked = await like.toggle('t1', OTHER);
eq('toggle pertama -> true', liked, true);
ok('isLiked sekarang true', like.isLiked('t1') === true);
eq('satu peristiwa terkirim', sent.length, 1);
eq('jenisnya kind 7', sent[0].kind, 7);
eq('tag e menunjuk catatan', sent[0].tags[0], ['e', 't1', '']);
eq('tag p menunjuk penulis', sent[0].tags[1], ['p', OTHER, '']);
eq('isi "+"', sent[0].content, '+');
eq('penghitung naik sekali', counts, [['t1', 1]]);
ok('id peristiwa suka dicatat', like.reactionFor('t1') === 'sig1');

// ===================== 2. batal (bagian yang dulu tidak ada) =====================
const after = await like.toggle('t1', OTHER);
eq('toggle kedua -> false', after, false);
ok('isLiked kembali false', like.isLiked('t1') === false);
eq('dua peristiwa terkirim', sent.length, 2);
eq('yang kedua kind 5 (NIP-09)', sent[1].kind, 5);
eq('menunjuk id peristiwa suka', sent[1].tags[0], ['e', 'sig1']);
eq('menyebut kind yang dihapus', sent[1].tags[1], ['k', '7']);
eq('penghitung turun sekali', counts, [['t1', 1], ['t1', -1]]);
eq('jejak suka dibersihkan', like.reactionFor('t1'), null);
ok('tidak ada alert (bukan lagi jalan buntu)', (globalThis.__alerts || 0) === 0);

// ===================== 3. keadaan dibangun dari relay =====================
setup();
like.absorb({ id: 'r1', pubkey: ME, kind: 7, created_at: 100, tags: [['e', 't9']] });
ok('suka dari perangkat lain terbaca', like.isLiked('t9') === true);
eq('penghitung ikut naik', counts, [['t9', 1]]);
like.absorb({ id: 'r1', pubkey: ME, kind: 7, created_at: 100, tags: [['e', 't9']] });
eq('peristiwa sama tidak dihitung dua kali', counts, [['t9', 1]]);

setup();
like.absorb({ id: 'r2', pubkey: ME, kind: 7, created_at: 100, tags: [['e', 't9']] });
like.absorb({ id: 'd1', pubkey: ME, kind: 5, created_at: 101, tags: [['e', 'r2']] });
ok('pembatalan dari perangkat lain terbaca', like.isLiked('t9') === false);
eq('penghitung turun', counts, [['t9', 1], ['t9', -1]]);

// peristiwa milik orang lain diabaikan
setup();
ok('kind 7 orang lain diabaikan', like.absorb({ id: 'x', pubkey: OTHER, kind: 7, created_at: 1, tags: [['e', 't3']] }) === false);
ok('tidak jadi disukai', like.isLiked('t3') === false);

// sasaran diambil dari tag "e" TERAKHIR (NIP-25)
setup();
like.absorb({ id: 'r3', pubkey: ME, kind: 7, created_at: 1, tags: [['e', 'root'], ['e', 'last']] });
ok('tag e terakhir yang jadi sasaran', like.isLiked('last') === true && like.isLiked('root') === false);

// ===================== 4. fase riwayat tidak mengubah penghitung =====================
setup();
like.absorb({ id: 'r4', pubkey: ME, kind: 7, created_at: 1, tags: [['e', 't7']] });
// setup() memakai historyMs: 0 -> fase riwayat sudah lewat. Sekarang uji
// kebalikannya: fase riwayat aktif (historyMs besar) harus TIDAK menambah angka,
// karena angka kartu sudah dihitung dari permintaan metrics halaman.
like.reset();
like.init({ pubkey: ME, relays: [], send: () => {}, onCount: (id, d) => counts.push([id, d]), historyMs: 60000 });
counts.length = 0;
like.absorb({ id: 'r5', pubkey: ME, kind: 7, created_at: 1, tags: [['e', 't8']] });
ok('tanda "suka" muncul walau fase riwayat', like.isLiked('t8') === true);
eq('penghitung TIDAK berubah saat riwayat', counts, []);

// ===================== 5. belum masuk =====================
like.reset();
sent = [];
like.init({ pubkey: null, relays: [], send: (ev) => sent.push(ev) });
globalThis.__alerts = 0;
const r = await like.toggle('t5', OTHER);
eq('toggle tanpa pubkey -> false', r, false);
eq('tanpa pubkey tidak mengirim apa pun', sent.length, 0);
ok('tanpa pubkey memberi tahu pengguna', (globalThis.__alerts || 0) === 1);

// ===================== 6. struktur halaman =====================
const PAGES = ['index.html', 'thread.html', 'notes.html', 'bookmark.html', 'relay.html', 'profile.html'];
const ALL_PAGES = PAGES.concat(['activity.html', 'compose.html']);
for (const p of ALL_PAGES) {
    const html = readFileSync(join(root, p), 'utf8');
    const src = readFileSync(join(root, 'assets', 'form-utils.js'), 'utf8');
    ok(`${p}: memuat form-utils.js`, html.includes('/assets/form-utils.js'));
    if (!html.includes('type="password"')) continue;
    const ids = [...html.matchAll(/<input[^>]*type="password"[^>]*id="([^"]+)"/g)].map(m => m[1]);
    for (const id of ids) {
        ok(`${p}: kolom sandi ${id} terdaftar untuk Enter`, src.includes(`'${id}'`));
    }
}
for (const p of PAGES) {
    const html = readFileSync(join(root, p), 'utf8');
    ok(`${p}: memuat nostr-like.js`, html.includes('/assets/nostr-like.js'));
    ok(`${p}: memanggil initLikeModule()`, html.includes('initLikeModule();'));
    ok(`${p}: likeEvent meneruskan ke modul`, html.includes('NostrLike.toggle'));
    ok(`${p}: tidak lagi menyimpan likedEvents sendiri`, !html.includes('likedEvents'));
    ok(`${p}: tidak lagi menyimpan aturan kind 7 sendiri`, !html.includes('kind: 7'));
}

// ===================== 7. balasan disembunyikan (index + profile) =====================
for (const p of ['index.html', 'profile.html']) {
    const html = readFileSync(join(root, p), 'utf8');
    ok(`${p}: memakai NostrNote.isReply untuk menyaring balasan`, html.includes('NostrNote.isReply'));
}

console.log(results.join('\n'));
console.log(`\n${pass} ok, ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);
