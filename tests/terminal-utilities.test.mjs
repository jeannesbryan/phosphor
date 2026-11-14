/* Guards for framework utility classes used by these pages. Run: node tests/terminal-utilities.test.mjs

   Why this file exists. Five elements across two pages used `t-border-left`
   while terminal.css only defined `t-border-top` and `t-border-bottom`. A class
   that does not exist produces no error and no console warning: the element
   simply has no rule, so what the author wrote as a bordered callout rendered
   as plain unstyled text. The same class list also carried `pl-2`, `pl-3` and
   `ml-2`, none of which existed either, so even after adding the border the
   content would have sat flush against the line.

   Found by comparing the class names in the HTML against the selectors in the
   stylesheet, not by reading code. That comparison is what this file automates.

   Scope: only classes shaped like framework utilities. Page-local classes and
   mount-point classes are listed below with a reason, because a rule is not
   always the right fix for them.
*/

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AKAR = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(AKAR, 'assets/terminal.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0, fail = 0;
const hasil = [];
function ok(nama, syarat, detail) {
    if (syarat) { pass++; hasil.push(`  ok   ${nama}`); }
    else { fail++; hasil.push(`  FAIL ${nama}${detail ? ' -> ' + detail : ''}`); }
}

/* ---- kelas yang didefinisikan stylesheet ---- */
const didefinisi = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) didefinisi.add(m[1]);

/* ---- kelas yang dipakai halaman ---- */
const dipakai = new Map(); // kelas -> Set(berkas)
for (const f of readdirSync(AKAR).filter(x => x.endsWith('.html'))) {
    const isi = readFileSync(join(AKAR, f), 'utf8');
    for (const m of isi.matchAll(/class="([^"]*)"/g)) {
        for (const c of m[1].split(/\s+/)) {
            if (!c) continue;
            if (!dipakai.has(c)) dipakai.set(c, new Set());
            dipakai.get(c).add(f);
        }
    }
}

/* ---- bentuk kelas framework ---- */
const POLA = /^(t-|d-|pt-|pb-|pl-|pr-|px-|py-|p-|mt-|mb-|ml-|mr-|mx-|my-|m-|fs-|text-|gap-)/;

/* Kelas lokal halaman atau titik pasang yang memang tidak perlu aturan CSS.
   Setiap entri wajib punya alasan, supaya daftar ini tidak menjadi tempat
   menyembunyikan kelas yang sebenarnya lupa didefinisikan. */
const TANPA_ATURAN = new Map([
    ['t-quote-holder', 'titik pasang untuk nostr-note.js; dipakai sebagai query selector, bukan untuk ditata'],
]);

const hilang = [];
for (const [c, berkas] of dipakai) {
    if (!POLA.test(c)) continue;
    if (didefinisi.has(c)) continue;
    if (TANPA_ATURAN.has(c)) continue;
    hilang.push({ kelas: c, berkas: [...berkas].join(', ') });
}

ok('semua kelas utilitas framework yang dipakai halaman didefinisikan di terminal.css',
    hilang.length === 0,
    hilang.map(h => `${h.kelas} [${h.berkas}]`).join(' ; '));

/* Daftar putih tidak boleh basi: kalau kelasnya sudah didefinisikan, entrinya
   harus dihapus supaya tidak menyamarkan masalah lain di masa depan. */
for (const [c] of TANPA_ATURAN) {
    ok(`daftar putih "${c}" belum basi (masih belum didefinisikan)`, !didefinisi.has(c));
}

/* ---- keluarga border harus lengkap ---- */
for (const sisi of ['top', 'bottom', 'left', 'right']) {
    ok(`.t-border-${sisi} ada`, didefinisi.has(`t-border-${sisi}`));
}
ok('.t-border ada', didefinisi.has('t-border'));
ok('.t-border-accent ada (pengganti inline border-left-color)',
    didefinisi.has('t-border-accent'));

/* ---- keluarga spacing harus lengkap di keempat sisi ----
   pt/pb pernah ditambahkan lebih dulu sementara pl/pr tertinggal; pola yang
   sama bisa terulang, jadi kelengkapannya diperiksa sekaligus. */
const SISI_SPACING = ['p', 'pt', 'pb', 'pl', 'pr', 'px', 'py', 'm', 'mt', 'mb', 'ml', 'mr', 'mx', 'my'];
for (const awalan of SISI_SPACING) {
    const lengkap = [1, 2, 3, 4, 5].every(n => didefinisi.has(`${awalan}-${n}`));
    ok(`keluarga .${awalan}-1 sampai .${awalan}-5 lengkap`, lengkap,
        [1, 2, 3, 4, 5].filter(n => !didefinisi.has(`${awalan}-${n}`)).map(n => `${awalan}-${n}`).join(', '));
}

/* ---- skala font-size tidak boleh berlubang ----
   fs-4 hilang sementara fs-1..fs-3 ada, jadi judul artikel jatuh ke ukuran
   badan teks. Skala yang berlubang selalu terlihat sebagai "kok kecil". */
for (const n of [1, 2, 3, 4]) {
    ok(`.fs-${n} ada`, didefinisi.has(`fs-${n}`));
}
ok('.fs-small ada', didefinisi.has('fs-small'));

/* ---- nilai skala konsisten dengan tetangganya ----
   pl-2 harus 10px karena pt-2 10px. Kalau salah satu menyimpang, padding
   vertikal dan horizontal pada satu elemen tidak lagi sejajar. */
function nilai(sel) {
    const re = new RegExp('\\.' + sel.replace(/[-]/g, '\\-') + '\\s*\\{([^}]*)\\}');
    const m = css.match(re);
    if (!m) return null;
    const px = m[1].match(/(\d+)px/);
    return px ? Number(px[1]) : null;
}
const SKALA = { 1: 5, 2: 10, 3: 15, 4: 20, 5: 30 };
for (const n of [1, 2, 3, 4, 5]) {
    ok(`.pl-${n} bernilai ${SKALA[n]}px seperti skala pt/mt`,
        nilai(`pl-${n}`) === SKALA[n], String(nilai(`pl-${n}`)));
    ok(`.ml-${n} bernilai ${SKALA[n]}px seperti skala mt`,
        nilai(`ml-${n}`) === SKALA[n], String(nilai(`ml-${n}`)));
}

/* ---- relay.html tidak lagi menaruh warna border secara inline ----
   Stylesheet !important mengalahkan inline style (terukur di Chrome), jadi
   inline border-left-color pada elemen ber-.t-border-left akan diabaikan tanpa
   pesan apa pun. Warna harus lewat kelas. */
for (const f of readdirSync(AKAR).filter(x => x.endsWith('.html'))) {
    const isi = readFileSync(join(AKAR, f), 'utf8');
    const polaInline = /class="[^"]*t-border-(left|right|top|bottom)[^"]*"[^>]*style="[^"]*border-(left|right|top|bottom)-color/g;
    const ketemu = isi.match(polaInline) || [];
    ok(`${f}: tidak ada border-*-color inline pada elemen t-border-*`,
        ketemu.length === 0, ketemu.join(' ; '));
}

console.log(hasil.join('\n'));
console.log(`\n${pass} ok, ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);
