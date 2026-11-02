// /mm/mp3 player — layout, styling and inline editors are shared with /mm/youtube (mm.css, mm_common.js)

const appContainer = document.getElementById('appContainer');
const allTracks = readJsonData(appContainer, 'tracks', []);
const TV_MODE = readJsonData(appContainer, 'tvMode', false) === true;
let filteredTracks = [...allTracks];
let currentTrackIndex = -1;
let currentTrack = null;

let queuePage = 1;
const songsPerPage = 10;
const selectedTagFilters = new Set(readJsonData(appContainer, 'selectedTags', []));

const audio = document.getElementById('audioEngine');

function splitTags(tagList) {
    return (tagList || '').split(',').map(t => t.trim()).filter(Boolean);
}

function formatTime(secs) {
    const m = Math.floor(secs / 60) || 0;
    const s = Math.floor(secs % 60) || 0;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function parseChapters(value) {
    const timestamps = String(value || '').split(',').map(token => {
        const parts = token.trim().split(':');
        if (!token.trim() || parts.length > 3 || !parts.every(part => /^\d+(?:\.\d+)?$/.test(part))
            || !parts.slice(0, -1).every(part => /^\d+$/.test(part))) return null;
        const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
        return Number.isFinite(seconds) ? seconds : null;
    }).filter(seconds => seconds !== null);
    return [...new Set(timestamps)].sort((first, second) => first - second);
}

function getChapterTarget(direction) {
    if (!audio || !currentTrack) return null;
    const chapters = parseChapters(currentTrack.chapter).filter(seconds => !Number.isFinite(audio.duration) || seconds <= audio.duration);
    if (direction > 0) return chapters.find(seconds => seconds > audio.currentTime + 0.05) ?? null;
    const reached = chapters.filter(seconds => seconds <= audio.currentTime + 0.05);
    return reached.length > 1 ? reached[reached.length - 2] : null;
}

function updateChapterButtons() {
    document.getElementById('prevChapterBtn').disabled = getChapterTarget(-1) === null;
    document.getElementById('nextChapterBtn').disabled = getChapterTarget(1) === null;
}

function seekChapter(direction) {
    const target = getChapterTarget(direction);
    if (target === null || audio.readyState === 0) return;
    audio.currentTime = target;
    updateChapterButtons();
}

// ── Track selection & playback ────────────────────────────────────────────────
function selectAndPlayTrack(index, autoPlay = true) {
    if (index < 0 || index >= filteredTracks.length) return;
    currentTrackIndex = index;
    currentTrack = filteredTracks[index];

    const page = Math.floor(index / songsPerPage) + 1;
    if (page !== queuePage) queuePage = page;
    renderQueue();

    updateCurrentTrackInfo();
    const chapterInput = document.getElementById('chapterInput');
    if (chapterInput) {
        chapterInput.value = currentTrack.chapter || '';
        chapterInput.disabled = false;
        document.getElementById('saveChaptersBtn').disabled = false;
        document.getElementById('chapterStatus').textContent = '';
    }

    renderInlineValue(document.getElementById('playlistEdit'), currentTrack.playlist || '');
    renderInlineValue(document.getElementById('categoryEdit'), currentTrack.category || '');
    renderInlineValue(document.getElementById('artistEdit'), currentTrack.artist || '');
    renderActiveTags();

    if (audio) {
        audio.src = `/mm/api/mp3/stream/${currentTrack.id}`;
        updateChapterButtons();
        if (autoPlay) audio.play().catch(e => console.warn('[Playback]', e));
    }
}

function updateCurrentTrackInfo() {
    if (!currentTrack) return;
    document.getElementById('nowTitle').textContent = currentTrack.title || 'Untitled';
    document.getElementById('nowArtist').textContent = (currentTrack.artist || 'Unknown Artist') +
        (currentTrack.album ? ` — ${currentTrack.album}` : '');
    document.querySelector('.mp3-now-playing').title = [currentTrack.title, currentTrack.artist, currentTrack.album].filter(Boolean).join(' - ');
}

function playNextTrack() {
    if (currentTrackIndex + 1 < filteredTracks.length) selectAndPlayTrack(currentTrackIndex + 1, true);
}

function playPrevTrack() {
    if (currentTrackIndex - 1 >= 0) selectAndPlayTrack(currentTrackIndex - 1, true);
}

function skipSeconds(sec) {
    if (audio && audio.duration) {
        audio.currentTime = Math.min(Math.max(0, audio.currentTime + sec), audio.duration);
    }
}

function togglePlay() {
    if (!audio) return;
    if (audio.paused) audio.play();
    else audio.pause();
}

// ── Queue (10 songs per page) ────────────────────────────────────────────────
function renderQueue() {
    const total = filteredTracks.length;
    const maxPages = Math.max(1, Math.ceil(total / songsPerPage));
    if (queuePage > maxPages) queuePage = maxPages;

    document.getElementById('curQueuePage').textContent = queuePage;
    document.getElementById('maxQueuePage').textContent = maxPages;
    document.getElementById('totalQueueCount').textContent = total;

    const start = (queuePage - 1) * songsPerPage;
    const pageTracks = filteredTracks.slice(start, start + songsPerPage);

    document.getElementById('queueList').innerHTML = pageTracks.map((t, idx) => {
        const globalIdx = start + idx;
        const isPlaying = currentTrack && currentTrack.id === t.id;
        const tags = splitTags(t.tag_list).map(tag => `<span class="mini-tag">${escapeHtml(tag)}</span>`).join('');
        return `
            <div class="playlist-item${isPlaying ? ' active' : ''}${t._missing ? ' missing' : ''}" data-index="${globalIdx}" tabindex="0" role="button">
                <div class="item-info">
                    <span class="item-title">${escapeHtml(t.title || 'Untitled')}</span>${tags}
                </div>
            </div>`;
    }).join('');

    renderPagination(maxPages);
}

function renderPagination(maxPages) {
    const track = document.getElementById('pageScrollTrack');
    let html = '';
    for (let p = 1; p <= maxPages; p++) {
        html += `<button type="button" class="page-num-pill${p === queuePage ? ' active' : ''}" data-page-num="${p}">${p}</button>`;
    }
    track.innerHTML = html;
    document.getElementById('queuePrevBtn').classList.toggle('disabled', queuePage <= 1);
    document.getElementById('queueNextBtn').classList.toggle('disabled', queuePage >= maxPages);

    const activePill = track.querySelector('.page-num-pill.active');
    if (activePill) {
        track.scrollLeft = activePill.offsetLeft - track.offsetLeft - track.clientWidth / 2 + activePill.offsetWidth / 2;
    }
}

function goToQueuePage(page) {
    const maxPages = Math.ceil(filteredTracks.length / songsPerPage) || 1;
    if (page >= 1 && page <= maxPages && page !== queuePage) {
        queuePage = page;
        renderQueue();
    }
}

// ── Tag filter chips (header) ────────────────────────────────────────────────
function buildTagChips() {
    const counts = new Map();
    allTracks.forEach(t => splitTags(t.tag_list).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1)));
    selectedTagFilters.forEach(tag => {
        if (!counts.has(tag)) counts.set(tag, 0);
    });

    const bar = document.getElementById('tagChipsBar');
    bar.innerHTML = '';
    if (counts.size) {
        const title = document.createElement('span');
        title.className = 'tag-filter-title';
        title.textContent = 'Tags';
        bar.appendChild(title);
    }
    const addChip = (tag, label, count) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        const selected = tag ? selectedTagFilters.has(tag) : selectedTagFilters.size === 0;
        chip.className = 'tag-chip' + (selected ? ' active' : '');
        chip.setAttribute('aria-pressed', String(selected));
        chip.dataset.tag = tag;
        chip.textContent = label;
        if (count !== undefined) {
            const c = document.createElement('span');
            c.className = 'tag-count';
            c.textContent = count;
            chip.append(' ', c);
        }
        bar.appendChild(chip);
    };
    addChip('', 'All');
    counts.forEach((count, tag) => addChip(tag, tag, count));

    const datalist = document.getElementById('trackTagsDatalist');
    if (datalist) {
        datalist.innerHTML = '';
        counts.forEach((_, tag) => {
            const opt = document.createElement('option');
            opt.value = tag;
            datalist.appendChild(opt);
        });
    }
}

function filterByTag(tag) {
    if (!tag) selectedTagFilters.clear();
    else if (selectedTagFilters.has(tag)) selectedTagFilters.delete(tag);
    else selectedTagFilters.add(tag);
    buildTagChips();
    applyTagFilters();
}

function applyTagFilters() {
    filteredTracks = allTracks.filter(track => {
        const tags = splitTags(track.tag_list);
        return [...selectedTagFilters].every(tag => tags.includes(tag));
    });
    currentTrackIndex = currentTrack ? filteredTracks.indexOf(currentTrack) : -1;
    queuePage = 1;
    renderQueue();
}

// ── Metadata saving (playlist / category / tags share one endpoint) ──────────
function saveTrack(track) {
    if (TV_MODE) return Promise.reject(new Error('Editing is unavailable in the TV player.'));
    return fetch(`/mm/api/mp3/track/${track.id}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
            playlist: track.playlist || '',
            category: track.category || '',
            tag_list: track.tag_list || '',
            chapter: track.chapter || '',
            artist: track.artist || ''
        })
    }).then(r => r.json().then(data => {
        if (!r.ok || !data.success) throw new Error(data.error || 'Server could not save metadata');
    }));
}

function commitTrackField(el, value, previous) {
    const track = currentTrack;
    if (!track) return renderInlineValue(el, previous);
    const field = el.dataset.field;
    const oldValue = track[field];

    renderInlineValue(el, value);
    track[field] = field === 'category' ? (value || null) : value;
    saveTrack(track)
        .then(() => {
            addInlineOption(field, value);
            if (track === currentTrack) updateCurrentTrackInfo();
            renderQueue();
        })
        .catch(err => {
            console.warn(`[${field}] update error:`, err);
            track[field] = oldValue;
            if (track === currentTrack) renderInlineValue(el, previous);
            alert(`Could not save changes: ${err.message}`);
        });
}

function renderActiveTags() {
    const container = document.getElementById('activeTagList');
    if (!container) return;
    container.innerHTML = '';
    if (!currentTrack) return;
    splitTags(currentTrack.tag_list).forEach(tag => container.appendChild(makeTagBadge(tag, removeTag)));
}

function updateTags(tags) {
    if (TV_MODE) return;
    currentTrack.tag_list = tags.join(', ');
    renderActiveTags();
    buildTagChips();
    applyTagFilters();
    saveTrack(currentTrack)
        .then(renderQueue)
        .catch(err => console.error('[Tags] sync error:', err));
}

function addTag(tag) {
    if (!currentTrack) return;
    const val = tag.replace(/^#/, '').trim();
    const tags = splitTags(currentTrack.tag_list);
    if (val && !tags.includes(val)) updateTags([...tags, val]);
}

function removeTag(tag) {
    if (!currentTrack) return;
    updateTags(splitTags(currentTrack.tag_list).filter(t => t !== tag));
}

// ── Audio events ─────────────────────────────────────────────────────────────
function setPlayingUi(isPlaying) {
    const playBtn = document.getElementById('mainPlayBtn');
    playBtn.querySelector('.icon-play').style.display = isPlaying ? 'none' : 'inline';
    playBtn.querySelector('.icon-pause').style.display = isPlaying ? 'inline' : 'none';
}

if (audio) {
    audio.addEventListener('error', () => {
        if (!currentTrack || !audio.getAttribute('src')) return;
        console.warn(`[Audio 404] File for track ID ${currentTrack.id} not found.`);
        currentTrack._missing = true;
        document.querySelector(`#queueList .playlist-item[data-index="${currentTrackIndex}"]`)?.classList.add('missing');
        setTimeout(playNextTrack, 1000);
    });
    audio.addEventListener('play', () => setPlayingUi(true));
    audio.addEventListener('pause', () => setPlayingUi(false));
    audio.addEventListener('ended', playNextTrack);
    audio.addEventListener('loadedmetadata', updateChapterButtons);
    audio.addEventListener('seeked', updateChapterButtons);
    audio.addEventListener('timeupdate', () => {
        updateChapterButtons();
        if (!audio.duration) return;
        document.getElementById('scrubber').value = (audio.currentTime / audio.duration) * 100;
        document.getElementById('currTime').textContent = formatTime(audio.currentTime);
        document.getElementById('durTime').textContent = formatTime(audio.duration);
    });
}

// ── Wiring ───────────────────────────────────────────────────────────────────
function onFilterChange() {
    const pl = document.getElementById('playlistSelect')?.value || '';
    const cat = document.getElementById('categorySelect')?.value || '';
    const artist = document.getElementById('artistSelect')?.value || '';
    const params = new URLSearchParams({ playlist: pl, category: cat, artist });
    selectedTagFilters.forEach(tag => params.append('tag', tag));
    window.location.href = `${window.location.pathname}?${params}`;
}

document.getElementById('playlistSelect')?.addEventListener('change', onFilterChange);
document.getElementById('categorySelect')?.addEventListener('change', onFilterChange);
document.getElementById('artistSelect')?.addEventListener('change', onFilterChange);

document.getElementById('tagChipsBar').addEventListener('click', (e) => {
    const chip = e.target.closest('.tag-chip');
    if (chip) {
        const restoreFocus = document.activeElement === chip;
        filterByTag(chip.dataset.tag);
        if (restoreFocus) [...document.querySelectorAll('.tag-chip')].find(button => button.dataset.tag === chip.dataset.tag)?.focus();
    }
});

document.getElementById('queueList').addEventListener('click', (e) => {
    const row = e.target.closest('.playlist-item');
    if (row) selectAndPlayTrack(parseInt(row.dataset.index, 10), true);
});
document.getElementById('queueList').addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('.playlist-item');
    if (!row) return;
    event.preventDefault();
    const index = Number(row.dataset.index);
    selectAndPlayTrack(index, true);
    document.querySelector(`#queueList .playlist-item[data-index="${index}"]`)?.focus({ preventScroll: true });
});

document.getElementById('pageScrollTrack').addEventListener('click', (e) => {
    const pill = e.target.closest('.page-num-pill');
    if (pill) goToQueuePage(parseInt(pill.dataset.pageNum, 10));
});
document.getElementById('queuePrevBtn').addEventListener('click', () => goToQueuePage(queuePage - 1));
document.getElementById('queueNextBtn').addEventListener('click', () => goToQueuePage(queuePage + 1));

document.getElementById('mainPlayBtn').addEventListener('click', togglePlay);
document.getElementById('prevTrackBtn').addEventListener('click', playPrevTrack);
document.getElementById('nextTrackBtn').addEventListener('click', playNextTrack);
document.getElementById('rev30sBtn').addEventListener('click', () => skipSeconds(-30));
document.getElementById('fwd30sBtn').addEventListener('click', () => skipSeconds(30));
document.getElementById('prevChapterBtn').addEventListener('click', () => seekChapter(-1));
document.getElementById('nextChapterBtn').addEventListener('click', () => seekChapter(1));
document.getElementById('chapterForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!currentTrack) return;
    const track = currentTrack;
    const previous = track.chapter || '';
    track.chapter = document.getElementById('chapterInput').value.trim();
    const status = document.getElementById('chapterStatus');
    const button = document.getElementById('saveChaptersBtn');
    button.disabled = true;
    try {
        await saveTrack(track);
        if (track === currentTrack) {
            status.textContent = 'Saved';
            updateChapterButtons();
        }
    } catch (error) {
        track.chapter = previous;
        if (track === currentTrack) status.textContent = 'Not saved';
        console.error('[Chapters]', error);
    } finally {
        button.disabled = !currentTrack;
    }
});

document.getElementById('scrubber').addEventListener('change', (e) => {
    if (audio && audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration;
});

document.querySelectorAll('.inline-edit').forEach(el => setupInlineEdit(el, commitTrackField));
setupTagInput(
    document.getElementById('inlineTagInput'),
    document.getElementById('addInlineTagBtn'),
    document.getElementById('trackTagsDatalist'),
    addTag
);

// ── Init ─────────────────────────────────────────────────────────────────────
buildTagChips();
applyTagFilters();
if (filteredTracks.length > 0) selectAndPlayTrack(0, false);
