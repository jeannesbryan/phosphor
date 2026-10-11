/* form-utils.js — small fixes that used to be copied into nine pages.
 *
 * Two things, both about the comfort of typing a password:
 *
 *   1. A show/hide button on EVERY <input type="password">. The input itself
 *      is left alone; this module wraps it in a position:relative box and puts
 *      the [SHOW]/[HIDE] button on the right. Callers do not need to change
 *      the page HTML.
 *
 *   2. Pressing Enter in a password field = clicking its button. The mapping
 *      lives in ENTER_SUBMIT so it only has to be updated in one place when a
 *      new page adds a field.
 *
 * Why a module: each page used to write its own decryption-button handling, so
 * a UX fix had to be repeated nine times (exactly like the Blossom upload
 * rules before they were unified). One place is easier to keep correct.
 *
 * Safe to fail: if the module does not load, the page keeps working as before
 * — just without the eye button and without Enter.
 */
(function (global) {
    'use strict';

    // Field -> button pressed on Enter. Only fields that actually have an
    // action button are registered; the rest are left alone.
    var ENTER_SUBMIT = {
        'unlockPassword': 'unlockBtn',
        'nsecInput': 'nsecLoginBtn',
        'nsecPassword': 'nsecLoginBtn',
        'ncryptsecInput': 'ncryptsecLoginBtn',
        'ncryptsecPassword': 'ncryptsecLoginBtn',
        'bunkerInput': 'bunkerLoginBtn'
    };

    // The single rule for switching the input type. Used by the eye button;
    // exported so it can be tested without a browser.
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

    /* Wrap one password field with the eye button. Safe to call twice: if it is
       already wrapped, it does nothing. */
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
            // Keep the caret at the end of the text so continued typing does not jump.
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

    /* Enter in the field = click its button. If the button is missing, that is fine. */
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
