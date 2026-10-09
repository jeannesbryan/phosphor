/* Tes untuk assets/blossom-auth.js — jalankan: node tests/blossom-auth.test.mjs
   Murni untuk bagian 1 & 2 (tanpa browser, tanpa jaringan, fetch ditipu).
   Bagian 3 memeriksa berkas halaman yang SESUNGGUHNYA.

   Kenapa tes ini ada
   ------------------
   2026-10-07: blossom-server 6.4.1 memperketat BUD-11 — tag `x` (sha256 blob)
   menjadi WAJIB untuk upload/delete. Phosphor waktu itu mengirim tag `payload`
   yang disalin ke TUJUH halaman, jadi setelah server dinaikkan semua unggahan
   ditolak `403 Auth token does not authorize operation on blob <hash>`.
   Sudah dibuktikan langsung ke server 6.4.1: `payload` -> HTTP 403, `x` -> 201.

   2026-10-09: aturan itu dipindahkan ke satu modul `assets/blossom-auth.js`
   atas persetujuan bos. Tes ini menjaga dua hal:
     (a) modul benar-benar menghasilkan tag `x` yang cocok dengan isi berkas —
         dibuktikan dengan menjalankan serangan `fetch` palsu dan menyidik
         header `Authorization` yang benar-benar dikirim;
     (b) halaman TIDAK lagi menyimpan salinan aturan itu sendiri — kalau ada
         yang menyalin ulang, tes gagal sebelum salinan itu jadi masalah.
*/
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import auth from '../assets/blossom-auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
    if (cond) { pass++; results.push(`  ok   ${name}`); }
    else { fail++; results.push(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
}
function eq(name, actual, expected) {
    ok(name, actual === expected, `dapat ${JSON.stringify(actual)}, harusnya ${JSON.stringify(expected)}`);
}
function okAsync(name, p, check) {
    return p.then((v) => { const r = check(v); ok(name, r.ok, r.extra); }, (e) => ok(name, false, 'melempar: ' + e));
}

/* ---------------------------------------------------------------- 1. KONTRAK */
eq('kind peristiwa otorisasi = 24242', auth.AUTH_KIND, 24242);
eq('batas berkas per catatan = 4', auth.MAX_FILES, 4);
eq('umur token = 60 detik', auth.AUTH_TTL_SECONDS, 60);

const ev = auth.buildAuthEvent({
    uploadEndpoint: 'https://blossom.example/upload',
    hashHex: 'a1'.repeat(32),
    pubkey: 'b2'.repeat(32),
    now: 1791000000
});
eq('created_at = now', ev.created_at, 1791000000);
eq('content tetap', ev.content, auth.AUTH_CONTENT);
eq('kind = 24242', ev.kind, 24242);
const tag = (k) => (ev.tags.find((t) => t[0] === k) || [])[1];
eq('tag u = URL upload', tag('u'), 'https://blossom.example/upload');
eq('tag method = PUT', tag('method'), 'PUT');
eq('tag x = hash blob', tag('x'), 'a1'.repeat(32));
eq('tag t = upload', tag('t'), 'upload');
eq('expiration = created_at + 60', tag('expiration'), '1791000060');
ok('TIDAK memakai tag payload (ditolak blossom >= 6.4.1)',
    !ev.tags.some((t) => t[0] === 'payload'));
eq('tepat satu tag x', ev.tags.filter((t) => t[0] === 'x').length, 1);

/* Alamat server dari config. */
eq('domain polos -> https + /upload',
    auth.uploadEndpointFor('blossom.jeannesbryan.my.id'), 'https://blossom.jeannesbryan.my.id/upload');
eq('sudah https + garis miring ekor',
    auth.uploadEndpointFor('https://blossom.example/'), 'https://blossom.example/upload');
eq('http dibiarkan apa adanya',
    auth.uploadEndpointFor('http://127.0.0.1:3099'), 'http://127.0.0.1:3099/upload');
eq('kosong -> fallback halaman',
    auth.uploadEndpointFor('', 'https://cadangan.example'), 'https://cadangan.example/upload');
eq('kosong tanpa fallback -> default modul',
    auth.uploadEndpointFor(undefined), auth.DEFAULT_SERVER + '/upload');

/* sha256: vektor uji baku untuk "abc". */
const abc = new TextEncoder().encode('abc').buffer;
await okAsync('sha256("abc") cocok vektor baku', auth.sha256Hex(abc), (h) => ({
    ok: h === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', extra: h
}));

/* Header = "Nostr " + base64(JSON peristiwa bertanda tangan). */
const tagVal = (tags, name) => {
    const t = (tags || []).find((x) => x[0] === name);
    return t ? t[1] : undefined;
};
const signed = { ...ev, id: 'c3'.repeat(32), sig: 'd4'.repeat(64) };
const header = auth.encodeAuthHeader(signed, (s) => Buffer.from(s, 'binary').toString('base64'));
ok('header berawalan "Nostr "', header.startsWith('Nostr '));
const decoded = JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'));
eq('header berisi peristiwa yang ditandatangani', decoded.sig, 'd4'.repeat(64));
eq('tag x ikut terkirim di header', tagVal(decoded.tags, 'x'), 'a1'.repeat(32));

/* ------------------------------------------------- 2. ALUR UI (fetch ditipu) */
function fakeFile(name, text) {
    return { name, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer) };
}

// fetch palsu yang merekam permintaan; mengembalikan seolah server 201.
let seen = [];
const okFetch = (url, opts) => {
    seen.push({ url, opts });
    return Promise.resolve({
        ok: true, status: 201,
        json: () => Promise.resolve({ url: 'https://blossom.example/' + 'e5'.repeat(32) + '.jpg' })
    });
};

const signer = (e) => Promise.resolve({ ...e, id: 'f6'.repeat(32), sig: 'a7'.repeat(64) });

seen = [];
const btn = { textContent: '[ MEDIA (0/4) ]' };
const ta = { value: '' };
const res1 = await auth.uploadSelectedFiles([fakeFile('foto.jpg', 'abc')], btn, ta, {
    servers: ['blossom.example'], pubkey: 'b2'.repeat(32), sign: signer,
    fetchImpl: okFetch, alertFn: (m) => results.push('  !! alert tak terduga: ' + m)
});
eq('satu berkas -> satu URL terkumpul', res1.uploaded.length, 1);
eq('URL ditempel ke textarea', ta.value, 'https://blossom.example/' + 'e5'.repeat(32) + '.jpg');
eq('tombol dikembalikan ke label semula', btn.textContent, '[ MEDIA (0/4) ]');
eq('endpoint dipakai dari servers[0]', res1.endpoint, 'https://blossom.example/upload');
eq('fetch dipanggil sekali', seen.length, 1);
eq('metode PUT', seen[0].opts.method, 'PUT');
eq('body = berkasnya sendiri', seen[0].opts.body.name, 'foto.jpg');

const authHeader = seen[0].opts.headers.Authorization;
const sentEv = JSON.parse(Buffer.from(authHeader.slice(6), 'base64').toString('utf8'));
eq('kind di header = 24242', sentEv.kind, 24242);
eq('tag x di header = sha256 isi berkas ("abc")',
    tagVal(sentEv.tags, 'x'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
ok('tag payload tidak pernah dikirim', !sentEv.tags.some((t) => t[0] === 'payload'));
eq('tag u di header = endpoint PUT', tagVal(sentEv.tags, 'u'), seen[0].url);

// Dua berkas -> dua baris di textarea.
seen = []; ta.value = ''; btn.textContent = '[ MEDIA (0/4) ]';
await auth.uploadSelectedFiles([fakeFile('a.jpg', 'x'), fakeFile('b.jpg', 'y')], btn, ta, {
    servers: ['blossom.example'], pubkey: 'b2'.repeat(32), sign: signer, fetchImpl: okFetch, alertFn: () => {}
});
eq('dua berkas -> dua URL di textarea', ta.value.split('\n').length, 2);
eq('teks tombol selama dua berkas ... ?', btn.textContent, '[ MEDIA (0/4) ]');

// Server menolak 403: pesan server HARUS terlihat, URL tidak ditempel.
seen = []; ta.value = '';
const alerts = [];
const errFetch = (url, opts) => Promise.resolve({
    ok: false, status: 403,
    text: () => Promise.resolve('Auth token does not authorize operation on blob 39f2...')
});
await auth.uploadSelectedFiles([fakeFile('c.jpg', 'z')], btn, ta, {
    servers: ['blossom.example'], pubkey: 'b2'.repeat(32), sign: signer,
    fetchImpl: errFetch, alertFn: (m) => alerts.push(m)
});
eq('403 -> textarea tetap kosong', ta.value, '');
eq('403 -> satu pesan galat', alerts.length, 1);
ok('pesan galat memuat sebab dari server', /does not authorize operation on blob/.test(alerts[0]), alerts[0]);
ok('pesan galat memuat status HTTP', /403/.test(alerts[0]), alerts[0]);
eq('tombol tetap dikembalikan', btn.textContent, '[ MEDIA (0/4) ]');

// Lebih dari 4 berkas: hanya 4 diproses, ada peringatan.
seen = []; ta.value = '';
const warn = [];
await auth.uploadSelectedFiles(
    [fakeFile('1', 'a'), fakeFile('2', 'b'), fakeFile('3', 'c'), fakeFile('4', 'd'), fakeFile('5', 'e')],
    btn, ta, { servers: ['blossom.example'], pubkey: 'b2'.repeat(32), sign: signer, fetchImpl: okFetch, alertFn: (m) => warn.push(m) }
);
eq('5 berkas -> hanya 4 diunggah', seen.length, 4);
eq('5 berkas -> satu peringatan', warn.length, 1);
ok('peringatan menyebut batas 4', /4/.test(warn[0]), warn[0]);

// Belum masuk: tidak ada permintaan sama sekali, tapi ada pemberitahuan.
seen = []; const notLogged = [];
await auth.uploadSelectedFiles([fakeFile('d.jpg', 'q')], btn, ta, {
    servers: ['blossom.example'], pubkey: null, sign: null, fetchImpl: okFetch, alertFn: (m) => notLogged.push(m)
});
eq('belum login -> tidak ada fetch', seen.length, 0);
eq('belum login -> ada pemberitahuan', notLogged.length, 1);
ok('belum login -> pesannya jelas', /login/i.test(notLogged[0]), notLogged[0]);

// Daftar server kosong -> jatuh ke fallback halaman.
seen = []; ta.value = '';
await auth.uploadSelectedFiles([fakeFile('e.jpg', 'w')], btn, ta, {
    servers: [], fallbackServer: 'https://cadangan.example',
    pubkey: 'b2'.repeat(32), sign: signer, fetchImpl: okFetch, alertFn: () => {}
});
eq('servers kosong -> pakai fallback', seen[0].url, 'https://cadangan.example/upload');

// ---------------------------------------------------------------- 3. HALAMAN */
const PAGES = ['index.html', 'thread.html', 'notes.html', 'notifications.html',
               'bookmark.html', 'relay.html', 'profile.html'];
let wired = 0;

for (const file of PAGES) {
    const html = readFileSync(join(root, file), 'utf8');
    ok(`${file}: memuat /assets/blossom-auth.js`, html.includes('/assets/blossom-auth.js'));
    ok(`${file}: ada penjaga window.BlossomAuth (gagal modul = terlihat)`,
        /window\.BlossomAuth/.test(html));
    ok(`${file}: memanggil BlossomAuth.uploadSelectedFiles`,
        /BlossomAuth\.uploadSelectedFiles\s*\(/.test(html));
    ok(`${file}: TIDAK menyimpan salinan aturan (kind 24242)`,
        !/kind\s*:\s*24242/.test(html), 'salinan aturan otorisasi ditemukan di halaman');
    ok(`${file}: TIDAK menyusun tag x sendiri`,
        !/\[\s*["']x["']\s*,\s*hashHex\s*\]/.test(html),
        'salinan tag x ditemukan di halaman');
    ok(`${file}: TIDAK memakai tag payload`,
        !/\[\s*["']payload["']\s*,/.test(html));
    /* Sengaja TIDAK memeriksa semua `subtle.digest`: `index.html` punya
       `minePoW()` yang sah-sah saja menghitung sha256 dari peristiwa yang
       diserialisasi (bukan dari isi berkas). Yang harus hilang dari halaman
       adalah sidik jari unggahan: menghitung hash dari `file.arrayBuffer()`. */
    ok(`${file}: tidak lagi menghitung sha256 isi berkas sendiri`,
        !/file\.arrayBuffer\s*\(/.test(html),
        'sidik jari unggahan (file.arrayBuffer + digest) masih ada di halaman');
    wired++;
}
eq('ketujuh halaman pengunggah diperiksa', wired, 7);

// Modul harus tetap menjadi satu-satunya definisi aturan itu di repo.
const modSrc = readFileSync(join(root, 'assets/blossom-auth.js'), 'utf8');
ok('modul mendefinisikan kind 24242', /AUTH_KIND\s*=\s*24242/.test(modSrc));
ok('modul memakai tag x', /\[\s*'x',\s*opts\.hashHex\s*\]/.test(modSrc));
ok('modul tidak memakai tag payload', !/'payload'/.test(modSrc));

console.log(results.join('\n'));
console.log(`\n${pass} ok, ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);
