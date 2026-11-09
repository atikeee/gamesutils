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

function parseChapterTimestamps(value) {
    const timestamps = String(value || '').trim().split(/[\s,]+/).map(token => {
        const parts = token.trim().split(':');
        if (!token.trim() || parts.length > 3 || !parts.every(part => /^\d+(?:\.\d+)?$/.test(part))
            || !parts.slice(0, -1).every(part => /^\d+$/.test(part))) return null;
        const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
        return Number.isFinite(seconds) ? seconds : null;
    }).filter(seconds => seconds !== null && seconds >= 0);
    return [...new Set(timestamps)].sort((first, second) => first - second);
}

function formatChapterTimestamps(value) {
    return parseChapterTimestamps(value).join(' ');
}

function setupChapterEditorToggle(toggle, form) {
    if (!toggle || !form) return;
    const wrapper = toggle.closest('.chapter-editor-wrap');
    const position = () => {
        const bounds = toggle.getBoundingClientRect();
        const popup = form.getBoundingClientRect();
        const left = Math.max(8, Math.min(bounds.left, window.innerWidth - popup.width - 8));
        const top = bounds.bottom + popup.height + 8 <= window.innerHeight
            ? bounds.bottom + 6
            : Math.max(8, bounds.top - popup.height - 6);
        form.style.left = `${left}px`;
        form.style.top = `${top}px`;
    };
    const stopPositioning = () => {
        window.removeEventListener('resize', position);
        window.removeEventListener('scroll', position, true);
    };
    const close = () => {
        form.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        stopPositioning();
    };
    toggle.addEventListener('click', () => {
        const open = form.hidden;
        form.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) {
            window.requestAnimationFrame(position);
            window.addEventListener('resize', position);
            window.addEventListener('scroll', position, true);
            form.querySelector('input')?.focus();
        } else {
            stopPositioning();
        }
    });
    document.addEventListener('click', event => {
        if (!form.hidden && wrapper && !wrapper.contains(event.target)) close();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !form.hidden) {
            close();
            toggle.focus();
        }
    });
}

// suggestions for the inline playlist / category editors (rendered by the server on #appContainer)
window.MM_OPTIONS = (() => {
    const c = document.getElementById('appContainer');
    return {
        playlist: readJsonData(c, 'playlistOptions', []),
        category: readJsonData(c, 'categoryOptions', []),
        artist: readJsonData(c, 'artistOptions', [])
    };
})();

// ── Inline playlist / category editor ─────────────────────────────────────────
// Click the value → editable input with a suggestion list; Enter/pick saves, Esc cancels.
// onCommit(el, newValue, previousValue) persists the change.

const INLINE_EMPTY_LABEL = { playlist: '', category: '+ category', artist: '+ artist' };

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
    if (document.body.classList.contains('mp3-page')) input.tabIndex = -1;
    input.value = current;
    input.placeholder = field === 'category' ? 'category (empty = none)' : field === 'artist' ? 'artist' : 'playlist';
    input.autocomplete = 'off';
    const list = document.createElement('div');
    list.className = 'inline-suggest';
    const floatingList = document.body.classList.contains('mp3-page');
    const positionList = () => {
        const bounds = el.getBoundingClientRect();
        const width = Math.min(220, window.innerWidth - 16);
        Object.assign(list.style, {
            position: 'fixed', top: `${bounds.bottom + 3}px`,
            left: `${Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))}px`,
            width: `${width}px`, zIndex: '2000'
        });
    };
    if (floatingList) {
        el.appendChild(input);
        document.body.appendChild(list);
        positionList();
        window.addEventListener('scroll', positionList, true);
        window.addEventListener('resize', positionList);
    } else {
        el.append(input, list);
    }

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
        if (floatingList) {
            list.remove();
            window.removeEventListener('scroll', positionList, true);
            window.removeEventListener('resize', positionList);
        }
        const value = (picked ?? input.value).trim();
        const changed = value !== current && (value || field === 'category' || field === 'artist');
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
