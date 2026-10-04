/* Tes untuk assets/nostr-embed.js — jalankan: node tests/nostr-embed.test.mjs
   Murni (tanpa browser, tanpa jaringan): hanya aturan deteksi URL YouTube dan
   bentuk markup pemutar. Perilaku klik diuji di browser sungguhan. */
import embed from '../assets/nostr-embed.js';

let pass = 0, fail = 0;
const results = [];

function ok(name, cond, extra) {
    if (cond) { pass++; results.push(`  ok   ${name}`); }
    else { fail++; results.push(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
}

function eq(name, actual, expected) {
    ok(name, actual === expected, `dapat ${JSON.stringify(actual)}, harusnya ${JSON.stringify(expected)}`);
}

// ---------- 1. URL asli dari catatan bos 29 Sep 2026 (kind 1, via Jumble) ----------
const REAL_URL = 'https://youtu.be/hop_rtjHI8g?si=ChcCBqqkIngFi-bH';
eq('catatan asli bos: youtu.be + ?si= -> id', embed.youTubeId(REAL_URL), 'hop_rtjHI8g');

// ---------- 2. bentuk URL YouTube yang lazim ----------
const shouldMatch = {
    'watch biasa': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'watch tanpa www': 'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'watch http': 'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'watch mobile (m.)': 'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'watch music': 'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'watch dengan parameter tambahan': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&feature=share',
    'watch dengan parameter sebelum v': 'https://www.youtube.com/watch?si=abc&v=dQw4w9WgXcQ',
    'shorts': 'https://www.youtube.com/shorts/abcdefghijk',
    'live': 'https://www.youtube.com/live/abcdefghijk?feature=share',
    'embed': 'https://www.youtube.com/embed/abcdefghijk',
    'nocookie embed': 'https://www.youtube-nocookie.com/embed/abcdefghijk',
    'youtu.be tanpa parameter': 'https://youtu.be/abcdefghijk',
    'youtu.be dengan stempel waktu': 'https://youtu.be/abcdefghijk?t=90'
};

for (const [label, url] of Object.entries(shouldMatch)) {
    const expected = url.includes('dQw4w9WgXcQ') ? 'dQw4w9WgXcQ' : 'abcdefghijk';
    eq(label, embed.youTubeId(url), expected);
}

// ---------- 3. tanda baca yang ikut tertelan regex pelink ----------
eq('di dalam tanda kurung', embed.youTubeId('(https://youtu.be/hop_rtjHI8g)'), 'hop_rtjHI8g');
eq('diikuti titik dan koma', embed.youTubeId('https://youtu.be/hop_rtjHI8g.,'), 'hop_rtjHI8g');
eq('diikuti tanda kutip', embed.youTubeId('https://youtu.be/hop_rtjHI8g"'), 'hop_rtjHI8g');
eq('&amp; hasil escapeHtml', embed.youTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&amp;t=10s'), 'dQw4w9WgXcQ');

// ---------- 4. yang BUKAN YouTube harus tetap jadi tautan biasa ----------
const shouldNotMatch = [
    'gambar blossom bos',
    'https://blossom.jeannesbryan.my.id/df00e25e7400d1cfcb49b8cb25ac8c07227885e3e3a0b2d6854eea3ffc2c70f4.png',
    'video unggahan manual (mp4)',
    'https://blossom.jeannesbryan.my.id/abc123.mp4',
    'situs lain', 'https://vimeo.com/123456789',
    'domain yang hanya mirip', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'subdomain jahat', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'id terlalu pendek', 'https://youtu.be/abc',
    'id terlalu panjang', 'https://youtu.be/abcdefghijkl',
    'watch tanpa v', 'https://www.youtube.com/watch?list=PL123',
    'skema aneh', 'javascript:alert(1)//youtu.be/abcdefghijk',
    'bukan url', 'kata biasa saja'
];
for (let i = 0; i < shouldNotMatch.length; i += 2) {
    eq('bukan video: ' + shouldNotMatch[i], embed.youTubeId(shouldNotMatch[i + 1]), null);
}
eq('null', embed.youTubeId(null), null);
eq('string kosong', embed.youTubeId(''), null);

// ---------- 5. markup pemutar ----------
const html = embed.playerHtml('hop_rtjHI8g');
ok('memuat data-yt-id', html.includes('data-yt-id="hop_rtjHI8g"'));
ok('thumbnail maxresdefault', html.includes('https://i.ytimg.com/vi/hop_rtjHI8g/maxresdefault.jpg'));
ok('cadangan hqdefault disiapkan', html.includes('data-yt-fallback="https://i.ytimg.com/vi/hop_rtjHI8g/hqdefault.jpg"'));
ok('thumbnail dimuat malas', html.includes('loading="lazy"'));
ok('BELUM ada iframe sebelum diklik', !html.includes('<iframe'));
ok('tanpa skrip pihak ketiga', !html.includes('<script'));
ok('ada tombol putar', html.includes('yt-play'));
eq('id tidak sah ditolak', embed.playerHtml('bukanid'), '');
eq('id kosong ditolak', embed.playerHtml(''), '');

// ---------- 6. kesetaraan gambar & video lama (tidak boleh berubah) ----------
ok('mp4 masih bukan youtube', embed.youTubeId('https://blossom.jeannesbryan.my.id/abc.webm') === null);

// ---------- 7. penyusun media: mana yang masuk grid, mana yang penuh ----------
const imgA = { full: false, html: '<div class="t-media-item"><img src="a.png" alt="A"></div>' };
const imgB = { full: false, html: '<div class="t-media-item"><img src="b.png" alt="B"></div>' };
const ytA = { full: true, html: embed.playerHtml('hop_rtjHI8g') };
const ytB = { full: true, html: embed.playerHtml('dQw4w9WgXcQ') };

eq('daftar kosong -> tidak ada markup', embed.buildMediaHtml([], 't-media-grid', 'mt-3'), '');
eq('null aman', embed.buildMediaHtml(null, 't-media-grid', 'mt-3'), '');

let satu = embed.buildMediaHtml([imgA], 't-media-grid', 'mt-3');
ok('satu gambar: dibungkus, bukan grid', satu.startsWith('<div class="mt-3">') && !satu.includes('t-media-grid'));

let dua = embed.buildMediaHtml([imgA, imgB], 't-media-grid', 'mt-3');
ok('dua gambar: dirapatkan jadi satu grid', (dua.match(/t-media-grid/g) || []).length === 1);
ok('dua gambar: keduanya ada di dalam grid', dua.includes('a.png') && dua.includes('b.png'));

// Kasus bos: gambar dulu, tautan YouTube sesudahnya.
let gambarLaluVideo = embed.buildMediaHtml([imgA, ytA], 't-media-grid', 'mt-3');
ok('gambar lalu video: grid muncul lebih dulu', gambarLaluVideo.indexOf('t-media-grid') < gambarLaluVideo.indexOf('yt-embed'));
ok('video TIDAK ikut masuk grid', gambarLaluVideo.indexOf('yt-embed') > gambarLaluVideo.indexOf('</div><div class="mt-3">'));
ok('video dibungkus blok sendiri', gambarLaluVideo.includes('<div class="mt-3"><div class="yt-embed"'));
ok('grid di sini berisi satu gambar saja (1 pembungkus mt-3)',
    (gambarLaluVideo.match(/<div class="mt-3">/g) || []).length === 2);

// Kebalikannya: video dulu, gambar sesudahnya. Urutan harus tetap seperti aslinya
// — inilah alasan pengumpulannya satu lintasan, bukan dua.
let videoLaluGambar = embed.buildMediaHtml([ytA, imgA], 't-media-grid', 'mt-3');
ok('video lalu gambar: video tetap lebih dulu', videoLaluGambar.indexOf('yt-embed') < videoLaluGambar.indexOf('a.png'));
ok('video lalu gambar: gambar tetap tampil', videoLaluGambar.includes('a.png'));

// Dua video berurutan: keduanya blok penuh, tidak ada grid sama sekali.
let duaVideo = embed.buildMediaHtml([ytA, ytB], 't-media-grid', 'mt-3');
ok('dua video: tanpa grid', !duaVideo.includes('t-media-grid'));
ok('dua video: keduanya blok penuh', (duaVideo.match(/<div class="mt-3">/g) || []).length === 2);

// Gambar mengapit video. Kedua gambar TIDAK boleh dirapatkan jadi satu grid,
// karena itu berarti memindahkan video dari posisinya di dalam catatan. Jadi
// yang benar: tiga blok berurutan tanpa grid sama sekali.
let berselang = embed.buildMediaHtml([imgA, ytA, imgB], 't-media-grid', 'mt-3');
eq('gambar-video-gambar: tanpa grid (kedua gambar tidak boleh digabung)',
    (berselang.match(/t-media-grid/g) || []).length, 0);
eq('gambar-video-gambar: tiga blok berurutan', (berselang.match(/<div class="mt-3">/g) || []).length, 3);
ok('gambar-video-gambar: video tetap di antara kedua gambar',
    berselang.indexOf('a.png') < berselang.indexOf('yt-embed') && berselang.indexOf('yt-embed') < berselang.indexOf('b.png'));

ok('kelas grid bisa diganti pemanggil', embed.buildMediaHtml([imgA, imgB], 'grid-x', 'w-1').includes('class="grid-x"'));
ok('kelas pembungkus bisa diganti pemanggil', embed.buildMediaHtml([ytA], 'grid-x', 'w-1').includes('<div class="w-1">'));
ok('nama berkas tetap jadi bawaan', embed.buildMediaHtml([imgA, imgB]).includes('class="media-grid"'));

// ---------- 8. extraAttrs: dipakai index untuk spoiler NSFW ----------
// Atribut harus menempel di elemen yang SAMA dengan kelasnya, bukan di
// pembungkus baru — kalau tidak, cek t-spoiler di dalam gambar tidak menemukannya.
const ATTR = 'onclick="this.classList.remove(\'t-spoiler\');"';
let spoiler1 = embed.buildMediaHtml([imgA], 't-media-grid t-spoiler', 't-spoiler', ATTR);
ok('extraAttrs ikut di pembungkus tunggal', spoiler1.includes('<div class="t-spoiler" ' + ATTR + '>'));
let spoiler2 = embed.buildMediaHtml([imgA, imgB], 't-media-grid t-spoiler', 't-spoiler', ATTR);
ok('extraAttrs ikut di grid', spoiler2.includes('<div class="t-media-grid t-spoiler" ' + ATTR + '>'));
let spoiler3 = embed.buildMediaHtml([ytA], 't-media-grid t-spoiler', 't-spoiler', ATTR);
ok('extraAttrs ikut di blok video penuh', spoiler3.includes('<div class="t-spoiler" ' + ATTR + '>'));
ok('tanpa extraAttrs tidak ada atribut nyasar', !embed.buildMediaHtml([imgA], 'g', 'w').includes('onclick'));
ok('extraAttrs kosong aman', embed.buildMediaHtml([imgA], 'g', 'w', '').includes('<div class="w">'));

console.log(results.join('\n'));
console.log(`\n${pass} ok, ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);
