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
const tvSocket = !TV_MODE && typeof io === 'function' ? io() : null;
let tvPlayback = false;
let tvState = null;
const trackSearch = document.getElementById('trackSearch');
const metadataFields = ['title', 'artist', 'album', 'playlist', 'category', 'tag_list', 'chapter'];
const showStatus = text => { document.getElementById('mp3Status').textContent = text; };
if (!TV_MODE) window.lucide?.createIcons();
setupChapterEditorToggle(document.getElementById('chapterEditorToggle'), document.getElementById('chapterForm'));

function playbackPosition() {
    return tvPlayback ? Number(tvState?.position) || 0 : audio.currentTime;
}

function playbackDuration() {
    return tvPlayback ? Number(tvState?.duration || currentTrack?.duration) || 0 : audio.duration;
}

function sendTv(action, data = {}) {
    if (!tvSocket?.connected) {
        showStatus('TV connection unavailable. Reconnect before sending playback commands.');
        return false;
    }
    tvSocket.emit('media_control', { action, ...data });
    return true;
}

function updateTvButton() {
    const button = document.getElementById('playOnTvBtn');
    if (!button) return;
    button.disabled = !currentTrack;
    button.setAttribute('aria-pressed', String(tvPlayback));
    button.title = tvPlayback ? 'Play in this browser' : 'Play on TV';
    button.setAttribute('aria-label', button.title);
}

function loadTrackOnTv() {
    if (!currentTrack) return;
    sendTv('load', {
        database: 'mp3', media_id: currentTrack.id,
        queue: { mp3_ids: filteredTracks.map(track => track.id) }
    });
}

function updateTimeline() {
    const duration = playbackDuration();
    const position = playbackPosition();
    document.getElementById('scrubber').value = duration > 0 ? position / duration * 100 : 0;
    document.getElementById('currTime').textContent = formatTime(position);
    document.getElementById('durTime').textContent = formatTime(duration);
}

function splitTags(tagList) {
    return (tagList || '').split(',').map(t => t.trim()).filter(Boolean);
}

function formatTime(secs) {
    const m = Math.floor(secs / 60) || 0;
    const s = Math.floor(secs % 60) || 0;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function parseChapters(value) {
    return parseChapterTimestamps(value);
}

function getChapterTarget(direction) {
    if (!audio || !currentTrack) return null;
    const duration = playbackDuration();
    const position = playbackPosition();
    const chapters = parseChapters(currentTrack.chapter).filter(seconds => !Number.isFinite(duration) || seconds <= duration);
    if (direction > 0) return chapters.find(seconds => seconds > position + 0.05) ?? null;
    const reached = chapters.filter(seconds => seconds <= position + 0.05);
    return reached.length > 1 ? reached[reached.length - 2] : null;
}

function updateChapterButtons() {
    document.getElementById('prevChapterBtn').disabled = getChapterTarget(-1) === null;
    document.getElementById('nextChapterBtn').disabled = getChapterTarget(1) === null;
}

function seekChapter(direction) {
    const target = getChapterTarget(direction);
    if (tvPlayback) {
        if (target !== null) sendTv('seek', { position: target });
        return;
    }
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
    const editButton = document.getElementById('editTrackBtn');
    if (editButton) editButton.disabled = false;
    updateTvButton();

    if (tvPlayback) {
        audio.pause();
        if (autoPlay) loadTrackOnTv();
        return;
    }
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
    if ('mediaSession' in navigator && 'MediaMetadata' in window) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: currentTrack.title || 'Untitled',
            artist: currentTrack.artist || 'Unknown Artist',
            album: currentTrack.album || ''
        });
    }
}

function playNextTrack() {
    if (currentTrackIndex + 1 < filteredTracks.length) selectAndPlayTrack(currentTrackIndex + 1, true);
}

function playPrevTrack() {
    if (currentTrackIndex - 1 >= 0) selectAndPlayTrack(currentTrackIndex - 1, true);
}

function skipSeconds(sec) {
    if (tvPlayback) {
        const duration = playbackDuration();
        const position = Math.max(0, playbackPosition() + sec);
        sendTv('seek', { position: duration > 0 ? Math.min(position, duration) : position });
        return;
    }
    if (audio && audio.duration) {
        audio.currentTime = Math.min(Math.max(0, audio.currentTime + sec), audio.duration);
    }
}

function togglePlay() {
    if (tvPlayback) {
        sendTv(tvState?.paused ? 'play' : 'pause');
        return;
    }
    if (!audio) return;
    if (audio.paused) audio.play();
    else audio.pause();
}

function playNextChapterOrTrack() {
    if (getChapterTarget(1) !== null) seekChapter(1);
    else playNextTrack();
}

function updateMediaPosition() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const duration = playbackDuration();
    if (!Number.isFinite(duration) || duration <= 0) {
        navigator.mediaSession.setPositionState();
        return;
    }
    navigator.mediaSession.setPositionState({
        duration,
        playbackRate: audio.playbackRate,
        position: Math.min(Math.max(0, playbackPosition()), duration)
    });
}

if (audio && 'mediaSession' in navigator) {
    const handlers = {
        play: () => tvPlayback ? sendTv('play') : audio.play().catch(error => console.warn('[Playback]', error)),
        pause: () => tvPlayback ? sendTv('pause') : audio.pause(),
        nexttrack: playNextChapterOrTrack,
        previoustrack: playPrevTrack,
        seekbackward: details => skipSeconds(-(details.seekOffset || 30)),
        seekforward: details => skipSeconds(details.seekOffset || 30),
        seekto: details => {
            if (tvPlayback) { sendTv('seek', { position: details.seekTime }); return; }
            if (!Number.isFinite(audio.duration)) return;
            audio.currentTime = Math.min(Math.max(0, details.seekTime), audio.duration);
        }
    };
    Object.entries(handlers).forEach(([action, handler]) => {
        try {
            navigator.mediaSession.setActionHandler(action, handler);
        } catch (error) {
            console.warn(`[Media Session] ${action} unavailable`, error);
        }
    });
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
        const isPlaying = !!currentTrack && currentTrack.id === t.id;
        const tags = splitTags(t.tag_list).map(tag => `<span class="mini-tag">${escapeHtml(tag)}</span>`).join('');
        return `
            <div class="playlist-item${isPlaying ? ' active' : ''}${t._missing ? ' missing' : ''}" id="queue-track-${t.id}" data-index="${globalIdx}" tabindex="0" role="option" aria-selected="${isPlaying}">
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

function goToQueuePage(page, autoPlay = false) {
    const maxPages = Math.ceil(filteredTracks.length / songsPerPage) || 1;
    if (page >= 1 && page <= maxPages && page !== queuePage) {
        queuePage = page;
        if (autoPlay) {
            selectAndPlayTrack((page - 1) * songsPerPage, true);
        } else {
            renderQueue();
        }
    }
}

function focusQueueTrack(index) {
    if (!filteredTracks.length) {
        document.querySelector('.page-num-pill.active')?.focus();
        return;
    }
    const firstOnPage = (queuePage - 1) * songsPerPage;
    const lastOnPage = Math.min(filteredTracks.length - 1, firstOnPage + songsPerPage - 1);
    const boundedIndex = Math.max(firstOnPage, Math.min(lastOnPage, index));
    document.getElementById(`queue-track-${filteredTracks[boundedIndex].id}`)?.focus();
}

function focusCurrentOrFirstSong() {
    const firstOnPage = (queuePage - 1) * songsPerPage;
    const playingOnPage = currentTrackIndex >= firstOnPage && currentTrackIndex < firstOnPage + songsPerPage;
    focusQueueTrack(playingOnPage ? currentTrackIndex : firstOnPage);
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
    const search = (trackSearch?.value || '').trim().toLocaleLowerCase();
    filteredTracks = allTracks.filter(track => {
        const tags = splitTags(track.tag_list);
        const matchesScope = TV_MODE || (
            track.playlist === document.getElementById('playlistSelect').value
            && (!document.getElementById('categorySelect').value || track.category === document.getElementById('categorySelect').value)
            && (!document.getElementById('artistSelect').value || track.artist === document.getElementById('artistSelect').value)
        );
        return matchesScope && [...selectedTagFilters].every(tag => tags.includes(tag))
            && (!search || ['title', 'artist', 'album', 'playlist', 'category', 'tag_list']
                .some(field => String(track[field] || '').toLocaleLowerCase().includes(search)));
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
            title: track.title || '',
            album: track.album || '',
            duration: track.duration || 0,
            playlist: track.playlist || '',
            category: track.category || '',
            tag_list: track.tag_list || '',
            chapter: track.chapter || '',
            artist: track.artist || ''
        })
    }).then(r => r.json().then(data => {
        if (!r.ok || !data.success) throw new Error(data.error || 'Server could not save metadata');
        return data.track;
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
    container.querySelectorAll('button').forEach(button => { button.tabIndex = -1; });
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
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
}

if (audio) {
    audio.addEventListener('error', () => {
        if (tvPlayback || !currentTrack || !audio.getAttribute('src')) return;
        console.warn(`[Audio 404] File for track ID ${currentTrack.id} not found.`);
        currentTrack._missing = true;
        document.querySelector(`#queueList .playlist-item[data-index="${currentTrackIndex}"]`)?.classList.add('missing');
        setTimeout(() => { if (!tvPlayback) playNextTrack(); }, 1000);
    });
    audio.addEventListener('play', () => { if (!tvPlayback) setPlayingUi(true); });
    audio.addEventListener('pause', () => { if (!tvPlayback) setPlayingUi(false); });
    audio.addEventListener('ended', () => { if (!tvPlayback) playNextTrack(); });
    audio.addEventListener('emptied', updateMediaPosition);
    audio.addEventListener('loadedmetadata', updateMediaPosition);
    audio.addEventListener('seeked', updateMediaPosition);
    audio.addEventListener('ratechange', updateMediaPosition);
    audio.addEventListener('loadedmetadata', updateChapterButtons);
    audio.addEventListener('seeked', updateChapterButtons);
    audio.addEventListener('timeupdate', () => {
        if (tvPlayback) return;
        updateChapterButtons();
        updateMediaPosition();
        if (!audio.duration) return;
        document.getElementById('scrubber').value = (audio.currentTime / audio.duration) * 100;
        document.getElementById('currTime').textContent = formatTime(audio.currentTime);
        document.getElementById('durTime').textContent = formatTime(audio.duration);
    });
}

// ── Wiring ───────────────────────────────────────────────────────────────────
function onFilterChange(event) {
    if (event?.target?.id === 'playlistSelect') {
        document.getElementById('categorySelect').value = '';
        document.getElementById('artistSelect').value = '';
    } else if (event?.target?.id === 'categorySelect') {
        document.getElementById('artistSelect').value = '';
    }
    const pl = document.getElementById('playlistSelect')?.value || '';
    const cat = document.getElementById('categorySelect')?.value || '';
    const artist = document.getElementById('artistSelect')?.value || '';
    const params = new URLSearchParams({ playlist: pl, category: cat, artist });
    if (trackSearch?.value.trim()) params.set('search', trackSearch.value.trim());
    selectedTagFilters.forEach(tag => params.append('tag', tag));
    window.location.href = `${window.location.pathname}?${params}`;
}

document.getElementById('playlistSelect')?.addEventListener('change', onFilterChange);
document.getElementById('categorySelect')?.addEventListener('change', onFilterChange);
document.getElementById('artistSelect')?.addEventListener('change', onFilterChange);
trackSearch?.addEventListener('input', applyTagFilters);

document.getElementById('startTvBtn')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    showStatus('Starting TV...');
    try {
        const response = await fetch('/mm/api/remote/tv/start', { method: 'POST' });
        const result = await response.json().catch(() => { throw new Error(`TV server returned HTTP ${response.status} instead of JSON.`); });
        if (!response.ok || !result.success) throw new Error(result.error || 'TV command failed.');
        const link = document.createElement('a');
        link.href = result.display_url;
        link.textContent = 'TV display';
        link.target = '_blank';
        link.rel = 'noopener';
        document.getElementById('mp3Status').replaceChildren('TV wake command sent; FunHub launched. ', link);
    } catch (error) {
        showStatus(error.message || 'TV connection failed.');
    } finally {
        button.disabled = false;
    }
});

document.getElementById('playOnTvBtn')?.addEventListener('click', () => {
    if (!currentTrack) return;
    if (!tvSocket?.connected) { showStatus('TV connection unavailable. Try again once connected.'); return; }
    if (!tvPlayback) {
        tvPlayback = true;
        audio.pause();
        loadTrackOnTv();
        showStatus('Sending audio to /mm/tv...');
    } else {
        sendTv('pause');
        const position = playbackPosition();
        tvPlayback = false;
        const trackId = currentTrack.id;
        audio.src = `/mm/api/mp3/stream/${currentTrack.id}`;
        audio.addEventListener('loadedmetadata', () => {
            if (tvPlayback || currentTrack?.id !== trackId) return;
            audio.currentTime = Math.min(position, Number.isFinite(audio.duration) ? audio.duration : position);
            audio.play().catch(error => showStatus(error.message));
        }, { once: true });
        showStatus('Playing in this browser.');
    }
    updateTvButton();
});

if (tvSocket) {
    tvSocket.on('connect', () => tvSocket.emit('media_join'));
    tvSocket.on('disconnect', () => { if (tvPlayback) showStatus('TV connection lost. Reconnecting...'); });
    tvSocket.on('media_error', result => {
        if (!tvPlayback) return;
        tvPlayback = false;
        setPlayingUi(false);
        updateTvButton();
        showStatus(result.error || 'TV playback failed.');
    });
    tvSocket.on('media_state', payload => {
        tvState = payload.state || payload;
        if (!tvPlayback) return;
        if (tvState.database_name !== 'mp3') {
            tvPlayback = false;
            updateTvButton();
            setPlayingUi(false);
            showStatus('The TV is now playing another media source.');
            return;
        }
        const track = allTracks.find(item => item.id === tvState.media_id);
        if (track && track !== currentTrack) {
            const index = filteredTracks.indexOf(track);
            if (index >= 0) selectAndPlayTrack(index, false);
            else { currentTrack = track; currentTrackIndex = -1; updateCurrentTrackInfo(); renderQueue(); }
        }
        setPlayingUi(!tvState.paused);
        updateTimeline();
        updateChapterButtons();
        updateMediaPosition();
        showStatus(tvState.paused ? 'Paused on TV.' : 'Playing on TV.');
    });
    tvSocket.on('media_progress', progress => {
        if (!tvPlayback || !tvState || progress.revision !== tvState.revision) return;
        Object.assign(tvState, progress);
        setPlayingUi(!progress.paused);
        updateTimeline();
        updateChapterButtons();
        updateMediaPosition();
    });
}

const editDialog = document.getElementById('editTrackDialog');
const editForm = document.getElementById('editTrackForm');
let editingTrack = null;
document.getElementById('editTrackBtn')?.addEventListener('click', () => {
    if (!currentTrack) return;
    editingTrack = currentTrack;
    [...metadataFields, 'duration', 'path'].forEach(field => {
        editForm.elements.namedItem(field).value = editingTrack[field] ?? (field === 'duration' ? 0 : '');
    });
    document.getElementById('editTrackStatus').textContent = '';
    editDialog.showModal();
});
document.getElementById('editTrackCancel')?.addEventListener('click', () => editDialog.close());
editDialog?.addEventListener('cancel', event => {
    if (document.getElementById('editTrackSave').disabled) event.preventDefault();
});
editForm?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!editingTrack) return;
    const track = editingTrack;
    const draft = { ...track };
    metadataFields.forEach(field => { draft[field] = editForm.elements.namedItem(field).value.trim(); });
    draft.duration = Number(editForm.elements.namedItem('duration').value);
    const button = document.getElementById('editTrackSave');
    const cancel = document.getElementById('editTrackCancel');
    button.disabled = true;
    cancel.disabled = true;
    document.getElementById('editTrackStatus').textContent = 'Saving...';
    try {
        const saved = await saveTrack(draft);
        Object.assign(track, saved);
        ['playlist', 'category', 'artist'].forEach(field => addInlineOption(field, track[field] || ''));
        buildTagChips();
        applyTagFilters();
        if (track === currentTrack) {
            updateCurrentTrackInfo();
            ['playlist', 'category', 'artist'].forEach(field => renderInlineValue(document.getElementById(`${field}Edit`), track[field] || ''));
            renderActiveTags();
            document.getElementById('chapterInput').value = track.chapter || '';
            updateChapterButtons();
        }
        editDialog.close();
        showStatus('Song information saved.');
    } catch (error) {
        document.getElementById('editTrackStatus').textContent = error.message;
    } finally {
        button.disabled = false;
        cancel.disabled = false;
    }
});

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
    if (row) {
        const index = Number(row.dataset.index);
        selectAndPlayTrack(index, true);
        document.getElementById(`queue-track-${filteredTracks[index]?.id}`)?.focus({ preventScroll: true });
    }
});
document.getElementById('queueList').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    const focusedRow = event.target.closest('.playlist-item');
    if (event.key === 'Enter' || event.key === ' ') {
        const index = Number(focusedRow?.dataset.index ?? currentTrackIndex);
        if (focusedRow && index >= 0) {
            selectAndPlayTrack(index, true);
            document.getElementById(`queue-track-${filteredTracks[index]?.id}`)?.focus({ preventScroll: true });
        }
        return;
    }
    if (!focusedRow) {
        focusCurrentOrFirstSong();
        return;
    }
    const currentIndex = Number(focusedRow.dataset.index);
    const nextIndex = currentIndex + (event.key === 'ArrowDown' ? 1 : -1);
    const firstOnPage = (queuePage - 1) * songsPerPage;
    const endOnPage = Math.min(filteredTracks.length, firstOnPage + songsPerPage);
    if (nextIndex < firstOnPage) {
        document.getElementById('mainPlayBtn')?.focus();
    } else if (nextIndex >= endOnPage) {
        document.querySelector('.page-num-pill.active')?.focus();
    } else {
        focusQueueTrack(nextIndex);
    }
});

if (TV_MODE) {
    document.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' || event.altKey || event.ctrlKey || event.metaKey) return;
        const target = event.target;
        if (target?.matches?.('select, input, textarea, [contenteditable="true"]')) return;
        if (!target?.closest?.('.mp3-pinned') && target !== document.body && target !== document.documentElement) return;
        event.preventDefault();
        focusCurrentOrFirstSong();
    });
}

document.getElementById('pageScrollTrack').addEventListener('click', (e) => {
    const pill = e.target.closest('.page-num-pill');
    if (pill) {
        goToQueuePage(parseInt(pill.dataset.pageNum, 10));
        document.querySelector(`.page-num-pill[data-page-num="${queuePage}"]`)?.focus();
    }
});
document.getElementById('queuePrevBtn').addEventListener('click', () => {
    goToQueuePage(queuePage - 1);
    document.getElementById('queuePrevBtn').focus();
});
document.getElementById('queueNextBtn').addEventListener('click', () => {
    goToQueuePage(queuePage + 1, true);
    document.getElementById('queueNextBtn').focus();
});

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
    track.chapter = formatChapterTimestamps(document.getElementById('chapterInput').value);
    document.getElementById('chapterInput').value = track.chapter;
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
    if (tvPlayback) { sendTv('seek', { position: e.target.value / 100 * playbackDuration() }); return; }
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

