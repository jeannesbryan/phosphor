/* form-utils.js — perbaikan kecil yang dulu disalin ke sembilan halaman.
 *
 * Dua hal, keduanya soal kenyamanan mengisi kata sandi:
 *
 *   1. Tombol lihat/sembunyikan kata sandi pada SETIAP <input type="password">.
 *      Input tidak disentuh; modul ini membungkusnya dengan wadah posisi-relatif
 *      lalu menaruh tombol [SHOW]/[HIDE] di kanan. Pemanggil tidak perlu
 *      mengubah HTML halaman.
 *
 *   2. Menekan Enter di kolom kata sandi = menekan tombolnya. Pemetaan ada di
 *      ENTER_SUBMIT supaya cukup diperbarui di satu tempat kalau halaman baru
 *      menambah kolom.
 *
 * Kenapa modul: dulu tiap halaman menulis sendiri penanganan tombol dekripsi,
 * jadi perbaikan UX harus diulang sembilan kali (persis seperti aturan unggah
 * Blossom sebelum disatukan). Satu tempat lebih mudah dijaga.
 *
 * Aman kalau gagal: kalau modul tidak dimuat, halaman tetap berjalan seperti
 * sebelumnya — hanya tanpa tombol mata dan tanpa Enter.
 */
(function (global) {
    'use strict';

    // Kolom -> tombol yang ditekan saat Enter. Hanya kolom yang memang punya
    // tombol aksi yang didaftarkan; sisanya dibiarkan.
    var ENTER_SUBMIT = {
        'unlockPassword': 'unlockBtn',
        'nsecInput': 'nsecLoginBtn',
        'nsecPassword': 'nsecLoginBtn',
        'ncryptsecInput': 'ncryptsecLoginBtn',
        'ncryptsecPassword': 'ncryptsecLoginBtn',
        'bunkerInput': 'bunkerLoginBtn'
    };

    // Satu-satunya aturan pergantian tipe. Dipakai tombol mata; diekspor supaya
    // bisa diuji tanpa browser.
    function toggleType(current) {
        return current === 'password' ? 'text' : 'password';
    }

    function typeFor(input) {
        if (input && input.getAttribute('type') === 'text') return 'text';
        return 'password';
    }

    function labelFor(type) {
        return type === 'text' ? '[HIDE]' : '[SHOW]';
    }

    var CSS = [
        '.pw-field{position:relative;display:block;}',
        '.pw-field > .t-input{padding-right:76px;}',
        '.pw-toggle{position:absolute;right:0;top:50%;transform:translateY(-50%);',
        'background:transparent;border:1px solid var(--t-green-dim);color:var(--t-green-dim);',
        'font-family:inherit;font-size:11px;letter-spacing:1px;padding:2px 6px;line-height:1.4;',
        'cursor:pointer;text-transform:uppercase;transition:0.2s;}',
        '.pw-toggle:hover{color:var(--t-green);border-color:var(--t-green);}',
        '.pw-toggle[aria-pressed="true"]{color:var(--t-green);border-color:var(--t-green);}'
    ];

    function installStyles(doc) {
        if (!doc || doc.__formUtilsStyles) return;
        doc.__formUtilsStyles = true;
        var style = doc.createElement('style');
        style.setAttribute('data-form-utils', '1');
        style.textContent = CSS.join('\n');
        (doc.head || doc.documentElement).appendChild(style);
    }

    /* Bungkus satu kolom kata sandi dengan tombol mata. Aman dipanggil dua kali:
       kalau sudah dibungkus, tidak melakukan apa-apa. */
    function enhance(input) {
        if (!input || !input.parentNode) return null;
        if (input.parentNode.classList && input.parentNode.classList.contains('pw-field')) return null;
        if (input.getAttribute('data-pw-enhanced')) return null;

        var doc = input.ownerDocument;
        var parent = input.parentNode;
        var field = doc.createElement('div');
        field.className = 'pw-field';
        parent.insertBefore(field, input);
        field.appendChild(input);

        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'pw-toggle';
        btn.setAttribute('aria-pressed', 'false');
        btn.textContent = labelFor(typeFor(input));
        btn.addEventListener('click', function () {
            var next = toggleType(typeFor(input));
            input.setAttribute('type', next);
            btn.textContent = labelFor(next);
            btn.setAttribute('aria-pressed', next === 'text' ? 'true' : 'false');
            // Kursor di akhir teks supaya mengetik lanjut tidak melompat.
            try { input.focus(); var v = input.value; input.value = v; } catch (e) {}
        });

        field.appendChild(btn);
        input.setAttribute('data-pw-enhanced', '1');
        return btn;
    }

    function enhanceAll(root) {
        root = root || (typeof document !== 'undefined' ? document : null);
        if (!root || typeof root.querySelectorAll !== 'function') return 0;
        var inputs = root.querySelectorAll('input[type="password"]');
        var n = 0;
        Array.prototype.forEach.call(inputs, function (input) { if (enhance(input)) n++; });
        return n;
    }

    /* Enter di kolom = klik tombolnya. Kalau tombolnya tidak ada, tidak apa-apa. */
    function submitOnEnter(input) {
        if (!input) return false;
        var id = input.id;
        var btnId = ENTER_SUBMIT[id];
        if (!btnId) return false;
        if (input.getAttribute('data-enter-bound')) return false;
        input.setAttribute('data-enter-bound', '1');
        input.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter' && e.keyCode !== 13) return;
            e.preventDefault();
            var btn = input.ownerDocument.getElementById(btnId);
            if (btn) btn.click();
        });
        return true;
    }

    function bindEnter(root) {
        root = root || (typeof document !== 'undefined' ? document : null);
        if (!root || typeof root.querySelectorAll !== 'function') return 0;
        var n = 0;
        Object.keys(ENTER_SUBMIT).forEach(function (inputId) {
            var input = root.getElementById ? root.getElementById(inputId) : null;
            if (input && submitOnEnter(input)) n++;
        });
        return n;
    }

    function install() {
        if (typeof document === 'undefined') return;
        installStyles(document);
        enhanceAll(document);
        bindEnter(document);
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
        else install();
    }

    var api = {
        ENTER_SUBMIT: ENTER_SUBMIT,
        toggleType: toggleType,
        labelFor: labelFor,
        enhance: enhance,
        enhanceAll: enhanceAll,
        submitOnEnter: submitOnEnter,
        bindEnter: bindEnter,
        install: install
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.FormUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
