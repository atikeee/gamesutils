// Shared helpers for /mm/youtube, /mm/mp3 and /mm/mp3/populate

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function readJsonData(el, key, fallback) {
    try {
        const raw = el?.dataset[key];
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        console.warn(`[Data] could not parse data-${key}:`, e);
        return fallback;
    }
}

// suggestions for the inline playlist / category editors (rendered by the server on #appContainer)
window.MM_OPTIONS = (() => {
    const c = document.getElementById('appContainer');
    return {
        playlist: readJsonData(c, 'playlistOptions', []),
        category: readJsonData(c, 'categoryOptions', [])
    };
})();

// ── Inline playlist / category editor ─────────────────────────────────────────
// Click the value → editable input with a suggestion list; Enter/pick saves, Esc cancels.
// onCommit(el, newValue, previousValue) persists the change.

const INLINE_EMPTY_LABEL = { playlist: '', category: '+ category' };

function renderInlineValue(el, value) {
    if (!el) return;
    const field = el.dataset.field;
    el.classList.remove('editing');
    el.dataset.value = value;
    el.textContent = value || INLINE_EMPTY_LABEL[field];
    el.classList.toggle('empty', !value);
}

function setupInlineEdit(el, onCommit) {
    el.addEventListener('click', () => openInlineEdit(el, onCommit));
    el.addEventListener('keydown', (e) => {
        if (!el.classList.contains('editing') && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            openInlineEdit(el, onCommit);
        }
    });
}

function openInlineEdit(el, onCommit) {
    if (el.classList.contains('editing')) return;
    const field = el.dataset.field;
    const current = el.dataset.value || '';
    const options = (window.MM_OPTIONS && window.MM_OPTIONS[field]) || [];

    el.classList.add('editing');
    el.textContent = '';
    const input = document.createElement('input');
    input.className = 'inline-edit-input';
    input.value = current;
    input.placeholder = field === 'category' ? 'category (empty = none)' : 'playlist';
    input.autocomplete = 'off';
    const list = document.createElement('div');
    list.className = 'inline-suggest';
    el.append(input, list);

    const renderOptions = () => {
        const typed = input.value.trim().toLowerCase();
        // show every option until the user starts typing something new
        const q = input.value.trim() === current ? '' : typed;
        const matches = options.filter(o => o.toLowerCase().includes(q));
        list.innerHTML = matches.map(o =>
            `<div class="inline-suggest-item${o === current ? ' current' : ''}" data-v="${escapeHtml(o)}">${escapeHtml(o)}</div>`
        ).join('');
        list.hidden = !matches.length;
    };

    let done = false;
    const finish = (save, picked) => {
        if (done) return;
        done = true;
        const value = (picked ?? input.value).trim();
        const changed = value !== current && (value || field === 'category');
        if (save && changed) onCommit(el, value, current);
        else renderInlineValue(el, current);
    };

    list.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.inline-suggest-item');
        if (!item) return;
        e.preventDefault();   // keep focus so blur doesn't save the half-typed text first
        finish(true, item.dataset.v);
    });
    input.addEventListener('input', renderOptions);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));

    renderOptions();
    input.focus();
    input.select();
}

function addInlineOption(field, value) {
    const opts = window.MM_OPTIONS?.[field];
    if (value && opts && !opts.includes(value)) {
        opts.push(value);
        opts.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }
}

// Tag input: Enter / "+" adds whatever is typed; picking from the datalist adds immediately
function setupTagInput(input, button, datalist, onAdd) {
    if (!input) return;
    const add = (val) => {
        const clean = (val || input.value).trim();
        if (!clean) return;
        onAdd(clean);
        input.value = '';
        input.blur();
    };

    input.addEventListener('input', (e) => {
        // never auto-pick while the user is typing letters
        if (e.inputType === 'insertText' || e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') return;
        const currentVal = input.value.trim();
        if (!currentVal || !datalist) return;
        const options = Array.from(datalist.querySelectorAll('option')).map(o => o.value);
        const exactMatch = options.find(o => o.toLowerCase() === currentVal.toLowerCase());
        if (exactMatch && (e.inputType === 'insertReplacementText' || !e.inputType)) add(exactMatch);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            add();
        }
    });
    button?.addEventListener('click', () => add());
}

function makeTagBadge(tag, onRemove) {
    const badge = document.createElement('span');
    badge.className = 'tag-badge';
    badge.dataset.tag = tag;
    badge.append(`${tag} `);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'remove-tag-btn';
    btn.dataset.tag = tag;
    btn.innerHTML = '&times;';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onRemove(tag);
    });
    badge.appendChild(btn);
    return badge;
}
