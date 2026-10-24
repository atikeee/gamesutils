// /mm/mp3 player — layout, styling and inline editors are shared with /mm/youtube (mm.css, mm_common.js)

const appContainer = document.getElementById('appContainer');
const allTracks = readJsonData(appContainer, 'tracks', []);
let filteredTracks = [...allTracks];
let currentTrackIndex = -1;
let currentTrack = null;

let queuePage = 1;
const songsPerPage = 10;
let selectedTagFilter = '';

const audio = document.getElementById('audioEngine');

function splitTags(tagList) {
    return (tagList || '').split(',').map(t => t.trim()).filter(Boolean);
}

function formatTime(secs) {
    const m = Math.floor(secs / 60) || 0;
    const s = Math.floor(secs % 60) || 0;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// ── Track selection & playback ────────────────────────────────────────────────
function selectAndPlayTrack(index, autoPlay = true) {
    if (index < 0 || index >= filteredTracks.length) return;
    currentTrackIndex = index;
    currentTrack = filteredTracks[index];

    const page = Math.floor(index / songsPerPage) + 1;
    if (page !== queuePage) queuePage = page;
    renderQueue();

    document.getElementById('nowTitle').textContent = currentTrack.title || 'Untitled';
    document.getElementById('nowArtist').textContent = (currentTrack.artist || 'Unknown Artist') +
        (currentTrack.album ? ` — ${currentTrack.album}` : '');

    renderInlineValue(document.getElementById('playlistEdit'), currentTrack.playlist || '');
    renderInlineValue(document.getElementById('categoryEdit'), currentTrack.category || '');
    renderActiveTags();

    if (audio) {
        audio.src = `/mm/api/mp3/stream/${currentTrack.id}`;
        if (autoPlay) audio.play().catch(e => console.warn('[Playback]', e));
    }
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
        const cat = t.category
            ? `<span class="mini-tag">${escapeHtml(t.category)}</span>`
            : '<span class="mini-tag muted">No Cat</span>';
        return `
            <div class="playlist-item${isPlaying ? ' active' : ''}${t._missing ? ' missing' : ''}" data-index="${globalIdx}">
                <span class="item-index">${isPlaying ? '&#9658;' : globalIdx + 1}</span>
                <div class="item-info">
                    <h4 class="item-title">${escapeHtml(t.title || 'Untitled')}</h4>
                    <p class="item-artist">${escapeHtml(t.artist || 'Unknown Artist')}</p>
                    <div class="item-tags">${cat}</div>
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
        chip.className = 'tag-chip' + (selectedTagFilter === tag ? ' active' : '');
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
    datalist.innerHTML = '';
    counts.forEach((_, tag) => {
        const opt = document.createElement('option');
        opt.value = tag;
        datalist.appendChild(opt);
    });
}

function filterByTag(tag) {
    selectedTagFilter = tag;
    buildTagChips();
    filteredTracks = tag ? allTracks.filter(t => splitTags(t.tag_list).includes(tag)) : [...allTracks];
    currentTrackIndex = currentTrack ? filteredTracks.indexOf(currentTrack) : -1;
    queuePage = 1;
    renderQueue();
}

// ── Metadata saving (playlist / category / tags share one endpoint) ──────────
function saveTrack(track) {
    return fetch(`/mm/api/mp3/track/${track.id}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
            playlist: track.playlist || '',
            category: track.category || '',
            tag_list: track.tag_list || ''
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
    container.innerHTML = '';
    if (!currentTrack) return;
    splitTags(currentTrack.tag_list).forEach(tag => container.appendChild(makeTagBadge(tag, removeTag)));
}

function updateTags(tags) {
    currentTrack.tag_list = tags.join(', ');
    renderActiveTags();
    buildTagChips();
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
    document.getElementById('visualizer').classList.toggle('playing', isPlaying);
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
    audio.addEventListener('timeupdate', () => {
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
    window.location.href = `/mm/mp3?playlist=${encodeURIComponent(pl)}&category=${encodeURIComponent(cat)}`;
}

document.getElementById('playlistSelect')?.addEventListener('change', onFilterChange);
document.getElementById('categorySelect')?.addEventListener('change', onFilterChange);

document.getElementById('tagChipsBar').addEventListener('click', (e) => {
    const chip = e.target.closest('.tag-chip');
    if (chip) filterByTag(chip.dataset.tag);
});

document.getElementById('queueList').addEventListener('click', (e) => {
    const row = e.target.closest('.playlist-item');
    if (row) selectAndPlayTrack(parseInt(row.dataset.index, 10), true);
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

document.getElementById('scrubber').addEventListener('change', (e) => {
    if (audio && audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration;
});
document.getElementById('volumeSlider').addEventListener('input', (e) => {
    if (audio) audio.volume = e.target.value;
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
renderQueue();
if (filteredTracks.length > 0) selectAndPlayTrack(0, false);
