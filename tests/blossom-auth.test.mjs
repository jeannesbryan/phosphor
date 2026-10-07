/* Tes untuk tag otorisasi BUD-11 yang dikirim Phosphor saat mengunggah media.
   Jalankan: node tests/blossom-auth.test.mjs

   Kenapa tes ini ada (2026-10-07)
   -------------------------------
   blossom-server 6.4.1 memperketat BUD-11: tag `x` (sha256 blob) sekarang
   WAJIB untuk upload/delete. Sebelumnya tag itu opsional — kalau tidak ada,
   pemeriksaan dilewati. Phosphor mengirim tag bernama `payload`, sehingga
   upload-nya DITOLAK 403 begitu server dinaikkan ke 6.4.1:
     "Auth token does not authorize operation on blob <hash>"
   Sudah dibuktikan langsung ke server 6.4.1: dengan `payload` -> HTTP 403,
   dengan `x` -> HTTP 201.

   Tes ini membaca berkas halaman yang sesungguhnya (bukan salinan), mengambil
   blok `let authEvent = {...}` di dalamnya, MENJALANKANNYA, lalu memeriksa
   tag yang dihasilkan. Jadi bukan pencocokan teks — kalau suatu saat tag-nya
   diubah lagi jadi salah, tes ini gagal.
*/
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const lines = [];

function ok(name, cond, extra) {
    if (cond) { pass++; lines.push(`  ok   ${name}`); }
    else { fail++; lines.push(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
}

const HAS_AUTH = 24242;
const pages = readdirSync(root).filter((f) => f.endsWith('.html'));
let checked = 0;

for (const file of pages) {
    const html = readFileSync(join(root, file), 'utf8');
    if (!html.includes(String(HAS_AUTH))) continue;   // halaman tanpa upload

    const match = html.match(/let authEvent = \{[\s\S]*?\};/);
    ok(`${file}: ada blok authEvent`, !!match);
    if (!match) continue;

    // Variabel yang dipakai kode aslinya, diberi nilai uji.
    const uploadEndpoint = 'https://blossom.example/upload';
    const hashHex = 'a1'.repeat(32);
    const nowTimestamp = 1791000000;
    const currentUserPubkey = 'f'.repeat(64);

    let authEvent;
    // Menjalankan kode yang benar-benar ada di berkas halaman.
    eval(match[0].replace('let authEvent =', 'authEvent ='));
    checked++;

    const xTags = authEvent.tags.filter((t) => t[0] === 'x');
    ok(`${file}: kind 24242`, authEvent.kind === HAS_AUTH, `dapat ${authEvent.kind}`);
    ok(`${file}: ada tepat satu tag x`, xTags.length === 1, `dapat ${xTags.length}`);
    ok(`${file}: tag x berisi hash blob`, xTags[0] && xTags[0][1] === hashHex,
        xTags[0] ? String(xTags[0][1]) : 'tidak ada');
    ok(`${file}: TIDAK memakai tag payload`,
        !authEvent.tags.some((t) => t[0] === 'payload'),
        'tag payload ditolak blossom >= 6.4.1');
    ok(`${file}: scope t=upload`,
        authEvent.tags.some((t) => t[0] === 't' && t[1] === 'upload'));
    ok(`${file}: ada expiration`,
        authEvent.tags.some((t) => t[0] === 'expiration'));
    ok(`${file}: method PUT`,
        authEvent.tags.some((t) => t[0] === 'method' && t[1] === 'PUT'));
}

ok('semua halaman pengunggah diperiksa', checked >= 7, `dapat ${checked} halaman`);

console.log(lines.join('\n'));
console.log(`\n${pass} ok, ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);
