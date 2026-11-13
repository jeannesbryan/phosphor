/* Aturan judul artikel long-form (NIP-23).

   Renderer artikel selalu mencetak judulnya sendiri dari tag `title`, lalu
   memasang isi artikel lewat marked.parse(). Kalau isi artikel dibuka dengan
   baris `# Judul` yang sama, judul itu tercetak dua kali: sekali oleh renderer,
   sekali oleh markdown.

   Alasan modul ini ada, bukan ditambal per artikel: lima artikel yang sudah
   terbit (02 sampai 06) memakai bentuk `# Judul` di baris pertama. Menambal
   berarti menandatangani ulang lima event dan mengubah created_at semuanya.
   Membuang baris yang berulang di sisi renderer membetulkan kelimanya sekaligus
   tanpa menyentuh satu pun event yang sudah tersiar.

   Aturan yang dipakai:
   - Hanya blok awal isi yang diperiksa, bukan seluruh dokumen. Baris `# ...`
     yang muncul di tengah artikel adalah bagian dari isi dan tidak disentuh.
   - Hanya heading tingkat satu (`# `), bukan `## `.
   - Baris itu dibuang HANYA kalau teksnya sama dengan judul yang sudah
     dicetak. Kalau berbeda, ia memang judul lain di dalam isi, dan membuangnya
     berarti menghilangkan informasi.
   - Kalau judul kosong, tidak ada yang dibuang: tanpa judul pembanding, tidak
     ada dasar untuk menyimpulkan baris itu berulang.
*/
(function (global) {
    'use strict';

    // Samakan bentuk sebelum dibandingkan: spasi berlebih diringkas, huruf
    // kecil. Tanda baca dibiarkan apa adanya, karena judul yang berbeda tanda
    // baca memang judul yang berbeda.
    function normalizeTitle(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function stripDuplicateTitle(content, title) {
        const source = content === null || content === undefined ? '' : String(content);
        const wanted = normalizeTitle(title);
        if (!wanted) return source;

        // Buang BOM kalau ada, lalu pecah per baris. \r\n dan \r diperlakukan
        // sama seperti \n supaya isi yang ditempel dari Windows tetap dikenali.
        const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');

        // Lewati baris kosong di awal, supaya isi yang diawali satu baris kosong
        // tetap dikenali.
        let start = 0;
        while (start < lines.length && lines[start].trim() === '') start++;
        if (start >= lines.length) return source;

        const first = lines[start];
        if (!first.startsWith('# ')) return source;

        const headingText = first.slice(2).trim();
        if (!headingText) return source;
        if (normalizeTitle(headingText) !== wanted) return source;

        // Buang juga baris kosong sesudah heading, supaya isi tidak dimulai
        // dengan jarak kosong yang menggantung. Baris kosong sebelum heading
        // ikut dibuang: kalau headingnya pergi, jarak di depannya tidak ada
        // gunanya lagi.
        let next = start + 1;
        while (next < lines.length && lines[next].trim() === '') next++;

        return lines.slice(next).join('\n');
    }

    const api = {
        normalizeTitle: normalizeTitle,
        stripDuplicateTitle: stripDuplicateTitle
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.NostrArticle = api;
})(typeof window !== 'undefined' ? window : globalThis);
