/* Tes untuk assets/nostr-note.js
   Jalankan: node tests/nostr-note.test.mjs
   Murni — tanpa browser, tanpa jaringan. Data ujinya adalah tiga catatan ASLI
   yang dilaporkan bos pada 2026-10-04, apa adanya dari relay. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const note = require('../assets/nostr-note.js');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond) { if (cond) { pass++; results.push('  ok   ' + name); } else { fail++; results.push('  FAIL ' + name); } }
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; results.push('  ok   ' + name); }
    else { fail++; results.push(`  FAIL ${name}\n         dapat: ${g}\n         ingin: ${w}`); }
}

// ===================== data nyata dari relay (2026-10-04) =====================

// Balasan "Yes 100%" — muncul di linimasa padahal seharusnya tidak.
const REPLY = {
    id: '884b51a879b8541f7dc766bf53ad3e943e9b96008697e752c7fc4d509b66ac64',
    pubkey: '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d',
    kind: 1,
    content: 'Yes 100%',
    tags: [
        ['e', '4a63646d83035656a88bdc2a9f90b2c48e3cff5a4fce7f8fb8d5a039f4c9a157', 'wss://relay.damus.io/', 'root', '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d'],
        ['e', '000006882e3d422be9529a22001b1e1999780d4ac8e5150f9712553e172b546a', 'wss://relay.primal.net/', 'reply', 'bc4b52cda9a2c8a17d1d03754475aa752ccc74da9041b3da7b844b0e47ed8389'],
        ['p', '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d', 'wss://relay.damus.io/'],
        ['client', 'Amethyst']
    ]
};

// Kutipan — penanda kutipannya ada di tag "q", bukan "e".
const QUOTE = {
    id: '00000083b134049c3d847ccb90287985c76909c5a238592e910ed374c9bf5f0f',
    pubkey: '460c25e682fda7832b52d1f22d3d22b3176d972f60dcdc3212ed8c92ef85065c',
    kind: 1,
    content: 'ZapStore will have 3 re-writes before iOS allows a non-Apple App Store.\nnostr:nevent1qqsy5cmydkpsx4jk4z9ac25ljzevfr3uladylnnl37udtgpe7ny6z4cpz4mhxue69uhhyetvv9ujuerpd46hxtnfduhsygrceeh65u3xgwrjsnny0wnf8zv4wd0v3374ckn9wdl92yc0qf3s05psgqqqqqqs99p39m',
    tags: [
        ['p', '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d', 'wss://relay.damus.io/'],
        ['q', '4a63646d83035656a88bdc2a9f90b2c48e3cff5a4fce7f8fb8d5a039f4c9a157', 'wss://relay.damus.io/', '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d'],
        ['zap', '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d', 'wss://relay.damus.io/', '0.9'],
        ['client', 'Amethyst']
    ]
};

// Catatan dengan tautan GitHub — cuma punya tag "p", tidak ada "e".
const GITHUB_POST = {
    id: '6a039dfccc328781de65e00e3a1334039bfdfd67c0fb0839bd35aa9efa1be376',
    pubkey: '7999814161743f22',
    kind: 1,
    content: 'We build everything completely in the open.\n\nhttps://github.com/Conduit-BTC/conduit-mono/blob/main/docs/OPEN_MARKETS.md\n',
    tags: [['p', '9d92077c5e35af76f7b1cd84738000b7bafb43d20b0a26c18fe29fa838d27146'], ['client', 'Ditto']]
};

console.log('--- 1. NIP-10: pengenalan balasan ---');
eq('balasan nyata (tag "e" bertanda reply) terdeteksi', note.isReply(REPLY), true);
eq('catatan biasa (tanpa tag "e") bukan balasan', note.isReply(GITHUB_POST), false);
eq('kutipan (tag "q", tanpa "e") bukan balasan', note.isReply(QUOTE), false);
eq('catatan tanpa tags tidak error', note.isReply({ content: 'x' }), false);
eq('tags null tidak error', note.isReply({ tags: null }), false);
eq('ev null tidak error', note.isReply(null), false);

// Tag "e" bertanda root saja -> tetap balasan (menunjuk induk).
eq('hanya tanda root tetap balasan',
    note.isReply({ tags: [['e', 'a'.repeat(64), 'wss://r', 'root']] }), true);
// Gaya lama tanpa penanda sama sekali -> menunjuk induk, jadi balasan.
eq('tag "e" tanpa penanda (gaya lama) -> balasan',
    note.isReply({ tags: [['e', 'a'.repeat(64)]] }), true);
// Semua tag "e" ditandai mention -> hanya menyebut, bukan balasan.
eq('tag "e" bertanda mention saja -> BUKAN balasan',
    note.isReply({ tags: [['e', 'a'.repeat(64), 'wss://r', 'mention']] }), false);
// Campuran: satu mention + satu reply -> tetap balasan.
eq('campuran mention + reply -> balasan',
    note.isReply({ tags: [['e', 'a'.repeat(64), 'wss://r', 'mention'], ['e', 'b'.repeat(64), 'wss://r', 'reply']] }), true);
// Tag "e" tanpa id harus diabaikan, bukan dianggap balasan.
eq('tag "e" tanpa id diabaikan', note.isReply({ tags: [['e']] }), false);
// Catatan yang menautkan ke REPO (bukan catatan) tidak boleh bikin salah tebak.
eq('hanya tag p -> bukan balasan', note.isReply({ tags: [['p', 'c'.repeat(64)]] }), false);

console.log('--- 2. NIP-18: target kutipan ---');
const targets = note.quoteTargets(QUOTE);
eq('kutipan nyata: satu target', targets.length, 1);
eq('id target benar', targets[0].id, '4a63646d83035656a88bdc2a9f90b2c48e3cff5a4fce7f8fb8d5a039f4c9a157');
eq('relay target dibaca', targets[0].relay, 'wss://relay.damus.io/');
eq('pubkey target dibaca', targets[0].pubkey, '78ce6faa72264387284e647ba6938995735ec8c7d5c5a65737e55130f026307d');
eq('balasan tanpa tag q -> tidak ada target', note.quoteTargets(REPLY).length, 0);
eq('tanpa tags -> tidak ada target', note.quoteTargets({}).length, 0);
eq('id tag q bukan heksadesimal 64 -> ditolak',
    note.quoteTargets({ tags: [['q', 'bukan-hex']] }).length, 0);
eq('id tag q kurang panjang -> ditolak',
    note.quoteTargets({ tags: [['q', 'a'.repeat(63)]] }).length, 0);
eq('dua tag q -> dua target',
    note.quoteTargets({ tags: [['q', 'a'.repeat(64)], ['q', 'b'.repeat(64)]] }).length, 2);
eq('id huruf besar dinormalkan ke kecil',
    note.quoteTargets({ tags: [['q', 'A'.repeat(64)]] })[0].id, 'a'.repeat(64));

console.log('--- 3. tautan GitHub: penguraian ---');
const gh = note.githubRepo('https://github.com/Conduit-BTC/conduit-mono/blob/main/docs/OPEN_MARKETS.md');
eq('tautan berkas nyata: owner', gh.owner, 'Conduit-BTC');
eq('tautan berkas nyata: repo', gh.repo, 'conduit-mono');
eq('tautan berkas nyata: path', gh.path, 'blob/main/docs/OPEN_MARKETS.md');
eq('url dasbor dibersihkan', gh.url, 'https://github.com/Conduit-BTC/conduit-mono');

const plain = note.githubRepo('https://github.com/honojs/hono');
eq('tautan repo polos: owner', plain.owner, 'honojs');
eq('tautan repo polos: repo', plain.repo, 'hono');
eq('tautan repo polos: path kosong', plain.path, '');
eq('akhiran .git dibuang', note.githubRepo('https://github.com/honojs/hono.git').repo, 'hono');
eq('www diterima', note.githubRepo('https://www.github.com/honojs/hono').repo, 'hono');

eq('github.com tanpa repo -> null', note.githubRepo('https://github.com/honojs'), null);
eq('halaman settings bukan repo', note.githubRepo('https://github.com/settings/profile'), null);
eq('halaman topics bukan repo', note.githubRepo('https://github.com/topics/javascript'), null);
eq('host palsu ditolak', note.githubRepo('https://github.com.evil.example/honojs/hono'), null);
eq('subdomain gist ditolak', note.githubRepo('https://gist.github.com/user/abc123'), null);
eq('domain lain ditolak', note.githubRepo('https://gitlab.com/honojs/hono'), null);
eq('bukan url ditolak', note.githubRepo('bukan url'), null);
eq('bukan string ditolak', note.githubRepo(null), null);
eq('skema javascript: ditolak', note.githubRepo('javascript:alert(1)'), null);
eq('skema file: ditolak', note.githubRepo('file:///etc/passwd'), null);

console.log('--- 4. angka bintang ---');
eq('di bawah 1000 apa adanya', note.formatCount(0), '0');
eq('999 apa adanya', note.formatCount(999), '999');
eq('1000 jadi 1k', note.formatCount(1000), '1k');
eq('1234 jadi 1.2k', note.formatCount(1234), '1.2k');
eq('12345 jadi 12.3k', note.formatCount(12345), '12.3k');
eq('tidak dibulatkan ke atas', note.formatCount(1999), '1.9k');

console.log('--- 5. kartu repo: penyusunan ---');
const card = note.repoCardHtml(
    { owner: 'Conduit-BTC', repo: 'conduit-mono', path: 'blob/main/docs/OPEN_MARKETS.md', url: 'https://github.com/Conduit-BTC/conduit-mono' },
    { full_name: 'Conduit-BTC/conduit-mono', description: 'A Bitcoin <script> relay', stargazers_count: 1234, language: 'Rust', owner_avatar: 'https://avatars.githubusercontent.com/u/1?v=4' }
);
ok('kartu punya tautan keluar', card.includes('href="https://github.com/Conduit-BTC/conduit-mono"'));
ok('tautan keluar aman (noopener)', card.includes('rel="noopener noreferrer"'));
ok('nama repo tampil', card.includes('Conduit-BTC/conduit-mono'));
ok('deskripsi tampil', card.includes('A Bitcoin'));
ok('bintang tampil', card.includes('\u2605 1.2k'));
ok('bahasa tampil', card.includes('Rust'));
ok('path berkas tampil', card.includes('blob/main/docs/OPEN_MARKETS.md'));
ok('deskripsi ber-<script> di-escape', !note.repoCardHtml(
    { owner: 'a', repo: 'b', path: '', url: 'https://github.com/a/b' },
    { full_name: 'a/b', description: '<script>alert(1)</script>', stargazers_count: 1, language: '', owner_avatar: '' }
).includes('<script>alert'));
ok('tanpa deskripsi tidak ada blok deskripsi', !note.repoCardHtml(
    { owner: 'a', repo: 'b', path: '', url: 'https://github.com/a/b' },
    { full_name: 'a/b', description: '', stargazers_count: null, language: '', owner_avatar: '' }
).includes('gh-card-desc'));
eq('data kosong -> tanpa markup', note.repoCardHtml(null, null), '');

console.log('--- 6. kartu kutipan ---');
const qc = note.quoteCardHtml(REPLY);
ok('kartu kutipan memuat isi catatan', qc.includes('Yes 100%'));
ok('kelas author- dipakai (agar profil terisi otomatis)', qc.includes('class="author-78ce6faa'));
ok('kelas avatar- dipakai', qc.includes('class="avatar-78ce6faa'));
ok('isi ber-<script> di-escape', !note.quoteCardHtml({ pubkey: 'a'.repeat(64), content: '<script>alert(1)</script>' }).includes('<script>alert'));
eq('ev null -> tanpa markup', note.quoteCardHtml(null), '');

const longText = 'x'.repeat(400);
const ql = note.quoteCardHtml({ pubkey: 'a'.repeat(64), content: longText });
ok('isi panjang dipotong', ql.includes('\u2026'));
ok('isi panjang tidak melebihi batas + penanda', ql.length < 400 + 400);

const withImg = note.quoteCardHtml({ pubkey: 'a'.repeat(64), content: 'lihat https://example.com/foto.png ya' });
eq('gambar pertama terdeteksi', note.firstImageUrl({ content: 'lihat https://example.com/foto.png ya' }), 'https://example.com/foto.png');
eq('tanpa gambar -> null', note.firstImageUrl({ content: 'tanpa gambar' }), null);
ok('gambar dipakai di kartu kutipan', withImg.includes('t-quote-media'));

console.log('--- 7. pemasangan kartu kutipan (tanpa relay) ---');
const holder = { children: [], appendChild(el) { this.children.push(el); } };

// Tanpa document nyata, appendQuoteCard berhenti dengan aman (null), tapi
// jumlah target yang dipakai tetap bisa diperiksa.
eq('catatan tanpa tag q -> 0 target dipasang', note.mountQuotes(holder, REPLY, {}), 0);

// Dengan get() yang mengembalikan catatan dari singgahan, jalur sinkron dipakai.
let cache = { [targets[0].id]: QUOTE };
const before = holder.children.length;
note.mountQuotes(holder, QUOTE, { get: (id) => cache[id] || null });
eq('holder tidak berubah tanpa document (aman di Node)', holder.children.length, before);
eq('get dipanggil dengan id target yang benar', (() => {
    let seen = null;
    note.mountQuotes(holder, QUOTE, { get: (id) => { seen = id; return null; }, load: () => Promise.resolve(null) });
    return seen;
})(), targets[0].id);

// load() gagal -> tidak ada yang dipasang, tidak ada galat.
let loadCalled = 0;
note.mountQuotes(holder, QUOTE, { load: () => { loadCalled++; return Promise.resolve(null); } });
eq('load dipanggil sekali per target', loadCalled, 1);

// onEvent/after tidak dipanggil kalau catatannya tidak ditemukan.
let afterCalled = 0;
note.mountQuotes(holder, QUOTE, { load: () => Promise.resolve(null), after: () => { afterCalled++; } });
await new Promise(r => setTimeout(r, 10));
eq('after tidak dipanggil saat gagal', afterCalled, 0);

console.log('--- 8. ambil catatan berdasarkan id (penjaga) ---');
eq('id bukan hex -> null tanpa membuka socket', await note.fetchEventById('bukan-id'), null);
eq('id null -> null', await note.fetchEventById(null), null);
note.setRelays([]);
eq('daftar relay kosong -> null', await note.fetchEventById('a'.repeat(64)), null);
note.setRelays('bukan array');
eq('daftar relay bukan array -> null', await note.fetchEventById('a'.repeat(64)), null);

// ============ 9. catatan mesin (JSON presence/telemetri) ============
// Sampel ASLI dari relay bos, 2026-10-11.
console.log('--- 9. catatan mesin ---');
const MACHINE = [
    { kind: 1, content: '{"type":"presence","payload":"online"}', tags: [["t", "type"]] },
    { kind: 1, content: '{"v":1,"online":true,"ts":1791657534}', tags: [["t", "presence"]] },
    { kind: 1, content: '{"type":"PresenceHeartbeat","senderKey":"74cc6f02","senderName":"test999","timestamp":1791657554377}', tags: [["t", "t"]] },
    { kind: 1, content: '  {"type":"presence"}  ', tags: [["t", "presence"]] }, // spasi + tag mesin
];
for (const ev of MACHINE) ok('mesin: ' + ev.content.slice(0, 40), note.isMachineNote(ev) === true);

// Aktivitas olahraga Gaspool JUGA JSON — HARUS tetap tampil.
const SPORT = {
    kind: 1, content: '{"sport":"cycling","title":"Jumat Gaul","distance":28.6,"duration":"01:41:04"}',
    tags: [["t", "activity"]]
};
ok('aktivitas Gaspool TIDAK dianggap mesin', note.isMachineNote(SPORT) === false);

// Yang jelas bukan mesin.
ok('tulisan biasa bukan mesin', note.isMachineNote({ kind: 1, content: 'Halo dunia', tags: [] }) === false);
ok('JSON bukan objek (larik) bukan mesin', note.isMachineNote({ kind: 1, content: '[1,2,3]', tags: [] }) === false);
ok('JSON satu kunci tanpa tag bukan mesin', note.isMachineNote({ kind: 1, content: '{"foo":"bar"}', tags: [] }) === false);
ok('teks yang dimulai { tapi bukan JSON bukan mesin', note.isMachineNote({ kind: 1, content: '{ halo }', tags: [] }) === false);
ok('kind lain bukan mesin', note.isMachineNote({ kind: 7, content: '{"type":"presence","payload":"online"}', tags: [] }) === false);
ok('catatan kosong bukan mesin', note.isMachineNote({ kind: 1, content: '', tags: [] }) === false);
ok('tanpa field content aman', note.isMachineNote({ kind: 1, tags: [] }) === false);
ok('ev null aman', note.isMachineNote(null) === false);

console.log(results.join('\n'));
console.log(`\n${pass} ok, ${fail} gagal`);
process.exit(fail ? 1 : 0);
