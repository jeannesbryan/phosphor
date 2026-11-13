/* Tes untuk assets/nostr-article.js. Jalankan: node tests/nostr-article.test.mjs

   Murni: tanpa browser, tanpa jaringan. Yang diuji bukan pencocokan teks, tetapi
   perilaku fungsi terhadap bentuk isi artikel yang benar-benar ada di relay:
   artikel 01 (tanpa heading) dan artikel 02 sampai 06 (dengan heading `# Judul`).
*/
import articleModule from '../assets/nostr-article.js';

const A = articleModule.default || articleModule;
const strip = A.stripDuplicateTitle;

let pass = 0, fail = 0;
const results = [];

function ok(name, cond, extra) {
    if (cond) { pass++; results.push(`  ok   ${name}`); }
    else { fail++; results.push(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
}

function eq(name, actual, expected) {
    ok(name, actual === expected,
       `dapat ${JSON.stringify(actual)}, harusnya ${JSON.stringify(expected)}`);
}

const JUDUL = 'Mengunci Onion Service dari Serangan DoS';

/* 1. Bentuk artikel 02-06: heading di baris pertama, sama dengan judul. */
eq('heading pembuka yang sama dibuang',
   strip(`# ${JUDUL}\n\nParagraf pembuka.`, JUDUL),
   'Paragraf pembuka.');

/* 2. Tanpa baris kosong sesudah heading. */
eq('tanpa baris kosong sesudah heading',
   strip(`# ${JUDUL}\nParagraf pembuka.`, JUDUL),
   'Paragraf pembuka.');

/* 3. Bentuk artikel 01: tidak ada heading, isi harus utuh. */
const tanpaHeading = 'Pernah melihat alamat situs web Tor yang bagian depannya bisa dibaca?';
eq('isi tanpa heading tidak diubah', strip(tanpaHeading, JUDUL), tanpaHeading);

/* 4. Heading berbeda dari judul = bagian isi, jangan dibuang. */
eq('heading berbeda dibiarkan',
   strip('# Judul Lain\n\nIsi.', JUDUL),
   '# Judul Lain\n\nIsi.');

/* 5. Beda kapitalisasi dan spasi berlebih tetap dianggap sama. */
eq('beda kapitalisasi tetap dibuang',
   strip('# mengunci onion service dari serangan dos\n\nIsi.', JUDUL),
   'Isi.');
eq('spasi berlebih tetap dibuang',
   strip('#   Mengunci  Onion   Service dari Serangan DoS  \n\nIsi.', JUDUL),
   'Isi.');

/* 6. Heading tingkat dua bukan urusan modul ini. Diuji dua bentuk: teks yang
   berbeda, dan teks yang SAMA PERSIS dengan judul. Yang kedua penting, karena
   renderer mencetak judul sebagai h1; `## Judul` di bawahnya tampil sebagai
   subjudul, bukan duplikat, jadi tidak boleh ikut dibuang. */
eq('h2 pembuka tidak disentuh',
   strip('## Sub Bagian\n\nIsi.', JUDUL),
   '## Sub Bagian\n\nIsi.');
eq('h2 dengan judul yang sama tetap tidak disentuh',
   strip(`## ${JUDUL}\n\nIsi.`, JUDUL),
   `## ${JUDUL}\n\nIsi.`);

/* 7. Heading di TENGAH artikel adalah isi, bukan judul. Ini berbeda dari
   perilaku lama Phosphor yang memakai find() ke seluruh dokumen. */
const tengah = `Paragraf awal.\n\n# ${JUDUL}\n\nParagraf berikutnya.`;
eq('heading di tengah tidak disentuh', strip(tengah, JUDUL), tengah);

/* 8. Judul kosong = tidak ada dasar membuang apa pun. */
eq('judul kosong: isi utuh', strip(`# ${JUDUL}\n\nIsi.`, ''), `# ${JUDUL}\n\nIsi.`);
eq('judul null: isi utuh', strip(`# ${JUDUL}\n\nIsi.`, null), `# ${JUDUL}\n\nIsi.`);
eq('judul undefined: isi utuh', strip(`# ${JUDUL}\n\nIsi.`, undefined), `# ${JUDUL}\n\nIsi.`);

/* 9. Isi kosong atau null tidak boleh melempar. */
eq('content kosong', strip('', JUDUL), '');
eq('content null', strip(null, JUDUL), '');
eq('content undefined', strip(undefined, JUDUL), '');
eq('content hanya baris kosong', strip('\n\n\n', JUDUL), '\n\n\n');

/* 10. Baris kosong di awal isi tidak menghalangi pengenalan heading. */
eq('baris kosong di awal tetap dikenali',
   strip(`\n\n# ${JUDUL}\n\nIsi.`, JUDUL),
   'Isi.');

/* 11. Jangan merusak sisa isi: seluruh byte sesudah heading harus sama. */
const sisa = 'Baris satu.\n\n```bash\ntor --version\n```\n\nBaris terakhir.';
eq('sisa isi utuh byte demi byte',
   strip(`# ${JUDUL}\n\n${sisa}`, JUDUL), sisa);

/* 12. Heading yang isinya hanya tanda pagar atau kosong. */
eq('heading kosong tidak dibuang', strip('#\n\nIsi.', JUDUL), '#\n\nIsi.');
eq('heading hanya spasi tidak dibuang', strip('#   \n\nIsi.', JUDUL), '#   \n\nIsi.');

/* 13. CRLF dari Windows. */
eq('CRLF dikenali',
   strip(`# ${JUDUL}\r\n\r\nParagraf.`, JUDUL),
   'Paragraf.');

/* 14. BOM di awal berkas. */
eq('BOM tidak menghalangi',
   strip(`\uFEFF# ${JUDUL}\n\nParagraf.`, JUDUL),
   'Paragraf.');

/* 15. Judul dengan tanda baca harus cocok persis; beda tanda baca = beda judul. */
eq('beda tanda baca tidak dibuang',
   strip('# Mengunci Onion Service dari Serangan DoS!\n\nIsi.', JUDUL),
   '# Mengunci Onion Service dari Serangan DoS!\n\nIsi.');

/* 16. Tiga pagar tidak boleh dianggap heading. */
eq('### pembuka tidak disentuh',
   strip(`### ${JUDUL}\n\nIsi.`, JUDUL),
   `### ${JUDUL}\n\nIsi.`);

/* 17. normalizeTitle sendiri. */
eq('normalizeTitle merapikan spasi dan huruf',
   A.normalizeTitle('  A   B  '), 'a b');
eq('normalizeTitle null', A.normalizeTitle(null), '');

/* 18. Regresi: artikel 02-06 punya bentuk yang sama, satu aturan untuk semua. */
const artikel = [
    ['Onion Service Privat dengan Client Authorization v3',
     '# Onion Service Privat dengan Client Authorization v3\n\nOnion service Anda sudah jalan.'],
    ['Memasang Onion Service dari Nol',
     '# Memasang Onion Service dari Nol\n\nArtikel ini memandu.'],
    ['Menyajikan Satu Konten di Clearnet dan .onion Tanpa Duplikasi',
     '# Menyajikan Satu Konten di Clearnet dan .onion Tanpa Duplikasi\n\nAda satu masalah.'],
    ['Memindahkan Onion Service ke Server Lain Tanpa Mengganti Alamat',
     'Ada satu hal yang membuat onion service berbeda.\n\nIsi berlanjut.']
];
artikel.forEach(([judul, isi]) => {
    const hasil = strip(isi, judul);
    ok(`artikel "${judul.slice(0, 30)}..." tidak lagi diawali heading`,
       !hasil.startsWith('# '), hasil.slice(0, 40));
    ok(`artikel "${judul.slice(0, 30)}..." tetap punya isi`,
       hasil.trim().length > 5 && !hasil.startsWith('\n'), String(hasil.length));
});

/* Laporan */
console.log(results.join('\n'));
console.log(`\n${pass} lulus, ${fail} gagal`);
process.exit(fail === 0 ? 0 : 1);
